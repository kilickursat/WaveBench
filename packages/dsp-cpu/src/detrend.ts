import { CompensatedAccumulator, WaveBenchError } from "@wavebench/core";

/** none: unchanged; constant: subtract the mean; linear: subtract the least-squares line (scipy.signal.detrend). */
export type DetrendMode = "none" | "constant" | "linear";

export function isDetrendMode(v: string): v is DetrendMode {
  return v === "none" || v === "constant" || v === "linear";
}

/** Writes x[start .. start+length) minus its trend into out[0 .. length). */
export function detrendInto(x: ArrayLike<number>, start: number, length: number, mode: DetrendMode, out: Float64Array): void {
  if (length > out.length) throw new WaveBenchError("INVALID_ARGUMENT", "output buffer too short");
  if (mode === "none") {
    for (let n = 0; n < length; n++) out[n] = x[start + n];
    return;
  }
  const sum = new CompensatedAccumulator();
  for (let n = 0; n < length; n++) sum.add(x[start + n]);
  const mean = sum.value / length;
  if (mode === "constant" || length < 2) {
    for (let n = 0; n < length; n++) out[n] = x[start + n] - mean;
    return;
  }
  // Centred index c = n - (L-1)/2: sum(c) = 0 and sum(c^2) = L(L^2-1)/12, so slope = sum(c x) / sum(c^2).
  const centre = (length - 1) / 2;
  const sxy = new CompensatedAccumulator();
  for (let n = 0; n < length; n++) sxy.add((n - centre) * (x[start + n] - mean));
  const slope = sxy.value / ((length * (length * length - 1)) / 12);
  for (let n = 0; n < length; n++) out[n] = x[start + n] - mean - slope * (n - centre);
}

export function detrend(x: ArrayLike<number>, mode: DetrendMode): Float64Array {
  const out = new Float64Array(x.length);
  detrendInto(x, 0, x.length, mode, out);
  return out;
}
