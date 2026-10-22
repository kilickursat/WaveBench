/**
 * Neumaier's compensated summation. The rounding error stays at a few ulps of the result regardless of the
 * number of terms, which keeps means and mean squares of long records accurate in Float64.
 */
export function compensatedSum(values: ArrayLike<number>, start = 0, end = values.length): number {
  let sum = 0;
  let c = 0;
  for (let i = start; i < end; i++) {
    const v = values[i];
    const t = sum + v;
    c += Math.abs(sum) >= Math.abs(v) ? sum - t + v : v - t + sum;
    sum = t;
  }
  return sum + c;
}

/** Streaming form of {@link compensatedSum}. */
export class CompensatedAccumulator {
  private sum = 0;
  private c = 0;

  add(v: number): void {
    const t = this.sum + v;
    this.c += Math.abs(this.sum) >= Math.abs(v) ? this.sum - t + v : v - t + this.sum;
    this.sum = t;
  }

  get value(): number {
    return this.sum + this.c;
  }
}
