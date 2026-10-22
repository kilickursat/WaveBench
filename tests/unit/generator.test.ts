import { describe, expect, it } from "vitest";
import { channelStats, gaussianSource, generateSignals } from "@wavebench/core";
import { segmentSpectrum, spectrumValues } from "@wavebench/dsp-cpu";

describe("synthetic signals", () => {
  it("a sine reads back its amplitude and frequency", () => {
    const [x] = generateSignals({ sampleRateHz: 1000, samples: 1000, unit: "g", channels: [{ name: "x", components: [{ kind: "sine", frequencyHz: 50, amplitude: 0.2, phaseDeg: 0 }] }] });
    const s = segmentSpectrum(x, 0, x.length, 1000, { window: "rectangular", detrend: "none", fftLength: "exact" });
    expect(spectrumValues(s, "peak")[50]).toBeCloseTo(0.2, 12);
  });

  it("the linear chirp follows scipy.signal.chirp: f0 at t = 0, f1 at the last sample", () => {
    const fs = 1000;
    const [x] = generateSignals({ sampleRateHz: fs, samples: 2001, unit: "g", channels: [{ name: "c", components: [{ kind: "chirp", f0Hz: 10, f1Hz: 110, amplitude: 1 }] }] });
    expect(x[0]).toBe(1);
    // Instantaneous frequency f(t) = f0 + (f1 - f0) t / T; phase at T = 2 pi (f0 T + (f1 - f0) T / 2).
    const T = 2;
    expect(x[2000]).toBeCloseTo(Math.cos(2 * Math.PI * (10 * T + 0.5 * 100 * T)), 9);
  });

  it("noise is reproducible from its seed and has the requested standard deviation", () => {
    const spec = { sampleRateHz: 100, samples: 100000, unit: "g", channels: [{ name: "n", components: [{ kind: "noise" as const, rms: 0.05, seed: 42 }] }] };
    const [a] = generateSignals(spec);
    const [b] = generateSignals(spec);
    expect(Array.from(a.subarray(0, 50))).toEqual(Array.from(b.subarray(0, 50)));
    expect(channelStats(a).acRms).toBeCloseTo(0.05, 3);
    const g = gaussianSource(1);
    let m = 0;
    for (let i = 0; i < 100000; i++) m += g();
    expect(Math.abs(m / 100000)).toBeLessThan(0.02);
  });
});
