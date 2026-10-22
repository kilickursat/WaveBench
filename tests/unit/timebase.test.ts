import { describe, expect, it } from "vitest";
import {
  analyzeTimestamps, frameSummary, frequencyAt, medianInPlace, samplingSummary, timeAt, WaveBenchError,
} from "@wavebench/core";
import { seq } from "./helpers";

// The first twelve cases are the template's timebase tests (tests/unit/timebase.test.mjs), unchanged in substance.
describe("assigned sampling rate", () => {
  it("60,000 samples at 1 kHz: last timestamp differs from nominal span", () => {
    expect(samplingSummary(60000, 1000)).toEqual({
      intervalSec: 0.001, firstTimeSec: 0, lastTimeSec: 59.999, nominalSpanSec: 60, nyquistHz: 500,
    });
  });
  it("time origin shifts labels only", () => {
    expect(timeAt(500, 1000, 10)).toBe(10.5);
    expect(samplingSummary(1000, 1000, 10).nominalSpanSec).toBe(1);
  });
  it("one-sample records have a defined origin", () => {
    expect(samplingSummary(1, 1000).lastTimeSec).toBe(0);
  });
  it("frequency axis includes even-length Nyquist", () => {
    expect(frequencyAt(512, 1024, 1000)).toBe(500);
    expect(frequencyAt(1, 1024, 1000)).toBe(0.9765625);
  });
  it("odd FFT lengths do not land exactly on Nyquist", () => {
    expect(frequencyAt(127, 255, 255)).toBe(127);
  });
  it("STFT uses complete frames and the explicit half-window center", () => {
    const result = frameSummary(60000, 1024, 256, 1000);
    expect(result.frameCount).toBe(231);
    expect(result.firstFrameCenterSec).toBe(0.512);
    expect(result.lastFrameCenterSec).toBe(59.392);
    expect(result.overlapFraction).toBe(0.75);
  });
  it("short records have zero complete frames, not a silently smaller window", () => {
    expect(frameSummary(100, 1024, 256, 1000).frameCount).toBe(0);
    expect(frameSummary(100, 1024, 256, 1000).firstFrameCenterSec).toBeNull();
  });
  it("zero/negative/nonfinite sampling rates are rejected", () => {
    for (const fs of [0, -1, NaN, Infinity]) expect(() => timeAt(0, fs)).toThrow(WaveBenchError);
  });
  it("invalid sample indexes/counts are rejected", () => {
    for (const n of [-1, 0.5, NaN]) expect(() => timeAt(n, 1000)).toThrow(WaveBenchError);
    expect(() => samplingSummary(0, 1000)).toThrow(WaveBenchError);
  });
  it("invalid FFT bins are rejected", () => {
    expect(() => frequencyAt(513, 1024, 1000)).toThrow(WaveBenchError);
  });
  it("invalid frame parameters are rejected", () => {
    expect(() => frameSummary(1000, 128, 0, 1000)).toThrow(WaveBenchError);
    expect(() => frameSummary(1000, 128, 256, 1000)).toThrow(WaveBenchError);
  });
  it("nonfinite origins and representational overflow are rejected", () => {
    expect(() => timeAt(0, 1000, Infinity)).toThrow(WaveBenchError);
    expect(() => samplingSummary(1000, Number.MIN_VALUE)).toThrow(WaveBenchError);
  });
});

describe("timestamp diagnostics", () => {
  it("exact uniform timestamps: both estimators give fs", () => {
    const d = analyzeTimestamps(seq(5000, (n) => 3 + n / 1000.5));
    expect(d.quality).toBe("uniform-within-policy");
    expect(d.sampleRateFromFitHz!).toBeCloseTo(1000.5, 8);
    expect(d.sampleRateFromMedianHz!).toBeCloseTo(1000.5, 6);
    expect(d.maxResidualSec!).toBeLessThan(1e-12);
    expect(d.gapCount).toBe(0);
  });

  it("timestamps printed with 4 decimals at 1024 Hz are uniform within the default policy", () => {
    const d = analyzeTimestamps(seq(4096, (n) => Math.round((n / 1024) * 1e4) / 1e4));
    expect(d.quality).toBe("uniform-within-policy");
    expect(Math.abs(d.sampleRateFromFitHz! - 1024)).toBeLessThan(0.01);
  });

  it("millisecond timestamps at 1024 Hz repeat: irregular, but the fit still finds 1024 Hz", () => {
    const d = analyzeTimestamps(seq(8192, (n) => Math.floor((n / 1024) * 1000) / 1000));
    expect(d.quality).toBe("irregular");
    expect(d.duplicateCount).toBeGreaterThan(0);
    expect(Math.abs(d.sampleRateFromFitHz! - 1024)).toBeLessThan(0.05);
  });

  it("a missing block of samples is a gap and splits the record", () => {
    const t = seq(1000, (n) => (n < 600 ? n : n + 5) / 100);
    const d = analyzeTimestamps(t);
    expect(d.quality).toBe("irregular");
    expect(d.gapCount).toBe(1);
    expect(d.gaps[0].index).toBe(600);
    expect(d.gaps[0].incrementSec).toBeCloseTo(0.06, 12);
    expect(d.longestSegment).toEqual({ start: 0, end: 600 });
  });

  it("decreasing or missing timestamps are invalid and never re-sorted", () => {
    const t = seq(100, (n) => n / 10);
    t[50] = t[49] - 0.05;
    expect(analyzeTimestamps(t).quality).toBe("invalid");
    expect(analyzeTimestamps(t).firstOrderProblemIndex).toBe(50);
    const u = seq(100, (n) => n / 10);
    u[7] = NaN;
    expect(analyzeTimestamps(u).quality).toBe("invalid");
    expect(analyzeTimestamps(u).firstNonFiniteIndex).toBe(7);
  });

  it("jitter beyond the residual limit is reported", () => {
    const t = seq(1000, (n) => n / 100 + (n === 500 ? 0.003 : 0));
    const d = analyzeTimestamps(t, { maxResidualFraction: 0.1, gapFactor: 1.5 });
    expect(d.quality).toBe("irregular");
    expect(d.maxResidualSec!).toBeGreaterThan(0.001);
  });

  it("median of an even-length array averages the two central values", () => {
    expect(medianInPlace(Float64Array.of(4, 1, 3, 2))).toBe(2.5);
    expect(medianInPlace(Float64Array.of(5, 1, 3))).toBe(3);
  });
});
