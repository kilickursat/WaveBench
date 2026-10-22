import { useCallback, useEffect, useMemo, useRef } from "react";
import type uPlot from "uplot";
import { unitLabel } from "@wavebench/core";
import { getState, setState, useApp } from "../state/store";
import type { TimeViewResult } from "../engine/protocol";
import { channelColor, chartColors, type ChartColors } from "../lib/colors";
import { charts } from "../lib/exports";
import { int, num, seconds, tick } from "../lib/format";
import { useDark, useEngine, useSize } from "../lib/hooks";
import { selectPlugin, shade, tooltipPlugin, UPlotChart, wheelZoomPlugin, withGaps } from "./Chart";
import { Icon, NumberField, Segmented } from "./ui";

function useTimeBounds() {
  const configured = useApp((s) => s.configured);
  return useMemo(() => (configured ? { first: configured.firstTimeSec, last: configured.lastTimeSec, fs: configured.sampleRateHz, n: configured.samples } : null), [configured]);
}

/** Sample index of a time on the record's uniform grid. */
function indexOf(t: number, bounds: { first: number; fs: number; n: number }): number {
  return Math.max(0, Math.min(bounds.n - 1, Math.round((t - bounds.first) * bounds.fs)));
}

export function TimePanel() {
  const configured = useApp((s) => s.configured);
  const view = useApp((s) => s.view);
  const timeSource = useApp((s) => s.timeSource);
  const layout = useApp((s) => s.layout);
  const hidden = useApp((s) => s.hidden);
  const dataRev = useApp((s) => s.dataRev);
  const hasChain = useApp((s) => s.chainApplied.some((c) => c.enabled) && !!s.process);
  const bounds = useTimeBounds();
  const [areaRef, size] = useSize<HTMLDivElement>();
  const dark = useDark();
  const ids = configured?.channels.map((c) => c.id) ?? [];
  const shown = ids.filter((id) => !hidden.includes(id));
  const width = Math.max(64, Math.round(size.width * Math.min(2, window.devicePixelRatio || 1)));
  const wantRaw = !hasChain || timeSource !== "processed";
  const wantProcessed = hasChain && timeSource !== "raw";
  const base = configured && view && shown.length ? { channels: shown, tMin: view.tMin, tMax: view.tMax, width, rev: dataRev } : null;
  const raw = useEngine<TimeViewResult>(base && wantRaw ? { type: "timeView", source: "raw", channels: base.channels, tMin: base.tMin, tMax: base.tMax, width: base.width } : null, 30);
  const processed = useEngine<TimeViewResult>(base && wantProcessed ? { type: "timeView", source: "processed", channels: base.channels, tMin: base.tMin, tMax: base.tMax, width: base.width } : null, 30);
  if (!configured || !view || !bounds) return null;
  const colors = chartColors(dark);
  const unit = unitLabel(configured.unit);
  const primary = wantProcessed ? processed.data : raw.data;
  const decimated = primary && !primary.exact;
  return (
    <section className="panel time" aria-label="Time signal">
      <div className="panel-bar">
        <h2>Time signal</h2>
        {hasChain && (
          <Segmented label="Signal shown" value={timeSource} options={[{ value: "processed", label: "Processed" }, { value: "raw", label: "Raw" }, { value: "both", label: "Both" }]} onChange={(v) => setState({ timeSource: v })} />
        )}
        <Segmented label="Layout" value={layout} options={[{ value: "stacked", label: "Stacked" }, { value: "overlay", label: "Overlay" }]} onChange={(v) => setState({ layout: v })} />
        <div className="spacer" />
        <span className="fine hide-narrow">
          {decimated ? `min/max of ${int(primary!.samples)} samples per pixel column` : primary ? `${int(primary.samples)} samples` : ""}
        </span>
        <button className="btn small" title="Zoom out" onClick={() => zoom(2)}>
          <Icon name="zoomout" size={14} />
        </button>
        <button className="btn small" onClick={() => setState({ view: { tMin: bounds.first, tMax: bounds.last } })}>Full</button>
      </div>
      <div className="chart-area" ref={areaRef}>
        {layout === "stacked" ? (
          <div className="stack">
            {shown.map((id, i) => (
              <TimeChart key={id} chartKey={`time:${id}`} ids={[id]} requestIds={shown} allIds={ids} raw={raw.data} processed={processed.data} colors={colors} unit={unit} last={i === shown.length - 1} dark={dark} />
            ))}
          </div>
        ) : (
          <TimeChart chartKey="time:overlay" ids={shown} requestIds={shown} allIds={ids} raw={raw.data} processed={processed.data} colors={colors} unit={unit} last dark={dark} />
        )}
      </div>
      <IntervalBar />
    </section>
  );
}

function zoom(factor: number): void {
  const s = getState();
  if (!s.view || !s.configured) return;
  const mid = (s.view.tMin + s.view.tMax) / 2;
  const half = ((s.view.tMax - s.view.tMin) / 2) * factor;
  const lo = Math.max(s.configured.firstTimeSec, mid - half);
  const hi = Math.min(s.configured.lastTimeSec, mid + half);
  setState({ view: { tMin: lo, tMax: hi } });
}

function setView(lo: number, hi: number): void {
  const c = getState().configured;
  if (!c) return;
  const minSpan = 4 / c.sampleRateHz;
  let a = Math.max(c.firstTimeSec, lo);
  let b = Math.min(c.lastTimeSec, hi);
  if (b - a < minSpan) {
    const m = (a + b) / 2;
    a = Math.max(c.firstTimeSec, m - minSpan / 2);
    b = Math.min(c.lastTimeSec, m + minSpan / 2);
  }
  setState({ view: { tMin: a, tMax: b } });
}

function setIntervalTimes(t0: number, t1: number): void {
  const c = getState().configured;
  if (!c) return;
  const b = { first: c.firstTimeSec, fs: c.sampleRateHz, n: c.samples };
  const start = indexOf(t0, b);
  const end = Math.max(start + 1, indexOf(t1, b) + 1);
  setState({ interval: { start, end } });
}

function TimeChart({ chartKey, ids, requestIds, allIds, raw, processed, colors, unit, last, dark }: {
  chartKey: string;
  ids: string[];
  /** Channel order of the engine's time-view results. */
  requestIds: string[];
  allIds: string[];
  raw: TimeViewResult | null;
  processed: TimeViewResult | null;
  colors: ChartColors;
  unit: string;
  last: boolean;
  dark: boolean;
}) {
  const configured = useApp((s) => s.configured)!;
  const view = useApp((s) => s.view)!;
  const interval = useApp((s) => s.interval);
  const process = useApp((s) => s.process);
  const highlight = useApp((s) => s.highlight);
  const axis = useApp((s) => s.axis);
  const labels = new Map(configured.channels.map((c) => [c.id, c.label]));
  const both = !!raw && !!processed;
  // Draw-time values read through a ref so the uPlot instance is only rebuilt for structural changes.
  const live = useRef({ view, interval, process, highlight, configured, axis });
  live.current = { view, interval, process, highlight, configured, axis };
  const plotRef = useRef<uPlot | null>(null);
  const seriesIds = useMemo(() => {
    const out: { id: string; source: "raw" | "processed" }[] = [];
    for (const id of ids) {
      if (raw) out.push({ id, source: "raw" });
      if (processed) out.push({ id, source: "processed" });
    }
    return out;
  }, [ids, raw, processed]);
  const data = useMemo<uPlot.AlignedData>(() => {
    const primary = processed ?? raw;
    if (!primary) return [[]];
    // Raw and processed envelopes are computed on the same pixel grid, so they share x.
    const x = primary.x;
    const cols = seriesIds.map(({ id, source }) => {
      const r = source === "raw" ? raw! : processed!;
      const v = r.values[requestIds.indexOf(id)];
      return v && v.length === x.length ? withGaps(v) : new Array(x.length).fill(null);
    });
    return [x, ...cols] as uPlot.AlignedData;
  }, [raw, processed, seriesIds, requestIds]);
  const structure = `${seriesIds.map((s) => `${s.id}:${s.source}`).join(",")}|${dark}|${last}|${both}|${axis}`;
  const options = useMemo<Omit<uPlot.Options, "width" | "height">>(() => {
    const toAxis = (t: number) => (live.current.axis === "samples" ? int((t - live.current.configured.firstTimeSec) * live.current.configured.sampleRateHz) : tick(t));
    return {
      scales: { x: { time: false, range: () => [live.current.view.tMin, live.current.view.tMax] } },
      legend: { show: false },
      cursor: { sync: { key: "wb-time" }, drag: { x: true, y: false, setScale: false }, points: { size: 6 } },
      select: { show: true, left: 0, top: 0, width: 0, height: 0 },
      axes: [
        {
          stroke: colors.muted, grid: { stroke: colors.grid, width: 1 }, ticks: { stroke: colors.axis, width: 1, size: 4 },
          values: (_u, splits) => (last ? splits.map(toAxis) : splits.map(() => "")), size: last ? 32 : 6,
          label: last ? (live.current.axis === "samples" ? "sample" : "time (s)") : undefined, labelSize: 14, labelFont: "11px sans-serif", font: "11px sans-serif",
        },
        { stroke: colors.muted, grid: { stroke: colors.grid, width: 1 }, ticks: { stroke: colors.axis, width: 1, size: 4 }, size: 58, values: (_u, s) => s.map(tick), font: "11px sans-serif", label: unit, labelSize: 14, labelFont: "11px sans-serif" },
      ],
      series: [
        {},
        ...seriesIds.map(({ id, source }) => {
          const color = channelColor(colors, allIds, id);
          const muted = both && source === "raw";
          return { label: `${labels.get(id)}${both ? ` (${source})` : ""}`, stroke: muted ? colors.axis : color, width: muted ? 1 : 1.25, points: { show: false } };
        }),
      ],
      hooks: {
        drawClear: [
          (u: uPlot) => {
            const { interval: iv, process: p, highlight: h, configured: c } = live.current;
            const fs = c.sampleRateHz;
            const t = (i: number) => c.firstTimeSec + i / fs;
            const ranges: { from: number; to: number; color: string }[] = [];
            if (iv && (iv.start > 0 || iv.end < c.samples)) ranges.push({ from: t(iv.start), to: t(iv.end - 1), color: colors.interval });
            if (p && p.edgeStart > 0) ranges.push({ from: c.firstTimeSec, to: t(p.edgeStart), color: colors.edge });
            if (p && p.edgeEnd > 0) ranges.push({ from: t(c.samples - 1 - p.edgeEnd), to: c.lastTimeSec, color: colors.edge });
            if (h) ranges.push({ from: h.startSec, to: h.endSec, color: colors.highlight });
            shade(u, ranges);
          },
        ],
      },
      plugins: [
        tooltipPlugin((u, idx) => {
          if (idx === null) return null;
          const x = u.data[0][idx];
          return {
            title: live.current.axis === "samples" ? `sample ${int((x - live.current.configured.firstTimeSec) * live.current.configured.sampleRateHz)}` : seconds(x),
            rows: seriesIds.map((s, i) => ({ color: (u.series[i + 1].stroke as string) ?? undefined, label: (u.series[i + 1].label as string) ?? s.id, value: `${num(u.data[i + 1][idx] as number, 5)} ${unit}` })),
          };
        }),
        wheelZoomPlugin(setView, () => [live.current.configured.firstTimeSec, live.current.configured.lastTimeSec]),
        selectPlugin(setView, setIntervalTimes, () => setView(live.current.configured.firstTimeSec, live.current.configured.lastTimeSec)),
      ],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structure]);
  const onReady = useCallback((u: uPlot | null) => {
    plotRef.current = u;
    if (u) charts.set(chartKey, u);
    else charts.delete(chartKey);
  }, [chartKey]);
  // Viewport, interval, highlight: reposition and redraw without rebuilding.
  useEffect(() => {
    const u = plotRef.current;
    if (!u) return;
    if (u.scales.x.min !== view.tMin || u.scales.x.max !== view.tMax) u.setScale("x", { min: view.tMin, max: view.tMax });
    else u.redraw(false);
  }, [view, interval, process, highlight, data]);
  return (
    <div className="chart" style={{ flex: 1, minHeight: 0 }}>
      {ids.length === 1 && (
        <div className="chart-label">
          <i style={{ background: channelColor(colors, allIds, ids[0]) }} />
          {labels.get(ids[0])}
        </div>
      )}
      {ids.length > 1 && (
        <div className="chart-label legend" style={{ pointerEvents: "auto" }}>
          {ids.map((id) => (
            <span key={id}>
              <i style={{ background: channelColor(colors, allIds, id) }} />
              {labels.get(id)}
            </span>
          ))}
        </div>
      )}
      <UPlotChart options={options} data={data} onReady={onReady} />
    </div>
  );
}

function IntervalBar() {
  const configured = useApp((s) => s.configured)!;
  const interval = useApp((s) => s.interval);
  const view = useApp((s) => s.view);
  // On an irregular timebase there is no sampling rate to place an interval with (analyses are blocked).
  if (!interval || !configured.usable) return null;
  const fs = configured.sampleRateHz;
  const t = (i: number) => configured.firstTimeSec + i / fs;
  const n = interval.end - interval.start;
  const full = interval.start === 0 && interval.end === configured.samples;
  return (
    <div className="footer-line">
      <strong>Analysis interval</strong>
      <NumberField ariaLabel="Interval start in seconds" value={Number(t(interval.start).toPrecision(8))} onCommit={(v) => v !== null && setIntervalTimes(v, t(interval.end - 1))} />
      <span>to</span>
      <NumberField ariaLabel="Interval end in seconds" value={Number(t(interval.end - 1).toPrecision(8))} onCommit={(v) => v !== null && setIntervalTimes(t(interval.start), v)} />
      <span>s · {int(n)} samples · N/fs = {seconds(n / fs)}</span>
      <button className="btn small" disabled={!view} onClick={() => view && setIntervalTimes(view.tMin, view.tMax)}>Use visible range</button>
      <button className="btn small" disabled={full} onClick={() => setState({ interval: { start: 0, end: configured.samples } })}>Whole record</button>
      <span className="hide-narrow">Drag to zoom · Shift+drag sets the interval · double-click shows all</span>
    </div>
  );
}
