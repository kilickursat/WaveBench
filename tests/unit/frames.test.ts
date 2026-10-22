import { describe, expect, it } from "vitest";
import { generateSignals, WaveBenchError } from "@wavebench/core";
import {
  frameFrequencies, frameTimes, MAX_STFT_CELLS, planFrames, stft, welch, type DetrendMode,
  type FrameQuantity, type WindowName,
} from "@wavebench/dsp-cpu";
import { expectClose, fixture, flat } from "./helpers";

describe("template STFT / Welch fixture", () => {
  const fx = fixture("stft-welch-golden.json");
  const opts = { window: "hann" as const, windowLength: fx.windowLength, hopLength: fx.hopLength, fftLength: fx.fftLength, detrend: "none" as const };
  it("complete-frame PSD, frame centres and frequencies", () => {
    const r = stft(fx.input, fx.sampleRateHz, opts, "psd");
    expect(r.plan.frames).toBe(fx.expectedPsdFrameMajor.length);
    expectClose(r.values, flat(fx.expectedPsdFrameMajor), 1e-12);
    expectClose(frameTimes(r.plan), fx.frameTimesSec, 1e-15);
    expectClose(frameFrequencies(r.plan), fx.frequencyHz, 1e-15);
  });
  it("Welch equals the mean of the frame PSDs", () => {
    expectClose(welch(fx.input, fx.sampleRateHz, opts).values, fx.expectedWelchPsd, 1e-12);
  });
});

describe("Welch against scipy.signal.welch", () => {
  const fx = fixture("welch-golden.json");
  for (const c of fx.cases) {
    it(`${c.window} L=${c.windowLength} H=${c.hopLength} M=${c.fftLength} detrend=${c.detrend} ${c.scaling}`, () => {
      const r = welch(fx.input, c.sampleRateHz, {
        window: c.window as WindowName, windowLength: c.windowLength, hopLength: c.hopLength, fftLength: c.fftLength,
        detrend: c.detrend as DetrendMode,
      }, c.scaling === "density" ? "psd" : "power");
      expect(r.plan.frames).toBe(c.segments);
      expectClose(frameFrequencies(r.plan), c.frequencyHz, 1e-15);
      expectClose(r.values, c.expected, 1e-12);
    });
  }
});

describe("STFT against explicit NumPy frames (cross-checked with ShortTimeFFT)", () => {
  const fx = fixture("stft-golden.json");
  for (const c of fx.cases) {
    it(`${c.window} L=${c.windowLength} H=${c.hopLength} M=${c.fftLength} detrend=${c.detrend} ${c.output}`, () => {
      const r = stft(fx.input, c.sampleRateHz, {
        window: c.window as WindowName, windowLength: c.windowLength, hopLength: c.hopLength, fftLength: c.fftLength,
        detrend: c.detrend as DetrendMode,
      }, c.output as FrameQuantity);
      expectClose(r.values, flat(c.expectedFrameMajor), 1e-12);
      expectClose(frameTimes(r.plan), c.frameTimesSec, 1e-15);
    });
  }
});

describe("frame bookkeeping", () => {
  it("reports the samples no complete frame covers", () => {
    const p = planFrames(1000, 100, { window: "hann", windowLength: 128, hopLength: 64, fftLength: "exact", detrend: "none" });
    expect(p.frames).toBe(14);
    expect(p.unusedSamples).toBe(1000 - (13 * 64 + 128));
  });
  it("refuses an interval shorter than one window instead of shrinking the window", () => {
    expect(() => planFrames(100, 100, { window: "hann", windowLength: 128, hopLength: 64, fftLength: "exact", detrend: "none" })).toThrow(WaveBenchError);
  });
  it("refuses hops longer than the window", () => {
    expect(() => planFrames(1000, 100, { window: "hann", windowLength: 128, hopLength: 129, fftLength: "exact", detrend: "none" })).toThrow(WaveBenchError);
  });
  it("refuses spectrograms beyond the cell limit", () => {
    const big = { length: MAX_STFT_CELLS * 2 } as unknown as Float64Array;
    expect(() => stft(big, 1000, { window: "hann", windowLength: 1024, hopLength: 1, fftLength: "exact", detrend: "none" })).toThrow(/cells/);
  });
});

describe("physics", () => {
  it("white noise of standard deviation s has a one-sided PSD of 2 s^2 / fs", () => {
    const fs = 1000;
    const sigma = 0.1;
    const [x] = generateSignals({ sampleRateHz: fs, samples: 200_000, unit: "g", channels: [{ name: "n", components: [{ kind: "noise", rms: sigma, seed: 7 }] }] });
    const r = welch(x, fs, { window: "hann", windowLength: 1024, hopLength: 512, fftLength: "exact", detrend: "constant" });
    let mean = 0;
    for (let k = 1; k < r.values.length - 1; k++) mean += r.values[k];
    mean /= r.values.length - 2;
    expect(Math.abs(mean / ((2 * sigma * sigma) / fs) - 1)).toBeLessThan(0.02);
  });
});
