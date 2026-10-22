// Spectral windows as generalised cosine sums, w[n] = sum_k (-1)^k a_k cos(2 pi k n / D), with D = L for the
// periodic (DFT-even) convention used in all spectral analyses and D = L - 1 for the symmetric one. Coefficients
// are those of scipy.signal.windows (flat top: D'Antona & Ferrero, as in SciPy).
import { CompensatedAccumulator, WaveBenchError } from "@wavebench/core";
import { unitRoot } from "./fft";

export type WindowName = "rectangular" | "hann" | "hamming" | "blackman" | "flattop";
export type WindowConvention = "periodic" | "symmetric";

export const WINDOW_COEFFICIENTS: Record<WindowName, readonly number[]> = {
  rectangular: [1],
  hann: [0.5, 0.5],
  hamming: [0.54, 0.46],
  blackman: [0.42, 0.5, 0.08],
  flattop: [0.21557895, 0.41663158, 0.277263158, 0.083578947, 0.006947368],
};

export const WINDOW_LABELS: Record<WindowName, string> = {
  rectangular: "Rectangular",
  hann: "Hann",
  hamming: "Hamming",
  blackman: "Blackman",
  flattop: "Flat top",
};

export function isWindowName(name: string): name is WindowName {
  return name in WINDOW_COEFFICIENTS;
}

const cache = new Map<string, Float64Array>();

/** Window samples; cached per (name, length, convention). Do not modify the returned array. */
export function windowSamples(name: WindowName, length: number, convention: WindowConvention = "periodic"): Float64Array {
  if (!isWindowName(name)) throw new WaveBenchError("INVALID_ARGUMENT", `unknown window "${name}"`);
  if (!Number.isSafeInteger(length) || length < 1) throw new WaveBenchError("INVALID_ARGUMENT", `window length must be a positive integer (got ${length})`);
  const key = `${name}:${length}:${convention}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const w = new Float64Array(length);
  if (length === 1) w[0] = 1;
  else {
    const a = WINDOW_COEFFICIENTS[name];
    const d = convention === "periodic" ? length : length - 1;
    for (let n = 0; n < length; n++) {
      let v = a[0];
      for (let k = 1; k < a.length; k++) {
        // k n is reduced modulo d inside unitRoot, so long windows keep full accuracy.
        const [c] = unitRoot(k * n, d);
        v += (k % 2 ? -1 : 1) * a[k] * c;
      }
      w[n] = v;
    }
  }
  if (cache.size > 128) cache.clear();
  cache.set(key, w);
  return w;
}

export interface WindowMetrics {
  length: number;
  /** sum(w) */
  sum: number;
  /** sum(w^2) */
  energy: number;
  /** sum(w) / L: amplitude of a bin-centred tone after windowing, relative to rectangular. */
  coherentGain: number;
  /** L sum(w^2) / sum(w)^2, in bins. */
  enbwBins: number;
}

export function windowMetrics(w: Float64Array): WindowMetrics {
  const s1 = new CompensatedAccumulator();
  const s2 = new CompensatedAccumulator();
  for (let i = 0; i < w.length; i++) {
    s1.add(w[i]);
    s2.add(w[i] * w[i]);
  }
  const sum = s1.value;
  const energy = s2.value;
  return {
    length: w.length,
    sum,
    energy,
    coherentGain: sum / w.length,
    enbwBins: sum !== 0 ? (w.length * energy) / (sum * sum) : Infinity,
  };
}
