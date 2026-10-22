# WaveBench - project blueprint

Status: product and engineering specification. Version 0.1.0 implements it; what is
done and what remains is tracked in ROADMAP.md, and what is verified in VALIDATION.md.
Initial focus: offline file analysis of three-axis acceleration, with a generic
multichannel signal model underneath.

## 1. Product statement

An open-source, local-first browser workbench for importing raw sensor records,
constructing or validating their timebase, processing selected channels, and
exploring time-domain, FFT, PSD and STFT results through linked scientific plots.
Use WebGPU to accelerate appropriate workloads, without making GPU availability a
condition of access to the user's data. Use an Origin-style worksheet plus graph
workflow, rather than attempting to reproduce an entire desktop statistics suite.

The core product promise is reproducibility: every displayed result has a known
source, channel, time selection, unit, processing sequence and numerical convention.

Proposed user journey:

```text
Import file -> Map columns and units -> Establish/validate timebase
-> Inspect data quality -> Select interval/channels -> Configure processing
-> Compare raw/processed waveforms -> FFT / PSD / STFT
-> Inspect peaks and statistics -> Export results plus analysis recipe
```

The first release should require no account, server-side processing or uploads.
Serve the app over HTTPS, or through a local development server. Offline-after-
installation behavior is a separate PWA milestone, not an automatic consequence of
client-side computation. WebGPU requires an appropriate secure context and runtime
capability checks [S01].

## 2. Scope and feature priorities

| Module | First usable release | Later expansion |
| --- | --- | --- |
| Import | CSV, TSV, delimited TXT; headers/delimiters/column mapping; file preview | XLSX, binary readers, instrument adapters |
| Timing | Assigned sampling rate, explicit timestamps, sample/time display, gap diagnostics | Clock synchronization and multi-device drift correction |
| Channels | X/Y/Z, arbitrary channel labels, calibrated units, visibility and comparison | More sensors, coordinate rotations and richer calibration matrices |
| Time analysis | Raw/processed traces, range selection, mean, RMS, AC RMS, standard deviation, peak, peak-to-peak, crest factor | Rolling statistics, event detection, envelope and correlation |
| Preprocessing | Calibration, mean removal, linear detrend, explicit invalid-data policy | General resampling UI, interpolation tools and advanced repair |
| Filters | Butterworth low/high/band-pass/band-stop, notch, response preview, causal/offline modes | FIR designer, additional filter families and envelopes |
| Frequency | Real FFT amplitude and phase, periodogram, Welch PSD, dominant peaks | Coherence, cross spectra, FRF, modal workflows |
| Time-frequency | STFT spectrogram, selectable window/hop/FFT length, linked cursor | Wavelets, inverse transforms, order tracking |
| Compute | Worker-based CPU baseline and WebGPU batched STFT for supported devices | WASM backend and additional GPU kernels |
| Export | Processed CSV, spectra CSV, PNG figures, JSON recipe and metadata | Vector plot export and composed reports |

Live Web Serial/Web Bluetooth acquisition, automatic diagnosis, machine learning,
cloud accounts and 3D scenes are explicitly outside the first release. Design a
future acquisition interface, but do not let streaming requirements delay correct
file analysis.

## 3. Import and timebase contract

Support two main input forms:

```csv
ax,ay,az
0.01,-0.02,1.00
0.02,-0.01,1.01
```

```csv
time_s,ax,ay,az
0.000,0.01,-0.02,1.00
0.001,0.02,-0.01,1.01
```

Without timestamps, require a positive sampling rate supplied by the user or
trusted acquisition metadata. Amplitude samples alone do not determine that rate.
For N samples indexed n = 0,...,N-1, define:

```text
dt = 1 / fs
t[n] = startOffsetSec + n / fs
lastSampleTime = startOffsetSec + (N - 1) / fs
acquisitionSpanConvention = N / fs
NyquistFrequency = fs / 2
```

Example: N=60,000 and fs=1,000 Hz gives dt=0.001 s, a last relative sample at
59.999 s, a nominal acquisition span of 60 s, and Nyquist=500 Hz. Label the duration
convention instead of silently mixing the last sample's timestamp and N/fs.

Keep three separate actions in the interface:

| Action | What changes | What does not change |
| --- | --- | --- |
| Set/override sampling rate | Interpretation of sample timing and all dependent frequency results | Stored sample values and count |
| Change time origin | Time labels and absolute origin metadata | Sample spacing and spectrum |
| Resample to a new rate | Sample values, count, rate, and downstream results | The intended physical observation interval |

Resampling is a signal-processing operation. Downsampling needs an anti-alias
strategy; it is not implemented by editing fs or picking every kth sample [S10].
Offer resampling only after its numerical implementation is verified. Until then,
show it as planned, not as an active control.

With timestamps, retain original values and units. Check finite values, monotonicity,
duplicates, missing rows, gaps, jitter and mismatch with nominal fs. Estimate fs from
median positive increments as a diagnostic, not proof of uniform sampling. Store the
sampling quality thresholds and their rationale. Never silently sort timestamps,
remove gaps, or compress rows with missing values.

Ordinary FFT/STFT should be blocked for unsupported irregular records until the user
chooses a contiguous verified segment or an explicit, documented conversion to a
uniform grid. Lomb-Scargle can be a later alternative for irregularly sampled spectral
analysis [S11]. Interpolation across gaps is an assumption, not recovered evidence.

Store absolute origin separately from Float64 relative seconds. Use implicit timing
for uniformly sampled data where possible. Do not pass Unix epoch timestamps as
Float32 GPU coordinates.

## 4. Acceleration-specific behavior

Retain raw measurements without modification. Store sensor ID, channel axis,
orientation convention, unit, scale, offset and calibration provenance. Counts,
volts, g and m/s^2 must not be treated as interchangeable. With an agreed linear
calibration convention:

```text
physicalValue = (rawValue - offsetRawUnits) * gainPhysicalUnitsPerRawUnit
```

Support unit conversion using 1 standard g = 9.80665 m/s^2 [S18]. An unknown
calibration must remain visible as unknown; do not label raw counts as acceleration.

Provide separate X/Y/Z traces. An optional derived magnitude is
sqrt(ax^2 + ay^2 + az^2), but mark it as a nonlinear derived channel. It is not a
replacement for the three signed component spectra and can introduce frequency
content absent from each signed component (for example, abs(sin) differs from sin).

Mean removal is not a universal gravity-removal algorithm. Changing sensor
orientation changes how gravity projects onto the axes [S17]. Keep gravity
compensation and velocity/displacement integration outside the initial release;
those require additional assumptions, calibration and drift controls.

## 5. User interface and interactions

```text
+----------------------------------------------------------------------------+
| WaveBench   Import   Save project   Export       CPU/GPU status              |
+-----------------+---------------------------------------+------------------+
| DATASETS        | Time history: X / Y / Z               | PARAMETERS       |
| Run 001         | raw + processed; linked selection    | fs / time origin |
|   X   Y   Z     +-------------------+-------------------+ units/calibration|
| Run 002         | FFT / PSD         | STFT spectrogram  | filter controls  |
|                 | peaks + cursors   | time/frequency    | FFT/window       |
| PROCESSING      +-------------------+-------------------+ hop/overlap      |
| Calibrate       | Worksheet / statistics / peak table  | scaling / dB ref |
| Detrend         | provenance / warnings / task status  | Apply / reset    |
| Filter          |                                       |                  |
+-----------------+---------------------------------------+------------------+
```

All time views share selection boundaries; selecting a time-frequency location
highlights its contributing time window. Show the active analysis interval and
whether a result uses raw or processed samples. Separate viewport changes from
analysis-range changes: merely panning a chart must not silently recalculate a
new scientific result.

Display each channel consistently, with distinguishable line styles as well as
color. Include keyboard controls, readable units, dark/light themes, a virtualized
worksheet, filter-response preview, and progress/cancel controls. Keep large sample
arrays out of React state; UI state should contain lightweight references and
parameters.

Parameter edits create a draft. An explicit Apply action or debounced preview
creates a versioned result. Mark old results stale; do not show an old spectrum
under newly edited parameters. Preserve raw data and support undo/redo through
operation history rather than repeated full-array copies.

## 6. Architecture

```text
Main UI (React/TypeScript)
  | commands, parameters, lightweight result summaries
  v
Import + analysis worker / job manager
  |-- Data store: typed arrays, immutable inputs, quality masks
  |-- Processing planner: validation, dependencies, caching, cancellation
  |-- CPU engine: Float64 correctness baseline, recursive SOS filters
  |-- WebGPU engine: Float32 kernels, batched FFT/STFT, spectral reductions
  |-- Result registry: units, ranges, provenance, warnings
  `-- Spectrogram renderer on same GPU device, where supported
```

Suggested implementation choices:

| Concern | Proposed choice | Reason / constraint |
| --- | --- | --- |
| Application | React + TypeScript + Vite | Typed browser app; Vite has a React/TS starter [S14] |
| State | Small store or React context | Store metadata/IDs, not multi-million-row objects |
| Time/frequency traces | uPlot | Canvas 2D charting; not a WebGPU renderer [S12] |
| Spectrogram | Custom WebGPU texture renderer, CPU/Canvas fallback | Keep large time-frequency arrays near compute |
| CPU FFT | Own Float64 FFT (radix-2 + Bluestein, any length) | Chosen over fft.js, whose power-of-two limit would force padding [S13] |
| GPU DSP | Native WebGPU + WGSL | Explicit kernels and numerical validation [S03] |
| Compute isolation | Web Workers + transferable ArrayBuffers | Transfer buffer ownership deliberately [S15] |
| Persistence | JSON recipe initially; IndexedDB/OPFS later | Explicit local retention and deletion policy |
| Tests | Node/Vitest; Playwright when app exists; Python/SciPy oracle | Separate algorithm, browser and GPU checks |

A rendering library does not provide a validated signal-processing FFT by itself.
Treat CPU FFT and GPU FFT as replaceable backends behind a common numerical contract.
An existing WGSL FFT implementation is a candidate, not an accepted dependency until
its license, supported sizes, accuracy and failure behavior are checked.

Suggested execution split: CPU for parsing, quality checks, short records, coefficient
design and recursive IIR filtering; GPU candidate workloads include many STFT frames,
windowing, magnitude/PSD, reductions, long convolution and spectrogram coloring.
Benchmark these choices rather than claiming GPU is universally faster. Include
upload, compilation and readback in end-to-end measurements.

Use Float64 CPU reference calculations and Float32 GPU calculations with documented
tolerances. WGSL does not offer a general Float64 arithmetic type [S03]. Record the
backend and precision for every result. Query actual GPU limits; a supported browser
can still return no adapter, and allocations must fit the selected device [S01,S02].

If worker WebGPU and OffscreenCanvas work together, keep compute and spectrogram
rendering in the same worker/device [S16]. Otherwise use a tested alternate rendering
path. GPU buffers are not generic message payloads to share arbitrarily across
independent GPU devices. Handle device loss, cancellation and allocation failures
without corrupting the input dataset.

## 7. Memory, responsiveness and local privacy

Use columnar typed arrays rather than one JavaScript object per sample. Ten million
samples on each of three Float32 channels require 120,000,000 bytes for those values
alone. Parsing buffers, timestamps, copies, FFT workspace and spectrograms add to
that total; do not advertise arbitrary file sizes without measured limits.

Parse files incrementally. Build min/max display summaries and a multiresolution
view cache. Plot reductions are only for display: analysis always reads the chosen
full-resolution signal. Keep maximum excursions visible when reducing long records.

Tile STFT work by frame batches, preserve overlapping samples between batches, and
avoid unnecessary GPU readback. Recursive filters retain state across causal chunks.
Forward-backward filtering requires a whole-segment strategy or a separately
validated block method; naive chunk-by-chunk filtering is not equivalent [S08,S09].

Every long task has a job ID, progress status, cancellation and a revision token so
late results cannot replace newer results. Detect device limits and warn before
unaffordable operations. Default policy: no telemetry, data uploads, remote fonts or
CDN dependencies after deployment; verify this policy with network tests. Explain
which project data are retained locally and how to remove them.

## 8. Reproducibility and export

The recipe must include input identity (prefer a content hash), original column
mapping, source units, calibration, timebase source, active interval, ordered
processing steps, invalid-data policy, filter coefficients/design parameters,
window samples or definition, hop, FFT length, normalization, boundary convention,
backend/precision and application/algorithm versions.

An export bundles processed CSV, spectral tables, PNG views and recipe JSON. A
recipe alone does not contain the source measurements; clearly distinguish a
recipe-only export from a portable project archive containing data. Export a
content hash or clearly state that identity has not been verified.

Do not generate SVG by hiding an entire screenshot inside an SVG container and call
it vector output. Genuine vector plot export is a separate renderer/task. PNG is an
honest first-release target.

## 9. Implementation milestones

| Milestone | Deliverable | Exit condition |
| --- | --- | --- |
| M0: Scientific contract | Units, timebase, scaling conventions, reference fixtures | Off-by-one, DC/Nyquist, PSD and filter tests specified |
| M1: Import and time view | CSV mapping, quality report, linked X/Y/Z traces and stats | Example files load without silently altering timing |
| M2: CPU analysis | FFT, periodogram, Welch, filters and STFT | Results match independent references under stated conventions |
| M3: WebGPU path | Batched STFT, GPU spectrum/texture path, auto/CPU/GPU selector | Numerical comparison plus measured end-to-end benchmark |
| M4: Reproducible beta | Export/import recipe, histories, documentation, static deployment | New user can reproduce a bundled example |
| M5: Extensions | Additional formats, WASM, resampling UI, streaming and advanced tools | Separate scientific and UX acceptance tests |

Call the first GPU release a beta only after the numerical CPU/GPU comparison and
unsupported-device fallback tests pass. Targets are milestones, not delivery-time
or speed guarantees.

## 10. Proposed repository layout

```text
wavebench/
  apps/web/                   # planned React/Vite interface
  packages/core/              # types, timebase, units, numerical contracts
  packages/dsp-cpu/            # planned CPU FFT/filter/STFT implementations
  packages/dsp-webgpu/         # planned GPU device manager and WGSL kernels
  packages/plots/              # planned linked charts and spectrogram renderer
  examples/                   # synthetic, redistributable data + recipes
  reference/                  # SciPy fixture generator + pinned environment
  tests/unit/                 # runnable timebase tests in this draft
  tests/fixtures/             # generated numerical golden arrays
  tests/e2e/                  # planned browser tests
  docs/                       # blueprint, DSP spec, validation, roadmap, sources
  .github/                    # CI, Pages deployment and contribution templates
  CONTRIBUTING.md
  README.md
```

The repository follows this layout. Packages are source folders compiled with the
application; they are not published to npm separately (yet).

License: Apache License 2.0 (LICENSE). Third-party notices are listed in NOTICE. The
included synthetic example data avoid redistribution of confidential sensor logs.

## 11. Recommended first vertical slice

Implement one real path before expanding the menu: import X/Y/Z CSV without time,
set fs and units, generate the time axis, select an interval, inspect raw traces,
apply an optional low-pass filter, view correctly normalized FFT and STFT, and
export the exact recipe. Then implement the GPU backend against that same behavior.
The differentiator should be trustworthy local analysis, not the number of buttons.
