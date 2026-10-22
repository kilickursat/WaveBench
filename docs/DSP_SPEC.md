# Numerical and signal-processing contract

Status: normative, implemented in WaveBench 0.1.0. Equations here define WaveBench's
behaviour; every backend must match them, and the tests in tests/unit and tests/e2e
check that they do (docs/VALIDATION.md). Sources are listed in SOURCES.md. User data
and raw samples remain immutable. Sections marked "(0.1.0)" record the definitions the
implementation added to the original contract.

## Time-domain statistics

For the selected finite samples x[n], N > 0:
- mean = sum(x) / N
- RMS = sqrt(sum(x^2) / N)
- AC RMS = sqrt(sum((x - mean)^2) / N)
- population standard deviation = AC RMS (label the denominator N)
- peak absolute = max(abs(x))
- peak-to-peak = max(x) - min(x)
- crest factor = peak absolute / RMS; undefined when RMS=0, not infinity or zero

State whether statistics describe raw or processed samples and which interval is
used. Missing samples are never silently discarded to produce a misleading time
axis. More advanced estimators must declare their conventions.

## Real FFT and PSD

Let L be the selected analysis length, M be the FFT length with M >= L, w[n] the
window, fs > 0, and u[n] the signal after the specified detrend. Define:

```text
X[k] = sum_{n=0}^{L-1} w[n] u[n] exp(-i 2 pi k n / M)
f[k] = k fs / M, k=0,...,floor(M/2)
C[k] = 1 at DC, and at Nyquist only when M is even; otherwise 2
A_peak[k] = C[k] abs(X[k]) / abs(sum(w))
PSD[k] = C[k] abs(X[k])^2 / (fs sum(w^2))
```

A_peak uses a coherent-gain correction suitable for resolved bin-centered tones;
it is not a guarantee of exact amplitude for every off-bin or overlapping tone.
Reject an amplitude-normalization window with zero coherent gain. PSD requires a
nonzero energy window. For a sinusoidal RMS amplitude spectrum, divide interior
A_peak bins by sqrt(2), not DC or the even-M Nyquist bin. The PSD unit is inputUnit^2/Hz
and amplitude retains inputUnit [S04,S05]. Phase is angle(X[k]) referenced to the
analysis segment's first sample; mask or warn for phase near the magnitude floor.

Frequency spacing is fs/M. Zero padding samples the same windowed transform more
densely; it does not supply a longer observation or independently resolve arbitrary
closely spaced frequencies [S04]. Show both L and M, and never truncate an input
segment implicitly because the chosen M is too small. A radix-2 backend can support
M restricted to powers of two initially; report this capability and the padding.

For a rectangular window without detrending, sum(PSD)*fs/M equals mean(x^2).
For a general window, the corresponding quantity is sum((w*u)^2)/sum(w^2).
Do not assert an exact raw variance identity for an arbitrary window and mean policy.

## Output quantities (0.1.0)

From the same transform, with C[k] as above:

```text
peak[k]  = C[k] |X[k]| / |sum(w)|
rms[k]   = peak[k] / sqrt(2) for interior bins; = peak[k] at DC and at the even-M Nyquist bin
power[k] = C[k] |X[k]|^2 / sum(w)^2          (= rms[k]^2, unit^2)
psd[k]   = C[k] |X[k]|^2 / (fs sum(w^2))     (unit^2/Hz)
asd[k]   = sqrt(psd[k])                       (unit/sqrt(Hz))
```

power[k] = psd[k] x ENBW, with ENBW = fs sum(w^2) / sum(w)^2 in Hz, exactly and bin by
bin; the application derives power and ASD from the PSD this way. Decibels use
10 log10 for power and PSD and 20 log10 for peak, RMS and ASD, always relative to 1 in
the displayed unit ("dB re 1 g^2/Hz").

Transforms of any length are exact: powers of two use an iterative radix-2 FFT, other
lengths Bluestein's chirp-z identity (j^2 reduced modulo 2N before forming angles).
The FFT length is "exact" (M = L), "next power of two" or a chosen M >= L; a shorter M is
refused rather than truncating data. Twiddle factors are built with exact octant
symmetries (e.g. W^(N/4) = -i exactly).

Phase is shown in degrees for bins whose peak amplitude lies within 60 dB of the
largest bin; below that floor it is NaN: there the phase is set by leakage, noise and
rounding, not by a signal component.

## Windows

Support rectangular, periodic Hann, Hamming and Blackman with exact definitions in
the recipe. Default spectral window: periodic Hann. For L > 1:

```text
w[n] = 0.5 - 0.5 cos(2 pi n / L), n=0,...,L-1
```

A symmetric Hann uses L-1 in the denominator and is not identical. Use the periodic
variant for the reference spectral tests [S19]. Store the convention explicitly.

Implemented (0.1.0): all windows are generalised cosine sums
w[n] = sum_k (-1)^k a_k cos(2 pi k n / D), with D = L (periodic, used by every analysis)
or D = L - 1 (symmetric, available to the library), and the coefficients of
scipy.signal.windows:

| Window | a_0, a_1, ... | Coherent gain sum(w)/L | ENBW (bins) |
| --- | --- | --- | --- |
| Rectangular | 1 | 1 | 1 |
| Hann | 0.5, 0.5 | 0.5 | 1.5 |
| Hamming | 0.54, 0.46 | 0.54 | 1.363 |
| Blackman | 0.42, 0.5, 0.08 | 0.42 | 1.727 |
| Flat top | 0.21557895, 0.41663158, 0.277263158, 0.083578947, 0.006947368 | 0.21557895 | 3.770 |

The flat top window recovers the amplitude of an off-bin tone to within about 0.2 %
(tested); with Hann the scalloping loss can reach 1.4 dB. A flat top window takes
negative values; its energy sum(w^2) is still positive.

## Welch PSD

Split a uniform segment into length-L frames with hop H, detrend each frame according
to the configured policy, compute its windowed PSD, then take the arithmetic mean.
Default proposal: periodic Hann, 50% overlap, mean averaging, PSD scaling. This is
Welch averaging, not the FFT of an averaged waveform [S06]. Reject a segment shorter
than the chosen window unless the user changes the configuration. Do not silently
let a library reduce L and still display the original requested setting.

Implemented (0.1.0): the overlap is entered in percent and rounded to whole samples,
noverlap = round(L p / 100) clipped to [0, L-1], H = L - noverlap; the realised H and
overlap are displayed and recorded. Frames are averaged with compensated sums. Samples
after the last complete segment are reported as unused. Band RMS is
sqrt(sum_k psd[k] df) over the bins with f_low <= f[k] <= f_high (rectangle rule, df =
fs/M); over all bins with constant detrending it is shown beside the time-domain AC RMS
as a Parseval consistency check (equal for stationary signals up to estimation
variance and frames left out).

## STFT

For the first release use complete frames only, no boundary padding:

```text
frameCount = max(0, 1 + floor((N - L) / H))
frameStart[p] = p H
frameTime[p] = startOffsetSec + (p H + L/2) / fs
X[p,k] = FFT_M(w[n] u[p H+n])[k]
```

Frame time is explicitly the L/2 window-center convention (matching the convention
used by this fixture generator); it is not the midpoint of first/last sample labels.
Warn or reject zero-frame results. Permit zero padding within each FFT only when
M>=L, and record it separately from boundary padding. Configure detrending per frame
explicitly. Display PSD, amplitude or magnitude with a labeled normalization, never
an unlabeled abs(FFT) called physical acceleration [S05,S07].

Illustrative fs=1000 Hz, L=M=1024, H=256 yields window duration 1.024 s, hop 0.256 s,
75% overlap, and bin spacing 0.9765625 Hz. These are example choices, not universal
settings. Longer windows improve frequency discrimination at the expense of temporal
localization; increasing overlap does not shorten the physical analysis window.

For dB amplitude use 20 log10(A/Aref); for PSD use 10 log10(P/Pref). State reference
units and value. A display floor clips colors, not stored numerical spectra. Do not
average dB values and label the result an arithmetic mean PSD.

Implemented (0.1.0): each frame can be shown as PSD, peak amplitude or power (the
same per-frame scaling as a single spectrum). A spectrogram may hold at most 2^24
cells (frames x bins); larger requests are refused with the numbers, so the user can
increase the hop. Frame times use L/2 for every window; for odd L this is half a
sample after the centre of the first and last sample times, as documented. Display:
cell (p, k) covers t in [t_p - H/(2 fs), t_p + H/(2 fs)) and f in [f_k - df/2, f_k + df/2);
a pixel covering several cells shows their maximum (sampled with a stride beyond 32
cells per axis), so short events are not lost by zooming out. The colour scale runs
over a stated range of dB below a stated top (default: the largest value).

## Filtering

Offer a visible ordered processing chain and response preview. First family:
Butterworth low/high/band-pass/band-stop and a notch defined by center frequency and
Q (or another explicitly converted bandwidth convention). Validate finite cutoff
values strictly inside (0, fs/2), sorted band edges and supported orders.

Use cascaded second-order sections for IIR evaluation. Store both design parameters
and actual coefficients, along with the design algorithm version. Label prototype
order versus realized order for band filters. Provide two distinct modes:

- Causal: stateful forward filtering, phase response and delay visible; streaming
  state must continue across chunks.
- Offline zero-phase: forward-backward filtering, explicit initialization/padding,
  minimum-length check, and edge-transient warning. This is not a streaming method.

Forward-backward filtering squares the magnitude response and doubles the realized
filter order relative to one pass. A single-pass -3 dB design cutoff is not the
combined -3 dB point after two passes. Plot the effective response; do not present
zero phase as an unchanged single-pass response [S08,S09].

Default context proposal: filter each contiguous full record, then crop an analysis
interval. If the user selects crop-then-filter, retain that order and show the new
edge regions. Do not independently filtfilt arbitrary chunks and concatenate them.

Implemented (0.1.0):

- Butterworth design follows the analog-prototype route of scipy.signal.butter:
  poles -exp(i pi m / 2N), frequency transformation (lp2lp, lp2hp, lp2bp, lp2bs), the
  bilinear transform with edges pre-warped as 4 tan(pi f / fs) at a normalised rate of
  2, then pairing into second-order sections with SciPy's "nearest" strategy, so
  coefficients compare one to one with SciPy. |H| = 1/sqrt(2) at every design edge for
  one pass. Orders: 1-16 for low-pass and high-pass, prototype orders 1-10 for
  band-pass and band-stop (realised order 2N).
- Notch (scipy.signal.iirnotch): zeros at exp(+-i w0), -3 dB width exactly f0/Q in Hz
  (the design accounts for frequency warping).
- Sections are evaluated in direct form II transposed with SciPy's operation order.
  Causal filtering starts from zero state or, on request, from the steady state of the
  first sample (sosfilt_zi x[0]). Zero-phase filtering extends the record by padlen =
  3 (2 sections + 1 - min(#b2==0, #a2==0)) samples with odd (default), even or
  constant extension (or none), runs forward and backward from steady states, and
  trims; the record must be longer than padlen.
- The start-up region marked on the time plot is the number of samples holding 99.9 %
  of one pass's impulse-response energy, at the start (causal) or at both ends
  (zero-phase); it is an indication, not a bound.
- Conditioning: Float64 rounding in a section is amplified roughly like 1/delta^2,
  delta = 1 - max|pole| (low cutoffs relative to fs). Each design reports
  max(1e-12, 1e-15/delta^2) as an estimated worst-case relative error; the tests hold
  results to that bound against 50-digit references. The application warns above
  1e-8 and refuses a design above 1e-4.
- Frequency responses and group delays of designed filters are evaluated from their
  zeros and poles, which keeps accuracy near the unit circle (error growing like
  eps/delta instead of eps/delta^2); forward-backward filters are shown as |H|^2 with
  zero phase.

## Timestamps, units and derived channels (0.1.0)

A time column is read as seconds (or ms, µs, ns), or as ISO 8601 date-times kept to
the full precision of their fraction (relative seconds from integer epoch seconds plus
the fractional digits; no zone means UTC arithmetic without daylight-saving
corrections). Diagnostics: non-finite values and decreasing timestamps make the
record invalid (rows are never re-sorted); repeated timestamps, gaps (an increment
above 1.5 x the median) and deviations from the least-squares grid t = a + b n beyond a
tolerance (default 10 % of b) make it irregular. Only a record that is uniform within
the tolerance is analysed, at fs = 1/b from the least-squares fit (default) or 1/median
increment, starting at its first timestamp. The fit tolerates timestamps printed with
coarse resolution, where the median increment can be badly biased. Traces are never
drawn across a gap.

Units: physical value = (raw - offset) x gain, then an exact factor to the displayed
unit (1 g = 9.80665 m/s^2, 1 mg = 1e-3 g, 1 Gal = 0.01 m/s^2). Counts, volts and unknown
units are never converted to acceleration.

The derived |a| = sqrt(x^2 + y^2 + z^2) is computed from the processed component
channels. It is nonlinear: its spectrum is not a combination of the component spectra
(e.g. |sin| has no component at the sine's frequency).

## WebGPU path (0.1.0)

The GPU computes in Float32 with the same plans, windows, frame boundaries and
scaling as the CPU engine. Window samples and FFT twiddles are computed in Float64 on
the CPU and uploaded as correctly rounded Float32 tables (WGSL sin/cos are only
guaranteed to an absolute 2^-11). Per frame, one workgroup removes the mean or line
(workgroup reductions) and applies the window; a radix-2 Stockham FFT runs log2(M)
batched stages; a final pass applies the one-sided scaling. Before upload, the
segment mean is removed in Float64 when frames are detrended (which changes nothing
mathematically and leaves only the variation for Float32). Welch sums frames in chunks
of 64 on the GPU and adds the chunks in Float64 on the CPU. FFT lengths must be powers
of two; other lengths, and anything beyond the device's buffer limits, run on the CPU
with a note. The GPU result is accepted at a normalised L2 error of 1e-4 against the
Float64 engine; measured errors are about 1e-7.

## Display reductions (0.1.0)

Plots of long records and spectra show, per pixel column, the minimum and maximum of
the samples in that column in their order of occurrence, so that every excursion
stays visible. These arrays are never used by an analysis.

## Quality gates

Block a transform on NaN/Inf or unsupported nonuniform sampling. A future interpolation
operation must record the method, gap limits and affected samples. Missing data is
not zero acceleration. Persist calibration and clipping flags into results.

CPU Float64 is the correctness baseline. GPU Float32 must have numerical tolerances,
explicit supported ranges and a CPU fallback. A deterministic recipe means the same
specified operations, not a promise of bitwise equality across GPU vendors.
