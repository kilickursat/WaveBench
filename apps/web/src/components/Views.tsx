import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type uPlot from "uplot";
import { unitLabel, type ChannelStats } from "@wavebench/core";
import { engine } from "../engine/client";
import type { FilterResponse, RowsResult, StatsResult } from "../engine/protocol";
import { useApp } from "../state/store";
import { channelColor, chartColors, type ChartColors } from "../lib/colors";
import { charts } from "../lib/exports";
import { hertz, int, num, seconds, tick } from "../lib/format";
import { useDark, useEngine, useSize } from "../lib/hooks";
import { results } from "../lib/results";
import { Provenance } from "./AnalysisPanel";
import { tooltipPlugin, UPlotChart } from "./Chart";
import type { SpectrumSeries } from "./SpectrumChart";
import { Segmented } from "./ui";

/** Response of the applied filters: |H| per pass (|H|^2 for zero-phase), phase and group delay of causal filters. */
export function FilterView() {
  const rev = useApp((s) => s.dataRev);
  const process = useApp((s) => s.process);
  const configured = useApp((s) => s.configured)!;
  const [scale, setScale] = useState<"log" | "linear">("log");
  const dark = useDark();
  const colors = chartColors(dark);
  const hasFilters = !!process?.steps.some((s) => s.sos);
  const req = useEngine<FilterResponse>(hasFilters ? { type: "filterResponse", scale, points: 1024, rev } : null);
  const r = req.data;
  const fs = configured.sampleRateHz;
  const toSeries = (pick: (x: { magnitude: Float64Array; phaseDeg: Float64Array | null; groupDelaySamples: Float64Array | null }) => Float64Array | null, transform: (v: number) => number): SpectrumSeries[] => {
    if (!r) return [];
    const out: SpectrumSeries[] = [];
    const combined = pick(r.combined);
    if (r.steps.length > 1 && combined) out.push({ id: "all", label: "Chain", color: colors.ink, values: combined.map(transform) });
    r.steps.forEach((s, i) => {
      const v = pick(s);
      if (v) out.push({ id: `s${s.index}`, label: s.description, color: colors.series[i % 3], values: v.map(transform) });
    });
    return out;
  };
  const grid = r ? r.frequencies : null;
  const magnitude = useMemo(() => toSeries((x) => x.magnitude, (v) => (v > 0 ? 20 * Math.log10(v) : NaN)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [r, dark]);
  const phase = useMemo(() => toSeries((x) => x.phaseDeg, (v) => v),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [r, dark]);
  const delay = useMemo(() => toSeries((x) => x.groupDelaySamples, (v) => (v / fs) * 1e3),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [r, dark, fs]);
  if (!hasFilters) {
    return <div className="empty-plot">No filter is applied. Add one under Processing; its response appears here.</div>;
  }
  return (
    <>
      <div className="panel-bar">
        <Segmented label="Frequency axis" value={scale} options={[{ value: "log", label: "Log f" }, { value: "linear", label: "Lin f" }]} onChange={setScale} />
        <span className="fine">The response of what is applied: one pass for causal filters, |H|² and zero phase for forward-backward.</span>
      </div>
      <div className="analysis-body">
        <div className={`plot-col ${req.stale || req.running ? "stale" : ""}`}>
          {req.error ? <div className="error-box">{req.error}</div> : !r || !grid ? <div className="empty-plot">Computing…</div> : (
            <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, padding: "4px 8px 0" }}>
              <div style={{ flex: 1, minHeight: 0 }}>
                <ResponseChart chartKey="filter-mag" series={magnitude} frequencies={grid} logX={scale === "log"} yLabel="magnitude (dB)" unit="dB" colors={colors} floor={-160} />
              </div>
              {phase.length > 0 && (
                <div style={{ height: "28%" }}>
                  <ResponseChart chartKey="filter-phase" series={phase} frequencies={grid} logX={scale === "log"} yLabel="phase (°)" unit="°" colors={colors} />
                </div>
              )}
              {delay.length > 0 && (
                <div style={{ height: "28%" }}>
                  <ResponseChart chartKey="filter-delay" series={delay} frequencies={grid} logX={scale === "log"} yLabel="group delay (ms)" unit="ms" colors={colors} />
                </div>
              )}
            </div>
          )}
        </div>
        <aside className="side">
          <h3>Applied filters</h3>
          {process!.steps.filter((s) => s.sos).map((s) => (
            <div key={s.index} className="callout" style={{ marginBottom: 8 }}>
              <strong>{s.description}</strong>
              <dl className="kv">
                <dt>Realised order</dt>
                <dd>{s.realizedOrder}</dd>
                <dt>Sections</dt>
                <dd>{s.sections}</dd>
                <dt>Largest |pole|</dt>
                <dd>{num(s.maxPoleRadius ?? NaN, 9)}</dd>
                <dt>Rounding bound</dt>
                <dd title="Estimated worst-case relative error of Float64 filtering, max(1e-12, 1e-15/(1-|p|)^2)">{(s.roundingBound ?? 0).toExponential(0)}</dd>
                <dt>Start-up</dt>
                <dd>{s.transientSamples ? seconds(s.transientSamples / fs) : "–"}</dd>
                {s.padLength !== undefined && (
                  <>
                    <dt>Edge padding</dt>
                    <dd>{int(s.padLength)} samples</dd>
                  </>
                )}
              </dl>
            </div>
          ))}
          <p className="hint">
            Butterworth: -3 dB at the design cutoff for one pass, so -6 dB after forward-backward filtering. Nyquist {hertz(fs / 2)}. The magnitude axis
            stops at -160 dB; curves continue below it.
          </p>
        </aside>
      </div>
    </>
  );
}

/** Response curves on the engine's frequency grid (log- or linearly spaced). */
function ResponseChart({ chartKey, series, frequencies, logX, yLabel, unit, colors, floor }: {
  chartKey: string;
  series: SpectrumSeries[];
  frequencies: Float64Array;
  logX: boolean;
  yLabel: string;
  unit: string;
  colors: ChartColors;
  /** Lowest value of the y axis; the curves continue below it (e.g. towards a zero at Nyquist). */
  floor?: number;
}) {
  const data = useMemo<uPlot.AlignedData>(
    () => [frequencies, ...series.map((s) => Array.from(s.values, (v) => (Number.isFinite(v) ? v : null)))] as uPlot.AlignedData,
    [frequencies, series],
  );
  const structure = `${series.map((s) => s.id + s.color).join(",")}|${yLabel}|${logX}|${colors.surface}|${floor}`;
  const options = useMemo<Omit<uPlot.Options, "width" | "height">>(() => ({
    scales: {
      x: { time: false, distr: logX ? 3 : 1 },
      y: floor === undefined ? {} : { range: (_u: uPlot, lo: number | null, hi: number | null) => [Math.max(lo ?? floor, floor), Math.max(hi ?? 0, floor + 10) + 5] },
    },
    legend: { show: false },
    cursor: { drag: { x: true, y: false, setScale: true }, points: { size: 6 } },
    axes: [
      { stroke: colors.muted, grid: { stroke: colors.grid, width: 1 }, ticks: { stroke: colors.axis, width: 1, size: 4 }, values: (_u, s) => s.map(tick), label: "frequency (Hz)", labelSize: 14, labelFont: "11px sans-serif", font: "11px sans-serif", size: 32 },
      { stroke: colors.muted, grid: { stroke: colors.grid, width: 1 }, ticks: { stroke: colors.axis, width: 1, size: 4 }, values: (_u, s) => s.map(tick), label: yLabel, labelSize: 14, labelFont: "11px sans-serif", font: "11px sans-serif", size: 62 },
    ],
    series: [{}, ...series.map((s) => ({ label: s.label, stroke: s.color, width: 1.5, points: { show: false } }))],
    plugins: [
      tooltipPlugin((u, idx) => (idx === null ? null : {
        title: hertz(u.data[0][idx]),
        rows: series.map((s, i) => ({ color: s.color, label: s.label, value: u.data[i + 1][idx] == null ? "–" : `${num(u.data[i + 1][idx] as number, 5)} ${unit}` })),
      })),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [structure]);
  const onReady = useCallback((u: uPlot | null) => {
    if (u) charts.set(chartKey, u);
    else charts.delete(chartKey);
  }, [chartKey]);
  return (
    <div className="chart">
      {series.length > 1 && (
        <div className="chart-label legend">
          {series.map((s) => (
            <span key={s.id}><i style={{ background: s.color }} />{s.label}</span>
          ))}
        </div>
      )}
      <UPlotChart options={options} data={data} onReady={onReady} />
    </div>
  );
}

const STATS: { key: keyof ChannelStats; label: string; unit: boolean }[] = [
  { key: "count", label: "N", unit: false },
  { key: "mean", label: "Mean", unit: true },
  { key: "rms", label: "RMS", unit: true },
  { key: "acRms", label: "AC RMS (std)", unit: true },
  { key: "min", label: "Min", unit: true },
  { key: "max", label: "Max", unit: true },
  { key: "peakAbs", label: "Peak |x|", unit: true },
  { key: "peakToPeak", label: "Peak-to-peak", unit: true },
  { key: "crestFactor", label: "Crest factor", unit: false },
];

export function StatsView() {
  const interval = useApp((s) => s.interval)!;
  const rev = useApp((s) => s.dataRev);
  const source = useApp((s) => s.analysisSource);
  const configured = useApp((s) => s.configured)!;
  const dark = useDark();
  const colors = chartColors(dark);
  const ids = configured.channels.map((c) => c.id);
  const req = useEngine<StatsResult>({ type: "stats", source, interval, rev });
  const r = req.data;
  if (r) results.stats = { value: r, signal: source, interval: [interval.start, interval.end] };
  const unit = unitLabel(configured.unit);
  const fs = configured.sampleRateHz;
  return (
    <>
      <div className={`scroll ${req.stale ? "stale" : ""}`} style={{ padding: "8px 12px" }}>
        {req.error && <div className="error-box">{req.error}</div>}
        {r && (
          <table className="grid">
            <thead>
              <tr>
                <th>Channel</th>
                {STATS.map((s) => <th key={s.key}>{s.label}{s.unit ? ` (${unit})` : ""}</th>)}
              </tr>
            </thead>
            <tbody>
              {r.map((row) => (
                <tr key={row.id}>
                  <td><span className="swatch" style={{ background: channelColor(colors, ids, row.id), display: "inline-block", marginRight: 6 }} />{row.label}</td>
                  {row.stats ? STATS.map((s) => <td key={s.key}>{s.key === "count" ? int(row.stats![s.key] as number) : num(row.stats![s.key] as number | null, 6)}</td>) : <td colSpan={STATS.length} className="fail">{row.error}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="hint">
          Population definitions (denominator N): RMS = √(Σx²/N), AC RMS = √(Σ(x − mean)²/N), crest factor = peak / RMS (undefined when RMS = 0).
          Interval: samples {int(interval.start)}–{int(interval.end - 1)}, {seconds((interval.end - interval.start) / fs)}, {source} signal.
        </p>
      </div>
      <Provenance><span>CPU · Float64 with compensated sums</span></Provenance>
    </>
  );
}

const ROW_HEIGHT = 26;
const BLOCK = 256;

/** The record as a table, read in blocks from the engine (only visible rows are rendered). */
export function DataView() {
  const configured = useApp((s) => s.configured)!;
  const rev = useApp((s) => s.dataRev);
  const config = useApp((s) => s.config)!;
  const [ref, size] = useSize<HTMLDivElement>();
  const [scrollTop, setScrollTop] = useState(0);
  const [blocks, setBlocks] = useState(new Map<number, RowsResult>());
  const requested = useRef(new Set<number>());
  useEffect(() => {
    requested.current = new Set();
    setBlocks(new Map());
  }, [rev]);
  const total = configured.samples;
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 10);
  const last = Math.min(total, Math.ceil((scrollTop + size.height) / ROW_HEIGHT) + 10);
  useEffect(() => {
    for (let b = Math.floor(first / BLOCK); b * BLOCK < last; b++) {
      if (requested.current.has(b)) continue;
      requested.current.add(b);
      void engine.call<RowsResult>({ type: "rows", start: b * BLOCK, count: BLOCK, rev }).then((r) => setBlocks((m) => new Map(m).set(b, r)), () => requested.current.delete(b));
    }
  }, [first, last, rev]);
  const header = blocks.values().next().value?.columns.map((c) => c.label) ?? [];
  const rows = [];
  for (let i = first; i < last; i++) {
    const block = blocks.get(Math.floor(i / BLOCK));
    const j = i - (block?.start ?? 0);
    rows.push(
      <tr key={i} style={{ position: "absolute", top: (i + 1) * ROW_HEIGHT, height: ROW_HEIGHT, display: "table", tableLayout: "fixed", width: "100%" }}>
        <td>{int(i)}</td>
        <td>{int(config.rows.start + i + 1)}</td>
        <td>{block ? num(block.times[j], 10) : ""}</td>
        {block?.columns.map((c, k) => <td key={k}>{Number.isFinite(c.values[j]) ? String(c.values[j]) : "missing"}</td>)}
      </tr>,
    );
  }
  return (
    <div ref={ref} className="scroll" onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)} style={{ position: "relative" }}>
      <table className="grid" style={{ position: "relative", height: (total + 1) * ROW_HEIGHT, display: "block" }}>
        <thead style={{ position: "sticky", top: 0, display: "table", tableLayout: "fixed", width: "100%", zIndex: 2 }}>
          <tr style={{ height: ROW_HEIGHT }}>
            <th>Sample</th>
            <th>File row</th>
            <th>Time (s)</th>
            {header.map((h, i) => <th key={i}>{h} ({unitLabel(config.displayUnit)})</th>)}
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
}
