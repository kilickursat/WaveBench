// The ordered processing chain applied to each contiguous record before an analysis interval is cropped
// (docs/DSP_SPEC.md, "Filtering"). Raw samples are never modified; every step writes a new array.
import { WaveBenchError } from "@wavebench/core";
import { detrend } from "./detrend";
import {
  describeFilter, designFilter, REFUSE_ROUNDING_BOUND, WARN_ROUNDING_BOUND, type FilterDesign, type FilterSpec,
} from "./filters/design";
import { impulseEnergyLength } from "./filters/response";
import { defaultPadLength, sosfilt, sosfiltZi, sosfiltfilt, type PadType } from "./filters/sos";

export type ChainStep =
  | { kind: "detrend"; enabled: boolean; mode: "constant" | "linear" }
  | {
      kind: "filter";
      enabled: boolean;
      spec: FilterSpec;
      /** zero-phase: forward-backward (offline, |H|^2, no delay); causal: one forward pass (|H|, phase delay). */
      mode: "zero-phase" | "causal";
      /** Causal start: zero state (scipy.signal.sosfilt default) or the steady state of the first sample. */
      initial: "zero" | "steady-state";
      padding: PadType;
    };

export interface AppliedStep {
  index: number;
  description: string;
  design?: FilterDesign;
  /** Samples holding 99.9 % of one pass's impulse-response energy: the edge region affected by start-up. */
  transientSamples?: number | null;
  padLength?: number;
}

export interface ChainResult {
  y: Float64Array;
  steps: AppliedStep[];
  warnings: string[];
  /** Approximate number of samples at the start and end of the record influenced by filter transients. */
  edgeStart: number;
  edgeEnd: number;
}

export function applyChain(x: Float64Array, sampleRateHz: number, steps: ChainStep[]): ChainResult {
  let y: Float64Array = x;
  const applied: AppliedStep[] = [];
  const warnings: string[] = [];
  let edgeStart = 0;
  let edgeEnd = 0;
  steps.forEach((step, index) => {
    if (!step.enabled) return;
    if (step.kind === "detrend") {
      y = detrend(y, step.mode);
      applied.push({ index, description: step.mode === "constant" ? "Remove mean" : "Remove linear trend" });
      return;
    }
    const design = designFilter(step.spec, sampleRateHz);
    if (design.roundingBound > REFUSE_ROUNDING_BOUND) {
      throw new WaveBenchError(
        "ILL_CONDITIONED",
        `${describeFilter(step.spec)}: the poles lie within ${(1 - design.maxPoleRadius).toExponential(1)} of the unit circle, ` +
          `so Float64 filtering could be wrong by up to ${design.roundingBound.toExponential(0)} (relative). ` +
          "Raise the cutoff, lower the order, or analyse at a lower sample rate.",
      );
    }
    if (design.roundingBound > WARN_ROUNDING_BOUND) {
      warnings.push(
        `${describeFilter(step.spec)}: the cutoff is very low for the sample rate; estimated rounding error up to ` +
          `${design.roundingBound.toExponential(0)} (relative)`,
      );
    }
    const transient = impulseEnergyLength(design.sos);
    const description = `${describeFilter(step.spec)}, ${step.mode === "zero-phase" ? "zero-phase (forward-backward)" : "causal"}`;
    if (transient === null) warnings.push(`${describeFilter(step.spec)}: the impulse response does not decay within ${(1 << 22).toLocaleString()} samples`);
    else if (transient > y.length / 4) {
      warnings.push(
        `${describeFilter(step.spec)}: start-up transients last about ${transient.toLocaleString()} samples ` +
          `(${(transient / sampleRateHz).toPrecision(3)} s), a large part of the record`,
      );
    }
    const t = transient ?? y.length;
    if (step.mode === "zero-phase") {
      const padLength = step.padding === "none" ? 0 : defaultPadLength(design.sos);
      if (y.length <= padLength) {
        throw new WaveBenchError("SIGNAL_TOO_SHORT", `zero-phase filtering needs more than ${padLength} samples; the record has ${y.length}`);
      }
      y = sosfiltfilt(design.sos, y, step.padding);
      edgeStart += t;
      edgeEnd += t;
      applied.push({ index, description, design, transientSamples: transient, padLength });
    } else {
      const zi = step.initial === "steady-state" ? sosfiltZi(design.sos).map((v) => v * y[0]) : undefined;
      y = sosfilt(design.sos, y, zi).y;
      edgeStart += t;
      applied.push({ index, description, design, transientSamples: transient });
    }
  });
  return { y: y === x ? Float64Array.from(x) : y, steps: applied, warnings, edgeStart, edgeEnd };
}
