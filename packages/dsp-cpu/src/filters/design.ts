// Filter design entry points. Every specification is validated against the sample rate before design: edges must
// lie strictly inside (0, fs/2) and be ordered. Coefficients are stored with the design parameters.
import { WaveBenchError } from "@wavebench/core";
import { cabs, csqrt, cx, type Complex } from "./complex";
import { zpkGroupDelay, zpkResponse } from "./response";
import { bilinear, buttap, lp2bp, lp2bs, lp2hp, lp2lp, zpk2sos, type Zpk } from "./zpk";

export interface ButterworthEdgeSpec {
  family: "butterworth";
  response: "lowpass" | "highpass";
  order: number;
  cutoffHz: number;
}

export interface ButterworthBandSpec {
  family: "butterworth";
  response: "bandpass" | "bandstop";
  /** Prototype order N; the realised filter has order 2N. */
  order: number;
  lowHz: number;
  highHz: number;
}

/** Second-order notch, scipy.signal.iirnotch: zero at centerHz, -3 dB width centerHz / q (exact, in Hz). */
export interface NotchSpec {
  family: "notch";
  centerHz: number;
  q: number;
}

export type FilterSpec = ButterworthEdgeSpec | ButterworthBandSpec | NotchSpec;

export function isBandSpec(spec: FilterSpec): spec is ButterworthBandSpec {
  return spec.family === "butterworth" && (spec.response === "bandpass" || spec.response === "bandstop");
}

export const MAX_ORDER = { lowpass: 16, highpass: 16, bandpass: 10, bandstop: 10 } as const;

export interface FilterDesign {
  spec: FilterSpec;
  sampleRateHz: number;
  /** Rows [b0 b1 b2 1 a1 a2]. */
  sos: Float64Array;
  sections: number;
  /** Order of the realised digital filter (2N for band filters of prototype order N). */
  realizedOrder: number;
  zeros: Complex[];
  poles: Complex[];
  gain: number;
  maxPoleRadius: number;
  /**
   * Estimated worst-case relative rounding error of Float64 filtering with this design, max(1e-12, 1e-15/delta^2)
   * with delta = 1 - max|p|: rounding is amplified like 1/delta^2 as poles approach the unit circle (very low
   * cutoffs relative to the sample rate). Checked against 50-digit references in tests/unit/filters.test.ts.
   */
  roundingBound: number;
}

/** Above this bound a design gets a warning; above REFUSE_ROUNDING_BOUND it is refused. */
export const WARN_ROUNDING_BOUND = 1e-8;
export const REFUSE_ROUNDING_BOUND = 1e-4;

export function roundingBound(maxPoleRadius: number): number {
  const delta = 1 - maxPoleRadius;
  return Math.max(1e-12, 1e-15 / (delta * delta));
}

export function describeFilter(spec: FilterSpec): string {
  if (spec.family === "notch") return `Notch ${fmt(spec.centerHz)} Hz, Q ${fmt(spec.q)}`;
  const name = { lowpass: "Low-pass", highpass: "High-pass", bandpass: "Band-pass", bandstop: "Band-stop" }[spec.response];
  const edges = isBandSpec(spec) ? `${fmt(spec.lowHz)}–${fmt(spec.highHz)} Hz` : `${fmt(spec.cutoffHz)} Hz`;
  return `Butterworth ${name.toLowerCase()} ${edges}, order ${spec.order}`;
}

function fmt(v: number): string {
  return Number.isFinite(v) ? String(Number(v.toPrecision(6))) : String(v);
}

/** Null when valid, otherwise the reason. */
export function validateFilterSpec(spec: FilterSpec, sampleRateHz: number): string | null {
  if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0) return "the sample rate must be positive";
  const nyquist = sampleRateHz / 2;
  const inside = (f: number) => Number.isFinite(f) && f > 0 && f < nyquist;
  if (spec.family === "notch") {
    if (!inside(spec.centerHz)) return `the notch frequency must lie strictly between 0 and the Nyquist frequency ${fmt(nyquist)} Hz`;
    if (!Number.isFinite(spec.q) || spec.q <= 0) return "Q must be positive";
    return null;
  }
  const max = MAX_ORDER[spec.response];
  if (!Number.isSafeInteger(spec.order) || spec.order < 1 || spec.order > max) return `the order must be an integer from 1 to ${max}`;
  if (!isBandSpec(spec)) {
    if (!inside(spec.cutoffHz)) return `the cutoff must lie strictly between 0 and the Nyquist frequency ${fmt(nyquist)} Hz`;
    return null;
  }
  if (!inside(spec.lowHz) || !inside(spec.highHz)) return `band edges must lie strictly between 0 and the Nyquist frequency ${fmt(nyquist)} Hz`;
  if (!(spec.lowHz < spec.highHz)) return "the lower band edge must be below the upper edge";
  return null;
}

export function butterworthZpk(spec: ButterworthEdgeSpec | ButterworthBandSpec, sampleRateHz: number): Zpk {
  // Pre-warp the edges for the bilinear transform at a normalised rate of 2 (scipy.signal.iirfilter).
  const edges = isBandSpec(spec) ? [spec.lowHz, spec.highHz] : [spec.cutoffHz];
  const warped = edges.map((f) => 4 * Math.tan((Math.PI * (2 * f / sampleRateHz)) / 2));
  const proto = buttap(spec.order);
  let analog: Zpk;
  switch (spec.response) {
    case "lowpass":
      analog = lp2lp(proto, warped[0]);
      break;
    case "highpass":
      analog = lp2hp(proto, warped[0]);
      break;
    case "bandpass":
      analog = lp2bp(proto, Math.sqrt(warped[0] * warped[1]), warped[1] - warped[0]);
      break;
    case "bandstop":
      analog = lp2bs(proto, Math.sqrt(warped[0] * warped[1]), warped[1] - warped[0]);
      break;
  }
  return bilinear(analog, 2);
}

function quadraticRoots(a1: number, a2: number): Complex[] {
  // z^2 + a1 z + a2 = 0
  const disc = csqrt(cx(a1 * a1 - 4 * a2));
  return [cx((-a1 + disc.re) / 2, disc.im / 2), cx((-a1 - disc.re) / 2, -disc.im / 2)];
}

export function designFilter(spec: FilterSpec, sampleRateHz: number): FilterDesign {
  const problem = validateFilterSpec(spec, sampleRateHz);
  if (problem) throw new WaveBenchError("INVALID_FILTER", problem);
  let zpk: Zpk;
  let sos: Float64Array;
  if (spec.family === "notch") {
    const w0 = (Math.PI * 2 * spec.centerHz) / sampleRateHz;
    const bw = w0 / spec.q;
    const beta = Math.tan(bw / 2);
    const gain = 1 / (1 + beta);
    const c = Math.cos(w0);
    sos = Float64Array.of(gain, -2 * gain * c, gain, 1, -2 * gain * c, 2 * gain - 1);
    zpk = { z: [cx(c, Math.sin(w0)), cx(c, -Math.sin(w0))], p: quadraticRoots(sos[4], sos[5]), k: gain };
  } else {
    zpk = butterworthZpk(spec, sampleRateHz);
    sos = zpk2sos(zpk);
  }
  const maxPoleRadius = zpk.p.reduce((m, v) => Math.max(m, cabs(v)), 0);
  if (!(maxPoleRadius < 1)) {
    throw new WaveBenchError("UNSTABLE_DESIGN", `the design has a pole on or outside the unit circle (|p| = ${maxPoleRadius}); it cannot be used`);
  }
  return {
    spec,
    sampleRateHz,
    sos,
    sections: sos.length / 6,
    realizedOrder: spec.family === "notch" ? 2 : isBandSpec(spec) ? 2 * spec.order : spec.order,
    zeros: zpk.z,
    poles: zpk.p,
    gain: zpk.k,
    maxPoleRadius,
    roundingBound: roundingBound(maxPoleRadius),
  };
}

/** Frequency response of a design, evaluated from its roots (see zpkResponse). */
export function designResponse(design: FilterDesign, frequenciesHz: ArrayLike<number>): { re: Float64Array; im: Float64Array } {
  return zpkResponse(design.zeros, design.poles, design.gain, frequenciesHz, design.sampleRateHz);
}

export function designGroupDelay(design: FilterDesign, frequenciesHz: ArrayLike<number>): Float64Array {
  return zpkGroupDelay(design.zeros, design.poles, frequenciesHz, design.sampleRateHz);
}
