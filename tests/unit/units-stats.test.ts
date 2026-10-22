import { describe, expect, it } from "vitest";
import {
  channelStats, compatibleUnits, compensatedSum, conversionFactor, spectralUnitAscii, spectralUnitLabel,
  STANDARD_GRAVITY, WaveBenchError,
} from "@wavebench/core";
import { fixture } from "./helpers";

describe("units", () => {
  it("standard gravity is exact and conversions are reciprocal", () => {
    expect(STANDARD_GRAVITY).toBe(9.80665);
    expect(conversionFactor("g", "m/s^2")).toBe(9.80665);
    expect(conversionFactor("mg", "g")).toBeCloseTo(1e-3, 15);
    expect(conversionFactor("Gal", "m/s^2")).toBe(0.01);
    expect(conversionFactor("g", "Gal")).toBeCloseTo(980.665, 10);
    expect(conversionFactor("m/s^2", "g") * conversionFactor("g", "m/s^2")).toBeCloseTo(1, 15);
  });

  it("counts, volts and unknown units are never converted to acceleration", () => {
    expect(() => conversionFactor("count", "g")).toThrow(WaveBenchError);
    expect(() => conversionFactor("V", "g")).toThrow(WaveBenchError);
    expect(compatibleUnits("count").map((u) => u.id)).toEqual(["count"]);
    expect(compatibleUnits("g").map((u) => u.id)).toEqual(["g", "mg", "m/s^2", "mm/s^2", "Gal"]);
  });

  it("spectral units", () => {
    expect(spectralUnitLabel("g", "psd")).toBe("g²/Hz");
    expect(spectralUnitLabel("m/s^2", "psd")).toBe("(m/s²)²/Hz");
    expect(spectralUnitLabel("g", "asd")).toBe("g/√Hz");
    expect(spectralUnitAscii("m/s^2", "psd")).toBe("(m/s^2)^2/Hz");
  });
});

describe("statistics", () => {
  it("matches NumPy with population denominators", () => {
    const f = fixture("stats-golden.json");
    const s = channelStats(Float64Array.from(f.input));
    const e = f.expected;
    expect(s.count).toBe(e.count);
    for (const key of ["mean", "rms", "acRms", "min", "max", "peakAbs", "peakToPeak", "crestFactor"] as const) {
      expect(Math.abs((s[key] as number) - e[key])).toBeLessThanOrEqual(1e-14 * Math.max(1, Math.abs(e[key])));
    }
    expect(s.acRms).toBeCloseTo(e.std, 14);
  });

  it("crest factor is undefined for an all-zero signal", () => {
    expect(channelStats(new Float64Array(10)).crestFactor).toBeNull();
  });

  it("missing samples are refused, not skipped", () => {
    expect(() => channelStats(Float64Array.of(1, NaN, 3))).toThrow(WaveBenchError);
  });

  it("a large offset does not swamp a small variation", () => {
    // E[x^2] - mean^2 would lose about two digits here; the two-pass form keeps them.
    const x = new Float64Array(1_000_001);
    for (let i = 0; i < x.length; i++) x[i] = 1e4 + (i % 2 ? 1e-3 : -1e-3);
    x[x.length - 1] = 1e4;
    const s = channelStats(x);
    expect(s.acRms).toBeCloseTo(1e-3 * Math.sqrt(1e6 / 1_000_001), 11);
    expect(compensatedSum([1e16, 1, -1e16])).toBe(1);
  });
});
