import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type uPlot from "uplot";
import { spectralUnitLabel } from "@wavebench/core";
import { WINDOW_LABELS, type FrameQuantity } from "@wavebench/dsp-cpu";
import { COLORMAP_LABELS, colormapCss, type ColormapName, type ColorScale } from "@wavebench/plots";
import { engine } from "../engine/client";
import type { StftMeta } from "../engine/protocol";
import { setState, useApp } from "../state/store";
import { chartColors } from "../lib/colors";
import { charts } from "../lib/exports";
import { hertz, int, num, percent, seconds, tick } from "../lib/format";
import { useDark, useEngine } from "../lib/hooks";
import { results } from "../lib/results";
import { DETREND_OPTIONS, Provenance, WINDOW_OPTIONS } from "./AnalysisPanel";
import { UPlotChart } from "./Chart";
import { NumberField, Select } from "./ui";

const QUANTITIES: { value: FrameQuantity; label: string }[] = [
  { value: "psd", label: "PSD" },
  { value: "peak", label: "Amplitude (peak)" },
  { value: "power", label: "Power (RMS²)" },
];

interface Probe {
  frame: number;
  bin: number;
  timeSec: number;
  frequencyHz: number;
  value: number;
  windowStartSec: number;
  windowEndSec: number;
}

export function SpectrogramView() {
  const s = useApp((x) => x.stft);
  const interval = useApp((x) => x.interval)!;
  const rev = useApp((x) => x.dataRev);
  const source = useApp((x) => x.analysisSource);
  const backend = useApp((x) => x.backend);
  const configured = useApp((x) => x.configured)!;
  const dark = useDark();
  const colors = chartColors(dark);
  const channel = s.channel ?? configured.channels[0]?.id;
  const n = interval.end - interval.start;
  const settings = { window: s.window, windowLength: s.windowLength, overlapPercent: s.overlapPercent, fftFactor: s.fftFactor, detrend: s.detrend };
  const tooShort = s.windowLength > n;
  const req = useEngine<StftMeta>(channel && !tooShort ? { type: "stft", source, interval, channel, settings, quantity: s.quantity, backend, rev } : null);
  const meta = req.data;
  results.stft = meta;
  const [renderer, setRenderer] = useState<"webgpu" | "canvas2d" | null>(null);
  const set = (patch: Partial<typeof s>) => setState({ stft: { ...s, ...patch } });
  const factor = s.quantity === "peak" ? 20 : 10;
  const top = s.topDb ?? (meta && meta.max > 0 ? Math.ceil(factor * Math.log10(meta.max)) : 0);
  const scale: ColorScale = { mode: "db", dbFactor: factor, reference: 1, lo: top - s.rangeDb, hi: top, colormap: s.colormap };
  const unit = configured.unit;
  const qUnit = spectralUnitLabel(unit, s.quantity === "peak" ? "peak" : s.quantity);
  const label = configured.channels.find((c) => c.id === channel)?.label ?? "";
  return (
    <>
      <div className="panel-bar">
        <label className="inline">Channel<Select value={channel ?? ""} options={configured.channels.map((c) => ({ value: c.id, label: c.label }))} onChange={(v) => set({ channel: v })} /></label>
        <label className="inline">Window<Select value={s.window} options={WINDOW_OPTIONS} onChange={(v) => set({ window: v })} /></label>
        <label className="inline" title="Samples per frame: longer frames resolve frequency better and time worse">
          Length
          <NumberField className={`num ${tooShort ? "invalid" : ""}`} ariaLabel="Frame length in samples" integer min={2} max={1 << 20} value={s.windowLength} onCommit={(v) => v !== null && set({ windowLength: v })} />
        </label>
        <label className="inline">Overlap<Select value={s.overlapPercent} options={[0, 50, 75, 87.5, 93.75].map((o) => ({ value: o, label: `${o} %` }))} onChange={(v) => set({ overlapPercent: v })} /></label>
        <label className="inline">FFT<Select<string> value={String(s.fftFactor)} options={[{ value: "1", label: "= length" }, { value: "2", label: "2 × length" }, { value: "4", label: "4 × length" }, { value: "pow2", label: "Next power of 2" }]} onChange={(v) => set({ fftFactor: v === "pow2" ? "pow2" : Number(v) })} /></label>
        <label className="inline">Detrend<Select value={s.detrend} options={DETREND_OPTIONS} onChange={(v) => set({ detrend: v })} /></label>
        <label className="inline">Values<Select value={s.quantity} options={QUANTITIES} onChange={(v) => set({ quantity: v, topDb: null })} /></label>
        <label className="inline">Colours<Select<ColormapName> value={s.colormap} options={(Object.keys(COLORMAP_LABELS) as ColormapName[]).map((c) => ({ value: c, label: COLORMAP_LABELS[c] }))} onChange={(v) => set({ colormap: v })} /></label>
        <label className="inline" title="Colour range below the top value">
          Range
          <Select value={s.rangeDb} options={[40, 60, 80, 100, 120].map((d) => ({ value: d, label: `${d} dB` }))} onChange={(v) => set({ rangeDb: v })} />
        </label>
        <label className="inline" title="Top of the colour scale; empty = the largest value">
          Top
          <NumberField className="num" ariaLabel="Top of the colour scale in dB" allowEmpty placeholder="auto" value={s.topDb} onCommit={(v) => set({ topDb: v })} />
        </label>
      </div>
      <div className="analysis-body full">
        <div className={`plot-col ${req.stale || req.running ? "stale" : ""}`}>
          {tooShort ? (
            <div className="error-box">The interval has {int(n)} samples, fewer than one frame ({int(s.windowLength)}). Shorten the frame or widen the interval.</div>
          ) : req.error ? (
            <div className="error-box">{req.error}</div>
          ) : !meta ? (
            <div className="empty-plot">{req.running ? `Computing… ${req.progress !== null ? percent(req.progress, 2) : ""}` : ""}</div>
          ) : (
            <div style={{ display: "flex", flex: 1, minHeight: 0, padding: "4px 8px 0" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <HeatmapChart meta={meta} scale={scale} colors={colors} unit={qUnit} label={label} onRenderer={setRenderer} />
              </div>
              <ColorBar scale={scale} unit={qUnit} />
            </div>
          )}
        </div>
      </div>
      {meta && (
        <Provenance p={meta.provenance} notes={meta.notes}>
          <span>{int(meta.grid.frames)} frames × {int(meta.grid.bins)} bins</span>
          <span>L = {int(meta.windowLength)} ({seconds(meta.windowLength / configured.sampleRateHz)}), hop {int(meta.hopLength)} ({seconds(meta.grid.hopSec)}), M = {int(meta.fftLength)}</span>
          <span>Δf = {hertz(meta.grid.binWidthHz)} · {WINDOW_LABELS[s.window]} · frame time = start + L/2</span>
          {renderer && <span>drawn with {renderer === "webgpu" ? "WebGPU" : "Canvas 2D"}</span>}
        </Provenance>
      )}
    </>
  );
}

function HeatmapChart({ meta, scale, colors, unit, label, onRenderer }: {
  meta: StftMeta;
  scale: ColorScale;
  colors: ReturnType<typeof chartColors>;
  unit: string;
  label: string;
  onRenderer: (kind: "webgpu" | "canvas2d") => void;
}) {
  const plot = useRef<uPlot | null>(null);
  const [probe, setProbe] = useState<{ p: Probe; left: number; top: number } | null>(null);
  const live = useRef({ meta, scale });
  live.current = { meta, scale };
  const g = meta.grid;
  const tMin = g.firstTimeSec - g.hopSec / 2;
  const tMax = g.firstTimeSec + (g.frames - 0.5) * g.hopSec;
  const fMax = (g.bins - 1) * g.binWidthHz;
  const render = useRef<number | null>(null);
  const pending = useRef<{ t: number; f: number; left: number; top: number } | null>(null);
  const inflight = useRef(false);
  const sendProbe = useCallback(() => {
    const q = pending.current;
    if (!q) return;
    pending.current = null;
    inflight.current = true;
    engine.call<Probe | null>({ type: "probeStft", timeSec: q.t, frequencyHz: q.f }).then(
      (p) => {
        setProbe(p ? { p, left: q.left, top: q.top } : null);
        setState({ highlight: p ? { startSec: p.windowStartSec, endSec: p.windowEndSec } : null });
      },
      () => undefined,
    ).finally(() => {
      inflight.current = false;
      if (pending.current) sendProbe();
    });
  }, []);
  const draw = useCallback(() => {
    if (render.current !== null) return;
    render.current = requestAnimationFrame(() => {
      render.current = null;
      const u = plot.current;
      if (!u) return;
      const { min: x0, max: x1 } = u.scales.x;
      const { min: y0, max: y1 } = u.scales.y;
      if (x0 == null || x1 == null || y0 == null || y1 == null) return;
      void engine.call({ type: "renderStft", view: { tMin: x0, tMax: x1, fMin: y0, fMax: y1, width: Math.round(u.bbox.width), height: Math.round(u.bbox.height) }, scale: live.current.scale });
    });
  }, []);
  const data = useMemo<uPlot.AlignedData>(() => [[tMin, tMax], [0, fMax]], [tMin, tMax, fMax]);
  const structure = `${colors.surface}|${meta.grid.frames}|${meta.grid.bins}|${tMin}|${fMax}`;
  const options = useMemo<Omit<uPlot.Options, "width" | "height">>(() => ({
    scales: { x: { time: false, range: (_u, a, b) => [a, b] }, y: { range: (_u, a, b) => [a, b] } },
    legend: { show: false },
    cursor: { drag: { x: true, y: true, uni: 24, setScale: true }, points: { show: false } },
    axes: [
      { stroke: colors.muted, grid: { show: false }, ticks: { stroke: colors.axis, width: 1, size: 4 }, values: (_u, s) => s.map(tick), label: "time (s)", labelSize: 14, labelFont: "11px sans-serif", font: "11px sans-serif", size: 32 },
      { stroke: colors.muted, grid: { show: false }, ticks: { stroke: colors.axis, width: 1, size: 4 }, values: (_u, s) => s.map(tick), label: "frequency (Hz)", labelSize: 14, labelFont: "11px sans-serif", font: "11px sans-serif", size: 62 },
    ],
    // A transparent series spanning [0, fMax] gives both scales their range (hidden series are not ranged).
    series: [{}, { stroke: "transparent", width: 0, points: { show: false } }],
    hooks: {
      ready: [
        (u: uPlot) => {
          const c = document.createElement("canvas");
          c.className = "heatmap-canvas";
          u.under.appendChild(c);
          const off = c.transferControlToOffscreen();
          void engine.call<"webgpu" | "canvas2d">({ type: "attachCanvas", canvas: off }, { transfer: [off] }).then((kind) => {
            onRenderer(kind);
            draw();
          });
          u.over.addEventListener("dblclick", () => {
            u.setScale("x", { min: tMin, max: tMax });
            u.setScale("y", { min: 0, max: fMax });
          });
          u.over.addEventListener("mouseleave", () => {
            setProbe(null);
            setState({ highlight: null });
          });
        },
      ],
      setScale: [() => draw()],
      setSize: [() => draw()],
      setCursor: [
        (u: uPlot) => {
          const { left, top } = u.cursor;
          if (left === undefined || top === undefined || left < 0 || top < 0) return;
          // One probe in flight at a time; the newest pointer position is sent next.
          pending.current = { t: u.posToVal(left, "x"), f: u.posToVal(top, "y"), left, top };
          if (!inflight.current) sendProbe();
        },
      ],
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [structure]);
  useEffect(() => draw(), [meta, scale.lo, scale.hi, scale.colormap, draw]);
  useEffect(() => () => setState({ highlight: null }), []);
  const onReady = useCallback((u: uPlot | null) => {
    plot.current = u;
    if (u) charts.set("stft", u);
    else charts.delete("stft");
  }, []);
  const db = probe && probe.p.value > 0 ? scale.dbFactor * Math.log10(probe.p.value) : null;
  return (
    <div className="chart">
      <div className="chart-label">{label}</div>
      <UPlotChart options={options} data={data} onReady={onReady} />
      {probe && plot.current && (
        <div className="tooltip" style={{ left: probe.left + plot.current.over.offsetLeft + 14, top: probe.top + plot.current.over.offsetTop + 10 }}>
          <div className="muted">frame {int(probe.p.frame)} · bin {int(probe.p.bin)}</div>
          <div>t = {seconds(probe.p.timeSec)} (window {seconds(probe.p.windowStartSec)} – {seconds(probe.p.windowEndSec)})</div>
          <div>f = {hertz(probe.p.frequencyHz)}</div>
          <div>{num(probe.p.value, 4)} {unit}{db !== null ? ` · ${num(db, 4)} dB` : ""}</div>
        </div>
      )}
    </div>
  );
}

function ColorBar({ scale, unit }: { scale: ColorScale; unit: string }) {
  const stops = Array.from({ length: 17 }, (_, i) => `${colormapCss(scale.colormap, 1 - i / 16)} ${(i / 16) * 100}%`).join(", ");
  return (
    <div className="colorbar" aria-label="Colour scale">
      <span>{num(scale.hi, 4)} dB</span>
      <div className="bar" style={{ background: `linear-gradient(to bottom, ${stops})` }} />
      <span>{num(scale.lo, 4)} dB</span>
      <span className="fine" style={{ fontSize: 10, lineHeight: 1.2 }}>re 1 {unit}</span>
    </div>
  );
}
