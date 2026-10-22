import { useMemo } from "react";
import { unitLabel, type SpectralQuantity } from "@wavebench/core";
import { bandRms, findPeaks, nextPowerOfTwo, WINDOW_LABELS, type DetrendMode, type WindowName } from "@wavebench/dsp-cpu";
import { setState, useApp } from "../state/store";
import type { Tab } from "../state/model";
import type { ComputeProvenance } from "@wavebench/core";
import type { SpectrumResult, StatsResult, WelchResult } from "../engine/protocol";
import { channelColor, chartColors } from "../lib/colors";
import { hertz, int, num, percent, seconds } from "../lib/format";
import { useDark, useEngine } from "../lib/hooks";
import { results } from "../lib/results";
import { dbFactor, fftPhase, fftValues, QUANTITY_LABELS, quantityUnit, toDb, welchValues } from "../lib/spectra";
import { SpectrumChart, numberText } from "./SpectrumChart";
import { SpectrogramView } from "./SpectrogramView";
import { DataView, FilterView, StatsView } from "./Views";
import { NumberField, Segmented, Select } from "./ui";

const TABS: { id: Tab; label: string }[] = [
  { id: "fft", label: "Spectrum (FFT)" },
  { id: "welch", label: "PSD (Welch)" },
  { id: "stft", label: "Spectrogram (STFT)" },
  { id: "filter", label: "Filter response" },
  { id: "stats", label: "Statistics" },
  { id: "data", label: "Data" },
];

export const WINDOW_OPTIONS = (Object.keys(WINDOW_LABELS) as WindowName[]).map((w) => ({ value: w, label: WINDOW_LABELS[w] }));
export const DETREND_OPTIONS: { value: DetrendMode; label: string }[] = [
  { value: "none", label: "None" },
  { value: "constant", label: "Remove mean" },
  { value: "linear", label: "Remove linear trend" },
];

export function AnalysisPanel() {
  const tab = useApp((s) => s.tab);
  const configured = useApp((s) => s.configured);
  const hasChain = useApp((s) => s.chainApplied.some((c) => c.enabled) && !!s.process);
  const source = useApp((s) => s.analysisSource);
  if (!configured) return null;
  const blocked = !configured.usable && tab !== "data";
  return (
    <section className="panel analysis" aria-label="Analysis">
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setState({ tab: t.id })}>
            {t.label}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        {hasChain && tab !== "filter" && tab !== "data" && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 4px" }}>
            <span className="fine">Analyse</span>
            <Segmented label="Signal analysed" value={source} options={[{ value: "processed", label: "Processed" }, { value: "raw", label: "Raw" }]} onChange={(v) => setState({ analysisSource: v })} />
          </div>
        )}
      </div>
      {blocked ? (
        <div className="error-box">
          The timestamps are not uniform within the tolerance, so FFT, PSD, spectrogram and filters are blocked: an ordinary Fourier
          transform assumes equally spaced samples. Use the timebase options on the left (sampling-rate mode, or rows without gaps).
        </div>
      ) : tab === "fft" ? (
        <FftView />
      ) : tab === "welch" ? (
        <WelchView />
      ) : tab === "stft" ? (
        <SpectrogramView />
      ) : tab === "filter" ? (
        <FilterView />
      ) : tab === "stats" ? (
        <StatsView />
      ) : (
        <DataView />
      )}
    </section>
  );
}

export function Provenance({ p, notes, children }: { p?: ComputeProvenance; notes?: string[]; children?: React.ReactNode }) {
  return (
    <div className="status-line">
      {children}
      {p && (
        <span>
          <b>{p.backend === "cpu" ? "CPU" : "WebGPU"}</b> · {p.precision === "float64" ? "Float64" : "Float32"} · {num(p.elapsedMs, 3)} ms
          {p.adapter ? ` · ${p.adapter}` : ""}
        </span>
      )}
      {notes?.map((n, i) => <span key={i} className="fail" style={{ fontWeight: 400 }}>{n}</span>)}
    </div>
  );
}

function useSeriesColors() {
  const dark = useDark();
  const configured = useApp((s) => s.configured);
  const colors = chartColors(dark);
  const ids = configured?.channels.map((c) => c.id) ?? [];
  const label = (id: string) => configured?.channels.find((c) => c.id === id)?.label ?? id;
  return { colors, color: (id: string) => channelColor(colors, ids, id), label };
}

function FftView() {
  const s = useApp((x) => x.fft);
  const interval = useApp((x) => x.interval)!;
  const rev = useApp((x) => x.dataRev);
  const source = useApp((x) => x.analysisSource);
  const backend = useApp((x) => x.backend);
  const unit = useApp((x) => x.configured!.unit);
  const fs = useApp((x) => x.configured!.sampleRateHz);
  const { colors, color, label } = useSeriesColors();
  const n = interval.end - interval.start;
  const req = useEngine<SpectrumResult>({ type: "spectrum", source, interval, settings: { window: s.window, detrend: s.detrend, fftLength: s.fftLength }, backend, rev });
  const r = req.data;
  if (r) results.fft = { value: r, settings: s, signal: source, interval: [interval.start, interval.end] };
  const set = (patch: Partial<typeof s>) => setState({ fft: { ...s, ...patch } });
  const db = s.yScale === "db";
  const series = useMemo(
    () => (r ? r.channels.map((c) => {
      const v = fftValues(r, c, s.output);
      return { id: c.id, label: label(c.id), color: color(c.id), values: db ? toDb(v, dbFactor(s.output)) : v };
    }) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [r, s.output, db, colors],
  );
  // Peaks more than 60 dB (amplitude) below a channel's largest peak are leakage or noise, not listed.
  const peaks = useMemo(() => (r ? r.channels.map((c) => {
    const list = findPeaks(fftValues(r, c, s.output), r.binWidthHz, 5, 3);
    const floor = (list[0]?.value ?? 0) * (s.output === "power" || s.output === "psd" ? 1e-6 : 1e-3);
    return { id: c.id, list: list.filter((p) => p.value >= floor) };
  }) : []), [r, s.output]);
  const phase = useMemo(() => (r && s.phase ? r.channels.map((c) => ({ id: c.id, label: label(c.id), color: color(c.id), values: fftPhase(r, c) })) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [r, s.phase, colors]);
  const yUnit = quantityUnit(unit, s.output, db);
  const fftChoice = s.fftLength === "exact" ? "exact" : s.fftLength === "pow2" ? "pow2" : "custom";
  return (
    <>
      <div className="panel-bar">
        <label className="inline">Window<Select value={s.window} options={WINDOW_OPTIONS} onChange={(v) => set({ window: v })} /></label>
        <label className="inline">Detrend<Select value={s.detrend} options={DETREND_OPTIONS} onChange={(v) => set({ detrend: v })} /></label>
        <label className="inline" title="M = L: exact; a larger M zero-pads, sampling the same transform more densely without adding resolution">
          FFT length
          <Select
            value={fftChoice}
            options={[{ value: "exact", label: `Exact (${int(n)})` }, { value: "pow2", label: `Next power of 2 (${int(nextPowerOfTwo(n))})` }, { value: "custom", label: "Custom…" }]}
            onChange={(v) => set({ fftLength: v === "custom" ? nextPowerOfTwo(n) * 2 : v })}
          />
        </label>
        {fftChoice === "custom" && (
          <NumberField className="num" ariaLabel="FFT length" integer min={n} max={1 << 26} value={s.fftLength as number} onCommit={(v) => v !== null && set({ fftLength: v })} />
        )}
        <label className="inline">Output<Select<SpectralQuantity> value={s.output} options={(Object.keys(QUANTITY_LABELS) as SpectralQuantity[]).map((q) => ({ value: q, label: QUANTITY_LABELS[q] }))} onChange={(v) => set({ output: v })} /></label>
        <Segmented label="Y scale" value={s.yScale} options={[{ value: "linear", label: "Lin" }, { value: "log", label: "Log" }, { value: "db", label: "dB" }]} onChange={(v) => set({ yScale: v })} />
        <Segmented label="X scale" value={s.xScale} options={[{ value: "linear", label: "Lin f" }, { value: "log", label: "Log f" }]} onChange={(v) => set({ xScale: v })} />
        <label className="inline"><input type="checkbox" checked={s.phase} onChange={(e) => set({ phase: e.target.checked })} /> Phase</label>
      </div>
      <div className="analysis-body">
        <div className={`plot-col ${req.stale || req.running ? "stale" : ""}`}>
          {req.error ? <div className="error-box">{req.error}</div> : !r ? <div className="empty-plot">Computing…</div> : (
            <>
              <div style={{ flex: 1, minHeight: 0, padding: "4px 8px 0" }}>
                <SpectrumChart chartKey="fft" series={series} binWidthHz={r.binWidthHz} logX={s.xScale === "log"} logY={s.yScale === "log"} yLabel={`${QUANTITY_LABELS[s.output]} (${yUnit})`} valueText={numberText(yUnit)} peaks={db ? undefined : peaks.flatMap((p) => (p.list[0] ? [{ id: p.id, frequencyHz: p.list[0].frequencyHz, value: p.list[0].value }] : []))} colors={colors} />
              </div>
              {phase && (
                <div style={{ height: "36%", padding: "0 8px" }}>
                  <SpectrumChart chartKey="fft-phase" series={phase} binWidthHz={r.binWidthHz} logX={s.xScale === "log"} logY={false} yLabel="phase (°), within 60 dB of the peak" valueText={(v) => `${num(v, 4)}°`} colors={colors} />
                </div>
              )}
            </>
          )}
        </div>
        <aside className="side">
          {r && (
            <>
              <h3>Largest peaks</h3>
              {peaks.map((p) => (
                <div key={p.id} style={{ marginBottom: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                    <span className="swatch" style={{ background: color(p.id) }} />
                    {label(p.id)}
                  </div>
                  <table className="grid">
                    <tbody>
                      {p.list.map((k) => (
                        <tr key={k.bin} title={k.interpolatedHz !== null ? `Interpolated estimate ${hertz(k.interpolatedHz)}` : undefined}>
                          <td>{hertz(k.frequencyHz)}</td>
                          <td>{num(k.value, 4)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
              <p className="hint">Bin frequencies (±Δf/2); hover a row for the interpolated estimate. Values in {quantityUnit(unit, s.output, false)}.</p>
            </>
          )}
        </aside>
      </div>
      {r && (
        <Provenance p={r.provenance} notes={r.notes}>
          <span>L = {int(r.segmentLength)} · M = {int(r.fftLength)}{r.fftLength > r.segmentLength ? " (zero-padded)" : ""}</span>
          <span>Δf = {hertz(r.binWidthHz)} · ENBW = {hertz(r.enbwHz)}</span>
          <span>{WINDOW_LABELS[s.window]} (periodic) · {source} · {seconds(r.segmentLength / fs)}</span>
        </Provenance>
      )}
    </>
  );
}

function WelchView() {
  const s = useApp((x) => x.welch);
  const interval = useApp((x) => x.interval)!;
  const rev = useApp((x) => x.dataRev);
  const source = useApp((x) => x.analysisSource);
  const backend = useApp((x) => x.backend);
  const configured = useApp((x) => x.configured)!;
  const { colors, color, label } = useSeriesColors();
  const unit = configured.unit;
  const fs = configured.sampleRateHz;
  const n = interval.end - interval.start;
  const settings = { window: s.window, windowLength: s.windowLength, overlapPercent: s.overlapPercent, fftFactor: s.fftFactor, detrend: s.detrend };
  const tooShort = s.windowLength > n;
  const req = useEngine<WelchResult>(tooShort ? null : { type: "welch", source, interval, settings, backend, rev });
  const stats = useEngine<StatsResult>({ type: "stats", source, interval, rev }, 200);
  const r = req.data;
  if (r) results.welch = { value: r, settings: s, signal: source, interval: [interval.start, interval.end] };
  const set = (patch: Partial<typeof s>) => setState({ welch: { ...s, ...patch } });
  const db = s.yScale === "db";
  const series = useMemo(
    () => (r ? r.channels.map((c) => {
      const v = welchValues(r, c.psd, s.output);
      return { id: c.id, label: label(c.id), color: color(c.id), values: db ? toDb(v, dbFactor(s.output)) : v };
    }) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [r, s.output, db, colors],
  );
  const lo = s.bandLow ?? 0;
  const hi = s.bandHigh ?? fs / 2;
  const restricted = lo > 0 || hi < fs / 2;
  const yUnit = quantityUnit(unit, s.output, db);
  const overlap = r ? 1 - r.hopLength / r.windowLength : s.overlapPercent / 100;
  return (
    <>
      <div className="panel-bar">
        <label className="inline">Window<Select value={s.window} options={WINDOW_OPTIONS} onChange={(v) => set({ window: v })} /></label>
        <label className="inline" title="Samples per segment">
          Segment
          <NumberField className={`num ${tooShort ? "invalid" : ""}`} ariaLabel="Segment length in samples" integer min={2} max={1 << 24} value={s.windowLength} onCommit={(v) => v !== null && set({ windowLength: v })} />
        </label>
        <label className="inline">
          Overlap
          <Select value={s.overlapPercent} options={[0, 25, 50, 66.7, 75, 87.5].map((o) => ({ value: o, label: `${o} %` }))} onChange={(v) => set({ overlapPercent: v })} />
        </label>
        <label className="inline" title="Zero padding of each segment">
          FFT length
          <Select<string> value={String(s.fftFactor)} options={[{ value: "1", label: "= segment" }, { value: "2", label: "2 × segment" }, { value: "4", label: "4 × segment" }, { value: "pow2", label: "Next power of 2" }]} onChange={(v) => set({ fftFactor: v === "pow2" ? "pow2" : Number(v) })} />
        </label>
        <label className="inline">Detrend<Select value={s.detrend} options={DETREND_OPTIONS} onChange={(v) => set({ detrend: v })} /></label>
        <label className="inline">Output<Select value={s.output} options={[{ value: "psd", label: "PSD" }, { value: "asd", label: "ASD (√PSD)" }, { value: "power", label: "Power (RMS²)" }]} onChange={(v) => set({ output: v })} /></label>
        <Segmented label="Y scale" value={s.yScale} options={[{ value: "linear", label: "Lin" }, { value: "log", label: "Log" }, { value: "db", label: "dB" }]} onChange={(v) => set({ yScale: v })} />
        <Segmented label="X scale" value={s.xScale} options={[{ value: "linear", label: "Lin f" }, { value: "log", label: "Log f" }]} onChange={(v) => set({ xScale: v })} />
      </div>
      <div className="analysis-body">
        <div className={`plot-col ${req.stale || req.running ? "stale" : ""}`}>
          {tooShort ? (
            <div className="error-box">The interval has {int(n)} samples, fewer than one segment ({int(s.windowLength)}). Shorten the segment or widen the interval; the segment is never shortened silently.</div>
          ) : req.error ? <div className="error-box">{req.error}</div> : !r ? <div className="empty-plot">Computing…</div> : (
            <div style={{ flex: 1, minHeight: 0, padding: "4px 8px 0" }}>
              <SpectrumChart chartKey="welch" series={series} binWidthHz={r.binWidthHz} logX={s.xScale === "log"} logY={s.yScale === "log"} yLabel={`${s.output === "psd" ? "PSD" : s.output === "asd" ? "ASD" : "Power"} (${yUnit})`} valueText={numberText(yUnit)} colors={colors} />
            </div>
          )}
        </div>
        <aside className="side">
          <h3>RMS in a band</h3>
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
            <NumberField ariaLabel="Band low edge in hertz" min={0} max={fs / 2} allowEmpty placeholder="0" value={s.bandLow} onCommit={(v) => set({ bandLow: v })} />
            <span>–</span>
            <NumberField ariaLabel="Band high edge in hertz" min={0} max={fs / 2} allowEmpty placeholder={num(fs / 2)} value={s.bandHigh} onCommit={(v) => set({ bandHigh: v })} />
            <span>Hz</span>
          </div>
          {r && (
            <table className="grid">
              <thead>
                <tr>
                  <th>Channel</th>
                  <th>Band</th>
                  {restricted && <th>All f</th>}
                  <th title="Time-domain RMS about the mean over the same interval">AC RMS</th>
                </tr>
              </thead>
              <tbody>
                {r.channels.map((c) => {
                  const band = bandRms(c.psd, r.binWidthHz, lo, hi);
                  const all = bandRms(c.psd, r.binWidthHz, 0, fs / 2);
                  const ac = stats.data?.find((x) => x.id === c.id)?.stats?.acRms;
                  return (
                    <tr key={c.id}>
                      <td><span className="swatch" style={{ background: color(c.id), display: "inline-block", marginRight: 5 }} />{label(c.id)}</td>
                      <td>{num(band.rms, 4)}</td>
                      {restricted && <td>{num(all.rms, 4)}</td>}
                      <td>{ac !== undefined ? num(ac, 4) : "–"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <p className="hint">
            √(Σ PSD·Δf) over bins with {hertz(lo)} ≤ f ≤ {hertz(hi)}, in {unitLabel(unit)}. With the mean removed, the all-f value should be close to the
            time-domain AC RMS (Parseval); a large difference points to non-stationarity or frames left out at the end.
          </p>
        </aside>
      </div>
      {r && (
        <Provenance p={r.provenance} notes={r.notes}>
          <span>{int(r.frames)} segments of L = {int(r.windowLength)} ({seconds(r.windowLength / fs)}), hop {int(r.hopLength)} ({percent(overlap, 3)} overlap), M = {int(r.fftLength)}</span>
          <span>Δf = {hertz(r.binWidthHz)} · ENBW = {hertz(r.enbwHz)}</span>
          {r.unusedSamples > 0 && <span>{int(r.unusedSamples)} samples at the end not covered by a complete segment</span>}
        </Provenance>
      )}
    </>
  );
}
