// Browser checks of the built app (dist/wavebench-offline.html, opened from disk; no server):
//  1. GPU self-test in the engine worker: WebGPU Float32 against the Float64 CPU engine (gate 1e-4).
//  2. Reference fixtures through the app's own path (CSV text -> parse -> configure -> WebGPU spectrum, Welch and
//     STFT), compared here against the SciPy values in tests/fixtures (gate 1e-4).
//  3. A UI smoke test of the bundled example.
//  4. No network request and no page error during the run.
// Without a WebGPU adapter the GPU checks are reported as SKIPPED (never as passed); REQUIRE_WEBGPU=1 makes that
// a failure (CI sets it: headless Chromium has a software adapter, SwiftShader).
//   npm run build && node tests/e2e/run.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../..", import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(`${root}tests/fixtures/${name}`, "utf8"));
const GATE = 1e-4;
const results = [];
const failures = [];

function relL2(a, b) {
  let num = 0;
  let den = 0;
  for (let i = 0; i < b.length; i++) {
    num += (a[i] - b[i]) ** 2;
    den += b[i] ** 2;
  }
  return den > 0 ? Math.sqrt(num / den) : Math.sqrt(num);
}

function record(name, error, extra = "") {
  const pass = Number.isFinite(error) && error <= GATE;
  results.push({ name, error, pass, extra });
  if (!pass) failures.push(`${name}: error ${error}`);
}

const browser = await chromium.launch({
  args: [
    "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan=swiftshader", "--use-webgpu-adapter=swiftshader",
    "--disable-vulkan-surface", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
  ],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const network = [];
const pageErrors = [];
page.on("request", (r) => {
  if (!/^(file|blob|data):/.test(r.url())) network.push(r.url());
});
page.on("pageerror", (e) => pageErrors.push(e.message));
page.on("console", (m) => m.type() === "error" && pageErrors.push(m.text()));
await page.goto(`file://${root}dist/wavebench-offline.html`);
await page.waitForFunction(() => window.wavebench?.getState().gpu !== null, null, { timeout: 60000 });
const gpu = await page.evaluate(() => window.wavebench.getState().gpu);
console.log(`WebGPU: ${gpu.available ? gpu.adapter : `not available (${gpu.reason})`}`);

/** Load a single-column signal into the engine with an assigned rate, as an imported file would be. */
async function loadSignal(values, fs) {
  const text = `x\n${values.map(String).join("\n")}\n`;
  return page.evaluate(async ({ text, fs }) => {
    const { engine } = window.wavebench;
    await engine.call({ type: "load", text, name: "fixture.csv", kind: "file", options: { delimiter: ",", decimal: ".", skipLines: 0, hasHeader: true } });
    return engine.call({
      type: "configure",
      config: {
        channels: [{ column: 0, label: "x", enabled: true, offset: 0, gain: 1 }], unit: "m/s^2", displayUnit: "m/s^2",
        timebase: { mode: "rate", sampleRateHz: fs, startSec: 0 }, rows: { start: 0, end: text.split("\n").length - 2 }, magnitude: false,
      },
    });
  }, { text, fs });
}

const call = (request) => page.evaluate((r) => window.wavebench.engine.call(r), request);

if (gpu.available) {
  // 1. Self-test.
  const rows = await call({ type: "gpuSelfTest" });
  for (const r of rows) record(`self-test: ${r.check} (${r.size})`, r.error);

  // 2a. One-sided spectra (template fixture), power-of-two lengths only (the GPU path's domain).
  for (const c of fixture("spectra-golden.json").cases) {
    if ((c.fftLength & (c.fftLength - 1)) !== 0 || c.name === "zero") continue;
    await loadSignal(c.input, c.sampleRateHz);
    const win = c.windowName === "hann-periodic" ? "hann" : c.windowName;
    const r = await call({ type: "spectrum", source: "raw", interval: { start: 0, end: c.input.length }, settings: { window: win, detrend: "none", fftLength: c.fftLength }, backend: "webgpu" });
    if (r.provenance.backend !== "webgpu") failures.push(`spectrum ${c.name}: ran on ${r.provenance.backend}`);
    const re = Object.values(r.channels[0].re);
    const im = Object.values(r.channels[0].im);
    record(`spectrum ${c.name} (M=${c.fftLength})`, relL2([...re, ...im], [...c.expected.complexReal, ...c.expected.complexImag]));
  }

  // 2b. Welch, power-of-two FFT lengths.
  const welch = fixture("welch-golden.json");
  for (const c of welch.cases) {
    if ((c.fftLength & (c.fftLength - 1)) !== 0 || c.scaling !== "density") continue;
    await loadSignal(welch.input, c.sampleRateHz);
    const factor = c.fftLength / c.windowLength;
    if (!Number.isInteger(factor)) continue;
    const r = await call({
      type: "welch", source: "raw", interval: { start: 0, end: welch.input.length }, backend: "webgpu",
      settings: { window: c.window, windowLength: c.windowLength, overlapPercent: (100 * (c.windowLength - c.hopLength)) / c.windowLength, fftFactor: factor, detrend: c.detrend },
    });
    if (r.provenance.backend !== "webgpu") failures.push(`welch ${c.window}: ran on ${r.provenance.backend}`);
    record(`Welch ${c.window} L=${c.windowLength} H=${r.hopLength} M=${c.fftLength} ${c.detrend}`, relL2(Object.values(r.channels[0].psd), c.expected), `${r.frames} segments`);
  }

  // 2c. STFT matrices, read back through the CSV export.
  const stft = fixture("stft-golden.json");
  for (const c of stft.cases) {
    if ((c.fftLength & (c.fftLength - 1)) !== 0) continue;
    const factor = c.fftLength / c.windowLength;
    if (!Number.isInteger(factor)) continue;
    await loadSignal(stft.input, c.sampleRateHz);
    const overlapPercent = (100 * (c.windowLength - c.hopLength)) / c.windowLength;
    const meta = await call({
      type: "stft", source: "raw", interval: { start: 0, end: stft.input.length }, channel: "c0", quantity: c.output, backend: "webgpu",
      settings: { window: c.window, windowLength: c.windowLength, overlapPercent, fftFactor: factor, detrend: c.detrend },
    });
    if (meta.provenance.backend !== "webgpu") failures.push(`stft ${c.window}: ran on ${meta.provenance.backend}`);
    const csv = await call({ type: "export", what: "stft-csv", interval: { start: 0, end: stft.input.length } });
    const lines = csv.trim().split("\n").slice(1).map((l) => l.split(",").map(Number));
    const times = lines.map((l) => l[0]);
    const values = lines.flatMap((l) => l.slice(1));
    record(`STFT ${c.window} L=${c.windowLength} H=${c.hopLength} M=${c.fftLength} ${c.output}`, relL2(values, c.expectedFrameMajor.flat()));
    const timeError = Math.max(...times.map((t, i) => Math.abs(t - c.frameTimesSec[i])));
    if (!(timeError < 1e-12)) failures.push(`STFT ${c.window}: frame times differ by ${timeError}`);
  }
} else {
  console.log("GPU checks: SKIPPED (no WebGPU adapter)");
  if (process.env.REQUIRE_WEBGPU === "1") failures.push("a WebGPU adapter is required (REQUIRE_WEBGPU=1)");
}

// 3. UI smoke test with the bundled example.
await page.evaluate(() => window.wavebench.actions.openExample("with-time"));
await page.waitForFunction(() => window.wavebench.getState().configured?.samples === 8192, null, { timeout: 60000 });
for (const tab of ["fft", "welch", "stft", "stats", "data"]) {
  await page.evaluate((t) => window.wavebench.setState({ tab: t }), tab);
  await page.waitForTimeout(tab === "stft" ? 4000 : 1500);
}
const ui = await page.evaluate(() => {
  const s = window.wavebench.getState();
  return { fs: s.configured.sampleRateHz, quality: s.configured.diagnostics?.quality, statsRows: document.querySelectorAll(".panel.analysis table.grid tbody tr").length };
});
if (ui.fs !== 1024 || ui.quality !== "uniform-within-policy") failures.push(`example timebase: ${JSON.stringify(ui)}`);

await browser.close();

// 5. Without WebGPU (no flags: headless Chromium on Linux then offers no adapter) everything runs on the CPU.
{
  const plain = await chromium.launch({ args: [] });
  const p = await plain.newPage({ viewport: { width: 1440, height: 900 } });
  p.on("pageerror", (e) => pageErrors.push(`(no WebGPU) ${e.message}`));
  await p.goto(`file://${root}dist/wavebench-offline.html`);
  await p.waitForFunction(() => window.wavebench?.getState().gpu !== null, null, { timeout: 60000 });
  const g = await p.evaluate(() => window.wavebench.getState().gpu);
  if (g.available) console.log("CPU fallback check: SKIPPED (this browser offers WebGPU without flags)");
  else {
    await p.evaluate(() => window.wavebench.actions.openExample("with-time"));
    await p.waitForFunction(() => window.wavebench.getState().configured?.samples === 8192, null, { timeout: 60000 });
    await p.evaluate(() => window.wavebench.setState({ tab: "stft" }));
    await p.waitForFunction(() => /drawn with Canvas 2D/.test(document.querySelector(".panel.analysis .status-line")?.textContent ?? ""), null, { timeout: 60000 });
    const status = await p.textContent(".panel.analysis .status-line");
    if (!/CPU/.test(status)) failures.push(`CPU fallback: unexpected status "${status}"`);
    else console.log("CPU fallback without WebGPU: spectrogram on the CPU, drawn with Canvas 2D");
  }
  await plain.close();
}

for (const r of results) console.log(`${r.pass ? "pass" : "FAIL"}  ${r.error.toExponential(2)}  ${r.name}${r.extra ? `  (${r.extra})` : ""}`);
console.log(`network requests: ${network.length ? network.join(" ") : "none"}`);
if (network.length) failures.push("the page made network requests");
if (pageErrors.length) failures.push(...pageErrors.map((e) => `page error: ${e}`));
console.log(`${results.filter((r) => r.pass).length}/${results.length} GPU comparisons within ${GATE}${gpu.available ? "" : " (GPU checks skipped)"}`);
if (failures.length) {
  console.log(`\nFAILED:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("All browser checks passed.");
