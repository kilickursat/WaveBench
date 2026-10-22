# @wavebench/dsp-webgpu

WebGPU compute (Float32) with the same plans, frames and scaling as the CPU engine.

- `shaders.ts` – WGSL: framing with workgroup-reduced detrend and windowing, radix-2 Stockham FFT stages, one-sided
  scaling, Welch chunk sums, maximum, and the spectrogram fragment shader. Window samples and twiddles come from
  Float64 tables (WGSL sin/cos are only accurate to 2^-11).
- `spectral.ts` – `GpuSpectral`: segment spectra, Welch, STFT kept on the GPU; batching within device limits; refuses
  non-power-of-two lengths so callers fall back to the CPU.
- `render.ts` – draws a spectrogram buffer into a WebGPU canvas (OffscreenCanvas in the worker), no read-back.
- `device.ts` – adapter and device with error scopes and device-loss tracking.
- `selftest.ts` – GPU against the Float64 engine; used in the app (*Check this GPU*) and in CI.
