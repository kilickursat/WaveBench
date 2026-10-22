import { describe, expect, it } from "vitest";
import { WaveBenchError } from "@wavebench/core";
import {
  findPeaks, segmentSpectrum, spectrumPhase, spectrumValues, windowSamples, type DetrendMode,
  type WindowName,
} from "@wavebench/dsp-cpu";
import { expectClose, expectComplexClose, fixture, seq } from "./helpers";

const windowName = (name: string): WindowName => (name === "hann-periodic" ? "hann" : (name as WindowName));

describe("one-sided spectra against the template fixtures (SciPy periodogram)", () => {
  const fx = fixture("spectra-golden.json");
  for (const c of fx.cases) {
    it(c.name, () => {
      const name = windowName(c.windowName);
      expectClose(windowSamples(name, c.input.length), c.window, 1e-15);
      const s = segmentSpectrum(c.input, 0, c.input.length, c.sampleRateHz, { window: name, detrend: "none", fftLength: c.fftLength });
      expect(s.bins).toBe(c.expected.frequencyHz.length);
      for (let k = 0; k < s.bins; k++) expect((k * c.sampleRateHz) / s.fftLength).toBe(c.expected.frequencyHz[k]);
      if (c.name === "zero") {
        expect(Array.from(spectrumValues(s, "psd")).every((v) => v === 0)).toBe(true);
        return;
      }
      expectComplexClose(s.re, s.im, c.expected.complexReal, c.expected.complexImag, 1e-12);
      expectClose(spectrumValues(s, "peak"), c.expected.peakAmplitude, 1e-12);
      expectClose(spectrumValues(s, "psd"), c.expected.psd, 1e-12);
    });
  }
});

describe("detrended and windowed spectra (SciPy periodogram)", () => {
  const fx = fixture("spectrum-extra-golden.json");
  for (const c of fx.cases) {
    it(c.name, () => {
      const s = segmentSpectrum(c.input, 0, c.input.length, c.sampleRateHz, {
        window: c.windowName, detrend: c.detrend as DetrendMode, fftLength: c.fftLength,
      });
      expectComplexClose(s.re, s.im, c.expected.complexReal, c.expected.complexImag, 1e-12);
      expectClose(spectrumValues(s, "peak"), c.expected.peakAmplitude, 1e-12);
      expectClose(spectrumValues(s, "psd"), c.expected.psd, 1e-12);
    });
  }
});

describe("scaling conventions", () => {
  const fs = 1024;
  const sine = seq(1024, (n) => 0.5 * Math.sin((2 * Math.PI * 64 * n) / fs) + 0.25);

  it("bin-centred tone: peak 0.5, RMS 0.5/sqrt2, DC not doubled", () => {
    const s = segmentSpectrum(sine, 0, sine.length, fs, { window: "rectangular", detrend: "none", fftLength: "exact" });
    const peak = spectrumValues(s, "peak");
    const rms = spectrumValues(s, "rms");
    expect(peak[64]).toBeCloseTo(0.5, 13);
    expect(rms[64]).toBeCloseTo(0.5 / Math.SQRT2, 13);
    expect(peak[0]).toBeCloseTo(0.25, 13);
    expect(rms[0]).toBeCloseTo(0.25, 13);
  });

  it("power equals RMS squared and ASD equals sqrt(PSD) in every bin", () => {
    const s = segmentSpectrum(sine, 0, 1000, fs, { window: "hann", detrend: "constant", fftLength: "pow2" });
    const rms = spectrumValues(s, "rms");
    const power = spectrumValues(s, "power");
    const psd = spectrumValues(s, "psd");
    const asd = spectrumValues(s, "asd");
    for (let k = 0; k < s.bins; k++) {
      expect(Math.abs(power[k] - rms[k] * rms[k])).toBeLessThanOrEqual(1e-15 * Math.max(1e-30, power[k]) + 1e-30);
      expect(Math.abs(asd[k] - Math.sqrt(psd[k]))).toBeLessThanOrEqual(1e-15 * asd[k] + 1e-300);
    }
  });

  it("Parseval: rectangular window sums the PSD to the mean square", () => {
    const x = seq(777, (n) => Math.sin(n * 0.37) + 0.3 * Math.cos(n * 1.91) + 0.1);
    for (const fftLength of ["exact", 1024, 2000] as const) {
      const s = segmentSpectrum(x, 0, x.length, 500, { window: "rectangular", detrend: "none", fftLength });
      const psd = spectrumValues(s, "psd");
      let sum = 0;
      for (const v of psd) sum += v;
      let ms = 0;
      for (const v of x) ms += v * v;
      expect(Math.abs((sum * 500) / s.fftLength - ms / x.length)).toBeLessThan(1e-13);
    }
  });

  it("Parseval with a window: the PSD integrates to the window-weighted mean square", () => {
    const x = seq(500, (n) => Math.sin(n * 0.37) + 0.5);
    const s = segmentSpectrum(x, 0, x.length, 100, { window: "blackman", detrend: "none", fftLength: 1024 });
    const w = windowSamples("blackman", 500);
    let num = 0;
    let den = 0;
    for (let n = 0; n < 500; n++) {
      num += (w[n] * x[n]) ** 2;
      den += w[n] * w[n];
    }
    const sum = spectrumValues(s, "psd").reduce((a, b) => a + b, 0);
    expect(Math.abs((sum * 100) / 1024 - num / den)).toBeLessThan(1e-13);
  });

  it("zero padding samples the same transform: amplitude unchanged, finer grid", () => {
    const x = seq(256, (n) => 0.5 * Math.sin((2 * Math.PI * 64 * n) / fs));
    const a = segmentSpectrum(x, 0, 256, fs, { window: "rectangular", detrend: "none", fftLength: "exact" });
    const b = segmentSpectrum(x, 0, 256, fs, { window: "rectangular", detrend: "none", fftLength: 1024 });
    expect(spectrumValues(a, "peak")[16]).toBeCloseTo(0.5, 13);
    expect(spectrumValues(b, "peak")[64]).toBeCloseTo(0.5, 13);
    expect(b.binWidthHz).toBe(1);
    expect(a.binWidthHz).toBe(4);
  });

  it("flat top recovers an off-bin tone amplitude to 0.2 %; Hann does not", () => {
    const x = seq(4096, (n) => 0.2 * Math.sin((2 * Math.PI * 50.37 * n) / 1000 + 0.3));
    const ft = segmentSpectrum(x, 0, x.length, 1000, { window: "flattop", detrend: "constant", fftLength: "exact" });
    const hann = segmentSpectrum(x, 0, x.length, 1000, { window: "hann", detrend: "constant", fftLength: "exact" });
    expect(Math.abs(Math.max(...spectrumValues(ft, "peak")) - 0.2) / 0.2).toBeLessThan(2e-3);
    expect(Math.abs(Math.max(...spectrumValues(hann, "peak")) - 0.2) / 0.2).toBeGreaterThan(1e-2);
  });

  it("phase is referenced to the first sample of the segment", () => {
    const x = seq(1000, (n) => Math.cos((2 * Math.PI * 25 * n) / 1000 + Math.PI / 6));
    const s = segmentSpectrum(x, 0, x.length, 1000, { window: "rectangular", detrend: "none", fftLength: "exact" });
    expect(spectrumPhase(s)[25]).toBeCloseTo(30, 10);
    expect(spectrumPhase(s)[26]).toBeNaN();
  });

  it("ENBW and bin width are reported", () => {
    const s = segmentSpectrum(sine, 0, 1024, fs, { window: "hann", detrend: "none", fftLength: "exact" });
    expect(s.binWidthHz).toBe(1);
    expect(s.enbwHz).toBeCloseTo(1.5, 12);
  });
});

describe("refusals", () => {
  it("missing samples, short FFT lengths and empty intervals", () => {
    const x = seq(100, (n) => n);
    x[40] = NaN;
    expect(() => segmentSpectrum(x, 0, 100, 10, { window: "hann", detrend: "none", fftLength: "exact" })).toThrow(/sample 40/);
    expect(() => segmentSpectrum(x, 50, 50, 10, { window: "hann", detrend: "none", fftLength: 32 })).toThrow(WaveBenchError);
    expect(() => segmentSpectrum(x, 0, 0, 10, { window: "hann", detrend: "none", fftLength: "exact" })).toThrow(WaveBenchError);
    expect(() => segmentSpectrum(x, 50, 50, 0, { window: "hann", detrend: "none", fftLength: "exact" })).toThrow(WaveBenchError);
  });
});

describe("peaks", () => {
  it("finds two tones and interpolates between bins", () => {
    const x = seq(2048, (n) => Math.sin((2 * Math.PI * 100.25 * n) / 1000) + 0.3 * Math.sin((2 * Math.PI * 240 * n) / 1000));
    const s = segmentSpectrum(x, 0, x.length, 1000, { window: "hann", detrend: "none", fftLength: "exact" });
    const peaks = findPeaks(spectrumValues(s, "peak"), s.binWidthHz, 2);
    expect(peaks.map((p) => p.bin)).toEqual([205, 492]);
    expect(Math.abs(peaks[0].interpolatedHz! - 100.25)).toBeLessThan(0.05);
  });
});
