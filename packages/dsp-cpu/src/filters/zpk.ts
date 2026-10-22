// Zero-pole-gain design steps, following the analog-prototype route of scipy.signal.iirfilter: Butterworth
// prototype, frequency transformation, bilinear transform with pre-warped edges, then pairing into second-order
// sections with the "nearest" strategy of scipy.signal.zpk2sos so coefficients can be compared one to one.
import { WaveBenchError } from "@wavebench/core";
import {
  cabs, cadd, cconj, cdiv, cmul, cneg, cprod, cscale, csqrt, csub, cx, poly, type Complex,
} from "./complex";

export interface Zpk {
  z: Complex[];
  p: Complex[];
  k: number;
}

/** Analog Butterworth prototype: poles -exp(i pi m / 2N), m = -N+1, -N+3, ..., N-1; no zeros; unit gain. */
export function buttap(order: number): Zpk {
  const p: Complex[] = [];
  for (let m = -order + 1; m < order; m += 2) {
    const a = (Math.PI * m) / (2 * order);
    p.push(cneg(cx(Math.cos(a), Math.sin(a))));
  }
  return { z: [], p, k: 1 };
}

const degree = (s: Zpk) => s.p.length - s.z.length;

export function lp2lp(s: Zpk, wo: number): Zpk {
  return { z: s.z.map((v) => cscale(v, wo)), p: s.p.map((v) => cscale(v, wo)), k: s.k * wo ** degree(s) };
}

export function lp2hp(s: Zpk, wo: number): Zpk {
  const d = degree(s);
  const z = s.z.map((v) => cdiv(cx(wo), v));
  for (let i = 0; i < d; i++) z.push(cx(0));
  const ratio = cdiv(cprod(s.z.map(cneg)), cprod(s.p.map(cneg)));
  return { z, p: s.p.map((v) => cdiv(cx(wo), v)), k: s.k * ratio.re };
}

function shiftPair(v: Complex, wo: number): [Complex, Complex] {
  const root = csqrt(csub(cmul(v, v), cx(wo * wo)));
  return [cadd(v, root), csub(v, root)];
}

export function lp2bp(s: Zpk, wo: number, bw: number): Zpk {
  const d = degree(s);
  const zl = s.z.map((v) => cscale(v, bw / 2));
  const pl = s.p.map((v) => cscale(v, bw / 2));
  const zs = zl.map((v) => shiftPair(v, wo));
  const ps = pl.map((v) => shiftPair(v, wo));
  const z = [...zs.map((q) => q[0]), ...zs.map((q) => q[1])];
  for (let i = 0; i < d; i++) z.push(cx(0));
  return { z, p: [...ps.map((q) => q[0]), ...ps.map((q) => q[1])], k: s.k * bw ** d };
}

export function lp2bs(s: Zpk, wo: number, bw: number): Zpk {
  const d = degree(s);
  const zh = s.z.map((v) => cdiv(cx(bw / 2), v));
  const ph = s.p.map((v) => cdiv(cx(bw / 2), v));
  const zs = zh.map((v) => shiftPair(v, wo));
  const ps = ph.map((v) => shiftPair(v, wo));
  const z = [...zs.map((q) => q[0]), ...zs.map((q) => q[1])];
  for (let i = 0; i < d; i++) z.push(cx(0, wo));
  for (let i = 0; i < d; i++) z.push(cx(0, -wo));
  const ratio = cdiv(cprod(s.z.map(cneg)), cprod(s.p.map(cneg)));
  return { z, p: [...ps.map((q) => q[0]), ...ps.map((q) => q[1])], k: s.k * ratio.re };
}

/** s -> z with s = 2 fs (z - 1) / (z + 1); zeros at infinity map to z = -1 (Nyquist). */
export function bilinear(s: Zpk, fs: number): Zpk {
  const fs2 = cx(2 * fs);
  const d = degree(s);
  const z = s.z.map((v) => cdiv(cadd(fs2, v), csub(fs2, v)));
  for (let i = 0; i < d; i++) z.push(cx(-1));
  const p = s.p.map((v) => cdiv(cadd(fs2, v), csub(fs2, v)));
  const ratio = cdiv(cprod(s.z.map((v) => csub(fs2, v))), cprod(s.p.map((v) => csub(fs2, v))));
  return { z, p, k: s.k * ratio.re };
}

const TOL = 100 * Number.EPSILON;

/** Split into one representative (imag > 0) per conjugate pair and the real values, sorted as scipy's _cplxreal. */
export function cplxreal(values: Complex[]): { zc: Complex[]; zr: number[] } {
  if (!values.length) return { zc: [], zr: [] };
  const sorted = values.slice().sort((a, b) => a.re - b.re || Math.abs(a.im) - Math.abs(b.im));
  const isRealAt = sorted.map((v) => Math.abs(v.im) <= TOL * cabs(v));
  const zr = sorted.filter((_, i) => isRealAt[i]).map((v) => v.re);
  if (zr.length === values.length) return { zc: [], zr };
  const rest = sorted.filter((_, i) => !isRealAt[i]);
  const zp = rest.filter((v) => v.im > 0);
  const zn = rest.filter((v) => v.im < 0);
  if (zp.length !== zn.length) throw new WaveBenchError("DESIGN_FAILED", "complex value without a matching conjugate");
  // Runs of (approximately) equal real part are ordered by |imag|.
  let i = 0;
  while (i < zp.length - 1) {
    if (zp[i + 1].re - zp[i].re <= TOL * cabs(zp[i])) {
      let j = i + 1;
      while (j < zp.length - 1 && zp[j + 1].re - zp[j].re <= TOL * cabs(zp[j])) j++;
      for (const chunk of [zp, zn]) {
        const part = chunk.slice(i, j + 1).sort((a, b) => Math.abs(a.im) - Math.abs(b.im));
        chunk.splice(i, part.length, ...part);
      }
      i = j + 1;
    } else i++;
  }
  for (let n = 0; n < zp.length; n++) {
    if (cabs(csub(zp[n], cconj(zn[n]))) > TOL * cabs(zn[n])) {
      throw new WaveBenchError("DESIGN_FAILED", "complex value without a matching conjugate");
    }
  }
  return { zc: zp.map((v, n) => ({ re: (v.re + zn[n].re) / 2, im: (v.im - zn[n].im) / 2 })), zr };
}

const isReal = (v: Complex) => v.im === 0;

function nearestIndex(from: Complex[], to: Complex, which: "real" | "complex" | "any"): number {
  const order = from.map((_, i) => i).sort((a, b) => cabs(csub(from[a], to)) - cabs(csub(from[b], to)));
  if (which === "any") return order[0];
  const found = order.find((i) => (which === "real") === isReal(from[i]));
  if (found === undefined) throw new WaveBenchError("DESIGN_FAILED", "no zero available to pair with a pole");
  return found;
}

function section(zeros: Complex[], poles: Complex[]): number[] {
  const b = poly(zeros).map((c) => c.re);
  const a = poly(poles).map((c) => c.re);
  const row = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < b.length; i++) row[3 - b.length + i] = b[i];
  for (let i = 0; i < a.length; i++) row[6 - a.length + i] = a[i];
  return row;
}

/** Second-order sections [b0 b1 b2 1 a1 a2] per row; poles closest to the unit circle go to the last section. */
export function zpk2sos(input: Zpk): Float64Array {
  const z = input.z.slice();
  const p = input.p.slice();
  if (!z.length && !p.length) return Float64Array.of(input.k, 0, 0, 1, 0, 0);
  while (p.length < z.length) p.push(cx(0));
  while (z.length < p.length) z.push(cx(0));
  const sections = Math.floor((Math.max(p.length, z.length) + 1) / 2);
  if (p.length % 2 === 1) {
    p.push(cx(0));
    z.push(cx(0));
  }
  const zs = cplxreal(z);
  const ps = cplxreal(p);
  const zz: Complex[] = [...zs.zc, ...zs.zr.map((v) => cx(v))];
  const pp: Complex[] = [...ps.zc, ...ps.zr.map((v) => cx(v))];
  const worst = (arr: Complex[]) => {
    let best = 0;
    let dist = Infinity;
    arr.forEach((v, i) => {
      const d = Math.abs(1 - cabs(v));
      if (d < dist) {
        dist = d;
        best = i;
      }
    });
    return best;
  };
  const take = (arr: Complex[], i: number) => arr.splice(i, 1)[0];
  const realCount = (arr: Complex[]) => arr.filter(isReal).length;
  const sos = new Float64Array(sections * 6);
  for (let si = sections - 1; si >= 0; si--) {
    const p1 = take(pp, worst(pp));
    let row: number[];
    if (isReal(p1) && realCount(pp) === 0) {
      const z1 = take(zz, nearestIndex(zz, p1, "real"));
      row = section([z1, cx(0)], [p1, cx(0)]);
    } else if (pp.length + 1 === zz.length && !isReal(p1) && realCount(pp) === 1 && realCount(zz) === 1) {
      const z1 = take(zz, nearestIndex(zz, p1, "complex"));
      row = section([z1, cconj(z1)], [p1, cconj(p1)]);
    } else {
      let p2: Complex;
      if (isReal(p1)) {
        const realIdx = pp.map((v, i) => (isReal(v) ? i : -1)).filter((i) => i >= 0);
        p2 = take(pp, realIdx[worst(realIdx.map((i) => pp[i]))]);
      } else p2 = cconj(p1);
      if (zz.length) {
        const z1 = take(zz, nearestIndex(zz, p1, "any"));
        if (!isReal(z1)) row = section([z1, cconj(z1)], [p1, p2]);
        else if (zz.length) row = section([z1, take(zz, nearestIndex(zz, p1, "real"))], [p1, p2]);
        else row = section([z1], [p1, p2]);
      } else row = section([], [p1, p2]);
    }
    sos.set(row, si * 6);
  }
  if (pp.length || zz.length) throw new WaveBenchError("DESIGN_FAILED", "pole-zero pairing left unpaired roots");
  sos[0] *= input.k;
  sos[1] *= input.k;
  sos[2] *= input.k;
  return sos;
}
