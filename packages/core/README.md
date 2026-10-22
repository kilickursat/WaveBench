# @wavebench/core

Data handling shared by every engine, with no dependencies.

- `timebase.ts` – t[n] = t0 + n/fs, sampling summaries, complete-frame counts; timestamp diagnostics (order, gaps,
  least-squares rate, residual policy).
- `csv.ts` – delimiter, decimal and header detection (with user overrides), a streaming parser that keeps every row,
  ISO 8601 date-times at full fractional precision, formula-safe CSV text.
- `units.ts` – acceleration, voltage and count units with exact factors (1 g = 9.80665 m/s²).
- `stats.ts` – population statistics with compensated sums; `sum.ts` – Neumaier summation.
- `generator.ts` – deterministic synthetic signals (sine, offset, linear chirp, seeded Gaussian noise, pulse).
- `errors.ts` – `WaveBenchError`, the explicit refusal used everywhere.
