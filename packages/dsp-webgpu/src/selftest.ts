// GPU (Float32) against CPU (Float64, itself checked against SciPy) on deterministic signals. Runs in the app on the
// user's own adapter and in the browser tests. Gate from docs/VALIDATION.md: normalised L2 error <= 1e-4.
import { gaussianSource } from "@wavebench/core";
import { segmentSpectrum, stft, welch, type FrameOptions } from "@wavebench/dsp-cpu";
import type { GpuSpectral } from "./spectral";

export const GPU_GATE = 1e-4;

export interface SelfTestRow {
  check: string;
  size: string;
  error: number;
  gate: number;
  pass: boolean;
  gpuMs: number;
}

function relL2(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let num = 0;
  let den = 0;
  for (let i = 0; i < b.length; i++) {
    num += (a[i] - b[i]) ** 2;
    den += b[i] * b[i];
  }
  return den > 0 ? Math.sqrt(num / den) : Math.sqrt(num);
}

function complexRelL2(re: ArrayLike<number>, im: ArrayLike<number>, eRe: ArrayLike<number>, eIm: ArrayLike<number>): number {
  let num = 0;
  let den = 0;
  for (let i = 0; i < eRe.length; i++) {
    num += (re[i] - eRe[i]) ** 2 + (im[i] - eIm[i]) ** 2;
    den += eRe[i] ** 2 + eIm[i] ** 2;
  }
  return Math.sqrt(num / den);
}

/** Tones + chirp + noise + a 1 g offset, like an accelerometer axis. */
export function testSignal(n: number, fs: number, seed = 1): Float64Array {
  const g = gaussianSource(seed);
  const x = new Float64Array(n);
  const T = (n - 1) / fs;
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    x[i] = 1 + 0.2 * Math.sin(2 * Math.PI * 50 * t) + 0.05 * Math.cos(2 * Math.PI * (20 * t + (0.5 * (0.4 * fs - 20) * t * t) / T)) + 0.003 * g();
  }
  return x;
}

export async function gpuSelfTest(gpu: GpuSpectral, onRow?: (row: SelfTestRow) => void, maxLog2 = 18): Promise<SelfTestRow[]> {
  const rows: SelfTestRow[] = [];
  const push = (row: Omit<SelfTestRow, "gate" | "pass">) => {
    const full = { ...row, gate: GPU_GATE, pass: row.error <= GPU_GATE };
    rows.push(full);
    onRow?.(full);
  };
  const fs = 1000;
  for (let log2 = 1; log2 <= maxLog2; log2++) {
    const m = 2 ** log2;
    const x = testSignal(m, fs, log2);
    const t0 = performance.now();
    const g = await gpu.segment(x, 0, m, fs, { window: "hann", detrend: "none", fftLength: m });
    const ms = performance.now() - t0;
    const c = segmentSpectrum(x, 0, m, fs, { window: "hann", detrend: "none", fftLength: m });
    push({ check: "FFT, Hann, complex spectrum", size: `M = ${m.toLocaleString()}`, error: complexRelL2(g.re, g.im, c.re, c.im), gpuMs: ms });
  }
  const x = testSignal(60_000, fs, 99);
  const cases: [string, FrameOptions, "psd" | "power" | "peak"][] = [
    ["STFT PSD, Hann, linear detrend", { window: "hann", windowLength: 256, hopLength: 64, fftLength: 512, detrend: "linear" }, "psd"],
    ["STFT amplitude, flat top, constant detrend", { window: "flattop", windowLength: 1024, hopLength: 256, fftLength: 1024, detrend: "constant" }, "peak"],
    ["STFT power, Blackman, no detrend", { window: "blackman", windowLength: 2048, hopLength: 2048, fftLength: 4096, detrend: "none" }, "power"],
  ];
  for (const [name, options, q] of cases) {
    const t0 = performance.now();
    const g = await gpu.stft(x, 0, x.length, fs, options, q);
    const values = await gpu.read(g);
    const ms = performance.now() - t0;
    g.buffer.destroy();
    const c = stft(x, fs, options, q);
    push({ check: name, size: `${c.plan.frames} x ${c.plan.bins}`, error: relL2(values, c.values), gpuMs: ms });
  }
  const options: FrameOptions = { window: "hann", windowLength: 4096, hopLength: 2048, fftLength: 4096, detrend: "constant" };
  const t0 = performance.now();
  const g = await gpu.welch(x, 0, x.length, fs, options, "psd");
  const ms = performance.now() - t0;
  const c = welch(x, fs, options, "psd");
  push({ check: "Welch PSD, Hann, 50 % overlap", size: `${c.plan.frames} segments`, error: relL2(g.values, c.values), gpuMs: ms });
  return rows;
}
