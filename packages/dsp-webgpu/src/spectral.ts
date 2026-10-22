// Batched STFT, Welch PSD and segment spectra on WebGPU (Float32), with the same plans, windows, frame
// conventions and scaling as the Float64 CPU engine in packages/dsp-cpu. Supported: power-of-two FFT lengths.
import { CompensatedAccumulator, WaveBenchError } from "@wavebench/core";
import {
  assertFiniteSegment, isPowerOfTwo, MAX_STFT_CELLS, planFrames, quantityScale, unitRoot, windowSamples,
  type DetrendMode, type FftLengthRule, type FrameOptions, type FramePlan, type FrameQuantity, type WindowName,
} from "@wavebench/dsp-cpu";
import { guarded, type GpuContext } from "./device";
import { COLSUM_WGSL, FFT_STAGE_WGSL, FRAME_WGSL, MAX_WGSL, POWER_WGSL } from "./shaders";

const WG = 256;
/** Size of each complex work buffer; batches of frames are sized to fit. */
const BATCH_BYTES = 64 * 1024 * 1024;
const WELCH_CHUNK = 64;

export interface GpuStft {
  buffer: GPUBuffer;
  plan: FramePlan;
  quantity: FrameQuantity;
  bytes: number;
}

export interface Hooks {
  progress?: (fraction: number) => void;
  cancelled?: () => boolean;
}

type Field = ["u32" | "f32", number];

function pack(fields: Field[]): ArrayBuffer {
  const buf = new ArrayBuffer(Math.ceil(fields.length / 4) * 16);
  const u = new Uint32Array(buf);
  const f = new Float32Array(buf);
  fields.forEach(([t, v], i) => {
    if (t === "u32") u[i] = v;
    else f[i] = v;
  });
  return buf;
}

function grid(threads: number): { x: number; y: number; gridX: number } {
  const groups = Math.max(1, Math.ceil(threads / WG));
  const x = Math.min(groups, 65535);
  return { x, y: Math.ceil(groups / x), gridX: x * WG };
}

export class GpuSpectral {
  readonly context: GpuContext;
  private pipelines: Record<"frame" | "fft" | "power" | "colsum" | "max", GPUComputePipeline> | null = null;
  private readonly tables = new Map<string, GPUBuffer>();

  constructor(context: GpuContext) {
    this.context = context;
  }

  private get device(): GPUDevice {
    return this.context.device;
  }

  private get maxBinding(): number {
    return this.context.info.maxStorageBufferBindingSize;
  }

  private pipeline(name: "frame" | "fft" | "power" | "colsum" | "max"): GPUComputePipeline {
    if (!this.pipelines) {
      const make = (code: string) =>
        this.device.createComputePipeline({ layout: "auto", compute: { module: this.device.createShaderModule({ code }), entryPoint: "main" } });
      this.pipelines = {
        frame: make(FRAME_WGSL), fft: make(FFT_STAGE_WGSL), power: make(POWER_WGSL), colsum: make(COLSUM_WGSL), max: make(MAX_WGSL),
      };
    }
    return this.pipelines[name];
  }

  /**
   * Cached constant tables (windows, twiddles), least recently used first out. Evicted buffers are only dropped,
   * never destroyed: one may still be bound in the batch being encoded, and WebGPU keeps it alive while in use.
   */
  private table(key: string, build: () => Float32Array<ArrayBuffer>): GPUBuffer {
    let buf = this.tables.get(key);
    if (buf) {
      this.tables.delete(key);
      this.tables.set(key, buf);
      return buf;
    }
    const data = build();
    buf = this.device.createBuffer({ size: Math.max(16, data.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(buf, 0, data);
    this.tables.set(key, buf);
    while (this.tables.size > 48) this.tables.delete(this.tables.keys().next().value!);
    return buf;
  }

  /** exp(-2 pi i t / M) for t < M/2, from Float64 unit roots. */
  private twiddles(m: number): GPUBuffer {
    return this.table(`tw:${m}`, () => {
      const t = new Float32Array(Math.max(2, m));
      for (let j = 0; j < m / 2; j++) {
        const [c, s] = unitRoot(j, m);
        t[2 * j] = c;
        t[2 * j + 1] = -s;
      }
      return t;
    });
  }

  private window(name: WindowName, length: number): GPUBuffer {
    return this.table(`w:${name}:${length}`, () => Float32Array.from(windowSamples(name, length)));
  }

  /** Why a plan cannot run here, or null. */
  unsupported(plan: FramePlan, outputCells = 0): string | null {
    const m = plan.fftLength;
    if (!isPowerOfTwo(m) || m < 2) return `the WebGPU path needs a power-of-two FFT length (this analysis uses ${m.toLocaleString()})`;
    const limit = this.maxBinding;
    if (m * 8 > limit) return `an FFT of ${m.toLocaleString()} points exceeds this GPU's buffer limit`;
    if (plan.segmentLength * 4 > limit) return "the interval is longer than this GPU's buffer limit";
    if (outputCells * 4 > limit) {
      return `the result (${((outputCells * 4) / 2 ** 20).toFixed(0)} MiB) exceeds this GPU's buffer limit of ${(limit / 2 ** 20).toFixed(0)} MiB`;
    }
    return null;
  }

  private upload(x: ArrayLike<number>, start: number, length: number, detrend: DetrendMode): GPUBuffer {
    // Removing the segment mean in Float64 first leaves only the variation for Float32. Constant and linear
    // detrending remove any constant anyway, so the result is unchanged; with no detrend nothing is subtracted.
    let offset = 0;
    if (detrend !== "none") {
      const acc = new CompensatedAccumulator();
      for (let i = 0; i < length; i++) acc.add(x[start + i]);
      offset = acc.value / length;
    }
    const data = new Float32Array(length);
    for (let i = 0; i < length; i++) data[i] = x[start + i] - offset;
    const buf = this.device.createBuffer({ size: Math.max(16, data.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(buf, 0, data);
    return buf;
  }

  private uniform(size: number): GPUBuffer {
    return this.device.createBuffer({ size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /** Frame, window and transform every frame in batches; `sink` encodes what happens to each batch's spectra. */
  private async runBatches(
    plan: FramePlan,
    signal: GPUBuffer,
    sink: (pass: GPUComputePassEncoder, firstFrame: number, count: number, spectra: GPUBuffer) => void,
    hooks: Hooks = {},
    after?: (encoder: GPUCommandEncoder) => void,
  ): Promise<void> {
    const { device } = this;
    const m = plan.fftLength;
    const l = plan.windowLength;
    const batch = Math.min(plan.frames, Math.max(1, Math.floor(Math.min(BATCH_BYTES, this.maxBinding) / (m * 8))));
    const work = [0, 1].map(() => device.createBuffer({ size: batch * m * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }));
    const win = this.window(plan.window, l);
    const tw = this.twiddles(m);
    const stages = Math.round(Math.log2(m));
    const frameParams = this.uniform(48);
    const stageParams = Array.from({ length: stages }, () => this.uniform(32));
    const sxx = (l * (l * l - 1)) / 12;
    const detrend = { none: 0, constant: 1, linear: 2 }[plan.detrend];
    const temporary: GPUBuffer[] = [...work, frameParams, ...stageParams];
    try {
      for (let first = 0; first < plan.frames; first += batch) {
        const count = Math.min(batch, plan.frames - first);
        const fx = Math.min(count, 65535);
        device.queue.writeBuffer(frameParams, 0, pack([
          ["u32", l], ["u32", m], ["u32", plan.hopLength], ["u32", first * plan.hopLength],
          ["u32", count], ["u32", detrend], ["u32", fx], ["u32", 0],
          ["f32", (l - 1) / 2], ["f32", sxx > 0 ? 1 / sxx : 0], ["f32", 1 / l], ["f32", 0],
        ]));
        const half = m / 2;
        const g = grid(count * half);
        for (let s = 0, p = 1; s < stages; s++, p *= 2) {
          device.queue.writeBuffer(stageParams[s], 0, pack([
            ["u32", m], ["u32", half], ["u32", p], ["u32", count * half], ["u32", g.gridX], ["u32", m / (2 * p)], ["u32", 0], ["u32", 0],
          ]));
        }
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(this.pipeline("frame"));
        pass.setBindGroup(0, device.createBindGroup({
          layout: this.pipeline("frame").getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: frameParams } },
            { binding: 1, resource: { buffer: signal } },
            { binding: 2, resource: { buffer: win } },
            { binding: 3, resource: { buffer: work[0] } },
          ],
        }));
        pass.dispatchWorkgroups(fx, Math.ceil(count / fx));
        let src = 0;
        pass.setPipeline(this.pipeline("fft"));
        for (let s = 0; s < stages; s++) {
          pass.setBindGroup(0, device.createBindGroup({
            layout: this.pipeline("fft").getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: stageParams[s] } },
              { binding: 1, resource: { buffer: work[src] } },
              { binding: 2, resource: { buffer: work[1 - src] } },
              { binding: 3, resource: { buffer: tw } },
            ],
          }));
          pass.dispatchWorkgroups(g.x, g.y);
          src = 1 - src;
        }
        sink(pass, first, count, work[src]);
        pass.end();
        if (first + count >= plan.frames && after) after(encoder);
        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();
        hooks.progress?.((first + count) / plan.frames);
        if (hooks.cancelled?.()) throw new WaveBenchError("CANCELLED", "cancelled");
      }
    } finally {
      for (const b of temporary) b.destroy();
    }
  }

  private powerPass(
    pass: GPUComputePassEncoder,
    params: GPUBuffer,
    plan: FramePlan,
    count: number,
    outFrame: number,
    quantity: FrameQuantity,
    scale: number,
    spectra: GPUBuffer,
    out: GPUBuffer,
  ): void {
    const g = grid(count * plan.bins);
    this.device.queue.writeBuffer(params, 0, pack([
      ["u32", plan.fftLength], ["u32", plan.bins], ["u32", count], ["u32", outFrame],
      ["u32", quantity === "peak" ? 1 : 0], ["u32", g.gridX], ["u32", plan.fftLength % 2 === 0 ? 1 : 0], ["u32", 0],
      ["f32", scale], ["f32", 0], ["f32", 0], ["f32", 0],
    ]));
    pass.setPipeline(this.pipeline("power"));
    pass.setBindGroup(0, this.device.createBindGroup({
      layout: this.pipeline("power").getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: params } },
        { binding: 1, resource: { buffer: spectra } },
        { binding: 2, resource: { buffer: out } },
      ],
    }));
    pass.dispatchWorkgroups(g.x, g.y);
  }

  /** Spectrogram matrix (frame-major, Float32) kept on the GPU for rendering; read it back only on request. */
  async stft(
    x: ArrayLike<number>,
    start: number,
    length: number,
    sampleRateHz: number,
    options: FrameOptions,
    quantity: FrameQuantity,
    hooks: Hooks = {},
  ): Promise<GpuStft> {
    const plan = planFrames(length, sampleRateHz, options);
    const cells = plan.frames * plan.bins;
    if (cells > MAX_STFT_CELLS) throw new WaveBenchError("STFT_TOO_LARGE", `the spectrogram would have ${cells.toExponential(2)} cells (limit ${MAX_STFT_CELLS.toExponential(2)}); increase the hop`);
    const reason = this.unsupported(plan, cells);
    if (reason) throw new WaveBenchError("GPU_UNSUPPORTED", reason);
    assertFiniteSegment(x, start, length);
    const scale = quantityScale(quantity, plan.windowSum, plan.windowEnergy, sampleRateHz);
    return guarded(this.context, "STFT on the GPU", async () => {
      const signal = this.upload(x, start, length, plan.detrend);
      const out = this.device.createBuffer({ size: Math.max(16, cells * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const params = this.uniform(48);
      try {
        await this.runBatches(plan, signal, (pass, first, count, spectra) => this.powerPass(pass, params, plan, count, first, quantity, scale, spectra, out), hooks);
      } catch (e) {
        out.destroy();
        throw e;
      } finally {
        signal.destroy();
        params.destroy();
      }
      return { buffer: out, plan, quantity, bytes: cells * 4 };
    });
  }

  /** Welch mean of frame PSDs (or power spectra); chunk sums are added in Float64 on the CPU. */
  async welch(
    x: ArrayLike<number>,
    start: number,
    length: number,
    sampleRateHz: number,
    options: FrameOptions,
    quantity: "psd" | "power",
    hooks: Hooks = {},
  ): Promise<{ plan: FramePlan; values: Float64Array }> {
    const plan = planFrames(length, sampleRateHz, options);
    const reason = this.unsupported(plan);
    if (reason) throw new WaveBenchError("GPU_UNSUPPORTED", reason);
    assertFiniteSegment(x, start, length);
    const scale = quantityScale(quantity, plan.windowSum, plan.windowEnergy, sampleRateHz);
    const k = plan.bins;
    const batch = Math.min(plan.frames, Math.max(1, Math.floor(Math.min(BATCH_BYTES, this.maxBinding) / (plan.fftLength * 8))));
    const totalChunks = Math.ceil(plan.frames / batch) * Math.ceil(batch / WELCH_CHUNK);
    return guarded(this.context, "Welch PSD on the GPU", async () => {
      const signal = this.upload(x, start, length, plan.detrend);
      const frameValues = this.device.createBuffer({ size: Math.max(16, batch * k * 4), usage: GPUBufferUsage.STORAGE });
      const sums = this.device.createBuffer({ size: Math.max(16, totalChunks * k * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      sums.label = "welch sums";
      const readback = this.device.createBuffer({ size: Math.max(16, totalChunks * k * 4), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const powerParams = this.uniform(48);
      const sumParams = this.uniform(32);
      let outChunk = 0;
      try {
        await this.runBatches(
          plan,
          signal,
          (pass, _first, count, spectra) => {
            this.powerPass(pass, powerParams, plan, count, 0, quantity, scale, spectra, frameValues);
            const chunks = Math.ceil(count / WELCH_CHUNK);
            const g = grid(chunks * k);
            this.device.queue.writeBuffer(sumParams, 0, pack([
              ["u32", k], ["u32", count], ["u32", WELCH_CHUNK], ["u32", chunks], ["u32", outChunk], ["u32", g.gridX], ["u32", 0], ["u32", 0],
            ]));
            pass.setPipeline(this.pipeline("colsum"));
            pass.setBindGroup(0, this.device.createBindGroup({
              layout: this.pipeline("colsum").getBindGroupLayout(0),
              entries: [
                { binding: 0, resource: { buffer: sumParams } },
                { binding: 1, resource: { buffer: frameValues } },
                { binding: 2, resource: { buffer: sums } },
              ],
            }));
            pass.dispatchWorkgroups(g.x, g.y);
            outChunk += chunks;
          },
          hooks,
          (encoder) => encoder.copyBufferToBuffer(sums, 0, readback, 0, totalChunks * k * 4),
        );
        await readback.mapAsync(GPUMapMode.READ);
        const partial = new Float32Array(readback.getMappedRange().slice(0));
        readback.unmap();
        const values = new Float64Array(k);
        for (let bin = 0; bin < k; bin++) {
          const acc = new CompensatedAccumulator();
          for (let c = 0; c < outChunk; c++) acc.add(partial[c * k + bin]);
          values[bin] = acc.value / plan.frames;
        }
        return { plan, values };
      } finally {
        for (const b of [signal, frameValues, sums, readback, powerParams, sumParams]) b.destroy();
      }
    });
  }

  /** Complex one-sided transform of one segment (Float32 on the GPU, returned as Float64 arrays). */
  async segment(
    x: ArrayLike<number>,
    start: number,
    length: number,
    sampleRateHz: number,
    options: { window: WindowName; detrend: DetrendMode; fftLength: FftLengthRule },
  ): Promise<{ plan: FramePlan; re: Float64Array; im: Float64Array }> {
    const plan = planFrames(length, sampleRateHz, { window: options.window, windowLength: length, hopLength: length, fftLength: options.fftLength, detrend: options.detrend });
    const reason = this.unsupported(plan);
    if (reason) throw new WaveBenchError("GPU_UNSUPPORTED", reason);
    assertFiniteSegment(x, start, length);
    const k = plan.bins;
    return guarded(this.context, "FFT on the GPU", async () => {
      const signal = this.upload(x, start, length, plan.detrend);
      const readback = this.device.createBuffer({ size: Math.max(16, k * 8), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      let spectra: GPUBuffer | null = null;
      try {
        await this.runBatches(plan, signal, (_pass, _first, _count, s) => (spectra = s), {}, (encoder) => {
          encoder.copyBufferToBuffer(spectra!, 0, readback, 0, k * 8);
        });
        await readback.mapAsync(GPUMapMode.READ);
        const raw = new Float32Array(readback.getMappedRange().slice(0));
        readback.unmap();
        const re = new Float64Array(k);
        const im = new Float64Array(k);
        for (let i = 0; i < k; i++) {
          re[i] = raw[2 * i];
          im[i] = raw[2 * i + 1];
        }
        return { plan, re, im };
      } finally {
        signal.destroy();
        readback.destroy();
      }
    });
  }

  async read(stft: GpuStft, offsetCells = 0, cells = stft.plan.frames * stft.plan.bins): Promise<Float32Array> {
    return guarded(this.context, "reading the spectrogram", async () => {
      const bytes = cells * 4;
      const readback = this.device.createBuffer({ size: Math.max(16, Math.ceil(bytes / 4) * 4), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      try {
        const encoder = this.device.createCommandEncoder();
        encoder.copyBufferToBuffer(stft.buffer, offsetCells * 4, readback, 0, bytes);
        this.device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const out = new Float32Array(readback.getMappedRange(0, bytes).slice(0));
        readback.unmap();
        return out;
      } finally {
        readback.destroy();
      }
    });
  }

  /** Largest value of a GPU spectrogram (for the default colour range) without reading the matrix back. */
  async max(stft: GpuStft): Promise<number> {
    const count = stft.plan.frames * stft.plan.bins;
    const perThread = 16;
    const groups = Math.max(1, Math.ceil(count / (WG * perThread)));
    const gx = Math.min(groups, 65535);
    return guarded(this.context, "spectrogram maximum", async () => {
      const params = this.uniform(16);
      const partial = this.device.createBuffer({ size: Math.max(16, groups * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const readback = this.device.createBuffer({ size: Math.max(16, groups * 4), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      try {
        this.device.queue.writeBuffer(params, 0, pack([["u32", count], ["u32", perThread], ["u32", gx], ["u32", 0]]));
        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(this.pipeline("max"));
        pass.setBindGroup(0, this.device.createBindGroup({
          layout: this.pipeline("max").getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: params } },
            { binding: 1, resource: { buffer: stft.buffer } },
            { binding: 2, resource: { buffer: partial } },
          ],
        }));
        pass.dispatchWorkgroups(gx, Math.ceil(groups / gx));
        pass.end();
        encoder.copyBufferToBuffer(partial, 0, readback, 0, groups * 4);
        this.device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const values = new Float32Array(readback.getMappedRange(0, groups * 4).slice(0));
        readback.unmap();
        let m = -Infinity;
        for (const v of values) if (v > m) m = v;
        return m;
      } finally {
        params.destroy();
        partial.destroy();
        readback.destroy();
      }
    });
  }

  /** Upload Float64 CPU results (e.g. a CPU spectrogram) for GPU rendering only. */
  uploadValues(values: ArrayLike<number>): GPUBuffer {
    const data = Float32Array.from(values as ArrayLike<number>);
    const buf = this.device.createBuffer({ size: Math.max(16, data.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    this.device.queue.writeBuffer(buf, 0, data);
    return buf;
  }
}
