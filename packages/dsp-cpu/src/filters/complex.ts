/** Minimal complex arithmetic for filter design (small arrays; clarity over speed). */
export interface Complex {
  re: number;
  im: number;
}

export const cx = (re: number, im = 0): Complex => ({ re, im });
export const cadd = (a: Complex, b: Complex): Complex => ({ re: a.re + b.re, im: a.im + b.im });
export const csub = (a: Complex, b: Complex): Complex => ({ re: a.re - b.re, im: a.im - b.im });
export const cneg = (a: Complex): Complex => ({ re: -a.re, im: -a.im });
export const cconj = (a: Complex): Complex => ({ re: a.re, im: -a.im });
export const cscale = (a: Complex, s: number): Complex => ({ re: a.re * s, im: a.im * s });
export const cabs = (a: Complex): number => Math.hypot(a.re, a.im);

export function cmul(a: Complex, b: Complex): Complex {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re };
}

/** Smith's algorithm: avoids overflow and keeps accuracy when |b.re| and |b.im| differ widely. */
export function cdiv(a: Complex, b: Complex): Complex {
  if (Math.abs(b.re) >= Math.abs(b.im)) {
    const r = b.im / b.re;
    const d = b.re + b.im * r;
    return { re: (a.re + a.im * r) / d, im: (a.im - a.re * r) / d };
  }
  const r = b.re / b.im;
  const d = b.re * r + b.im;
  return { re: (a.re * r + a.im) / d, im: (a.im * r - a.re) / d };
}

/** Principal square root with C99 csqrt semantics, including the sign of a zero imaginary part. */
export function csqrt(z: Complex): Complex {
  const { re: x, im: y } = z;
  if (x === 0 && y === 0) return { re: 0, im: y };
  const r = Math.hypot(x, y);
  if (x >= 0) {
    const t = Math.sqrt((r + x) / 2);
    return { re: t, im: y / (2 * t) };
  }
  const t = Math.sqrt((r - x) / 2);
  const negative = y < 0 || Object.is(y, -0);
  return { re: Math.abs(y) / (2 * t), im: negative ? -t : t };
}

export function cprod(values: Complex[]): Complex {
  return values.reduce((acc, v) => cmul(acc, v), cx(1));
}

/** Polynomial coefficients (highest power first) with the given roots, as numpy.poly. */
export function poly(roots: Complex[]): Complex[] {
  let c: Complex[] = [cx(1)];
  for (const r of roots) {
    const next: Complex[] = new Array(c.length + 1).fill(null).map(() => cx(0));
    for (let i = 0; i < c.length; i++) {
      next[i] = cadd(next[i], c[i]);
      next[i + 1] = csub(next[i + 1], cmul(c[i], r));
    }
    c = next;
  }
  return c;
}
