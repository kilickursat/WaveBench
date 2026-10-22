# Browser checks

`run.mjs` opens the built `dist/wavebench-offline.html` from disk in headless Chromium (Playwright) and checks:

1. the GPU self-test: WebGPU (Float32) against the Float64 engine for FFT sizes 2 to 262,144, three STFT variants and a
   Welch PSD (gate 1e-4);
2. SciPy fixtures through the application's own path (CSV text → parse → configure → WebGPU spectrum, Welch, STFT);
3. a UI smoke test with the bundled example;
4. the CPU fallback in a browser without WebGPU (spectrogram computed on the CPU and drawn with Canvas 2D);
5. that the page made no network request and raised no error.

Without a WebGPU adapter the GPU checks are reported as skipped; `REQUIRE_WEBGPU=1` (set in CI) turns that into a
failure. Headless Chromium provides a software adapter (SwiftShader), so these checks validate correctness, not speed.

```sh
npx playwright install chromium
npm run build && REQUIRE_WEBGPU=1 npm run test:e2e
```
