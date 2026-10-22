/** Significant-digit formatting without exponent noise for everyday magnitudes. */
export function num(v: number | null | undefined, digits = 4): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e6 || a < 1e-4) return v.toExponential(Math.max(0, digits - 1)).replace("e+", "e");
  return Number(v.toPrecision(digits)).toLocaleString("en-US", { maximumFractionDigits: 12 });
}

export function int(v: number): string {
  return Math.round(v).toLocaleString("en-US");
}

export function seconds(v: number): string {
  if (!Number.isFinite(v)) return "–";
  const a = Math.abs(v);
  if (a !== 0 && a < 1e-3) return `${num(v * 1e6, 4)} µs`;
  if (a !== 0 && a < 1) return `${num(v * 1e3, 4)} ms`;
  if (a < 600) return `${num(v, 6)} s`;
  return `${num(v / 60, 5)} min`;
}

export function hertz(v: number): string {
  if (!Number.isFinite(v)) return "–";
  if (Math.abs(v) >= 1e3) return `${num(v / 1e3, 5)} kHz`;
  return `${num(v, 5)} Hz`;
}

export function percent(v: number, digits = 3): string {
  return `${num(100 * v, digits)} %`;
}

/** Axis tick text: compact, no trailing zeros. uPlot may pass null for splits it does not label. */
export function tick(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "";
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e5 || a < 1e-3) return v.toExponential(1).replace("e+", "e");
  return String(Number(v.toPrecision(6)));
}
