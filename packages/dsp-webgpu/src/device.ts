import { WaveBenchError } from "@wavebench/core";

export interface GpuInfo {
  vendor: string;
  architecture: string;
  description: string;
  /** A software or CPU-backed adapter (e.g. SwiftShader): correct, but not fast. */
  fallback: boolean;
  maxStorageBufferBindingSize: number;
  maxBufferSize: number;
}

export interface GpuContext {
  device: GPUDevice;
  info: GpuInfo;
  /** Set when the device is lost; the engine then refuses work and the caller falls back to the CPU. */
  lost: { reason: string } | null;
}

/** Largest single buffer requested from the adapter, whatever it offers. */
const BUFFER_CAP = 1 << 30;

export type GpuStatus = { ok: true; context: GpuContext } | { ok: false; reason: string };

export async function requestGpu(gpu: GPU | undefined = (globalThis.navigator as Navigator | undefined)?.gpu): Promise<GpuStatus> {
  if (!gpu) return { ok: false, reason: "this browser does not expose WebGPU here" };
  let adapter: GPUAdapter | null;
  try {
    adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  } catch (e) {
    return { ok: false, reason: `the adapter request failed: ${(e as Error).message}` };
  }
  if (!adapter) return { ok: false, reason: "no WebGPU adapter is available (GPU blocked, disabled or unsupported)" };
  const limits = adapter.limits;
  const maxStorage = Math.min(limits.maxStorageBufferBindingSize, BUFFER_CAP);
  const maxBuffer = Math.min(limits.maxBufferSize, BUFFER_CAP);
  let device: GPUDevice;
  try {
    device = await adapter.requestDevice({
      requiredLimits: { maxStorageBufferBindingSize: maxStorage, maxBufferSize: maxBuffer },
    });
  } catch (e) {
    return { ok: false, reason: `the device request failed: ${(e as Error).message}` };
  }
  const a = adapter as GPUAdapter & { info?: GPUAdapterInfo; isFallbackAdapter?: boolean };
  const info = a.info;
  const context: GpuContext = {
    device,
    lost: null,
    info: {
      vendor: info?.vendor || "unknown vendor",
      architecture: info?.architecture || "",
      description: info?.description || "",
      fallback: !!(a.isFallbackAdapter ?? (info as { isFallbackAdapter?: boolean } | undefined)?.isFallbackAdapter),
      maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
      maxBufferSize: device.limits.maxBufferSize,
    },
  };
  device.lost.then((l) => {
    context.lost = { reason: l.message || l.reason || "device lost" };
  });
  return { ok: true, context };
}

export function describeGpu(info: GpuInfo): string {
  const name = [info.vendor, info.architecture].filter(Boolean).join(" ") || "WebGPU adapter";
  return info.fallback ? `${name} (software adapter)` : name;
}

/** Run allocations or submissions inside error scopes; GPU errors become explicit refusals. */
export async function guarded<T>(context: GpuContext, what: string, work: () => T | Promise<T>): Promise<T> {
  if (context.lost) throw new WaveBenchError("GPU_LOST", `the GPU device was lost (${context.lost.reason}); computing on the CPU instead`);
  const { device } = context;
  device.pushErrorScope("out-of-memory");
  device.pushErrorScope("validation");
  let result: T;
  try {
    result = await work();
  } finally {
    const validation = await device.popErrorScope();
    const oom = await device.popErrorScope();
    if (oom) throw new WaveBenchError("GPU_OUT_OF_MEMORY", `${what}: the GPU ran out of memory`);
    if (validation) throw new WaveBenchError("GPU_ERROR", `${what}: ${validation.message}`);
  }
  return result;
}
