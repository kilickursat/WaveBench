# User guide

WaveBench runs entirely in your browser: files are read on your device and never uploaded. Open it at
<https://kilickursat.github.io/WaveBench/>, or open `wavebench-offline.html` (from the releases) straight from disk.

## 1. Open data

- **Open file** (or drop a file anywhere on the page): CSV, TSV or TXT, one row per sample.
- **Examples**: two synthetic 3-axis records (8,192 samples at 1024 Hz) – one with a time column, one without – and the
  **signal generator**, which makes tones, chirps, noise and pulses with known values.

The import dialog shows what was detected and lets you change it:

| Setting | What it means |
| --- | --- |
| Delimiter, decimal mark | Comma, semicolon, tab, vertical bar or spaces; `1.5` or `1,5` |
| Lines to skip, first line | Metadata lines before the table; whether the first table line holds column names |
| Column roles | **Signal**, **Time** or **Ignore** for each column (on the preview) |
| Signal unit | The unit of the values in the file. Counts and volts stay counts and volts until calibrated |
| Time column unit | Seconds, milliseconds, microseconds or nanoseconds (date-times are read as such) |
| Sampling rate, start time | Needed when there is no time column: sample n is at start + n / fs |

Cells that cannot be read are kept as **missing** (never zero) and listed with their line numbers. Filters and
transforms refuse a channel with missing samples; choose rows without them under **Data → Rows used**.

## 2. Check the timebase

**Sampling rate** mode uses the rate you entered. **Time column** mode checks the timestamps:

- *Uniform within the tolerance* – the timestamps stay within the tolerance (default 10 % of an interval) of a uniform
  grid; the rate is the least-squares fit (or the median interval, if you prefer).
- *Irregular* – repeated timestamps, gaps or larger deviations. Spectra and filters are blocked, because the Fourier
  transform assumes equal spacing. Use the offered remedies: treat the record as sampled at the fitted rate (a
  deliberate choice, recorded in the recipe), or use the longest stretch of rows without gaps.
- *Invalid* – timestamps that decrease or are missing. Rows are never re-sorted.

The summary shows N, 1/fs, the span N/fs (one interval longer than last minus first sample), the last sample time and
the Nyquist frequency fs/2.

## 3. Channels and units

Untick a column to leave it out. Rename channels in place. **Show in** converts acceleration exactly between g, mg,
m/s², mm/s² and Gal. **Calibration** applies value = (raw − offset) × gain per channel. **Add |a|** adds the magnitude
√(x² + y² + z²) of the processed axes; it is a nonlinear, derived channel, so its spectrum is not a combination of the
axis spectra.

## 4. Process

Add steps under **Processing** and press **Apply**; results keep using the applied chain until you do.

- **Filter**: Butterworth low-pass, high-pass, band-pass or band-stop, or a notch (centre and Q, where Q = centre /
  -3 dB width).
  - *Zero-phase (forward-backward)*: no delay, magnitude |H|²: the design cutoff becomes -6 dB. Needs the whole record.
  - *Causal (single pass)*: -3 dB at the cutoff, with the phase delay shown under **Filter response**.
- **Remove mean**: subtracts the mean of the whole record (or a straight-line trend).

Filters run on the whole record before the analysis interval is cut. Their start-up regions are shaded on the time
plot. Very low cutoffs relative to the sampling rate are numerically delicate: WaveBench warns, or refuses when Float64
accuracy could not be trusted, and suggests what to change.

## 5. Look at the signal

The time plot shows raw, processed or both. Drag to zoom, use the mouse wheel, double-click to see everything. Zooming
never changes a result: the **analysis interval** does, and you set it by Shift+drag, by typing the start and end, or
with **Use visible range** / **Whole record**. Long records are drawn as a min/max envelope per pixel column, so no peak
disappears; analyses always use every sample.

## 6. Analyse

Every result names the signal (raw or processed), its interval, its settings, and where it was computed (CPU Float64 or
WebGPU Float32) and how long it took.

- **Spectrum (FFT)** – one transform of the whole interval. Output: peak amplitude, RMS amplitude, power, PSD or ASD.
  Windows: Hann (default), Hamming, Blackman, flat top (best for reading tone amplitudes), rectangular. FFT length:
  exact, next power of two or custom (zero padding samples the transform more finely; it adds no resolution). The table
  lists the largest peaks at their bin frequencies; hover a row for an interpolated estimate.
- **PSD (Welch)** – the average of the PSDs of overlapping segments: smoother, at a coarser Δf. The side table gives the
  RMS in a frequency band, and the time-domain AC RMS beside it as a consistency check.
- **Spectrogram (STFT)** – PSD, amplitude or power of successive frames, in dB. Hover a cell for its time, frequency and
  value; the frame's samples are highlighted on the time plot. Longer frames resolve frequency better and time worse.
- **Filter response** – magnitude (dB), phase and group delay of the applied filters.
- **Statistics** – N, mean, RMS, AC RMS (standard deviation), min, max, peak, peak-to-peak and crest factor.
- **Data** – every sample: raw and processed values with their time and file row.

## 7. Export and repeat

**Export** writes CSV files of the spectrum, PSD, spectrogram, statistics and signals; the filter coefficients
(second-order sections, JSON); a PNG figure of what is on screen; and a **recipe** (JSON) with every setting, the
conventions used and the SHA-256 of the input file. **Apply recipe** applies one to the file that is open, matching
columns by name.

## 8. Compute: CPU and WebGPU

The **Compute** menu shows whether WebGPU is available and lets you choose:

- *Auto* (default): spectrograms on WebGPU when available; spectra and PSD on the CPU in Float64.
- *CPU only*: everything in Float64.
- *WebGPU where possible*: FFT, Welch and STFT on the GPU in Float32 (power-of-two FFT lengths; other lengths fall back
  to the CPU with a note).

**Check this GPU against the CPU** runs FFTs from 2 to 262,144 points, three spectrograms and a Welch PSD on your GPU
and reports their error against the Float64 engine (expected around 1e-7; the gate is 1e-4).

## Keyboard and accessibility

All controls are reachable with the keyboard; menus close with Escape. Channel identity is never colour alone: stacked
plots are labelled and every plot has a legend. Values are available as tables (peaks, band RMS, statistics, data) and
as CSV.
