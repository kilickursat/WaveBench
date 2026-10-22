import { readFileSync } from "node:fs";
import { expect } from "vitest";

/** Reference fixtures written by reference/generate_fixtures.py (NumPy/SciPy). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fixture(name: string): any {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
}

export function repoFile(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

/** ||a - b||_2 / ||b||_2 (or ||a||_2 when b is all zero). */
export function relL2(actual: ArrayLike<number>, expected: ArrayLike<number>): number {
  expect(actual.length).toBe(expected.length);
  let num = 0;
  let den = 0;
  for (let i = 0; i < expected.length; i++) {
    const d = actual[i] - expected[i];
    num += d * d;
    den += expected[i] * expected[i];
  }
  return den > 0 ? Math.sqrt(num / den) : Math.sqrt(num);
}

function l2(v: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

function maxAbs(v: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < v.length; i++) m = Math.max(m, Math.abs(v[i]));
  return m;
}

/**
 * CPU gate from docs/VALIDATION.md: ||actual - expected|| / ||ref|| <= gate, and no single entry off by more than
 * 10 gate max|ref|. ref is the expected array itself unless a reference signal is given, e.g. the input of a
 * filter or a detrend, whose outputs can be small by construction (an error relative to ~0 means nothing).
 */
export function expectClose(actual: ArrayLike<number>, expected: ArrayLike<number>, gate = 1e-10, reference?: ArrayLike<number>): void {
  expect(actual.length).toBe(expected.length);
  let num = 0;
  let worst = 0;
  for (let i = 0; i < expected.length; i++) {
    const d = Math.abs(actual[i] - expected[i]);
    if (!(d <= Infinity)) throw new Error(`entry ${i} is ${actual[i]}, expected ${expected[i]}`);
    num += d * d;
    worst = Math.max(worst, d);
  }
  const norm = Math.max(l2(expected), reference ? l2(reference) : 0);
  const scale = Math.max(maxAbs(expected), reference ? maxAbs(reference) : 0);
  const err = norm > 0 ? Math.sqrt(num) / norm : Math.sqrt(num);
  if (!(err <= gate)) throw new Error(`normalised L2 error ${err.toExponential(2)} exceeds ${gate.toExponential(0)}`);
  if (!(worst <= 10 * gate * Math.max(scale, Number.MIN_VALUE))) {
    throw new Error(`largest entry error ${worst.toExponential(2)} exceeds ${(10 * gate * scale).toExponential(2)}`);
  }
}

/** Complex vectors are compared as one vector [re..., im...]. */
export function expectComplexClose(re: ArrayLike<number>, im: ArrayLike<number>, expRe: ArrayLike<number>, expIm: ArrayLike<number>, gate = 1e-10): void {
  expectClose([...Array.from(re), ...Array.from(im)], [...Array.from(expRe), ...Array.from(expIm)], gate);
}

export function flat(rows: number[][]): Float64Array {
  return Float64Array.from(rows.flat());
}

export function seq(n: number, f: (i: number) => number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = f(i);
  return out;
}
