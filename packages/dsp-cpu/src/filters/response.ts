import { WaveBenchError } from "@wavebench/core";
import { sosfilt } from "./sos";
import type { Complex } from "./complex";

/**
 * H(e^{iw}) = k prod(e^{iw} - z_i) / prod(e^{iw} - p_i) from the design's roots (z-domain form, as many zeros as
 * poles, as every design here has). Near the unit circle this keeps accuracy where the polynomial form of a section
 * cancels: the relative error grows like eps / delta instead of eps / delta^2, delta = 1 - |p|.
 */
export function zpkResponse(
  zeros: Complex[],
  poles: Complex[],
  gain: number,
  frequenciesHz: ArrayLike<number>,
  sampleRateHz: number,
): { re: Float64Array; im: Float64Array } {
  if (zeros.length !== poles.length) throw new WaveBenchError("INVALID_ARGUMENT", "zero-pole form needs as many zeros as poles");
  const n = frequenciesHz.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const w = (2 * Math.PI * frequenciesHz[i]) / sampleRateHz;
    const c = Math.cos(w);
    const s = Math.sin(w);
    let hr = gain;
    let hi = 0;
    for (let j = 0; j < poles.length; j++) {
      // multiply by (e^{iw} - z) / (e^{iw} - p)
      const nr = c - zeros[j].re;
      const ni = s - zeros[j].im;
      const dr = c - poles[j].re;
      const di = s - poles[j].im;
      const d = dr * dr + di * di;
      const qr = (nr * dr + ni * di) / d;
      const qi = (ni * dr - nr * di) / d;
      const tr = hr * qr - hi * qi;
      hi = hr * qi + hi * qr;
      hr = tr;
    }
    re[i] = hr;
    im[i] = hi;
  }
  return { re, im };
}

/**
 * Group delay in samples from the roots: sum_p Re(e^{iw}/(e^{iw}-p)) - sum_z Re(e^{iw}/(e^{iw}-z)). NaN where
 * the frequency hits a zero on the unit circle (the phase jumps there).
 */
export function zpkGroupDelay(zeros: Complex[], poles: Complex[], frequenciesHz: ArrayLike<number>, sampleRateHz: number): Float64Array {
  const out = new Float64Array(frequenciesHz.length);
  for (let i = 0; i < out.length; i++) {
    const w = (2 * Math.PI * frequenciesHz[i]) / sampleRateHz;
    const c = Math.cos(w);
    const s = Math.sin(w);
    const term = (r: Complex) => {
      const ar = c - r.re;
      const ai = s - r.im;
      const d = ar * ar + ai * ai;
      return d > 1e-24 ? (c * ar + s * ai) / d : NaN;
    };
    let tau = 0;
    for (const p of poles) tau += term(p);
    for (const z of zeros) tau -= term(z);
    out[i] = tau;
  }
  return out;
}

/** H(exp(i w)) of the cascade at frequencies in Hz, w = 2 pi f / fs. */
export function sosResponse(sos: Float64Array, frequenciesHz: ArrayLike<number>, sampleRateHz: number): { re: Float64Array; im: Float64Array } {
  const n = frequenciesHz.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const ns = sos.length / 6;
  for (let i = 0; i < n; i++) {
    const w = (2 * Math.PI * frequenciesHz[i]) / sampleRateHz;
    const c1 = Math.cos(w);
    const s1 = -Math.sin(w);
    const c2 = Math.cos(2 * w);
    const s2 = -Math.sin(2 * w);
    let hr = 1;
    let hi = 0;
    for (let s = 0; s < ns; s++) {
      const o = 6 * s;
      const br = sos[o] + sos[o + 1] * c1 + sos[o + 2] * c2;
      const bi = sos[o + 1] * s1 + sos[o + 2] * s2;
      const ar = sos[o + 3] + sos[o + 4] * c1 + sos[o + 5] * c2;
      const ai = sos[o + 4] * s1 + sos[o + 5] * s2;
      // h *= b / a
      const d = ar * ar + ai * ai;
      const qr = (br * ar + bi * ai) / d;
      const qi = (bi * ar - br * ai) / d;
      const tr = hr * qr - hi * qi;
      hi = hr * qi + hi * qr;
      hr = tr;
    }
    re[i] = hr;
    im[i] = hi;
  }
  return { re, im };
}

/** Phase unwrapped along the frequency axis (radians). NaN entries are skipped. */
export function unwrapPhase(phase: Float64Array): Float64Array {
  const out = Float64Array.from(phase);
  let offset = 0;
  let prev = NaN;
  for (let i = 0; i < out.length; i++) {
    if (Number.isNaN(phase[i])) continue;
    if (!Number.isNaN(prev)) {
      let d = phase[i] - prev;
      while (d > Math.PI) {
        offset -= 2 * Math.PI;
        d -= 2 * Math.PI;
      }
      while (d < -Math.PI) {
        offset += 2 * Math.PI;
        d += 2 * Math.PI;
      }
    }
    prev = phase[i];
    out[i] = phase[i] + offset;
  }
  return out;
}

/**
 * Group delay -d(phase)/dw in samples, from tau = Re(sum k c_k e^{-iwk} / sum c_k e^{-iwk}) per polynomial
 * (numerator minus denominator, summed over sections). NaN where a numerator vanishes (a zero on the unit circle).
 */
export function sosGroupDelay(sos: Float64Array, frequenciesHz: ArrayLike<number>, sampleRateHz: number): Float64Array {
  const n = frequenciesHz.length;
  const out = new Float64Array(n);
  const ns = sos.length / 6;
  const term = (c0: number, c1: number, c2: number, w: number) => {
    const cr = c0 + c1 * Math.cos(w) + c2 * Math.cos(2 * w);
    const ci = -(c1 * Math.sin(w) + c2 * Math.sin(2 * w));
    const dr = c1 * Math.cos(w) + 2 * c2 * Math.cos(2 * w);
    const di = -(c1 * Math.sin(w) + 2 * c2 * Math.sin(2 * w));
    const mag2 = cr * cr + ci * ci;
    const scale = c0 * c0 + c1 * c1 + c2 * c2;
    if (mag2 <= 1e-20 * scale) return NaN;
    return (dr * cr + di * ci) / mag2;
  };
  for (let i = 0; i < n; i++) {
    const w = (2 * Math.PI * frequenciesHz[i]) / sampleRateHz;
    let tau = 0;
    for (let s = 0; s < ns; s++) {
      const o = 6 * s;
      tau += term(sos[o], sos[o + 1], sos[o + 2], w) - term(sos[o + 3], sos[o + 4], sos[o + 5], w);
    }
    out[i] = tau;
  }
  return out;
}

/**
 * Number of samples that contain `fraction` of the impulse-response energy of a single pass. Used to mark the
 * stretch at a record edge where filter start-up transients are significant; null when the response has not
 * decayed within maxSamples.
 */
export function impulseEnergyLength(sos: Float64Array, fraction = 0.999, maxSamples = 1 << 22): number | null {
  const block = 4096;
  const ns = sos.length / 6;
  const run = (stopAt: number | null): { total: number; index: number | null; converged: boolean } => {
    let state: Float64Array = new Float64Array(2 * ns);
    let total = 0;
    for (let start = 0; start < maxSamples; start += block) {
      const x = new Float64Array(block);
      if (start === 0) x[0] = 1;
      const { y, zf } = sosfilt(sos, x, state);
      state = zf;
      let blockEnergy = 0;
      for (let i = 0; i < block; i++) {
        const e = y[i] * y[i];
        blockEnergy += e;
        if (stopAt !== null && total + blockEnergy >= stopAt) return { total, index: start + i + 1, converged: true };
      }
      total += blockEnergy;
      if (stopAt === null && start > 0 && blockEnergy <= 1e-13 * total) return { total, index: null, converged: true };
    }
    return { total, index: null, converged: false };
  };
  const first = run(null);
  if (!first.converged || !(first.total > 0)) return null;
  return run(fraction * first.total).index;
}
