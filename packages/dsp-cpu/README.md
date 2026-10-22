# @wavebench/dsp-cpu

The Float64 reference engine. Conventions: [docs/DSP_SPEC.md](../../docs/DSP_SPEC.md); tests: `tests/unit`.

- `fft.ts` – complex and real FFT of any length: iterative radix-2, Bluestein chirp-z otherwise; exact unit roots.
- `windows.ts` – rectangular, Hann, Hamming, Blackman, flat top (periodic or symmetric) and their metrics.
- `detrend.ts` – none, constant, linear (as scipy.signal.detrend).
- `spectrum.ts` – one-sided spectra: peak, RMS, power, PSD, ASD, phase; FFT length rules.
- `frames.ts` – complete-frame Welch and STFT, as generators that report progress.
- `filters/` – Butterworth (zpk route of scipy.signal.butter, "nearest" SOS pairing) and notch design, sosfilt,
  steady-state initial conditions, sosfiltfilt padding, responses from roots or sections, group delay, impulse-energy
  length, conditioning bound.
- `chain.ts` – the ordered processing chain applied to a whole record.
- `peaks.ts` – largest peaks and band RMS.
