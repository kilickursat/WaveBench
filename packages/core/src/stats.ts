import { CompensatedAccumulator } from "./sum";
import { WaveBenchError } from "./errors";

/** Time-domain statistics with population (N) denominators; see docs/DSP_SPEC.md. */
export interface ChannelStats {
  count: number;
  mean: number;
  rms: number;
  /** RMS about the mean; equals the population standard deviation. */
  acRms: number;
  min: number;
  max: number;
  peakAbs: number;
  peakToPeak: number;
  /** peakAbs / rms; null when rms = 0 (undefined, not zero or infinity). */
  crestFactor: number | null;
}

export function channelStats(x: ArrayLike<number>, start = 0, end = x.length): ChannelStats {
  const count = end - start;
  if (count <= 0) throw new WaveBenchError("EMPTY_SELECTION", "statistics need at least one sample");
  const sum = new CompensatedAccumulator();
  const sumSq = new CompensatedAccumulator();
  let min = Infinity;
  let max = -Infinity;
  for (let i = start; i < end; i++) {
    const v = x[i];
    if (!Number.isFinite(v)) throw new WaveBenchError("NONFINITE_INPUT", `sample ${i} is not finite`);
    sum.add(v);
    sumSq.add(v * v);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = sum.value / count;
  // Second pass about the mean: avoids the cancellation in E[x^2] - mean^2.
  const dev = new CompensatedAccumulator();
  for (let i = start; i < end; i++) {
    const d = x[i] - mean;
    dev.add(d * d);
  }
  const rms = Math.sqrt(sumSq.value / count);
  const peakAbs = Math.max(Math.abs(min), Math.abs(max));
  return {
    count,
    mean,
    rms,
    acRms: Math.sqrt(dev.value / count),
    min,
    max,
    peakAbs,
    peakToPeak: max - min,
    crestFactor: rms > 0 ? peakAbs / rms : null,
  };
}
