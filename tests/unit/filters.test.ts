import { describe, expect, it } from "vitest";
import { WaveBenchError } from "@wavebench/core";
import {
  applyChain, cabs, defaultPadLength, designFilter, designGroupDelay, designResponse, impulseEnergyLength,
  roundingBound, sosfilt, sosfiltfilt, sosfiltZi, sosGroupDelay, sosResponse, validateFilterSpec, type FilterSpec,
  type PadType,
} from "@wavebench/dsp-cpu";
import { expectClose, expectComplexClose, fixture, flat, seq } from "./helpers";

function specOf(d: { response: string; prototypeOrder: number; edgesHz: number[] }): FilterSpec {
  return d.response === "lowpass" || d.response === "highpass"
    ? { family: "butterworth", response: d.response, order: d.prototypeOrder, cutoffHz: d.edgesHz[0] }
    : { family: "butterworth", response: d.response as "bandpass" | "bandstop", order: d.prototypeOrder, lowHz: d.edgesHz[0], highHz: d.edgesHz[1] };
}

function expectSos(actual: Float64Array, expected: number[][]): void {
  expect(actual.length).toBe(expected.length * 6);
  const e = flat(expected);
  for (let i = 0; i < e.length; i++) {
    const row = Math.floor(i / 6);
    const scale = Math.max(...expected[row].map(Math.abs), 1e-300);
    if (!(Math.abs(actual[i] - e[i]) <= 1e-11 * scale + 1e-300)) throw new Error(`coefficient ${i}: ${actual[i]} vs ${e[i]}`);
  }
}

describe("template filter fixture (4th-order low-pass, 100 Hz at 1024 Hz)", () => {
  const fx = fixture("filter-golden.json");
  const design = designFilter({ family: "butterworth", response: "lowpass", order: 4, cutoffHz: 100 }, fx.sampleRateHz);
  it("coefficients match scipy.signal.butter", () => expectSos(design.sos, fx.sos));
  it("causal output from zero state matches sosfilt", () => expectClose(sosfilt(design.sos, fx.input).y, fx.expectedCausal, 1e-12, fx.input));
  it("zero-phase output with odd padding of 15 matches sosfiltfilt", () => {
    expect(defaultPadLength(design.sos)).toBe(fx.zeroPhasePadLength);
    expectClose(sosfiltfilt(design.sos, fx.input, "odd", 15), fx.expectedZeroPhase, 1e-12, fx.input);
  });
});

// Gates: each design carries conditioningGate = max(1e-12, 1e-15 / delta^2), delta = 1 - max|pole|, the documented
// Float64 rounding amplification near the unit circle. Results are judged against 50-digit references ("exact...")
// and against SciPy (whose own error is within the same gate, checked by the fixture generator).
describe("Butterworth designs against SciPy and 50-digit references", () => {
  const fx = fixture("butterworth-golden.json");
  for (const d of fx.designs) {
    describe(`${d.response} N=${d.prototypeOrder} ${d.edgesHz.join("-")} Hz at ${d.sampleRateHz} Hz (gate ${d.conditioningGate.toExponential(0)})`, () => {
      const design = designFilter(specOf(d), d.sampleRateHz);
      const gate: number = d.conditioningGate;
      it("second-order sections and pole radius", () => {
        expectSos(design.sos, d.sos);
        expect(Math.abs(design.maxPoleRadius - d.maxPoleRadius)).toBeLessThan(1e-12);
        expect(design.roundingBound).toBeCloseTo(roundingBound(d.maxPoleRadius), 12);
      });
      it("frequency response from the roots and from the sections", () => {
        const fromRoots = designResponse(design, d.probeHz);
        expectComplexClose(fromRoots.re, fromRoots.im, d.exactHRe, d.exactHIm, Math.max(1e-13, gate / 100));
        const fromSos = sosResponse(design.sos, d.probeHz, d.sampleRateHz);
        expectComplexClose(fromSos.re, fromSos.im, d.exactHRe, d.exactHIm, gate);
        expectComplexClose(fromSos.re, fromSos.im, d.hRe, d.hIm, 2 * gate);
        const edges = designResponse(design, d.edgesHz);
        for (let i = 0; i < d.edgesHz.length; i++) expect(Math.hypot(edges.re[i], edges.im[i])).toBeCloseTo(Math.SQRT1_2, 12);
      });
      it("outputs: zero state, steady state, zero-phase", () => {
        expectClose(sosfiltZi(design.sos), flat(d.sosfiltZi), 2 * gate);
        const outputs: [string, Float64Array][] = [
          ["causalZeroState", sosfilt(design.sos, fx.input).y],
          ["causalSteadyState", sosfilt(design.sos, fx.input, sosfiltZi(design.sos).map((v) => v * fx.input[0])).y],
          ["zeroPhaseOdd", sosfiltfilt(design.sos, fx.input)],
        ];
        for (const [key, pad] of [["zeroPhaseEven", "even"], ["zeroPhaseConstant", "constant"], ["zeroPhaseNone", "none"]] as const) {
          if (d[key]) outputs.push([key, sosfiltfilt(design.sos, fx.input, pad as PadType)]);
        }
        for (const [key, y] of outputs) {
          const exactKey = "exact" + key[0].toUpperCase() + key.slice(1);
          expectClose(y, d[exactKey], gate, fx.input);
          expectClose(y, d[key], 2 * gate, fx.input);
        }
      });
    });
  }
  for (const n of fx.notches) {
    it(`notch ${n.f0Hz} Hz, Q ${n.q}, fs ${n.sampleRateHz} Hz`, () => {
      const design = designFilter({ family: "notch", centerHz: n.f0Hz, q: n.q }, n.sampleRateHz);
      expectSos(design.sos, n.sos);
      expectClose(sosfilt(design.sos, fx.input).y, n.causalZeroState, 1e-12, fx.input);
      expectClose(sosfiltfilt(design.sos, fx.input), n.zeroPhaseOdd, 1e-12, fx.input);
      const at = designResponse(design, [n.f0Hz]);
      expect(Math.hypot(at.re[0], at.im[0])).toBeLessThan(1e-12);
      // -3 dB points at f0 -+ half the width f0/Q (exact for iirnotch; bisection on |H|^2 = 1/2).
      const halfPower = (lo: number, hi: number) => {
        for (let i = 0; i < 200; i++) {
          const mid = (lo + hi) / 2;
          const h = designResponse(design, [mid]);
          const above = h.re[0] ** 2 + h.im[0] ** 2 > 0.5;
          if (above === (lo < n.f0Hz)) lo = mid;
          else hi = mid;
        }
        return (lo + hi) / 2;
      };
      const width = halfPower(n.f0Hz, n.sampleRateHz / 2 - 1e-9) - halfPower(1e-9, n.f0Hz);
      expect(Math.abs(width - n.f0Hz / n.q) / (n.f0Hz / n.q)).toBeLessThan(1e-9);
    });
  }
});

describe("filter physics", () => {
  it("forward-backward squares the magnitude: a sine at the cutoff comes out at half amplitude, in phase", () => {
    const fs = 1000;
    const fc = 50;
    const design = designFilter({ family: "butterworth", response: "lowpass", order: 4, cutoffHz: fc }, fs);
    const x = seq(20000, (n) => Math.sin((2 * Math.PI * fc * n) / fs));
    const y = sosfiltfilt(design.sos, x);
    let num = 0;
    let den = 0;
    let lag = 0;
    for (let n = 8000; n < 12000; n++) {
      num += y[n] * y[n];
      den += x[n] * x[n];
      lag += y[n] * Math.cos((2 * Math.PI * fc * n) / fs);
    }
    expect(Math.sqrt(num / den)).toBeCloseTo(0.5, 6);
    expect(Math.abs(lag / Math.sqrt(num * den))).toBeLessThan(1e-6);
  });

  it("group delay from the roots equals the section formula", () => {
    const d = designFilter({ family: "butterworth", response: "bandpass", order: 3, lowHz: 40, highHz: 60 }, 1000);
    const f = seq(50, (i) => 1 + i * 9.7);
    expectClose(designGroupDelay(d, f), sosGroupDelay(d.sos, f, 1000), 1e-9);
  });

  it("group delay of pure delays and a one-pole filter", () => {
    expect(sosGroupDelay(Float64Array.of(0, 1, 0, 1, 0, 0), [0, 10, 200], 1000)).toEqual(Float64Array.of(1, 1, 1));
    expect(Array.from(sosGroupDelay(Float64Array.of(0, 0, 1, 1, 0, 0), [5, 100], 1000)).map((v) => Math.round(v * 1e12) / 1e12)).toEqual([2, 2]);
    // y[n] = (1-a) x[n] + a y[n-1]: delay at DC = a / (1 - a) samples.
    const a = 0.9;
    const gd = sosGroupDelay(Float64Array.of(1 - a, 0, 0, 1, -a, 0), [0], 1000);
    expect(gd[0]).toBeCloseTo(a / (1 - a), 10);
  });

  it("impulse energy length of a one-pole filter is analytic", () => {
    const a = 0.99;
    // Energy share after N samples is 1 - a^(2N).
    const expected = Math.ceil(Math.log(0.001) / (2 * Math.log(a)));
    expect(impulseEnergyLength(Float64Array.of(1 - a, 0, 0, 1, -a, 0), 0.999)).toBe(expected);
  });

  it("high-order band-pass designs stay stable", () => {
    const d = designFilter({ family: "butterworth", response: "bandpass", order: 10, lowHz: 1, highHz: 1.2 }, 1000);
    expect(d.maxPoleRadius).toBeLessThan(1);
    expect(d.realizedOrder).toBe(20);
    for (const p of d.poles) expect(cabs(p)).toBeLessThan(1);
  });
});

describe("filter validation", () => {
  it("edges must lie strictly inside (0, fs/2) and be ordered", () => {
    const bad: FilterSpec[] = [
      { family: "butterworth", response: "lowpass", order: 4, cutoffHz: 500 },
      { family: "butterworth", response: "lowpass", order: 4, cutoffHz: 0 },
      { family: "butterworth", response: "highpass", order: 0, cutoffHz: 10 },
      { family: "butterworth", response: "highpass", order: 2.5, cutoffHz: 10 },
      { family: "butterworth", response: "bandpass", order: 2, lowHz: 60, highHz: 40 },
      { family: "notch", centerHz: 50, q: 0 },
      { family: "notch", centerHz: 600, q: 30 },
    ];
    for (const s of bad) {
      expect(validateFilterSpec(s, 1000)).not.toBeNull();
      expect(() => designFilter(s, 1000)).toThrow(WaveBenchError);
    }
  });
});

describe("processing chain", () => {
  it("applies enabled steps in order and leaves the input untouched", () => {
    const x = seq(5000, (n) => 1 + Math.sin(n * 0.05) + 0.2 * Math.sin(n * 2.5));
    const copy = Float64Array.from(x);
    const spec: FilterSpec = { family: "butterworth", response: "lowpass", order: 4, cutoffHz: 40 };
    const r = applyChain(x, 1000, [
      { kind: "detrend", enabled: true, mode: "constant" },
      { kind: "filter", enabled: false, spec: { family: "notch", centerHz: 50, q: 10 }, mode: "causal", initial: "zero", padding: "odd" },
      { kind: "filter", enabled: true, spec, mode: "zero-phase", initial: "zero", padding: "odd" },
    ]);
    const mean = x.reduce((a, b) => a + b, 0) / x.length;
    const manual = sosfiltfilt(designFilter(spec, 1000).sos, x.map((v) => v - mean));
    expectClose(r.y, manual, 1e-12, x);
    expect(Array.from(x)).toEqual(Array.from(copy));
    expect(r.steps.map((s) => s.index)).toEqual([0, 2]);
    expect(r.edgeStart).toBeGreaterThan(0);
    expect(r.edgeEnd).toBe(r.edgeStart);
  });
});
