import { describe, expect, it } from "vitest";
import { WaveBenchError } from "@wavebench/core";
import { fft, ifft, rfft, unitRoot } from "@wavebench/dsp-cpu";
import { expectComplexClose, fixture, relL2, seq } from "./helpers";

const fx = fixture("fft-golden.json");

function directDft(re: Float64Array, im: Float64Array): { re: Float64Array; im: Float64Array } {
  const n = re.length;
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sr = 0;
    let si = 0;
    for (let j = 0; j < n; j++) {
      const [c, s] = unitRoot(j * k, n);
      sr += re[j] * c + im[j] * s;
      si += im[j] * c - re[j] * s;
    }
    outRe[k] = sr;
    outIm[k] = si;
  }
  return { re: outRe, im: outIm };
}

describe("complex FFT against numpy.fft", () => {
  for (const c of fx.cases) {
    it(`N = ${c.n}${(c.n & (c.n - 1)) === 0 ? " (radix-2)" : " (Bluestein)"}`, () => {
      const re = Float64Array.from(c.re);
      const im = Float64Array.from(c.im);
      fft(re, im);
      expectComplexClose(re, im, c.fftRe, c.fftIm, 1e-13);
      ifft(re, im);
      expect(relL2(re, c.re)).toBeLessThan(1e-13);
      expect(relL2(im, c.im)).toBeLessThan(1e-13);
    });
  }
});

describe("real FFT against numpy.fft.rfft", () => {
  for (const c of fx.cases) {
    it(`N = ${c.n}`, () => {
      const { re, im } = rfft(Float64Array.from(c.re));
      expectComplexClose(re, im, c.rfftRe, c.rfftIm, 1e-13);
    });
  }
  it("zero padding 100 -> 256 samples", () => {
    const z = fx.zeroPadded;
    const { re, im } = rfft(Float64Array.from(z.input), z.n);
    expectComplexClose(re, im, z.rfftRe, z.rfftIm, 1e-13);
  });
  it("never truncates a segment longer than the FFT", () => {
    expect(() => rfft(new Float64Array(300), 256)).toThrow(WaveBenchError);
  });
});

describe("FFT identities", () => {
  it("matches a direct DFT for awkward lengths", () => {
    for (const n of [6, 9, 15, 49, 121, 210, 343]) {
      const re = seq(n, (i) => Math.sin(i * 1.3) + 0.2 * Math.cos(i * i * 0.01));
      const im = seq(n, (i) => Math.cos(i * 0.7));
      const ref = directDft(re, im);
      fft(re, im);
      expect(relL2(re, ref.re)).toBeLessThan(1e-12);
      expect(relL2(im, ref.im)).toBeLessThan(1e-12);
    }
  });

  it("Parseval holds for a long prime length and a long power of two", () => {
    for (const n of [65537, 65536]) {
      const re = seq(n, (i) => Math.sin(0.001 * i * i) + ((i * 7919) % 13) / 13);
      const im = new Float64Array(n);
      let energy = 0;
      for (let i = 0; i < n; i++) energy += re[i] * re[i];
      fft(re, im);
      let spec = 0;
      for (let i = 0; i < n; i++) spec += re[i] * re[i] + im[i] * im[i];
      expect(Math.abs(spec / n - energy) / energy).toBeLessThan(1e-12);
    }
  });

  it("unit roots are exact at the quarter points", () => {
    expect(unitRoot(256, 1024)).toEqual([0, 1]);
    expect(unitRoot(512, 1024)).toEqual([-1, 0]);
    const [c3, s3] = unitRoot(768, 1024);
    expect(c3 === 0 && s3 === -1).toBe(true);
    const [c, s] = unitRoot(1, 1024);
    const [c2, s2] = unitRoot(1023, 1024);
    expect(c2).toBe(c);
    expect(s2).toBe(-s);
  });
});
