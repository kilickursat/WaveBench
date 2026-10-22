// Sampling and timing conventions (docs/DSP_SPEC.md, "Import and timebase contract"). All times are relative
// seconds in Float64; an absolute clock origin is kept separately as text.
import { CompensatedAccumulator } from "./sum";
import { assertFinite, assertInteger, assertPositiveFinite, WaveBenchError } from "./errors";

/** t[n] = startOffsetSec + n / fs. */
export function timeAt(sampleIndex: number, sampleRateHz: number, startOffsetSec = 0): number {
  assertInteger(sampleIndex, 0, "sampleIndex");
  assertPositiveFinite(sampleRateHz, "sampleRateHz");
  assertFinite(startOffsetSec, "startOffsetSec");
  const result = startOffsetSec + sampleIndex / sampleRateHz;
  assertFinite(result, "computed time");
  return result;
}

export interface SamplingSummary {
  intervalSec: number;
  firstTimeSec: number;
  lastTimeSec: number;
  /** N / fs: the acquisition span, one sample interval longer than lastTimeSec - firstTimeSec. */
  nominalSpanSec: number;
  nyquistHz: number;
}

export function samplingSummary(sampleCount: number, sampleRateHz: number, startOffsetSec = 0): SamplingSummary {
  assertInteger(sampleCount, 1, "sampleCount");
  assertPositiveFinite(sampleRateHz, "sampleRateHz");
  assertFinite(startOffsetSec, "startOffsetSec");
  const intervalSec = 1 / sampleRateHz;
  const nominalSpanSec = sampleCount / sampleRateHz;
  assertFinite(intervalSec, "sample interval");
  assertFinite(nominalSpanSec, "nominal span");
  return {
    intervalSec,
    firstTimeSec: startOffsetSec,
    lastTimeSec: timeAt(sampleCount - 1, sampleRateHz, startOffsetSec),
    nominalSpanSec,
    nyquistHz: sampleRateHz / 2,
  };
}

/** f[k] = k fs / M on the one-sided grid k = 0..floor(M/2). */
export function frequencyAt(bin: number, fftLength: number, sampleRateHz: number): number {
  assertInteger(fftLength, 2, "fftLength");
  assertInteger(bin, 0, "bin");
  assertPositiveFinite(sampleRateHz, "sampleRateHz");
  if (bin > Math.floor(fftLength / 2)) throw new WaveBenchError("INVALID_ARGUMENT", "bin is outside the one-sided spectrum");
  return (bin / fftLength) * sampleRateHz;
}

export interface FrameSummary {
  frameCount: number;
  windowDurationSec: number;
  hopSec: number;
  overlapFraction: number;
  firstFrameCenterSec: number | null;
  lastFrameCenterSec: number | null;
}

/** Complete frames only: P = max(0, 1 + floor((N - L) / H)); frame p is centred at (pH + L/2) / fs. */
export function frameSummary(sampleCount: number, windowLength: number, hopLength: number, sampleRateHz: number): FrameSummary {
  assertInteger(sampleCount, 0, "sampleCount");
  assertInteger(windowLength, 1, "windowLength");
  assertInteger(hopLength, 1, "hopLength");
  assertPositiveFinite(sampleRateHz, "sampleRateHz");
  if (hopLength > windowLength) throw new WaveBenchError("INVALID_ARGUMENT", "hopLength exceeds windowLength");
  const frameCount = frameCountFor(sampleCount, windowLength, hopLength);
  const result: FrameSummary = {
    frameCount,
    windowDurationSec: windowLength / sampleRateHz,
    hopSec: hopLength / sampleRateHz,
    overlapFraction: 1 - hopLength / windowLength,
    firstFrameCenterSec: frameCount ? windowLength / 2 / sampleRateHz : null,
    lastFrameCenterSec: frameCount ? ((frameCount - 1) * hopLength + windowLength / 2) / sampleRateHz : null,
  };
  for (const value of Object.values(result)) {
    if (value !== null && !Number.isFinite(value)) throw new WaveBenchError("INVALID_ARGUMENT", "frame timing overflow");
  }
  return result;
}

export function frameCountFor(sampleCount: number, windowLength: number, hopLength: number): number {
  return sampleCount >= windowLength ? 1 + Math.floor((sampleCount - windowLength) / hopLength) : 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Timestamp diagnostics

export interface TimestampPolicy {
  /** Largest allowed |t[n] - (a + b n)| from the least-squares grid, as a fraction of the fitted interval b. */
  maxResidualFraction: number;
  /** An increment larger than gapFactor times the median increment is reported as a gap. */
  gapFactor: number;
}

/**
 * Default thresholds. A residual of 10 % of an interval keeps every sample within a tenth of a sample of the
 * uniform grid, which tolerates timestamps printed with limited resolution; 1.5 x the median interval separates a
 * missing sample (2 x) from ordinary jitter.
 */
export const DEFAULT_TIMESTAMP_POLICY: TimestampPolicy = { maxResidualFraction: 0.1, gapFactor: 1.5 };

export type TimestampQuality = "uniform-within-policy" | "irregular" | "invalid";

export interface TimestampDiagnostics {
  count: number;
  quality: TimestampQuality;
  reasons: string[];
  policy: TimestampPolicy;
  nonFiniteCount: number;
  firstNonFiniteIndex: number | null;
  decreasingCount: number;
  duplicateCount: number;
  firstOrderProblemIndex: number | null;
  medianIntervalSec: number | null;
  sampleRateFromMedianHz: number | null;
  /** Least-squares fit t[n] = a + b n over all samples. */
  fitIntervalSec: number | null;
  fitInterceptSec: number | null;
  sampleRateFromFitHz: number | null;
  maxResidualSec: number | null;
  rmsResidualSec: number | null;
  gapCount: number;
  largestIncrementSec: number | null;
  /** First gaps; index is the first sample after the gap. */
  gaps: { index: number; incrementSec: number }[];
  /** Longest run of samples without a gap (end exclusive), or null when the order is broken. */
  longestSegment: { start: number; end: number } | null;
}

export function analyzeTimestamps(
  times: ArrayLike<number>,
  policy: TimestampPolicy = DEFAULT_TIMESTAMP_POLICY,
): TimestampDiagnostics {
  const count = times.length;
  const reasons: string[] = [];
  const result: TimestampDiagnostics = {
    count, quality: "invalid", reasons, policy,
    nonFiniteCount: 0, firstNonFiniteIndex: null, decreasingCount: 0, duplicateCount: 0, firstOrderProblemIndex: null,
    medianIntervalSec: null, sampleRateFromMedianHz: null, fitIntervalSec: null, fitInterceptSec: null,
    sampleRateFromFitHz: null, maxResidualSec: null, rmsResidualSec: null, gapCount: 0, largestIncrementSec: null,
    gaps: [], longestSegment: null,
  };
  if (count < 2) {
    reasons.push("at least two timestamps are needed");
    return result;
  }
  for (let i = 0; i < count; i++) {
    if (!Number.isFinite(times[i])) {
      result.nonFiniteCount++;
      if (result.firstNonFiniteIndex === null) result.firstNonFiniteIndex = i;
    }
  }
  if (result.nonFiniteCount) {
    reasons.push(`${result.nonFiniteCount} timestamps are missing or not finite (first at sample ${result.firstNonFiniteIndex})`);
    return result;
  }
  const increments = new Float64Array(count - 1);
  for (let i = 1; i < count; i++) {
    const d = times[i] - times[i - 1];
    increments[i - 1] = d;
    if (d < 0) result.decreasingCount++;
    else if (d === 0) result.duplicateCount++;
    if (d <= 0 && result.firstOrderProblemIndex === null) result.firstOrderProblemIndex = i;
  }
  const positive = increments.filter((d) => d > 0);
  if (positive.length) {
    const median = medianInPlace(positive);
    result.medianIntervalSec = median;
    result.sampleRateFromMedianHz = 1 / median;
  }
  // Least-squares grid; centred index keeps the sums well conditioned.
  const nMean = (count - 1) / 2;
  const tMean = (() => {
    const acc = new CompensatedAccumulator();
    for (let i = 0; i < count; i++) acc.add(times[i]);
    return acc.value / count;
  })();
  const sxy = new CompensatedAccumulator();
  for (let i = 0; i < count; i++) sxy.add((i - nMean) * (times[i] - tMean));
  const sxx = (count * (count * count - 1)) / 12;
  const slope = sxy.value / sxx;
  const intercept = tMean - slope * nMean;
  let maxRes = 0;
  const ss = new CompensatedAccumulator();
  for (let i = 0; i < count; i++) {
    const r = times[i] - (intercept + slope * i);
    if (Math.abs(r) > maxRes) maxRes = Math.abs(r);
    ss.add(r * r);
  }
  result.fitIntervalSec = slope;
  result.fitInterceptSec = intercept;
  result.sampleRateFromFitHz = slope > 0 ? 1 / slope : null;
  result.maxResidualSec = maxRes;
  result.rmsResidualSec = Math.sqrt(ss.value / count);
  if (result.decreasingCount) {
    reasons.push(`${result.decreasingCount} timestamps decrease (first at sample ${result.firstOrderProblemIndex}); rows are never re-sorted`);
    return result;
  }
  const median = result.medianIntervalSec;
  if (median === null) {
    reasons.push("all timestamps are equal");
    return result;
  }
  let largest = 0;
  let segStart = 0;
  let best = { start: 0, end: 0 };
  for (let i = 0; i < increments.length; i++) {
    const d = increments[i];
    if (d > largest) largest = d;
    if (d > policy.gapFactor * median) {
      result.gapCount++;
      if (result.gaps.length < 20) result.gaps.push({ index: i + 1, incrementSec: d });
      if (i + 1 - segStart > best.end - best.start) best = { start: segStart, end: i + 1 };
      segStart = i + 1;
    }
  }
  if (count - segStart > best.end - best.start) best = { start: segStart, end: count };
  result.largestIncrementSec = largest;
  result.longestSegment = best;
  if (result.duplicateCount) {
    reasons.push(`${result.duplicateCount} repeated ${result.duplicateCount === 1 ? "timestamp" : "timestamps"} (zero increments)`);
  }
  if (result.gapCount) {
    reasons.push(
      `${result.gapCount} ${result.gapCount === 1 ? "gap" : "gaps"} longer than ${policy.gapFactor} x the median interval (largest ${formatSec(largest)})`,
    );
  }
  if (slope > 0 && maxRes > policy.maxResidualFraction * slope) {
    reasons.push(
      `timestamps deviate from a uniform grid by up to ${(100 * maxRes / slope).toFixed(1)} % of the interval ` +
        `(limit ${(100 * policy.maxResidualFraction).toFixed(1)} %)`,
    );
  }
  result.quality = reasons.length ? "irregular" : "uniform-within-policy";
  return result;
}

function formatSec(s: number): string {
  return s >= 1 ? `${s.toPrecision(4)} s` : s >= 1e-3 ? `${(s * 1e3).toPrecision(4)} ms` : `${(s * 1e6).toPrecision(4)} µs`;
}

/** Median by quickselect; reorders the array. */
export function medianInPlace(a: Float64Array): number {
  const n = a.length;
  if (!n) return NaN;
  const upper = select(a, n >> 1);
  if (n % 2) return upper;
  let lower = -Infinity;
  for (let i = 0; i < n >> 1; i++) if (a[i] > lower) lower = a[i];
  return (lower + upper) / 2;
}

function select(a: Float64Array, k: number): number {
  let lo = 0;
  let hi = a.length - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) {
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return a[k];
  }
  return a[k];
}
