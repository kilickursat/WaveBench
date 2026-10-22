# Contributing to WaveBench

Thank you for helping. Bug reports with a small test file, reference results from other tools, and pull requests are
all welcome. Please be kind and constructive ([CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)).

## Set up

Node.js 20.19 or newer.

```sh
npm ci
npm test            # unit tests in Node (Vitest)
npm run typecheck
npm run build       # dist/index.html and dist/wavebench-offline.html (the same single file)
npm run dev         # development server
```

Browser checks use Playwright's Chromium, which offers a software WebGPU adapter (SwiftShader):

```sh
npx playwright install chromium
npm run build && REQUIRE_WEBGPU=1 npm run test:e2e
```

Reference fixtures are generated with pinned NumPy, SciPy and mpmath:

```sh
python -m venv .venv && .venv/bin/pip install -r reference/requirements.txt
.venv/bin/python reference/generate_fixtures.py
```

## Where things live

| Folder | Contents |
| --- | --- |
| `packages/core` | timebase, units, CSV import, statistics, synthetic signals |
| `packages/dsp-cpu` | Float64 FFT, windows, detrending, spectra, Welch, STFT, filter design and filtering |
| `packages/dsp-webgpu` | WGSL kernels, GPU spectral engine, spectrogram renderer, GPU self-test |
| `packages/plots` | colour maps, heatmap mapping, display decimation |
| `apps/web` | the application (React; the engine worker owns all sample arrays) |
| `reference` | the fixture generator and its pinned environment |
| `tests/unit`, `tests/e2e`, `tests/fixtures` | tests and reference data |
| `docs` | numerical contract, validation record, user guide, roadmap |

## Rules for changes

The point of WaveBench is results that can be trusted. These rules keep it that way.

- **Numerical changes come with an independent reference.** Add or extend a fixture in `reference/generate_fixtures.py`
  (SciPy, NumPy, or an exact computation) or an analytic test, and update [docs/DSP_SPEC.md](docs/DSP_SPEC.md) when a
  convention changes. Do not loosen a tolerance to make a test pass; if a case is ill-conditioned, document why and give
  it a justified gate, or refuse it in the application.
- **Never assume silently.** No implicit zero padding or truncation, no re-sorting of timestamps, no zero-filling of
  missing values, no unit conversion without an exact factor. Refuse with an explanation instead.
- **Raw data are immutable.** Every processing step writes a new array. Display reductions (envelopes, max-pooled
  pixels) are never used for analysis.
- **Label everything.** Results state their signal, interval, window, lengths, Δf, ENBW, backend and precision. Units
  appear on axes, tables and CSV headers.
- **CPU Float64 is the reference.** GPU code must match it within the documented gate and fall back to the CPU when it
  cannot run. A GPU check that did not run is reported as skipped, never as passed.
- **Treat imported content as data.** Never evaluate text from files; put file-provided labels into the page as text,
  not HTML; neutralise spreadsheet formulas in exported CSV text fields.
- **No uploads, telemetry or third-party requests.** The app must work from a local file with no network; the browser
  checks assert that it makes no requests.
- **Keep the interface plain.** Short labels with units, the same control for the same job everywhere, no decoration.

## Pull requests

- One topic per pull request, with tests. Describe the user-visible behaviour, the numerical assumptions, the tests you
  ran (with their output), and any limits.
- Before pushing: `npm run typecheck && npm test && npm run build`, and the browser checks when you touched the GPU,
  the worker or the UI.
- Sign off your commits (`git commit -s`) to certify the [Developer Certificate of Origin](https://developercertificate.org/).
- Data: contribute only synthetic records or measurements you may publish. No confidential, personal or customer data.

## Reporting bugs

Open an issue with the steps, what you expected, what you saw, the browser and its version, and if possible a small CSV
file (synthetic is fine) and the recipe exported from the app (*Export → Save recipe*).

## License

By contributing you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
