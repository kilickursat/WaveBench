import { useRef } from "react";
import { initGpu, openExample, openFile, runSelfTest } from "../state/actions";
import { setState, useApp } from "../state/store";
import type { BackendPreference } from "../engine/protocol";
import {
  exportFigure, exportFilters, exportRecipe, exportSignals, exportSpectrumCsv, exportStatsCsv, exportWelchCsv, loadRecipe,
} from "../lib/exports";
import { results } from "../lib/results";
import { VERSION } from "../lib/version";
import { Icon, Menu, MenuItem, Select } from "./ui";

const DOCS = "https://github.com/kilickursat/WaveBench#readme";

export function TopBar() {
  const fileRef = useRef<HTMLInputElement>(null);
  const recipeRef = useRef<HTMLInputElement>(null);
  const source = useApp((s) => s.source);
  const process = useApp((s) => s.process);
  const theme = useApp((s) => s.theme);
  const ready = useApp((s) => !!s.configured);
  const cycleTheme = () => {
    const next = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
    setState({ theme: next });
    try {
      if (next === "system") localStorage.removeItem("wavebench.theme");
      else localStorage.setItem("wavebench.theme", next);
    } catch {
      // storage unavailable: the choice lasts for this visit
    }
  };
  return (
    <header className="topbar">
      <button className="btn ghost icon only-narrow" aria-label="Show settings" onClick={() => setState((s) => ({ sidebarOpen: !s.sidebarOpen }))}>
        <Icon name="menu" />
      </button>
      <div className="brand">
        <Icon name="logo" size={20} />
        <span className="brand-name">WaveBench</span> <small>{VERSION}</small>
      </div>
      <button className="btn" onClick={() => fileRef.current?.click()} title="Open a CSV, TSV or TXT file (it stays on this computer)">
        <Icon name="open" />
        <span className="label">Open file</span>
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".csv,.tsv,.txt,.dat,.asc,text/csv,text/plain"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void openFile(f);
        }}
      />
      <Menu label="Examples" icon="wave" title="Synthetic example data">
        {(close) => (
          <>
            <MenuItem title="3-axis acceleration with a time column" detail="examples/acceleration-with-time.csv · 8,192 rows at 1024 Hz" onClick={() => { close(); void openExample("with-time"); }} />
            <MenuItem title="3-axis acceleration, sampling rate only" detail="examples/acceleration-raw.csv · rate from its recipe" onClick={() => { close(); void openExample("rate-only"); }} />
            <hr />
            <MenuItem title="Signal generator…" detail="tones, chirps, noise and pulses with known values" onClick={() => { close(); setState({ generatorOpen: true }); }} />
          </>
        )}
      </Menu>
      <Menu label="Export" icon="download" title="Export results">
        {(close) => {
          const run = (f: () => unknown) => () => {
            close();
            void f();
          };
          return (
            <>
              <MenuItem title="Spectrum (CSV)" disabled={!results.fft} onClick={run(exportSpectrumCsv)} />
              <MenuItem title="PSD, Welch (CSV)" disabled={!results.welch} onClick={run(exportWelchCsv)} />
              <MenuItem title="Spectrogram (CSV)" disabled={!results.stft} detail="frames × frequency bins" onClick={run(() => exportSignals("stft-csv"))} />
              <MenuItem title="Statistics (CSV)" disabled={!results.stats} onClick={run(exportStatsCsv)} />
              <hr />
              <MenuItem title="Processed signals (CSV)" disabled={!ready} onClick={run(() => exportSignals("processed-csv"))} />
              <MenuItem title="Calibrated signals (CSV)" detail="after calibration and unit, before processing" disabled={!ready} onClick={run(() => exportSignals("raw-csv"))} />
              <MenuItem title="Filter coefficients (JSON)" disabled={!process?.steps.some((s) => s.sos)} onClick={run(exportFilters)} />
              <MenuItem title="Figure (PNG)" disabled={!ready} onClick={run(exportFigure)} />
              <hr />
              <MenuItem title="Save recipe (JSON)" detail="settings for repeating this analysis" disabled={!source} onClick={run(exportRecipe)} />
              <MenuItem title="Apply recipe…" disabled={!source} onClick={run(() => recipeRef.current?.click())} />
            </>
          );
        }}
      </Menu>
      <input
        ref={recipeRef}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void loadRecipe(f);
        }}
      />
      <div className="spacer" />
      <ComputeMenu />
      <button className="btn ghost icon" onClick={cycleTheme} aria-label={`Theme: ${theme}`} title={`Theme: ${theme} (click to change)`}>
        <Icon name={theme === "dark" ? "moon" : "sun"} />
      </button>
      <a className="btn ghost icon hide-narrow" href={DOCS} target="_blank" rel="noreferrer" aria-label="Documentation" title="Documentation">
        <Icon name="help" />
      </a>
    </header>
  );
}

const BACKENDS: { value: BackendPreference; label: string }[] = [
  { value: "auto", label: "Auto: spectrograms on WebGPU, spectra and PSD on the CPU" },
  { value: "cpu", label: "CPU only (Float64)" },
  { value: "webgpu", label: "WebGPU where possible (Float32)" },
];

function ComputeMenu() {
  const gpu = useApp((s) => s.gpu);
  const backend = useApp((s) => s.backend);
  const selfTest = useApp((s) => s.selfTest);
  const label = gpu?.available ? (backend === "cpu" ? "CPU · Float64" : "WebGPU ready") : gpu ? "CPU · Float64" : "Compute";
  return (
    <Menu label={<span><span className={`dot-inline ${gpu?.available ? "on" : ""}`} />{label}</span>} icon="chip" align="right" title="Compute backend">
      {() => (
        <div className="compute-panel">
          <h3 style={{ fontSize: 13, marginBottom: 6 }}>Compute</h3>
          <Select ariaLabel="Backend" value={backend} options={BACKENDS} onChange={(v) => setState({ backend: v })} />
          <p className="hint">
            The CPU path computes in Float64 and is checked against SciPy. WebGPU computes in Float32 (relative error near 1e-7) and
            handles power-of-two FFT lengths; anything else falls back to the CPU, and every result names the backend it used.
          </p>
          <div className="callout" style={{ marginTop: 10 }}>
            {gpu === null ? (
              "Checking for WebGPU…"
            ) : gpu.available ? (
              <>
                <strong>WebGPU: {gpu.adapter}</strong>
                {gpu.fallback && <div>A software adapter: results are correct but not fast.</div>}
                <div>Largest buffer: {gpu.maxBufferMiB?.toLocaleString()} MiB</div>
              </>
            ) : (
              <>
                <strong>WebGPU not available</strong>
                {gpu.reason}. Everything works on the CPU.
              </>
            )}
          </div>
          {gpu?.available && (
            <>
              <div className="row-actions">
                <button className="btn small" disabled={selfTest?.running} onClick={() => void runSelfTest()}>
                  {selfTest?.running ? "Checking…" : "Check this GPU against the CPU"}
                </button>
              </div>
              {selfTest && (
                <div style={{ maxHeight: 260, overflow: "auto", marginTop: 8 }}>
                  <table className="grid">
                    <thead>
                      <tr>
                        <th>Check</th>
                        <th>Size</th>
                        <th>Error</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {selfTest.rows.map((r, i) => (
                        <tr key={i}>
                          <td>{r.check}</td>
                          <td>{r.size}</td>
                          <td>{r.error.toExponential(1)}</td>
                          <td className={r.pass ? "pass" : "fail"}>{r.pass ? "pass" : "fail"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="hint">Normalised L2 error of the GPU result against the Float64 CPU result; gate 1e-4.</p>
                  {selfTest.error && <p className="hint fail">{selfTest.error}</p>}
                </div>
              )}
            </>
          )}
          {!gpu && <button className="btn small" onClick={() => void initGpu()}>Check now</button>}
        </div>
      )}
    </Menu>
  );
}
