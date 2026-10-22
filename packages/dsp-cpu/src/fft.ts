// Float64 discrete Fourier transforms. Convention (numpy.fft): X[k] = sum_n x[n] exp(-2 pi i k n / N), no scaling
// on the forward transform, 1/N on the inverse. Any N >= 1 is exact: powers of two use an iterative radix-2
// transform, other lengths Bluestein's chirp-z identity on a power-of-two convolution.
import { WaveBenchError } from "@wavebench/core";

export const MAX_FFT_LENGTH = 1 << 26;

export function isPowerOfTwo(n: number): boolean {
  return Number.isSafeInteger(n) && n > 0 && (n & (n - 1)) === 0 && n <= 1 << 30;
}

export function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * cos and sin of 2 pi j / n. For n divisible by 4 the angle is folded into the first octant with exact
 * identities, so that e.g. j = n/4 gives exactly (0, 1) and conjugate symmetry holds bit for bit.
 */
export function unitRoot(j: number, n: number): [number, number] {
  let k = j % n;
  if (k < 0) k += n;
  if (n % 4 === 0) {
    if (k > n / 2) {
      const [c, s] = unitRoot(n - k, n);
      return [c, -s];
    }
    if (k > n / 4) {
      const [c, s] = unitRoot(n / 2 - k, n);
      return [-c, s];
    }
    if (8 * k > n) {
      const [c, s] = unitRoot(n / 4 - k, n);
      return [s, c];
    }
  }
  const a = (2 * Math.PI * k) / n;
  return [Math.cos(a), Math.sin(a)];
}

interface ComplexPlan {
  readonly n: number;
  /** In place; inverse is unscaled. */
  transform(re: Float64Array, im: Float64Array, inverse: boolean): void;
}

class Radix2Plan implements ComplexPlan {
  readonly n: number;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly rev: Uint32Array;

  constructor(n: number) {
    this.n = n;
    const half = Math.max(1, n >> 1);
    this.cos = new Float64Array(half);
    this.sin = new Float64Array(half);
    for (let j = 0; j < half; j++) [this.cos[j], this.sin[j]] = unitRoot(j, n);
    this.rev = new Uint32Array(n);
    const bits = Math.round(Math.log2(n));
    for (let i = 1; i < n; i++) this.rev[i] = (this.rev[i >> 1] >> 1) | ((i & 1) << (bits - 1));
  }

  transform(re: Float64Array, im: Float64Array, inverse: boolean): void {
    const { n, cos, sin, rev } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
        const ti = im[i];
        im[i] = im[j];
        im[j] = ti;
      }
    }
    const sign = inverse ? 1 : -1;
    for (let size = 2; size <= n; size *= 2) {
      const half = size >> 1;
      const step = n / size;
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step];
        const wi = sign * sin[k * step];
        for (let a = k; a < n; a += size) {
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}

/** X[k] = w[k] sum_j (x[j] w[j]) conj(w[k-j]), w[j] = exp(-i pi j^2 / n), evaluated as a circular convolution. */
class BluesteinPlan implements ComplexPlan {
  readonly n: number;
  private readonly m: number;
  private readonly inner: Radix2Plan;
  private readonly wRe: Float64Array;
  private readonly wIm: Float64Array;
  private readonly bRe: Float64Array;
  private readonly bIm: Float64Array;
  private readonly aRe: Float64Array;
  private readonly aIm: Float64Array;

  constructor(n: number) {
    this.n = n;
    this.m = nextPowerOfTwo(2 * n - 1);
    this.inner = new Radix2Plan(this.m);
    this.wRe = new Float64Array(n);
    this.wIm = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      // j^2 is exact below 2^26.5; reduce modulo 2n before forming the angle pi j^2 / n.
      const q = (j * j) % (2 * n);
      const [c, s] = unitRoot(q, 2 * n);
      this.wRe[j] = c;
      this.wIm[j] = -s;
    }
    this.bRe = new Float64Array(this.m);
    this.bIm = new Float64Array(this.m);
    this.bRe[0] = this.wRe[0];
    this.bIm[0] = -this.wIm[0];
    for (let j = 1; j < n; j++) {
      this.bRe[j] = this.bRe[this.m - j] = this.wRe[j];
      this.bIm[j] = this.bIm[this.m - j] = -this.wIm[j];
    }
    this.inner.transform(this.bRe, this.bIm, false);
    this.aRe = new Float64Array(this.m);
    this.aIm = new Float64Array(this.m);
  }

  transform(re: Float64Array, im: Float64Array, inverse: boolean): void {
    const { n, m, wRe, wIm, bRe, bIm, aRe, aIm } = this;
    // The inverse uses conj(F(conj(x))).
    const s = inverse ? -1 : 1;
    for (let j = 0; j < n; j++) {
      const xr = re[j];
      const xi = s * im[j];
      aRe[j] = xr * wRe[j] - xi * wIm[j];
      aIm[j] = xr * wIm[j] + xi * wRe[j];
    }
    aRe.fill(0, n);
    aIm.fill(0, n);
    this.inner.transform(aRe, aIm, false);
    for (let k = 0; k < m; k++) {
      const r = aRe[k] * bRe[k] - aIm[k] * bIm[k];
      const i = aRe[k] * bIm[k] + aIm[k] * bRe[k];
      aRe[k] = r;
      aIm[k] = i;
    }
    this.inner.transform(aRe, aIm, true);
    const scale = 1 / m;
    for (let k = 0; k < n; k++) {
      const cr = aRe[k] * scale;
      const ci = aIm[k] * scale;
      re[k] = cr * wRe[k] - ci * wIm[k];
      im[k] = s * (cr * wIm[k] + ci * wRe[k]);
    }
  }
}

const complexPlans = new Map<number, ComplexPlan>();

function complexPlan(n: number): ComplexPlan {
  if (!Number.isSafeInteger(n) || n < 1) throw new WaveBenchError("INVALID_ARGUMENT", `FFT length must be a positive integer (got ${n})`);
  if (n > MAX_FFT_LENGTH) throw new WaveBenchError("FFT_TOO_LONG", `FFT length ${n} exceeds the supported maximum ${MAX_FFT_LENGTH}`);
  let plan = complexPlans.get(n);
  if (!plan) {
    plan = isPowerOfTwo(n) ? new Radix2Plan(n) : new BluesteinPlan(n);
    if (complexPlans.size > 64) complexPlans.clear();
    complexPlans.set(n, plan);
  }
  return plan;
}

/** In-place forward DFT of any length. */
export function fft(re: Float64Array, im: Float64Array): void {
  if (re.length !== im.length) throw new WaveBenchError("INVALID_ARGUMENT", "real and imaginary parts differ in length");
  complexPlan(re.length).transform(re, im, false);
}

/** In-place inverse DFT of any length, scaled by 1/N. */
export function ifft(re: Float64Array, im: Float64Array): void {
  if (re.length !== im.length) throw new WaveBenchError("INVALID_ARGUMENT", "real and imaginary parts differ in length");
  const n = re.length;
  complexPlan(n).transform(re, im, true);
  for (let i = 0; i < n; i++) {
    re[i] /= n;
    im[i] /= n;
  }
}

/** Real-input transform of length M, returning bins k = 0..floor(M/2). */
export class RealFFT {
  readonly n: number;
  readonly bins: number;
  private readonly half: ComplexPlan | null;
  private readonly full: ComplexPlan | null;
  private readonly zr: Float64Array;
  private readonly zi: Float64Array;
  private readonly twRe: Float64Array;
  private readonly twIm: Float64Array;

  constructor(n: number) {
    this.n = n;
    this.bins = Math.floor(n / 2) + 1;
    if (n % 2 === 0) {
      const h = n / 2;
      this.half = complexPlan(h);
      this.full = null;
      this.zr = new Float64Array(h);
      this.zi = new Float64Array(h);
      this.twRe = new Float64Array(h);
      this.twIm = new Float64Array(h);
      for (let k = 0; k < h; k++) {
        const [c, s] = unitRoot(k, n);
        this.twRe[k] = c;
        this.twIm[k] = -s;
      }
    } else {
      this.half = null;
      this.full = complexPlan(n);
      this.zr = new Float64Array(n);
      this.zi = new Float64Array(n);
      this.twRe = this.twIm = new Float64Array(0);
    }
  }

  /** x holds `length` samples starting at `offset` (length <= n); the rest of the frame is zero. */
  forward(x: ArrayLike<number>, re: Float64Array, im: Float64Array, offset = 0, length = this.n): void {
    const { n, zr, zi } = this;
    if (length > n) throw new WaveBenchError("FFT_TOO_SHORT", `FFT length ${n} is shorter than the segment (${length}); it would truncate data`);
    if (this.full) {
      for (let j = 0; j < n; j++) {
        zr[j] = j < length ? x[offset + j] : 0;
        zi[j] = 0;
      }
      this.full.transform(zr, zi, false);
      for (let k = 0; k < this.bins; k++) {
        re[k] = zr[k];
        im[k] = zi[k];
      }
      return;
    }
    const h = n / 2;
    for (let m = 0; m < h; m++) {
      const e = 2 * m;
      zr[m] = e < length ? x[offset + e] : 0;
      zi[m] = e + 1 < length ? x[offset + e + 1] : 0;
    }
    this.half!.transform(zr, zi, false);
    const { twRe, twIm } = this;
    for (let k = 0; k <= h; k++) {
      const k1 = k === h ? 0 : k;
      const k2 = k === 0 ? 0 : h - k;
      const ar = zr[k1];
      const ai = zi[k1];
      const br = zr[k2];
      const bi = -zi[k2];
      // Even part E = (Z[k] + conj Z[h-k]) / 2, odd part O = (Z[k] - conj Z[h-k]) / 2i.
      const er = (ar + br) / 2;
      const ei = (ai + bi) / 2;
      const or = (ai - bi) / 2;
      const oi = -(ar - br) / 2;
      const wr = k === h ? -1 : twRe[k];
      const wi = k === h ? 0 : twIm[k];
      re[k] = er + (or * wr - oi * wi);
      im[k] = ei + (or * wi + oi * wr);
    }
  }
}

const realPlans = new Map<number, RealFFT>();

export function realFFT(n: number): RealFFT {
  let plan = realPlans.get(n);
  if (!plan) {
    plan = new RealFFT(n);
    if (realPlans.size > 64) realPlans.clear();
    realPlans.set(n, plan);
  }
  return plan;
}

/** One-sided transform of a real sequence, zero-padded to nfft (never truncated). */
export function rfft(x: ArrayLike<number>, nfft = x.length): { re: Float64Array; im: Float64Array } {
  const plan = realFFT(nfft);
  const re = new Float64Array(plan.bins);
  const im = new Float64Array(plan.bins);
  plan.forward(x, re, im, 0, x.length);
  return { re, im };
}
