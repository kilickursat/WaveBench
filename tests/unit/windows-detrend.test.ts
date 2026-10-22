import { describe, expect, it } from "vitest";
import { detrend, windowMetrics, windowSamples, type WindowName } from "@wavebench/dsp-cpu";
import { expectClose, fixture } from "./helpers";

describe("windows against scipy.signal.get_window", () => {
  const fx = fixture("windows-golden.json");
  for (const c of fx.cases) {
    it(`${c.name} L=${c.length}`, () => {
      expectClose(windowSamples(c.name as WindowName, c.length, "periodic"), c.periodic, 1e-14);
      expectClose(windowSamples(c.name as WindowName, c.length, "symmetric"), c.symmetric, 1e-14);
    });
  }
});

describe("window metrics", () => {
  it("periodic Hann: coherent gain 0.5, ENBW 1.5 bins", () => {
    const m = windowMetrics(windowSamples("hann", 4096));
    expect(m.coherentGain).toBeCloseTo(0.5, 14);
    expect(m.enbwBins).toBeCloseTo(1.5, 12);
  });
  it("periodic flat top: coherent gain a0, values dip below zero", () => {
    const w = windowSamples("flattop", 4096);
    expect(windowMetrics(w).coherentGain).toBeCloseTo(0.21557895, 14);
    expect(Math.min(...w)).toBeLessThan(0);
  });
  it("periodic and symmetric conventions differ", () => {
    expect(windowSamples("hann", 8, "periodic")[1]).not.toBeCloseTo(windowSamples("hann", 8, "symmetric")[1], 6);
  });
});

describe("detrend against scipy.signal.detrend", () => {
  const fx = fixture("detrend-golden.json");
  for (const c of fx.cases) {
    it(`length ${c.input.length}`, () => {
      // Errors relative to the input: the residual is small by construction.
      expectClose(detrend(c.input, "constant"), c.constant, 1e-14, c.input);
      expectClose(detrend(c.input, "linear"), c.linear, 1e-14, c.input);
      expect(Array.from(detrend(c.input, "none"))).toEqual(c.input);
    });
  }
});
