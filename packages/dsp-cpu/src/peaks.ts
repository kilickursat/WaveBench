export interface Peak {
  bin: number;
  frequencyHz: number;
  value: number;
  /**
   * Frequency from a parabola through the log values of the bin and its neighbours. An estimate: its bias depends
   * on the window and on nearby components. Null at the ends of the spectrum.
   */
  interpolatedHz: number | null;
}

/** Largest local maxima, at least `minSeparationBins` apart; DC is skipped unless includeDc is set. */
export function findPeaks(
  values: Float64Array,
  binWidthHz: number,
  count = 5,
  minSeparationBins = 3,
  includeDc = false,
): Peak[] {
  const candidates: number[] = [];
  const n = values.length;
  for (let k = includeDc ? 0 : 1; k < n; k++) {
    const v = values[k];
    if (!(v > 0) || !Number.isFinite(v)) continue;
    const left = k > 0 ? values[k - 1] : -Infinity;
    const right = k < n - 1 ? values[k + 1] : -Infinity;
    if (v > left && v >= right) candidates.push(k);
  }
  candidates.sort((a, b) => values[b] - values[a]);
  const chosen: number[] = [];
  for (const k of candidates) {
    if (chosen.length >= count) break;
    if (chosen.every((c) => Math.abs(c - k) >= minSeparationBins)) chosen.push(k);
  }
  return chosen.map((k) => {
    let interpolatedHz: number | null = null;
    if (k > 0 && k < n - 1 && values[k - 1] > 0 && values[k + 1] > 0) {
      const a = Math.log(values[k - 1]);
      const b = Math.log(values[k]);
      const c = Math.log(values[k + 1]);
      const den = a - 2 * b + c;
      if (den < 0) interpolatedHz = (k + (0.5 * (a - c)) / den) * binWidthHz;
    }
    return { bin: k, frequencyHz: k * binWidthHz, value: values[k], interpolatedHz };
  });
}

/** sqrt(sum PSD[k] df) over bins with f[k] in [lowHz, highHz]: the RMS in that band (rectangle rule). */
export function bandRms(psd: Float64Array, binWidthHz: number, lowHz: number, highHz: number): { rms: number; bins: number } {
  let sum = 0;
  let bins = 0;
  for (let k = 0; k < psd.length; k++) {
    const f = k * binWidthHz;
    if (f >= lowHz && f <= highHz) {
      sum += psd[k];
      bins++;
    }
  }
  return { rms: Math.sqrt(sum * binWidthHz), bins };
}
