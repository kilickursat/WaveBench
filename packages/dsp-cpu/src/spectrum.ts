// One-sided spectrum of one analysis segment (docs/DSP_SPEC.md, "Real FFT and PSD"):
//   X[k]  = sum_{n<L} w[n] u[n] exp(-2 pi i k n / M),  f[k] = k fs / M,  k = 0..floor(M/2)
//   C[k]  = 1 at DC and at Nyquist when M is even, otherwise 2
//   peak  = C |X| / |sum w|           (coherent-gain corrected tone amplitude)
//   rms   = peak / sqrt 2 for interior bins, = peak at DC and the even-M Nyquist bin
//   power = C |X|^2 / (sum w)^2       (= rms^2, unit^2)
//   psd   = C |X|^2 / (fs sum w^2)    (unit^2/Hz)
//   asd   = sqrt(psd)                 (unit/sqrt(Hz))
import { WaveBenchError, assertPositiveFinite, type SpectralQuantity } from "@wavebench/core";
import { detrendInto, type DetrendMode } from "./detrend";
import { nextPowerOfTwo, realFFT } from "./fft";
import { windowMetrics, windowSamples, type WindowName } from "./windows";

export type FftLengthRule = "exact" | "pow2" | number;

export interface SpectrumOptions {
  window: WindowName;
  detrend: DetrendMode;
  /** "exact": M = L; "pow2": next power of two >= L; a number: that M (must be >= L). */
  fftLength: FftLengthRule;
}

export interface SegmentSpectrum {
  sampleRateHz: number;
  segmentLength: number;
  fftLength: number;
  bins: number;
  window: WindowName;
  detrend: DetrendMode;
  re: Float64Array;
  im: Float64Array;
  windowSum: number;
  windowEnergy: number;
  binWidthHz: number;
  /** Equivalent noise bandwidth fs sum(w^2) / sum(w)^2. */
  enbwHz: number;
  coherentGain: number;
}

export function resolveFftLength(rule: FftLengthRule, segmentLength: number): number {
  if (rule === "exact") return segmentLength;
  if (rule === "pow2") return nextPowerOfTwo(segmentLength);
  if (!Number.isSafeInteger(rule) || rule < 1) throw new WaveBenchError("INVALID_ARGUMENT", `FFT length must be a positive integer (got ${rule})`);
  if (rule < segmentLength) {
    throw new WaveBenchError("FFT_TOO_SHORT", `FFT length ${rule} is shorter than the segment (${segmentLength} samples); data would be truncated`);
  }
  return rule;
}

export function oneSidedFactor(k: number, fftLength: number): number {
  return k === 0 || (fftLength % 2 === 0 && k === fftLength / 2) ? 1 : 2;
}

export function frequencies(fftLength: number, sampleRateHz: number): Float64Array {
  const bins = Math.floor(fftLength / 2) + 1;
  const f = new Float64Array(bins);
  for (let k = 0; k < bins; k++) f[k] = (k * sampleRateHz) / fftLength;
  return f;
}

export function assertFiniteSegment(x: ArrayLike<number>, start: number, length: number): void {
  for (let i = start; i < start + length; i++) {
    if (!Number.isFinite(x[i])) {
      throw new WaveBenchError("NONFINITE_INPUT", `sample ${i} is missing or not finite; transforms need complete data`);
    }
  }
}

export function segmentSpectrum(
  x: ArrayLike<number>,
  start: number,
  length: number,
  sampleRateHz: number,
  options: SpectrumOptions,
): SegmentSpectrum {
  assertPositiveFinite(sampleRateHz, "sample rate");
  if (!Number.isSafeInteger(length) || length < 1) throw new WaveBenchError("EMPTY_SELECTION", "the analysis interval has no samples");
  if (start < 0 || start + length > x.length) throw new WaveBenchError("INVALID_ARGUMENT", "segment outside the signal");
  assertFiniteSegment(x, start, length);
  const fftLength = resolveFftLength(options.fftLength, length);
  const w = windowSamples(options.window, length);
  const m = windowMetrics(w);
  if (!(m.energy > 0)) throw new WaveBenchError("ZERO_WINDOW", "the window has zero energy");
  const u = new Float64Array(length);
  detrendInto(x, start, length, options.detrend, u);
  for (let n = 0; n < length; n++) u[n] *= w[n];
  const plan = realFFT(fftLength);
  const re = new Float64Array(plan.bins);
  const im = new Float64Array(plan.bins);
  plan.forward(u, re, im, 0, length);
  return {
    sampleRateHz,
    segmentLength: length,
    fftLength,
    bins: plan.bins,
    window: options.window,
    detrend: options.detrend,
    re,
    im,
    windowSum: m.sum,
    windowEnergy: m.energy,
    binWidthHz: sampleRateHz / fftLength,
    enbwHz: (sampleRateHz * m.energy) / (m.sum * m.sum),
    coherentGain: m.coherentGain,
  };
}

/** Scale factor s and exponent so that value[k] = C[k] |X[k]|^p * s (asd takes a square root afterwards). */
export function quantityScale(q: SpectralQuantity, windowSum: number, windowEnergy: number, sampleRateHz: number): number {
  switch (q) {
    case "peak":
    case "rms":
      if (windowSum === 0) throw new WaveBenchError("ZERO_WINDOW_GAIN", "amplitude scaling needs a window with non-zero coherent gain");
      return 1 / Math.abs(windowSum);
    case "power":
      if (windowSum === 0) throw new WaveBenchError("ZERO_WINDOW_GAIN", "power scaling needs a window with non-zero coherent gain");
      return 1 / (windowSum * windowSum);
    case "psd":
    case "asd":
      return 1 / (sampleRateHz * windowEnergy);
  }
}

/** Value of one bin from the raw transform. */
export function binValue(q: SpectralQuantity, re: number, im: number, k: number, fftLength: number, scale: number): number {
  const c = oneSidedFactor(k, fftLength);
  switch (q) {
    case "peak":
      return c * Math.hypot(re, im) * scale;
    case "rms": {
      const peak = c * Math.hypot(re, im) * scale;
      return c === 2 ? peak / Math.SQRT2 : peak;
    }
    case "power":
    case "psd":
      return c * (re * re + im * im) * scale;
    case "asd":
      return Math.sqrt(c * (re * re + im * im) * scale);
  }
}

export function spectrumValues(s: SegmentSpectrum, q: SpectralQuantity): Float64Array {
  const scale = quantityScale(q, s.windowSum, s.windowEnergy, s.sampleRateHz);
  const out = new Float64Array(s.bins);
  for (let k = 0; k < s.bins; k++) out[k] = binValue(q, s.re[k], s.im[k], k, s.fftLength, scale);
  return out;
}

/**
 * Phase in degrees, referenced to the first sample of the segment. Bins whose peak amplitude is more than
 * `floorDb` below the largest bin are NaN: their phase is dominated by leakage and rounding, not signal.
 */
export function spectrumPhase(s: SegmentSpectrum, floorDb = 60): Float64Array {
  const out = new Float64Array(s.bins);
  let max = 0;
  for (let k = 0; k < s.bins; k++) max = Math.max(max, oneSidedFactor(k, s.fftLength) * Math.hypot(s.re[k], s.im[k]));
  const floor = max * 10 ** (-floorDb / 20);
  for (let k = 0; k < s.bins; k++) {
    const a = oneSidedFactor(k, s.fftLength) * Math.hypot(s.re[k], s.im[k]);
    out[k] = max > 0 && a >= floor ? (Math.atan2(s.im[k], s.re[k]) * 180) / Math.PI : NaN;
  }
  return out;
}
