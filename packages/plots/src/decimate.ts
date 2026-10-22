// Display reduction only: a min/max envelope per pixel column, so that every excursion of the full-resolution
// signal stays visible. Analyses never read these arrays.

/** Group boundaries (length G + 1) splitting [start, end) into at most `buckets` equal index ranges. */
export function linearGroups(start: number, end: number, buckets: number): Int32Array {
  const n = end - start;
  const g = Math.max(1, Math.min(buckets, n));
  const bounds = new Int32Array(g + 1);
  for (let b = 0; b <= g; b++) bounds[b] = start + Math.floor((b * n) / g);
  return bounds;
}

/**
 * Groups of bins whose frequencies fall into the same pixel of a logarithmic axis; `frequencyAt(k)` gives the
 * frequency of bin k (k * df on an FFT grid). Bins with f <= 0 are skipped.
 */
export function logGroups(frequencyAt: (k: number) => number, start: number, end: number, buckets: number): Int32Array {
  let first = start;
  while (first < end && !(frequencyAt(first) > 0)) first++;
  if (first >= end) return Int32Array.of(first, first);
  const lo = Math.log(frequencyAt(first));
  const span = Math.max(Math.log(frequencyAt(end - 1)) - lo, 1e-12);
  const bounds: number[] = [first];
  let current = 0;
  for (let k = first + 1; k < end; k++) {
    const b = Math.min(buckets - 1, Math.floor((buckets * (Math.log(frequencyAt(k)) - lo)) / span));
    if (b !== current) {
      bounds.push(k);
      current = b;
    }
  }
  bounds.push(end);
  return Int32Array.from(bounds);
}

export interface Envelope {
  /** Index positions (fractional allowed) of the output points, shared by all series. */
  index: Float64Array;
  values: Float64Array[];
  /** True when every sample is shown (no reduction). */
  exact: boolean;
}

/**
 * One point per single-member group; two per larger group, at its first and last index, carrying the series'
 * minimum and maximum in the order they occur. NaN samples are skipped; an all-NaN group gives NaN (a gap).
 */
export function minMaxEnvelope(series: ArrayLike<number>[], bounds: Int32Array): Envelope {
  const groups = bounds.length - 1;
  let points = 0;
  for (let g = 0; g < groups; g++) points += bounds[g + 1] - bounds[g] > 1 ? 2 : bounds[g + 1] > bounds[g] ? 1 : 0;
  const index = new Float64Array(points);
  const values = series.map(() => new Float64Array(points));
  let o = 0;
  for (let g = 0; g < groups; g++) {
    const a = bounds[g];
    const b = bounds[g + 1];
    if (b <= a) continue;
    if (b - a === 1) {
      index[o] = a;
      series.forEach((s, c) => (values[c][o] = s[a]));
      o++;
      continue;
    }
    index[o] = a;
    index[o + 1] = b - 1;
    series.forEach((s, c) => {
      let min = Infinity;
      let max = -Infinity;
      let iMin = -1;
      let iMax = -1;
      for (let i = a; i < b; i++) {
        const v = s[i];
        if (v < min) {
          min = v;
          iMin = i;
        }
        if (v > max) {
          max = v;
          iMax = i;
        }
      }
      if (iMin < 0) {
        values[c][o] = values[c][o + 1] = NaN;
      } else if (iMin <= iMax) {
        values[c][o] = min;
        values[c][o + 1] = max;
      } else {
        values[c][o] = max;
        values[c][o + 1] = min;
      }
    });
    o += 2;
  }
  return { index, values, exact: groups === bounds[groups] - bounds[0] };
}
