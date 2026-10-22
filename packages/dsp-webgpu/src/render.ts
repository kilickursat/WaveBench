import { cellCoordinates, colormapRgba, type ColorScale, type HeatmapGrid, type HeatmapView } from "@wavebench/plots";
import type { GpuContext } from "./device";
import { RENDER_WGSL } from "./shaders";

/** Draws a spectrogram held in a GPU buffer into a WebGPU canvas; no read-back of the matrix. */
export class GpuHeatmapRenderer {
  private readonly context: GpuContext;
  private readonly canvasContext: GPUCanvasContext;
  private readonly pipeline: GPURenderPipeline;
  private readonly params: GPUBuffer;
  private readonly lut: GPUBuffer;
  private lutName = "";

  private constructor(context: GpuContext, canvasContext: GPUCanvasContext, format: GPUTextureFormat) {
    this.context = context;
    this.canvasContext = canvasContext;
    const { device } = context;
    const module = device.createShaderModule({ code: RENDER_WGSL });
    this.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
    this.params = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.lut = device.createBuffer({ size: 256 * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }

  static create(context: GpuContext, canvas: OffscreenCanvas | HTMLCanvasElement, gpu: GPU): GpuHeatmapRenderer | null {
    const ctx = canvas.getContext("webgpu") as GPUCanvasContext | null;
    if (!ctx) return null;
    const format = gpu.getPreferredCanvasFormat();
    ctx.configure({ device: context.device, format, alphaMode: "premultiplied" });
    return new GpuHeatmapRenderer(context, ctx, format);
  }

  render(cells: GPUBuffer, grid: HeatmapGrid, view: HeatmapView, scale: ColorScale): void {
    if (this.context.lost) return;
    const { device } = this.context;
    if (this.lutName !== scale.colormap) {
      const rgba = colormapRgba(scale.colormap);
      const lut = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) lut[i] = rgba[i] / 255;
      device.queue.writeBuffer(this.lut, 0, lut);
      this.lutName = scale.colormap;
    }
    const { u0, u1, v0, v1 } = cellCoordinates(grid, view);
    const buf = new ArrayBuffer(48);
    const f = new Float32Array(buf);
    const u = new Uint32Array(buf);
    f[0] = u0;
    f[1] = (u1 - u0) / view.width;
    f[2] = v1;
    f[3] = (v1 - v0) / view.height;
    u[4] = grid.frames;
    u[5] = grid.bins;
    u[6] = scale.mode === "db" ? 1 : 0;
    f[8] = scale.dbFactor;
    f[9] = 1 / scale.reference;
    f[10] = scale.lo;
    f[11] = 1 / (scale.hi - scale.lo);
    device.queue.writeBuffer(this.params, 0, buf);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: this.canvasContext.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.params } },
        { binding: 1, resource: { buffer: cells } },
        { binding: 2, resource: { buffer: this.lut } },
      ],
    }));
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    this.params.destroy();
    this.lut.destroy();
  }
}
