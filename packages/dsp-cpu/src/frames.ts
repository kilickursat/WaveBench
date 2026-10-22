// Complete-frame analyses (docs/DSP_SPEC.md, "Welch PSD" and "STFT"). Frames never extend past the segment:
//   P = 1 + floor((N - L) / H),  frame p covers samples [pH, pH + L),  time(p) = (pH + L/2) / fs.
// Welch is the arithmetic mean of the frame PSDs (or power spectra), not the spectrum of an averaged waveform.
import { WaveBenchError, assertPositiveFinite } from "@wavebench/core";
import { detrendInto, type DetrendMode } from "./detrend";
import { realFFT } from "./fft";
import { assertFiniteSegment, binValue, frequencies, quantityScale, resolveFftLength, type FftLengthRule } from "./spectrum";
import { windowMetrics, windowSamples, type WindowName } from "./windows";

/** Largest STFT result held in memory: 2^24 cells (128 MiB in Float64). */
export const MAX_STFT_CELLS = 1 << 24;

export interface FrameOptions {
  window: WindowName;
  windowLength: number;
  hopLength: number;
  fftLength: FftLengthRule;
  detrend: DetrendMode;
}

export interface FramePlan {
  sampleRateHz: number;
  segmentLength: number;
  windowLength: number;
  hopLength: number;
  fftLength: number;
  bins: number;
  frames: number;
  window: WindowName;
  detrend: DetrendMode;
  windowSum: number;
  windowEnergy: number;
  binWidthHz: number;
  enbwHz: number;
  /** Samples at the end of the segment that no complete frame covers. */
  unusedSamples: number;
}

export function planFrames(segmentLength: number, sampleRateHz: number, options: FrameOptions): FramePlan {
  assertPositiveFinite(sampleRateHz, "sample rate");
  const { windowLength: L, hopLength: H } = options;
  if (!Number.isSafeInteger(L) || L < 1) throw new WaveBenchError("INVALID_ARGUMENT", `window length must be a positive integer (got ${L})`);
  if (!Number.isSafeInteger(H) || H < 1 || H > L) {
    throw new WaveBenchError("INVALID_ARGUMENT", `hop must be an integer between 1 and the window length ${L} (got ${H})`);
  }
  if (segmentLength < L) {
    throw new WaveBenchError(
      "SEGMENT_TOO_SHORT",
      `the interval has ${segmentLength} samples, fewer than one window (${L}); shorten the window or widen the interval`,
    );
  }
  const fftLength = resolveFftLength(options.fftLength, L);
  const frames = 1 + Math.floor((segmentLength - L) / H);
  const w = windowSamples(options.window, L);
  const m = windowMetrics(w);
  if (!(m.energy > 0)) throw new WaveBenchError("ZERO_WINDOW", "the window has zero energy");
  return {
    sampleRateHz,
    segmentLength,
    windowLength: L,
    hopLength: H,
    fftLength,
    bins: Math.floor(fftLength / 2) + 1,
    frames,
    window: options.window,
    detrend: options.detrend,
    windowSum: m.sum,
    windowEnergy: m.energy,
    binWidthHz: sampleRateHz / fftLength,
    enbwHz: (sampleRateHz * m.energy) / (m.sum * m.sum),
    unusedSamples: segmentLength - ((frames - 1) * H + L),
  };
}

/** Centre time of each frame relative to the first sample of the segment. */
export function frameTimes(plan: FramePlan): Float64Array {
  const t = new Float64Array(plan.frames);
  for (let p = 0; p < plan.frames; p++) t[p] = (p * plan.hopLength + plan.windowLength / 2) / plan.sampleRateHz;
  return t;
}

export function frameFrequencies(plan: FramePlan): Float64Array {
  return frequencies(plan.fftLength, plan.sampleRateHz);
}

export type FrameQuantity = "psd" | "power" | "peak";

/** Run one frame: writes the selected quantity for bins 0..K-1 into out. */
function frameValues(
  x: ArrayLike<number>,
  start: number,
  plan: FramePlan,
  w: Float64Array,
  buf: Float64Array,
  re: Float64Array,
  im: Float64Array,
  quantity: FrameQuantity,
  scale: number,
  out: Float64Array,
  outOffset: number,
): void {
  const L = plan.windowLength;
  detrendInto(x, start, L, plan.detrend, buf);
  for (let n = 0; n < L; n++) buf[n] *= w[n];
  realFFT(plan.fftLength).forward(buf, re, im, 0, L);
  for (let k = 0; k < plan.bins; k++) out[outOffset + k] = binValue(quantity, re[k], im[k], k, plan.fftLength, scale);
}

function framesPerYield(plan: FramePlan): number {
  return Math.max(1, Math.floor((1 << 18) / Math.max(plan.fftLength, 1)));
}

export interface WelchResult {
  plan: FramePlan;
  quantity: "psd" | "power";
  values: Float64Array;
}

/** Welch average; yields the completed fraction between batches of frames. */
export function* welchSteps(
  x: ArrayLike<number>,
  start: number,
  length: number,
  sampleRateHz: number,
  options: FrameOptions,
  quantity: "psd" | "power" = "psd",
): Generator<number, WelchResult> {
  const plan = planFrames(length, sampleRateHz, options);
  assertFiniteSegment(x, start, length);
  const w = windowSamples(plan.window, plan.windowLength);
  const scale = quantityScale(quantity, plan.windowSum, plan.windowEnergy, sampleRateHz);
  const buf = new Float64Array(plan.windowLength);
  const re = new Float64Array(plan.bins);
  const im = new Float64Array(plan.bins);
  const frame = new Float64Array(plan.bins);
  const sum = new Float64Array(plan.bins);
  const comp = new Float64Array(plan.bins);
  const batch = framesPerYield(plan);
  for (let p = 0; p < plan.frames; p++) {
    frameValues(x, start + p * plan.hopLength, plan, w, buf, re, im, quantity, scale, frame, 0);
    for (let k = 0; k < plan.bins; k++) {
      const v = frame[k];
      const t = sum[k] + v;
      comp[k] += Math.abs(sum[k]) >= Math.abs(v) ? sum[k] - t + v : v - t + sum[k];
      sum[k] = t;
    }
    if ((p + 1) % batch === 0) yield (p + 1) / plan.frames;
  }
  const values = new Float64Array(plan.bins);
  for (let k = 0; k < plan.bins; k++) values[k] = (sum[k] + comp[k]) / plan.frames;
  return { plan, quantity, values };
}

export interface StftResult {
  plan: FramePlan;
  quantity: FrameQuantity;
  /** Frame-major: values[p * bins + k]. */
  values: Float64Array;
}

export function* stftSteps(
  x: ArrayLike<number>,
  start: number,
  length: number,
  sampleRateHz: number,
  options: FrameOptions,
  quantity: FrameQuantity = "psd",
): Generator<number, StftResult> {
  const plan = planFrames(length, sampleRateHz, options);
  if (plan.frames * plan.bins > MAX_STFT_CELLS) {
    throw new WaveBenchError(
      "STFT_TOO_LARGE",
      `the spectrogram would have ${plan.frames} frames x ${plan.bins} bins = ${(plan.frames * plan.bins).toExponential(2)} cells ` +
        `(limit ${MAX_STFT_CELLS.toExponential(2)}); increase the hop or shorten the interval`,
    );
  }
  assertFiniteSegment(x, start, length);
  const w = windowSamples(plan.window, plan.windowLength);
  const scale = quantityScale(quantity, plan.windowSum, plan.windowEnergy, sampleRateHz);
  const buf = new Float64Array(plan.windowLength);
  const re = new Float64Array(plan.bins);
  const im = new Float64Array(plan.bins);
  const values = new Float64Array(plan.frames * plan.bins);
  const batch = framesPerYield(plan);
  for (let p = 0; p < plan.frames; p++) {
    frameValues(x, start + p * plan.hopLength, plan, w, buf, re, im, quantity, scale, values, p * plan.bins);
    if ((p + 1) % batch === 0) yield (p + 1) / plan.frames;
  }
  return { plan, quantity, values };
}

export function runToEnd<T>(steps: Generator<number, T>): T {
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

export function welch(
  x: ArrayLike<number>,
  sampleRateHz: number,
  options: FrameOptions,
  quantity: "psd" | "power" = "psd",
  start = 0,
  length = x.length - start,
): WelchResult {
  return runToEnd(welchSteps(x, start, length, sampleRateHz, options, quantity));
}

export function stft(
  x: ArrayLike<number>,
  sampleRateHz: number,
  options: FrameOptions,
  quantity: FrameQuantity = "psd",
  start = 0,
  length = x.length - start,
): StftResult {
  return runToEnd(stftSteps(x, start, length, sampleRateHz, options, quantity));
}
