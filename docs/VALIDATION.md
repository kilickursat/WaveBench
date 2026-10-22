# Validation

This page records what is checked, against what, with which tolerance, and what was measured. Numbers are from the
commit that adds this file, run with the commands below; CI repeats every check on each push. Nothing listed under
"Not validated" should be read as tested.

## What runs where

| Suite | Command | Environment | Result |
| --- | --- | --- | --- |
| Reference generation and self-checks | `npm run fixtures` (`python reference/generate_fixtures.py`) | Python 3.12.14, NumPy 2.3.5, SciPy 1.17.0, mpmath 1.3.0 | 82 checks pass; the template's original fixtures reproduce byte for byte |
| Unit tests (CPU engine, import, timebase, units, recipes) | `npm test` | Node.js 20.19.6, Vitest 4.1.12 | 250 tests pass |
| Browser checks of the build | `npm run build && npm run test:e2e` | Playwright 1.59.1, Chromium headless shell, WebGPU on SwiftShader (software adapter) | 31/31 GPU comparisons pass; UI smoke test, CPU fallback without WebGPU, no network requests, no page errors |

The fixture generator is the independent reference: it writes the expected arrays with NumPy and SciPy, checks them
against analytic results (Parseval, -3 dB points, flat-top amplitude, notch zeros, ShortTimeFFT frame times), and for
filters computes exact values in 50-digit arithmetic with an implementation that does not use SciPy. The manifest
(`reference/manifest.json`) records the environment and the SHA-256 of every fixture and example.

## Gates

| Comparison | Measure | Gate | Why this gate |
| --- | --- | --- | --- |
| CPU spectra, Welch, STFT against SciPy | normalised L2 ‖a − b‖/‖b‖ | 1e-12 | Float64 rounding of the FFT and sums is ~1e-15; the margin covers accumulation over long frames |
| CPU complex FFT against numpy.fft | normalised L2 over [re, im] | 1e-13 | |
| Windows, detrending, statistics | normalised L2 (detrend: relative to the input) | 1e-14 | a residual that is zero by construction is judged against the signal scale, not against ~0 |
| Filters against 50-digit references and SciPy | normalised L2 relative to the input | max(1e-12, 1e-15/δ²), δ = 1 − max\|pole\| | rounding in a section is amplified like 1/δ² near the unit circle; well-conditioned designs get 1e-12 |
| WebGPU against the Float64 CPU engine, and against SciPy | normalised L2 | 1e-4 | the gate of the original specification for Float32; measured errors are ~1e-7 |

Complex results are compared as one vector; every comparison also bounds the largest single error (10 x gate x the
largest reference value), so one wrong bin cannot hide in an L2 norm.

### Filters and conditioning

The filter fixtures include designs whose poles lie within 1.6e-4 of the unit circle (a 1 Hz low-pass at 10 kHz, a
0.2 Hz high-pass at 1024 Hz). Against the exact values, SciPy's own Float64 results are off by up to 1.5e-10 there, and
WaveBench's by up to 2.8e-10; for every design with δ ≥ 0.01 both are within 1e-13. The gate max(1e-12, 1e-15/δ²)
contains both everywhere, and the fixture generator asserts that SciPy satisfies it as well. Frequency responses of
designed filters are evaluated from their zeros and poles: against the exact response their error is below the gate
divided by 100. The application refuses designs whose bound exceeds 1e-4 and warns above 1e-8.

## Coverage

| Area | Reference | Cases |
| --- | --- | --- |
| FFT | numpy.fft (complex and real) | 15 lengths: 1–8, 16, 31, 97, 100, 128, 255, 256, 360 (radix-2 and Bluestein); zero padding 100 → 256; a direct DFT for 6 awkward lengths; Parseval at 65,536 and 65,537 |
| Windows | scipy.signal.get_window | 5 windows × 8 lengths, periodic and symmetric; coherent gain and ENBW |
| Detrending | scipy.signal.detrend | constant and linear, lengths 1–257 |
| One-sided spectra | scipy.signal.periodogram | the template's 8 cases (bin-centred sine, DC, Nyquist, odd length, zero padding, Hann two tones, zero, impulse) and 3 more (flat top off-bin tone with constant detrend, linear detrend with zero padding, Blackman at length 600) |
| Scaling identities | analytic | peak, RMS, power = RMS², ASD = √PSD; Parseval with and without a window; zero padding keeps amplitudes; flat top recovers an off-bin amplitude to 0.2 % (Hann does not); phase referenced to the first sample |
| Welch | scipy.signal.welch | 6 configurations: windows, overlaps 0–75 %, zero padding, detrend none/constant/linear, density and spectrum scaling, a non-integer rate; white noise of standard deviation σ gives 2σ²/fs within 2 % |
| STFT | explicit NumPy frames, cross-checked with scipy.signal.ShortTimeFFT | 4 configurations incl. zero padding and odd L; PSD, peak amplitude and power; frame times |
| Butterworth | scipy.signal.butter / sosfilt / sosfiltfilt, mpmath | 22 designs (low-pass, high-pass, band-pass, band-stop, orders 1–10, cutoffs from 2e-4 to 0.49 of the rate): SOS coefficients, pole radius, response at probe frequencies, -3 dB at every edge, steady-state initial conditions, causal and zero-phase outputs, 4 designs with even, constant and no padding |
| Notch | scipy.signal.iirnotch | 4 designs: coefficients, outputs, exact zero at f0, -3 dB width f0/Q |
| Filter physics | analytic | forward-backward halves a tone at the cutoff with zero phase shift; group delay of delays and a one-pole filter; impulse-energy length of a one-pole filter |
| Timestamps | constructed records | exact rates, 4-decimal and millisecond timestamps (where the median interval is biased and the least-squares fit is not), gaps and segments, decreasing and missing values, jitter |
| Import | constructed files and the examples | delimiters, decimal comma with many rows (a regression test), metadata lines, quotes, BOM and CRLF, missing and unreadable cells kept with line numbers, ISO date-times with sub-millisecond digits and time zones, chunk boundaries anywhere |
| Recipes | the bundled example recipe | schema, mapping by column name, missing columns, refusal of other schemas |
| WebGPU | the Float64 engine and the SciPy fixtures | FFT 2 to 262,144 points; STFT with Hann/linear detrend, flat top/constant detrend, Blackman/zero padding; Welch; 6 spectra, 2 Welch and 1 STFT fixture through the application's own import and analysis path |

## Measured performance

Not a guarantee: one machine, one browser. A 2-vCPU Intel Xeon Platinum 8259CL, Chromium headless shell, CPU engine
(Float64), 1,000,000 samples per channel.

| Operation | Time |
| --- | --- |
| Read a 35.9 MB CSV (1,000,000 rows × 4 columns) | 1.5 s |
| Timestamp diagnostics and set-up | 0.21 s |
| FFT of the full record, exact length 1,000,000 (Bluestein), 3 channels | 4.5 s |
| FFT of 524,288 samples (power of two), 3 channels | 0.9 s |
| Welch PSD, L = 4096, 50 % overlap, 3 channels | 0.77 s |
| STFT, L = 1024, 75 % overlap (3,903 frames), 1 channel | 0.54 s |
| Zero-phase 4th-order Butterworth low-pass, 3 channels | 0.35 s |

The same STFT on the SwiftShader software adapter takes 8.3 s: a CPU emulation of a GPU, useful for correctness,
meaningless for speed. GPU timings on real hardware have not been measured here; the app shows the time of every
result, including upload and read-back.

## Not validated

- WebGPU on real GPU hardware. CI and the measurements above use SwiftShader. Run *Compute → Check this GPU against
  the CPU* in the app to validate a particular adapter and driver.
- Browsers other than Chromium; mobile devices beyond screenshots of the layout.
- Files larger than about 1,000,000 rows (memory limits depend on the browser and device).
- Real sensor calibration: offsets and gains are applied as entered.

## Reproduce

```sh
python -m venv .venv && .venv/bin/pip install -r reference/requirements.txt
.venv/bin/python reference/generate_fixtures.py   # regenerates fixtures, manifest and validation-summary.json
npm ci && npm test
npx playwright install chromium
npm run build && REQUIRE_WEBGPU=1 npm run test:e2e
```
