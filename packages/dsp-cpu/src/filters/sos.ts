// Cascaded second-order sections in direct form II transposed, with the same operations and order as
// scipy.signal.sosfilt; forward-backward filtering as scipy.signal.sosfiltfilt (method "pad").
import { WaveBenchError } from "@wavebench/core";

function sectionsOf(sos: Float64Array): number {
  if (sos.length === 0 || sos.length % 6 !== 0) throw new WaveBenchError("INVALID_ARGUMENT", "SOS array must have 6 values per section");
  const n = sos.length / 6;
  for (let s = 0; s < n; s++) {
    if (sos[6 * s + 3] !== 1) throw new WaveBenchError("INVALID_ARGUMENT", "each section must be normalised so that a0 = 1");
  }
  return n;
}

/**
 * Filter x through all sections. zi holds two state values per section (zero when omitted); the final state is
 * returned so that a causal filter can continue on the next block of the same record.
 */
export function sosfilt(sos: Float64Array, x: ArrayLike<number>, zi?: Float64Array): { y: Float64Array; zf: Float64Array } {
  const ns = sectionsOf(sos);
  const y = Float64Array.from(x);
  const zf = new Float64Array(2 * ns);
  for (let s = 0; s < ns; s++) {
    const o = 6 * s;
    const b0 = sos[o];
    const b1 = sos[o + 1];
    const b2 = sos[o + 2];
    const a1 = sos[o + 4];
    const a2 = sos[o + 5];
    let z0 = zi ? zi[2 * s] : 0;
    let z1 = zi ? zi[2 * s + 1] : 0;
    for (let n = 0; n < y.length; n++) {
      const xn = y[n];
      const yn = b0 * xn + z0;
      z0 = b1 * xn - a1 * yn + z1;
      z1 = b2 * xn - a2 * yn;
      y[n] = yn;
    }
    zf[2 * s] = z0;
    zf[2 * s + 1] = z1;
  }
  return { y, zf };
}

/** Initial state for a unit step in steady state (scipy.signal.sosfilt_zi); scale by the first sample. */
export function sosfiltZi(sos: Float64Array): Float64Array {
  const ns = sectionsOf(sos);
  const zi = new Float64Array(2 * ns);
  let scale = 1;
  for (let s = 0; s < ns; s++) {
    const [b0, b1, b2, , a1, a2] = sos.subarray(6 * s, 6 * s + 6);
    // (I - A^T) z = B - a b0 with the companion matrix of [1, a1, a2] (lfilter_zi): solve the 2 x 2 system.
    const m00 = 1 + a1;
    const m01 = -1;
    const m10 = a2;
    const m11 = 1;
    const r0 = b1 - a1 * b0;
    const r1 = b2 - a2 * b0;
    const det = m00 * m11 - m01 * m10;
    if (det === 0) throw new WaveBenchError("SINGULAR_FILTER", "a section has a pole at z = 1; no steady state exists");
    zi[2 * s] = (scale * (r0 * m11 - m01 * r1)) / det;
    zi[2 * s + 1] = (scale * (m00 * r1 - m10 * r0)) / det;
    scale *= (b0 + b1 + b2) / (1 + a1 + a2);
  }
  return zi;
}

export type PadType = "odd" | "even" | "constant" | "none";

/** SciPy's default edge length: 3 * (2 * sections + 1 - min(#(b2 == 0), #(a2 == 0))). */
export function defaultPadLength(sos: Float64Array): number {
  const ns = sectionsOf(sos);
  let b2zero = 0;
  let a2zero = 0;
  for (let s = 0; s < ns; s++) {
    if (sos[6 * s + 2] === 0) b2zero++;
    if (sos[6 * s + 5] === 0) a2zero++;
  }
  return 3 * (2 * ns + 1 - Math.min(b2zero, a2zero));
}

function extend(x: ArrayLike<number>, n: number, padtype: PadType): Float64Array {
  const len = x.length;
  const out = new Float64Array(len + 2 * n);
  for (let i = 0; i < len; i++) out[n + i] = x[i];
  for (let i = 1; i <= n; i++) {
    const left = x[i];
    const right = x[len - 1 - i];
    if (padtype === "odd") {
      out[n - i] = 2 * x[0] - left;
      out[n + len - 1 + i] = 2 * x[len - 1] - right;
    } else if (padtype === "even") {
      out[n - i] = left;
      out[n + len - 1 + i] = right;
    } else {
      out[n - i] = x[0];
      out[n + len - 1 + i] = x[len - 1];
    }
  }
  return out;
}

/**
 * Zero-phase filtering: forward pass, then backward pass, each started from the steady state of its first sample,
 * on a signal extended by `padlen` samples at both ends. The magnitude response is |H|^2 and the phase is zero.
 * This is an offline method: it needs the whole contiguous record.
 */
export function sosfiltfilt(sos: Float64Array, x: ArrayLike<number>, padtype: PadType = "odd", padlen?: number): Float64Array {
  const edge = padtype === "none" ? 0 : padlen ?? defaultPadLength(sos);
  if (!Number.isSafeInteger(edge) || edge < 0) throw new WaveBenchError("INVALID_ARGUMENT", "padding length must be a non-negative integer");
  if (x.length <= edge) {
    throw new WaveBenchError(
      "SIGNAL_TOO_SHORT",
      `zero-phase filtering needs more than ${edge} samples (the edge padding); the record has ${x.length}`,
    );
  }
  const ext = edge > 0 ? extend(x, edge, padtype) : Float64Array.from(x);
  const zi = sosfiltZi(sos);
  const forward = sosfilt(sos, ext, scaled(zi, ext[0])).y;
  forward.reverse();
  const backward = sosfilt(sos, forward, scaled(zi, forward[0])).y;
  backward.reverse();
  return edge > 0 ? backward.slice(edge, backward.length - edge) : backward;
}

function scaled(zi: Float64Array, v: number): Float64Array {
  const out = new Float64Array(zi.length);
  for (let i = 0; i < zi.length; i++) out[i] = zi[i] * v;
  return out;
}
