import { spectralUnitAscii, spectralUnitLabel, type SpectralQuantity } from "@wavebench/core";
import { spectrumPhase, spectrumValues, type SegmentSpectrum } from "@wavebench/dsp-cpu";
import type { SpectrumChannel, SpectrumResult, WelchResult } from "../engine/protocol";

export const QUANTITY_LABELS: Record<SpectralQuantity, string> = {
  peak: "Amplitude (peak)",
  rms: "Amplitude (RMS)",
  power: "Power (RMS²)",
  psd: "PSD",
  asd: "ASD (√PSD)",
};

/** Power-like quantities take 10 log10, amplitude-like ones 20 log10. */
export function dbFactor(q: SpectralQuantity): 10 | 20 {
  return q === "power" || q === "psd" ? 10 : 20;
}

function asSegment(r: SpectrumResult, c: SpectrumChannel): SegmentSpectrum {
  return {
    sampleRateHz: r.sampleRateHz, segmentLength: r.segmentLength, fftLength: r.fftLength, bins: c.re.length, window: "rectangular",
    detrend: "none", re: c.re, im: c.im, windowSum: r.windowSum, windowEnergy: r.windowEnergy, binWidthHz: r.binWidthHz,
    enbwHz: r.enbwHz, coherentGain: r.windowSum / r.segmentLength,
  };
}

export function fftValues(r: SpectrumResult, c: SpectrumChannel, q: SpectralQuantity): Float64Array {
  return spectrumValues(asSegment(r, c), q);
}

export function fftPhase(r: SpectrumResult, c: SpectrumChannel): Float64Array {
  return spectrumPhase(asSegment(r, c));
}

/** From the Welch PSD: ASD = sqrt(PSD); power = PSD x ENBW, exactly, bin by bin. */
export function welchValues(r: WelchResult, psd: Float64Array, q: "psd" | "asd" | "power"): Float64Array {
  if (q === "psd") return psd;
  if (q === "asd") return psd.map(Math.sqrt);
  return psd.map((v) => v * r.enbwHz);
}

export function toDb(values: Float64Array, factor: 10 | 20): Float64Array {
  return values.map((v) => (v > 0 ? factor * Math.log10(v) : NaN));
}

export function quantityUnit(unit: string, q: SpectralQuantity, db: boolean): string {
  const u = spectralUnitLabel(unit, q);
  return db ? `dB re 1 ${u}` : u;
}

export function quantityUnitAscii(unit: string, q: SpectralQuantity): string {
  return spectralUnitAscii(unit, q);
}

export function frequencyAxis(bins: number, binWidthHz: number): Float64Array {
  const f = new Float64Array(bins);
  for (let k = 0; k < bins; k++) f[k] = k * binWidthHz;
  return f;
}
