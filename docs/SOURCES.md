# Sources and reference conventions

Reviewed 2026-10-22. These are technical references, not claims that a particular
library has already been integrated. Pin dependency versions and record them in a
lockfile when implementation starts. The fixture generator records its actual
Python, NumPy and SciPy versions separately.

- S01: MDN, GPU.requestAdapter: https://developer.mozilla.org/en-US/docs/Web/API/GPU/requestAdapter
- S02: MDN, GPUAdapter.limits: https://developer.mozilla.org/en-US/docs/Web/API/GPUAdapter/limits
- S03: W3C, WebGPU Shading Language: https://www.w3.org/TR/WGSL/
- S04: SciPy, spectral analysis guide: https://docs.scipy.org/doc/scipy/tutorial/signal.html
- S05: SciPy, periodogram: https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.periodogram.html
- S06: SciPy, Welch PSD: https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.welch.html
- S07: SciPy, ShortTimeFFT: https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.ShortTimeFFT.html
- S08: SciPy, forward-backward filtering: https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.filtfilt.html
- S09: SciPy, SOS forward-backward filtering: https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.sosfiltfilt.html
- S10: SciPy, polyphase resampling: https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.resample_poly.html
- S11: SciPy, Lomb-Scargle: https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.lombscargle.html
- S12: uPlot upstream README, Canvas 2D and MIT license: https://github.com/leeoniya/uPlot
- S13: fft.js upstream README, transform sizes and MIT license: https://github.com/indutny/fft.js
- S14: Vite, project scaffolding: https://vite.dev/guide/
- S15: MDN, transferable objects: https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects
- S16: MDN, OffscreenCanvas.getContext: https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas/getContext
- S17: Analog Devices AN-1057, acceleration and gravity: https://www.analog.com/en/resources/app-notes/an-1057.html
- S18: NIST, standard acceleration of gravity: https://physics.nist.gov/cgi-bin/cuu/Value?gn=
- S19: SciPy, periodic versus symmetric Hann windows: https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.windows.hann.html

Added with the implementation (0.1.0):

- S20: L. Bluestein, "A linear filtering approach to the computation of discrete Fourier transform", IEEE Trans. Audio Electroacoustics 18(4), 1970 (chirp-z FFT of any length).
- S21: E. Bainville, "OpenCL Fast Fourier Transform" (radix-2 Stockham kernels): http://www.bealto.com/gpu-fft.html
- S22: W3C, WGSL floating-point accuracy (sin/cos absolute error 2^-11 on [-pi, pi]): https://www.w3.org/TR/WGSL/#floating-point-accuracy
- S23: P. Welch, "The use of fast Fourier transform for the estimation of power spectra", IEEE Trans. Audio Electroacoustics 15(2), 1967.
- S24: F. J. Harris, "On the use of windows for harmonic analysis with the discrete Fourier transform", Proc. IEEE 66(1), 1978 (coherent gain, ENBW, scalloping).
- S25: S. J. Orfanidis, Introduction to Signal Processing, Prentice Hall, 1996, sec. 11.3 (second-order notch design used by scipy.signal.iirnotch).
- S26: SciPy, Butterworth design: https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.butter.html and zpk2sos pairing: https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.zpk2sos.html
- S27: SciPy, iirnotch: https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.iirnotch.html
- S28: mpmath, arbitrary-precision arithmetic used for the exact filter references: https://mpmath.org/
- S29: S. van der Walt and N. Smith, the viridis, magma and inferno colour maps (CC0): https://bids.github.io/colormap/
- S30: G. D'Antona and A. Ferrero, Digital Signal Processing for Measurement Systems, Springer, 2006 (the flat top window coefficients used by SciPy).
