// The engine worker: owns every sample array, runs CPU (Float64) and WebGPU (Float32) analyses, and renders the
// spectrogram into an OffscreenCanvas. Requests are answered in order of completion; long loops yield between
// batches so that "cancel" (or a newer request of the same type) can stop them.
import {
  analyzeTimestamps, channelStats, conversionFactor, csvText, DelimitedParser, generateSignals, sniffDelimited, unitDef,
  WaveBenchError, type ParsedTable, type TimestampDiagnostics,
} from "@wavebench/core";
import {
  applyChain, designGroupDelay, designResponse, nextPowerOfTwo, planFrames, segmentSpectrum, stftSteps, unwrapPhase,
  welchSteps, windowMetrics, windowSamples, type AppliedStep, type ChainStep, type FrameOptions,
} from "@wavebench/dsp-cpu";
import {
  describeGpu, GpuHeatmapRenderer, GpuSpectral, gpuSelfTest, requestGpu, type GpuContext, type GpuStft,
} from "@wavebench/dsp-webgpu";
import { cellAt, linearGroups, minMaxEnvelope, renderHeatmap, type ColorScale, type HeatmapGrid, type HeatmapView } from "@wavebench/plots";
import type {
  BackendPreference, ChannelInfo, ConfigureResult, DataConfig, Envelope, FilterResponse, FrameSettings, GpuStatusInfo,
  Interval, ProcessResult, Reply, Request, RowsResult, SignalSource, SniffReply, SourceInfo, SpectrumResult, StatsResult,
  StftMeta, TimeViewResult, WelchResult,
} from "./protocol";

const scope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<Envelope>) => void) | null;
  navigator: Navigator;
};

// ---------------------------------------------------------------------------------------------------------------
// State

interface Record_ {
  config: DataConfig;
  samples: number;
  sampleRateHz: number;
  startSec: number;
  /** Timestamps of the used rows (time-column mode), for display and the data table. */
  times: Float64Array | null;
  /** Largest regular step between timestamps (gap factor x median interval), or null on a uniform grid. */
  gapLimitSec: number | null;
  ids: string[];
  labels: Map<string, string>;
  raw: Map<string, Float64Array>;
  processed: Map<string, Float64Array>;
  usable: boolean;
}

interface StftState {
  meta: StftMeta;
  cpu: Float64Array | null;
  gpu: GpuStft | null;
  /** Float32 copy on the GPU for drawing a CPU result. */
  display: GPUBuffer | null;
  /** CPU copy of a GPU result, read back only when the canvas cannot draw with WebGPU. */
  readback: Float32Array | null;
}

let table: ParsedTable | null = null;
let source: SourceInfo | null = null;
let record: Record_ | null = null;
let chain: { steps: ChainStep[]; applied: AppliedStep[] } = { steps: [], applied: [] };
let stft: StftState | null = null;
let canvas: OffscreenCanvas | null = null;
let gpuRenderer: GpuHeatmapRenderer | null = null;
let ctx2d: OffscreenCanvasRenderingContext2D | null = null;
let gpu: { context: GpuContext; spectral: GpuSpectral } | null = null;
let gpuStatus: GpuStatusInfo | null = null;

const cancelled = new Set<number>();
const latest = new Map<string, number>();

// ---------------------------------------------------------------------------------------------------------------
// Messaging helpers

function post(reply: Reply, transfer: Transferable[] = []): void {
  scope.postMessage(reply, transfer);
}

const tickChannel = new MessageChannel();
const tickQueue: (() => void)[] = [];
tickChannel.port1.onmessage = () => tickQueue.shift()?.();
function tick(): Promise<void> {
  return new Promise((resolve) => {
    tickQueue.push(resolve);
    tickChannel.port2.postMessage(0);
  });
}

class Job {
  readonly id: number;
  private last = 0;

  constructor(id: number) {
    this.id = id;
  }

  check(): void {
    if (cancelled.has(this.id)) throw new WaveBenchError("CANCELLED", "cancelled");
  }

  progress(fraction: number, label?: string): void {
    const now = performance.now();
    if (now - this.last < 80 && fraction < 1) return;
    this.last = now;
    post({ id: this.id, kind: "progress", fraction, label });
  }

  /** Drive a CPU generator, yielding to the event loop between batches. */
  async run<T>(steps: Generator<number, T>, label: string): Promise<T> {
    for (;;) {
      const r = steps.next();
      if (r.done) return r.value;
      this.progress(r.value, label);
      await tick();
      this.check();
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// GPU

async function ensureGpu(): Promise<GpuStatusInfo> {
  if (gpuStatus && (!gpu || !gpu.context.lost)) return gpuStatus;
  const status = await requestGpu(scope.navigator.gpu);
  if (status.ok) {
    gpu = { context: status.context, spectral: new GpuSpectral(status.context) };
    const info = status.context.info;
    gpuStatus = {
      available: true, reason: null, adapter: describeGpu(info), fallback: info.fallback,
      maxBufferMiB: Math.round(info.maxStorageBufferBindingSize / 2 ** 20),
    };
  } else {
    gpu = null;
    gpuStatus = { available: false, reason: status.reason, adapter: null, fallback: false, maxBufferMiB: null };
  }
  return gpuStatus;
}

function usableGpu(): { context: GpuContext; spectral: GpuSpectral } | null {
  return gpu && !gpu.context.lost ? gpu : null;
}

/** The backend a request runs on, and why when it differs from the preference. */
function chooseBackend(preference: BackendPreference, autoPrefersGpu: boolean, fftLength: number): { backend: "cpu" | "webgpu"; note: string | null } {
  const g = usableGpu();
  const pow2 = fftLength >= 2 && (fftLength & (fftLength - 1)) === 0;
  if (preference === "cpu") return { backend: "cpu", note: null };
  if (preference === "webgpu") {
    if (!g) return { backend: "cpu", note: `WebGPU is not available (${gpuStatus?.reason ?? "not initialised"}); computed on the CPU` };
    if (!pow2) return { backend: "cpu", note: `the WebGPU path needs a power-of-two FFT length (${fftLength}); computed on the CPU` };
    return { backend: "webgpu", note: null };
  }
  return autoPrefersGpu && g && pow2 ? { backend: "webgpu", note: null } : { backend: "cpu", note: null };
}

function provenance(backend: "cpu" | "webgpu", t0: number) {
  return {
    backend,
    precision: backend === "cpu" ? ("float64" as const) : ("float32" as const),
    elapsedMs: performance.now() - t0,
    adapter: backend === "webgpu" ? gpuStatus?.adapter ?? undefined : undefined,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Import

const ROWS_PER_BYTE_GUESS = 1 / 28;

async function sha256(buffer: ArrayBuffer): Promise<string | null> {
  try {
    if (!crypto?.subtle) return null;
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

async function sniff(req: Extract<Request, { type: "sniff" }>): Promise<SniffReply> {
  const sample = req.file ? await req.file.slice(0, 256 * 1024).text() : req.text!.slice(0, 256 * 1024);
  const full = req.file ? req.file.size <= 256 * 1024 : req.text!.length <= 256 * 1024;
  const result = sniffDelimited(full ? sample + "\n" : sample);
  return { ...result, name: req.name, bytes: req.file ? req.file.size : null };
}

async function load(job: Job, req: Extract<Request, { type: "load" }>): Promise<SourceInfo> {
  const t0 = performance.now();
  let bytes: number | null = null;
  let hash: string | null = null;
  let parsed: ParsedTable;
  if (req.file) {
    const buffer = await req.file.arrayBuffer();
    bytes = buffer.byteLength;
    hash = await sha256(buffer);
    const parser = new DelimitedParser(req.options, Math.ceil(bytes * ROWS_PER_BYTE_GUESS) + 16);
    const decoder = new TextDecoder("utf-8");
    const chunk = 1 << 20;
    for (let offset = 0; offset < bytes; offset += chunk) {
      parser.push(decoder.decode(new Uint8Array(buffer, offset, Math.min(chunk, bytes - offset)), { stream: true }));
      job.progress(offset / bytes, "Reading");
      await tick();
      job.check();
    }
    parser.push(decoder.decode());
    parsed = parser.finish();
  } else {
    const text = req.text!;
    const encoded = new TextEncoder().encode(text);
    bytes = encoded.byteLength;
    hash = await sha256(encoded.buffer as ArrayBuffer);
    const parser = new DelimitedParser(req.options, Math.ceil(text.length * ROWS_PER_BYTE_GUESS) + 16);
    const chunk = 1 << 20;
    for (let offset = 0; offset < text.length; offset += chunk) {
      parser.push(text.slice(offset, offset + chunk));
      job.progress(offset / text.length, "Reading");
      await tick();
      job.check();
    }
    parsed = parser.finish();
  }
  table = parsed;
  resetRecord();
  source = {
    name: req.name, bytes, sha256: hash, kind: req.kind, names: parsed.names, kinds: parsed.kinds, rowCount: parsed.rowCount,
    timeOrigins: parsed.timeOrigins, issues: parsed.issues, issueCount: parsed.issueCount,
    columnIssueCounts: parsed.columnIssueCounts, rowsWithIssues: parsed.rowsWithIssues,
    skippedCommentLines: parsed.skippedCommentLines, skippedBlankLines: parsed.skippedBlankLines,
    parseOptions: req.options, generator: null, parseMs: performance.now() - t0,
  };
  return source;
}

function generate(req: Extract<Request, { type: "generate" }>): SourceInfo {
  const t0 = performance.now();
  const columns = generateSignals(req.spec);
  const names = req.spec.channels.map((c) => c.name);
  table = {
    names, kinds: names.map(() => "number"), columns, timeOrigins: names.map(() => null), rowCount: req.spec.samples,
    issues: [], issueCount: 0, columnIssueCounts: names.map(() => 0), rowsWithIssues: 0, skippedCommentLines: 0,
    skippedBlankLines: 0, firstDataLine: 1,
  };
  resetRecord();
  source = {
    name: req.name, bytes: null, sha256: null, kind: "generated", names, kinds: table.kinds, rowCount: req.spec.samples,
    timeOrigins: table.timeOrigins, issues: [], issueCount: 0, columnIssueCounts: table.columnIssueCounts, rowsWithIssues: 0,
    skippedCommentLines: 0, skippedBlankLines: 0, parseOptions: null, generator: req.spec, parseMs: performance.now() - t0,
  };
  return source;
}

function resetRecord(): void {
  record = null;
  chain = { steps: [], applied: [] };
  dropStft();
}

// ---------------------------------------------------------------------------------------------------------------
// Configure and process

const TIME_UNITS = { s: 1, ms: 1e-3, us: 1e-6, ns: 1e-9 } as const;

function magnitudeOf(arrays: Float64Array[], n: number): Float64Array {
  const out = new Float64Array(n);
  for (const a of arrays) for (let i = 0; i < n; i++) out[i] += a[i] * a[i];
  for (let i = 0; i < n; i++) out[i] = Math.sqrt(out[i]);
  return out;
}

function configure(config: DataConfig): ConfigureResult {
  if (!table || !source) throw new WaveBenchError("NO_DATA", "no data loaded");
  const { start, end } = config.rows;
  if (!(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end <= table.rowCount && end - start >= 2)) {
    throw new WaveBenchError("INVALID_ROWS", `rows must lie within 1 to ${table.rowCount} and include at least two samples`);
  }
  const n = end - start;
  unitDef(config.unit);
  const conversion = conversionFactor(config.unit, config.displayUnit);
  const enabled = config.channels.filter((c) => c.enabled);
  if (!enabled.length) throw new WaveBenchError("NO_CHANNELS", "select at least one signal column");
  const raw = new Map<string, Float64Array>();
  const labels = new Map<string, string>();
  const ids: string[] = [];
  const infos: ChannelInfo[] = [];
  for (const c of enabled) {
    const column = table.columns[c.column];
    if (!column) throw new WaveBenchError("NOT_NUMERIC", `column "${table.names[c.column]}" is not numeric`);
    const id = `c${c.column}`;
    const identity = c.offset === 0 && c.gain === 1 && conversion === 1;
    let values: Float64Array;
    if (identity) values = column.subarray(start, end);
    else {
      values = new Float64Array(n);
      const k = c.gain * conversion;
      for (let i = 0; i < n; i++) values[i] = (column[start + i] - c.offset) * k;
    }
    let missing = 0;
    for (let i = 0; i < n; i++) if (!Number.isFinite(values[i])) missing++;
    raw.set(id, values);
    labels.set(id, c.label);
    ids.push(id);
    infos.push({ id, label: c.label, derived: false, missing });
  }
  if (config.magnitude && ids.length >= 2) {
    const mag = magnitudeOf(ids.map((id) => raw.get(id)!), n);
    raw.set("mag", mag);
    labels.set("mag", "|a|");
    ids.push("mag");
    let missing = 0;
    for (let i = 0; i < n; i++) if (!Number.isFinite(mag[i])) missing++;
    infos.push({ id: "mag", label: "|a|", derived: true, missing });
  }
  let sampleRateHz: number;
  let startSec: number;
  let times: Float64Array | null = null;
  let diagnostics: TimestampDiagnostics | null = null;
  let rateSource: ConfigureResult["rateSource"] = "assigned";
  let usable = true;
  const tb = config.timebase;
  if (tb.mode === "rate") {
    if (!(Number.isFinite(tb.sampleRateHz) && tb.sampleRateHz > 0)) throw new WaveBenchError("INVALID_RATE", "the sampling rate must be a positive number");
    if (!Number.isFinite(tb.startSec)) throw new WaveBenchError("INVALID_START", "the start time must be a number");
    sampleRateHz = tb.sampleRateHz;
    startSec = tb.startSec;
  } else {
    const column = table.columns[tb.column];
    if (!column) throw new WaveBenchError("NOT_NUMERIC", "the time column is not readable");
    const kind = table.kinds[tb.column];
    const factor = kind === "datetime" || kind === "time-of-day" ? 1 : TIME_UNITS[tb.unit];
    times = new Float64Array(n);
    for (let i = 0; i < n; i++) times[i] = column[start + i] * factor;
    diagnostics = analyzeTimestamps(times, tb.policy);
    const fit = diagnostics.sampleRateFromFitHz;
    const median = diagnostics.sampleRateFromMedianHz;
    const rate = tb.rateFrom === "fit" ? fit : median;
    usable = diagnostics.quality === "uniform-within-policy" && !!rate && rate > 0;
    sampleRateHz = rate && rate > 0 ? rate : 1;
    startSec = Number.isFinite(times[0]) ? times[0] : 0;
    rateSource = tb.rateFrom === "fit" ? "timestamp fit" : "timestamp median";
  }
  const gapLimitSec = diagnostics?.gapCount && diagnostics.medianIntervalSec ? diagnostics.policy.gapFactor * diagnostics.medianIntervalSec : null;
  record = { config, samples: n, sampleRateHz, startSec, times, gapLimitSec, ids, labels, raw, processed: new Map(raw), usable };
  chain = { steps: [], applied: [] };
  dropStft();
  const firstTimeSec = times ? times[0] : startSec;
  const lastTimeSec = times ? times[n - 1] : startSec + (n - 1) / sampleRateHz;
  return {
    samples: n, sampleRateHz, startSec, firstTimeSec, lastTimeSec, usable, rateSource, diagnostics, channels: infos,
    unit: config.displayUnit, conversion,
  };
}

function requireRecord(analysis = false): Record_ {
  if (!record) throw new WaveBenchError("NO_DATA", "no data loaded");
  if (analysis && !record.usable) {
    throw new WaveBenchError(
      "IRREGULAR_TIMESTAMPS",
      "the timestamps are not uniform within the tolerance; use the sampling-rate mode or a gap-free range of rows",
    );
  }
  return record;
}

function processChain(steps: ChainStep[]): ProcessResult {
  const r = requireRecord(true);
  const t0 = performance.now();
  const processed = new Map<string, Float64Array>();
  const warnings: string[] = [];
  let applied: AppliedStep[] = [];
  let edgeStart = 0;
  let edgeEnd = 0;
  const active = steps.some((s) => s.enabled);
  for (const id of r.ids) {
    if (id === "mag") continue;
    const x = r.raw.get(id)!;
    if (!active) {
      processed.set(id, x);
      continue;
    }
    let missing = 0;
    for (let i = 0; i < x.length; i++) if (!Number.isFinite(x[i])) missing++;
    if (missing) {
      warnings.push(`${r.labels.get(id)}: ${missing} samples are missing, so this channel is not processed (filters need complete data)`);
      processed.set(id, x);
      continue;
    }
    const result = applyChain(x, r.sampleRateHz, steps);
    processed.set(id, result.y);
    if (!applied.length) {
      applied = result.steps;
      warnings.push(...result.warnings);
      edgeStart = result.edgeStart;
      edgeEnd = result.edgeEnd;
    }
  }
  if (r.ids.includes("mag")) {
    const parts = r.ids.filter((id) => id !== "mag").map((id) => processed.get(id)!);
    processed.set("mag", magnitudeOf(parts, r.samples));
  }
  r.processed = processed;
  chain = { steps, applied };
  dropStft();
  return {
    steps: applied.map((s) => ({
      index: s.index, description: s.description, sections: s.design?.sections, realizedOrder: s.design?.realizedOrder,
      maxPoleRadius: s.design?.maxPoleRadius, roundingBound: s.design?.roundingBound, transientSamples: s.transientSamples,
      padLength: s.padLength, sos: s.design ? Array.from(s.design.sos) : undefined,
    })),
    warnings,
    edgeStart: Math.min(edgeStart, r.samples),
    edgeEnd: Math.min(edgeEnd, r.samples),
    ms: performance.now() - t0,
  };
}

function signal(source_: SignalSource, id: string): Float64Array {
  const r = requireRecord();
  const map = source_ === "raw" ? r.raw : r.processed;
  const x = map.get(id);
  if (!x) throw new WaveBenchError("UNKNOWN_CHANNEL", `unknown channel ${id}`);
  return x;
}

function checkInterval(r: Record_, interval: Interval): void {
  if (!(Number.isInteger(interval.start) && Number.isInteger(interval.end) && interval.start >= 0 && interval.end <= r.samples && interval.end > interval.start)) {
    throw new WaveBenchError("INVALID_INTERVAL", "the analysis interval lies outside the record");
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Views and analyses

/** First sample index with time >= t (binary search on timestamps, arithmetic on a uniform grid). */
function indexAt(r: Record_, t: number): number {
  if (!r.times) return Math.ceil((t - r.startSec) * r.sampleRateHz - 1e-9);
  let lo = 0;
  let hi = r.samples;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (r.times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function timeView(req: Extract<Request, { type: "timeView" }>): TimeViewResult {
  const r = requireRecord();
  // One sample beyond each edge keeps the trace continuous to the plot border.
  const start = Math.max(0, Math.min(r.samples - 1, indexAt(r, req.tMin) - 1));
  const end = Math.max(start + 1, Math.min(r.samples, indexAt(r, req.tMax) + 1));
  const series = req.channels.map((id) => signal(req.source, id));
  const env = minMaxEnvelope(series, linearGroups(start, end, Math.max(1, Math.floor(req.width))));
  const x = new Float64Array(env.index.length);
  for (let i = 0; i < x.length; i++) x[i] = r.times ? r.times[env.index[i]] : r.startSec + env.index[i] / r.sampleRateHz;
  const gaps = r.gapLimitSec !== null ? breaksAt(x, r.gapLimitSec) : [];
  if (!gaps.length) return { x, index: env.index, values: env.values, exact: env.exact, samples: end - start };
  // A trace is never drawn across a gap in the timestamps: a NaN point breaks the line there.
  const n = x.length + gaps.length;
  const bx = new Float64Array(n);
  const bi = new Float64Array(n);
  const bv = env.values.map(() => new Float64Array(n));
  let o = 0;
  let g = 0;
  for (let i = 0; i < x.length; i++) {
    if (g < gaps.length && gaps[g] === i) {
      bx[o] = (x[i - 1] + x[i]) / 2;
      bi[o] = env.index[i];
      bv.forEach((v) => (v[o] = NaN));
      o++;
      g++;
    }
    bx[o] = x[i];
    bi[o] = env.index[i];
    bv.forEach((v, c) => (v[o] = env.values[c][i]));
    o++;
  }
  return { x: bx, index: bi, values: bv, exact: env.exact, samples: end - start };
}

/** Indices i where x[i] - x[i-1] exceeds the gap limit. */
function breaksAt(x: Float64Array, limit: number): number[] {
  const out: number[] = [];
  for (let i = 1; i < x.length; i++) if (x[i] - x[i - 1] > limit) out.push(i);
  return out;
}

function stats(req: Extract<Request, { type: "stats" }>): StatsResult {
  const r = requireRecord();
  checkInterval(r, req.interval);
  return r.ids.map((id) => {
    try {
      return { id, label: r.labels.get(id)!, stats: channelStats(signal(req.source, id), req.interval.start, req.interval.end), error: null };
    } catch (e) {
      return { id, label: r.labels.get(id)!, stats: null, error: (e as Error).message };
    }
  });
}

async function spectrum(job: Job, req: Extract<Request, { type: "spectrum" }>): Promise<SpectrumResult> {
  const r = requireRecord(true);
  checkInterval(r, req.interval);
  const length = req.interval.end - req.interval.start;
  const fftLength = req.settings.fftLength === "exact" ? length : req.settings.fftLength === "pow2" ? nextPowerOfTwo(length) : req.settings.fftLength;
  const choice = chooseBackend(req.backend, false, fftLength);
  const t0 = performance.now();
  const channels: SpectrumResult["channels"] = [];
  const notes = choice.note ? [choice.note] : [];
  for (const id of r.ids) {
    const x = signal(req.source, id);
    if (choice.backend === "webgpu") {
      const g = await usableGpu()!.spectral.segment(x, req.interval.start, length, r.sampleRateHz, req.settings);
      channels.push({ id, re: g.re, im: g.im });
    } else {
      const s = segmentSpectrum(x, req.interval.start, length, r.sampleRateHz, req.settings);
      channels.push({ id, re: s.re, im: s.im });
    }
    job.check();
    await tick();
  }
  const m = windowMetrics(windowSamples(req.settings.window, length));
  return {
    channels, sampleRateHz: r.sampleRateHz, segmentLength: length, fftLength, windowSum: m.sum, windowEnergy: m.energy,
    enbwHz: (r.sampleRateHz * m.energy) / (m.sum * m.sum), binWidthHz: r.sampleRateHz / fftLength,
    provenance: provenance(choice.backend, t0), notes,
  };
}

export function frameOptions(settings: FrameSettings): FrameOptions {
  const l = Math.round(settings.windowLength);
  const overlap = Math.min(l - 1, Math.max(0, Math.round((l * settings.overlapPercent) / 100)));
  const fftLength = settings.fftFactor === "pow2" ? nextPowerOfTwo(l) : l * settings.fftFactor;
  return { window: settings.window, windowLength: l, hopLength: l - overlap, fftLength, detrend: settings.detrend };
}

async function welch(job: Job, req: Extract<Request, { type: "welch" }>): Promise<WelchResult> {
  const r = requireRecord(true);
  checkInterval(r, req.interval);
  const options = frameOptions(req.settings);
  const length = req.interval.end - req.interval.start;
  const plan = planFrames(length, r.sampleRateHz, options);
  const choice = chooseBackend(req.backend, false, plan.fftLength);
  const t0 = performance.now();
  const notes = choice.note ? [choice.note] : [];
  const channels: WelchResult["channels"] = [];
  for (const [i, id] of r.ids.entries()) {
    const x = signal(req.source, id);
    if (choice.backend === "webgpu") {
      const g = await usableGpu()!.spectral.welch(x, req.interval.start, length, r.sampleRateHz, options, "psd", { cancelled: () => cancelled.has(job.id) });
      channels.push({ id, psd: g.values });
    } else {
      const res = await job.run(welchSteps(x, req.interval.start, length, r.sampleRateHz, options, "psd"), `Welch ${i + 1}/${r.ids.length}`);
      channels.push({ id, psd: res.values });
    }
  }
  return {
    channels, sampleRateHz: r.sampleRateHz, windowLength: plan.windowLength, hopLength: plan.hopLength, fftLength: plan.fftLength,
    frames: plan.frames, unusedSamples: plan.unusedSamples, enbwHz: plan.enbwHz, binWidthHz: plan.binWidthHz,
    provenance: provenance(choice.backend, t0), notes,
  };
}

function dropStft(): void {
  if (!stft) return;
  stft.gpu?.buffer.destroy();
  stft.display?.destroy();
  stft = null;
}

async function computeStft(job: Job, req: Extract<Request, { type: "stft" }>): Promise<StftMeta> {
  const r = requireRecord(true);
  checkInterval(r, req.interval);
  const options = frameOptions(req.settings);
  const length = req.interval.end - req.interval.start;
  const plan = planFrames(length, r.sampleRateHz, options);
  const choice = chooseBackend(req.backend, true, plan.fftLength);
  const x = signal(req.source, req.channel);
  const t0 = performance.now();
  const notes = choice.note ? [choice.note] : [];
  let cpu: Float64Array | null = null;
  let gpuResult: GpuStft | null = null;
  let max = 0;
  let backend = choice.backend;
  if (backend === "webgpu") {
    try {
      gpuResult = await usableGpu()!.spectral.stft(x, req.interval.start, length, r.sampleRateHz, options, req.quantity, {
        progress: (f) => job.progress(f, "Spectrogram"),
        cancelled: () => cancelled.has(job.id),
      });
      max = await usableGpu()!.spectral.max(gpuResult);
    } catch (e) {
      if ((e as WaveBenchError).code === "CANCELLED") throw e;
      gpuResult?.buffer.destroy();
      gpuResult = null;
      backend = "cpu";
      notes.push(`WebGPU could not compute this spectrogram (${(e as Error).message}); computed on the CPU`);
    }
  }
  if (backend === "cpu") {
    const res = await job.run(stftSteps(x, req.interval.start, length, r.sampleRateHz, options, req.quantity), "Spectrogram");
    cpu = res.values;
    for (let i = 0; i < cpu.length; i++) if (cpu[i] > max) max = cpu[i];
  }
  job.check();
  dropStft();
  const grid: HeatmapGrid = {
    frames: plan.frames,
    bins: plan.bins,
    firstTimeSec: r.startSec + (req.interval.start + plan.windowLength / 2) / r.sampleRateHz,
    hopSec: plan.hopLength / r.sampleRateHz,
    binWidthHz: plan.binWidthHz,
  };
  const meta: StftMeta = {
    channel: req.channel, quantity: req.quantity, grid, windowLength: plan.windowLength, hopLength: plan.hopLength,
    fftLength: plan.fftLength, max, provenance: provenance(backend, t0), notes,
  };
  stft = { meta, cpu, gpu: gpuResult, display: null, readback: null };
  return meta;
}

function attachCanvas(c: OffscreenCanvas): "webgpu" | "canvas2d" {
  gpuRenderer?.destroy();
  gpuRenderer = null;
  ctx2d = null;
  canvas = c;
  const g = usableGpu();
  if (g) {
    try {
      gpuRenderer = GpuHeatmapRenderer.create(g.context, c, scope.navigator.gpu);
    } catch {
      gpuRenderer = null;
    }
  }
  if (!gpuRenderer) ctx2d = c.getContext("2d");
  return gpuRenderer ? "webgpu" : "canvas2d";
}

let lastView: { view: HeatmapView; scale: ColorScale } | null = null;

/** CPU rendering of the current view into a bitmap of the given size (figure export). */
async function stftImage(width: number, height: number): Promise<ImageBitmap | null> {
  if (!stft || !lastView) return null;
  let values: ArrayLike<number> | null = stft.cpu ?? stft.readback;
  if (!values && stft.gpu && usableGpu()) {
    stft.readback = await usableGpu()!.spectral.read(stft.gpu);
    values = stft.readback;
  }
  if (!values) return null;
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const pixels = renderHeatmap(values, stft.meta.grid, { ...lastView.view, width: w, height: h }, lastView.scale);
  const off = new OffscreenCanvas(w, h);
  off.getContext("2d")!.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
  return off.transferToImageBitmap();
}

async function renderStft(view: HeatmapView, scale: ColorScale): Promise<void> {
  lastView = { view, scale };
  if (!canvas) return;
  const w = Math.max(1, Math.round(view.width));
  const h = Math.max(1, Math.round(view.height));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const v = { ...view, width: w, height: h };
  if (!stft) {
    ctx2d?.clearRect(0, 0, w, h);
    return;
  }
  if (gpuRenderer && usableGpu()) {
    if (!stft.gpu && !stft.display && stft.cpu) stft.display = usableGpu()!.spectral.uploadValues(stft.cpu);
    const buffer = stft.gpu?.buffer ?? stft.display;
    if (buffer) gpuRenderer.render(buffer, stft.meta.grid, v, scale);
    return;
  }
  if (!ctx2d) return;
  let values: ArrayLike<number> | null = stft.cpu;
  if (!values && stft.gpu && usableGpu()) {
    stft.readback ??= await usableGpu()!.spectral.read(stft.gpu);
    values = stft.readback;
  }
  if (!values) return;
  const pixels = renderHeatmap(values, stft.meta.grid, v, scale);
  ctx2d.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
}

async function probeStft(timeSec: number, frequencyHz: number) {
  if (!stft) return null;
  const cell = cellAt(stft.meta.grid, timeSec, frequencyHz);
  if (!cell) return null;
  const index = cell.frame * stft.meta.grid.bins + cell.bin;
  let value: number;
  if (stft.cpu) value = stft.cpu[index];
  else if (stft.readback) value = stft.readback[index];
  else if (stft.gpu && usableGpu()) value = (await usableGpu()!.spectral.read(stft.gpu, index, 1))[0];
  else return null;
  const r = requireRecord();
  // Frame p is centred at t_p and covers the samples [t_p - L/(2 fs), t_p + L/(2 fs)).
  const centre = stft.meta.grid.firstTimeSec + cell.frame * stft.meta.grid.hopSec;
  const half = stft.meta.windowLength / 2 / r.sampleRateHz;
  return {
    frame: cell.frame,
    bin: cell.bin,
    timeSec: centre,
    frequencyHz: cell.bin * stft.meta.grid.binWidthHz,
    value,
    windowStartSec: centre - half,
    windowEndSec: centre + half,
  };
}

/** Frequencies strictly inside (0, fs/2): log-spaced over five decades, or linear from 0. */
function responseGrid(scale: "log" | "linear", points: number): Float64Array {
  const r = requireRecord();
  const nyquist = r.sampleRateHz / 2;
  const n = Math.max(16, Math.min(8192, Math.round(points)));
  const f = new Float64Array(n);
  if (scale === "linear") for (let i = 0; i < n; i++) f[i] = (nyquist * i) / n;
  else {
    const lo = Math.log10(nyquist * 1e-5);
    const hi = Math.log10(nyquist * (1 - 1e-6));
    for (let i = 0; i < n; i++) f[i] = 10 ** (lo + ((hi - lo) * i) / (n - 1));
  }
  return f;
}

function filterResponse(scale: "log" | "linear", points: number): FilterResponse {
  const frequencies = responseGrid(scale, points);
  const n = frequencies.length;
  const combinedMag = new Float64Array(n).fill(1);
  let combinedPhase: Float64Array | null = new Float64Array(n);
  let combinedDelay: Float64Array | null = new Float64Array(n);
  const steps: FilterResponse["steps"] = [];
  for (const s of chain.applied) {
    if (!s.design) continue;
    const step = chain.steps[s.index];
    if (step.kind !== "filter") continue;
    const h = designResponse(s.design, frequencies);
    const magnitude = new Float64Array(n);
    for (let i = 0; i < n; i++) magnitude[i] = Math.hypot(h.re[i], h.im[i]);
    let phaseDeg: Float64Array | null = null;
    let groupDelaySamples: Float64Array | null = null;
    if (step.mode === "zero-phase") {
      for (let i = 0; i < n; i++) magnitude[i] *= magnitude[i];
    } else {
      const phase = new Float64Array(n);
      for (let i = 0; i < n; i++) phase[i] = Math.atan2(h.im[i], h.re[i]);
      phaseDeg = unwrapPhase(phase).map((p) => (p * 180) / Math.PI);
      groupDelaySamples = designGroupDelay(s.design, frequencies);
    }
    for (let i = 0; i < n; i++) {
      combinedMag[i] *= magnitude[i];
      if (combinedPhase) combinedPhase[i] += phaseDeg ? phaseDeg[i] : 0;
      if (combinedDelay) combinedDelay[i] += groupDelaySamples ? groupDelaySamples[i] : 0;
    }
    steps.push({ index: s.index, description: s.description, magnitude, phaseDeg, groupDelaySamples });
  }
  if (!steps.some((s) => s.phaseDeg)) {
    combinedPhase = null;
    combinedDelay = null;
  }
  return { frequencies, steps, combined: { magnitude: combinedMag, phaseDeg: combinedPhase, groupDelaySamples: combinedDelay } };
}

function rows(start: number, count: number): RowsResult {
  const r = requireRecord();
  const s = Math.max(0, Math.min(r.samples, start));
  const e = Math.min(r.samples, s + Math.max(0, count));
  const times = new Float64Array(e - s);
  for (let i = s; i < e; i++) times[i - s] = r.times ? r.times[i] : r.startSec + i / r.sampleRateHz;
  const columns: RowsResult["columns"] = [];
  for (const id of r.ids) columns.push({ label: `${r.labels.get(id)} (raw)`, values: r.raw.get(id)!.slice(s, e) });
  if (chain.steps.some((st) => st.enabled)) {
    for (const id of r.ids) columns.push({ label: `${r.labels.get(id)} (processed)`, values: r.processed.get(id)!.slice(s, e) });
  }
  return { start: s, times, columns };
}

function formatValue(v: number): string {
  return Number.isFinite(v) ? String(v) : "";
}

async function exportCsv(job: Job, what: string, interval: Interval): Promise<string> {
  const r = requireRecord();
  if (what === "stft-csv") {
    if (!stft) throw new WaveBenchError("NO_RESULT", "compute a spectrogram first");
    const { grid } = stft.meta;
    const values: ArrayLike<number> = stft.cpu ?? stft.readback ?? (stft.gpu && usableGpu() ? await usableGpu()!.spectral.read(stft.gpu) : []);
    const head = ["time_s"];
    for (let k = 0; k < grid.bins; k++) head.push(`${formatValue(k * grid.binWidthHz)}_Hz`);
    const lines = [head.join(",")];
    for (let p = 0; p < grid.frames; p++) {
      const row = [formatValue(grid.firstTimeSec + p * grid.hopSec)];
      for (let k = 0; k < grid.bins; k++) row.push(stft.cpu ? formatValue(values[p * grid.bins + k]) : formatValue(Number((values[p * grid.bins + k]).toPrecision(9))));
      lines.push(row.join(","));
      if (p % 256 === 0) {
        job.progress(p / grid.frames, "Writing");
        await tick();
      }
    }
    return lines.join("\n") + "\n";
  }
  checkInterval(r, interval);
  const map = what === "raw-csv" ? r.raw : r.processed;
  const unit = unitDef(r.config.displayUnit).ascii;
  const head = ["time_s", ...r.ids.map((id) => csvText(`${r.labels.get(id)}_${unit}`))];
  const lines = [head.join(",")];
  for (let i = interval.start; i < interval.end; i++) {
    const t = r.times ? r.times[i] : r.startSec + i / r.sampleRateHz;
    const row = [formatValue(t)];
    for (const id of r.ids) row.push(formatValue(map.get(id)![i]));
    lines.push(row.join(","));
    if ((i - interval.start) % 65536 === 0) {
      job.progress((i - interval.start) / (interval.end - interval.start), "Writing");
      await tick();
      job.check();
    }
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------------------------------------------
// Dispatch

const SUPERSEDE = new Set(["timeView", "stats", "spectrum", "welch", "stft", "probeStft", "rows"]);

async function handle(id: number, req: Request): Promise<{ result: unknown; transfer?: Transferable[] }> {
  const job = new Job(id);
  switch (req.type) {
    case "sniff":
      return { result: await sniff(req) };
    case "load":
      return { result: await load(job, req) };
    case "generate":
      return { result: generate(req) };
    case "configure":
      return { result: configure(req.config) };
    case "process":
      return { result: processChain(req.steps) };
    case "timeView": {
      const v = timeView(req);
      return { result: v, transfer: [v.x.buffer, v.index.buffer, ...v.values.map((a) => a.buffer)] };
    }
    case "stats":
      return { result: stats(req) };
    case "spectrum": {
      const s = await spectrum(job, req);
      return { result: s, transfer: s.channels.flatMap((c) => [c.re.buffer, c.im.buffer]) };
    }
    case "welch": {
      const w = await welch(job, req);
      return { result: w, transfer: w.channels.map((c) => c.psd.buffer) };
    }
    case "stft":
      return { result: await computeStft(job, req) };
    case "attachCanvas":
      return { result: attachCanvas(req.canvas) };
    case "renderStft":
      await renderStft(req.view, req.scale);
      return { result: null };
    case "probeStft":
      return { result: await probeStft(req.timeSec, req.frequencyHz) };
    case "stftImage": {
      const bitmap = await stftImage(req.width, req.height);
      return { result: bitmap, transfer: bitmap ? [bitmap] : [] };
    }
    case "filterResponse":
      return { result: filterResponse(req.scale, req.points) };
    case "rows":
      return { result: rows(req.start, req.count) };
    case "export":
      return { result: await exportCsv(job, req.what, req.interval) };
    case "gpuStatus":
      return { result: await ensureGpu() };
    case "gpuSelfTest": {
      await ensureGpu();
      const g = usableGpu();
      if (!g) throw new WaveBenchError("NO_GPU", gpuStatus?.reason ?? "WebGPU is not available");
      const rowsOut = await gpuSelfTest(g.spectral, (row) => post({ id, kind: "event", event: row }));
      return { result: rowsOut };
    }
    case "cancel":
      cancelled.add(req.target);
      return { result: null };
  }
}

scope.onmessage = async (e: MessageEvent<Envelope>) => {
  const { id, request } = e.data;
  if (SUPERSEDE.has(request.type)) {
    const previous = latest.get(request.type);
    if (previous !== undefined) cancelled.add(previous);
    latest.set(request.type, id);
  }
  try {
    const { result, transfer } = await handle(id, request);
    post({ id, kind: "done", result }, transfer ?? []);
  } catch (err) {
    const error = err as WaveBenchError;
    post({ id, kind: "error", code: error.code ?? "ERROR", message: error.message ?? String(err) });
  } finally {
    cancelled.delete(id);
    if (latest.get(request.type) === id) latest.delete(request.type);
  }
};
