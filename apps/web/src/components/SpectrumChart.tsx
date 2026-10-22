import { useCallback, useMemo, useRef } from "react";
import type uPlot from "uplot";
import { linearGroups, logGroups, minMaxEnvelope } from "@wavebench/plots";
import type { ChartColors } from "../lib/colors";
import { charts } from "../lib/exports";
import { hertz, num, tick } from "../lib/format";
import { tooltipPlugin, UPlotChart } from "./Chart";

export interface SpectrumSeries {
  id: string;
  label: string;
  color: string;
  values: Float64Array;
}

export interface PeakLabel {
  id: string;
  frequencyHz: number;
  value: number;
}

/** Display arrays for bins [k0, k1): every bin when they fit, otherwise a min/max envelope per pixel. */
function display(series: SpectrumSeries[], binWidthHz: number, k0: number, k1: number, width: number, logX: boolean, logY: boolean): uPlot.AlignedData {
  const bins = series[0]?.values.length ?? 0;
  const lo = Math.max(logX ? 1 : 0, k0);
  const hi = Math.min(bins, k1);
  if (hi <= lo) return [[], ...series.map(() => [])] as uPlot.AlignedData;
  const fix = (v: number) => (logY && !(v > 0)) || !Number.isFinite(v) ? null : v;
  if (hi - lo <= 2 * width) {
    const x = new Float64Array(hi - lo);
    for (let k = lo; k < hi; k++) x[k - lo] = k * binWidthHz;
    return [x, ...series.map((s) => Array.from(s.values.subarray(lo, hi), fix))] as uPlot.AlignedData;
  }
  const bounds = logX ? logGroups((k) => k * binWidthHz, lo, hi, width) : linearGroups(lo, hi, width);
  const env = minMaxEnvelope(series.map((s) => s.values), bounds);
  const x = env.index.map((k) => k * binWidthHz);
  return [x, ...env.values.map((v) => Array.from(v, fix))] as uPlot.AlignedData;
}

export function SpectrumChart({
  chartKey, series, binWidthHz, logX, logY, yLabel, valueText, peaks, colors, height,
}: {
  chartKey: string;
  series: SpectrumSeries[];
  binWidthHz: number;
  logX: boolean;
  logY: boolean;
  yLabel: string;
  valueText: (v: number) => string;
  peaks?: PeakLabel[];
  colors: ChartColors;
  height?: string;
}) {
  const plot = useRef<uPlot | null>(null);
  const width = Math.round(Math.min(4096, (window.innerWidth || 1600) * Math.min(2, window.devicePixelRatio || 1)));
  const live = useRef({ series, binWidthHz, logX, logY, peaks, valueText });
  live.current = { series, binWidthHz, logX, logY, peaks, valueText };
  const bins = series[0]?.values.length ?? 0;
  const data = useMemo(() => display(series, binWidthHz, 0, bins, width, logX, logY), [series, binWidthHz, bins, width, logX, logY]);
  const structure = `${series.map((s) => `${s.id}:${s.color}`).join(",")}|${logX}|${logY}|${yLabel}|${colors.surface}`;
  const options = useMemo<Omit<uPlot.Options, "width" | "height">>(() => ({
    scales: {
      x: { time: false, distr: logX ? 3 : 1 },
      y: { distr: logY ? 3 : 1 },
    },
    legend: { show: false },
    cursor: { drag: { x: true, y: false, setScale: true }, points: { size: 6 } },
    axes: [
      { stroke: colors.muted, grid: { stroke: colors.grid, width: 1 }, ticks: { stroke: colors.axis, width: 1, size: 4 }, values: (_u, s) => s.map(tick), label: "frequency (Hz)", labelSize: 14, labelFont: "11px sans-serif", font: "11px sans-serif", size: 32 },
      { stroke: colors.muted, grid: { stroke: colors.grid, width: 1 }, ticks: { stroke: colors.axis, width: 1, size: 4 }, values: (_u, s) => s.map(tick), label: yLabel, labelSize: 14, labelFont: "11px sans-serif", font: "11px sans-serif", size: 62 },
    ],
    series: [{}, ...series.map((s) => ({ label: s.label, stroke: s.color, width: 1.5, points: { show: false } }))],
    hooks: {
      setScale: [
        (u: uPlot, key: string) => {
          if (key !== "x") return;
          const { min, max } = u.scales.x;
          if (min === undefined || max === undefined || min === null || max === null) return;
          const l = live.current;
          const n = l.series[0]?.values.length ?? 0;
          if (n <= 2 * width) return;
          const k0 = Math.max(0, Math.floor(min / l.binWidthHz) - 1);
          const k1 = Math.min(n, Math.ceil(max / l.binWidthHz) + 2);
          // Re-decimate the visible bins after uPlot has finished this scale change (setData here would re-enter it).
          requestAnimationFrame(() => {
            if (u.scales.x.min !== min || u.scales.x.max !== max) return;
            u.setData(display(l.series, l.binWidthHz, k0, k1, width, l.logX, l.logY), false);
            u.redraw();
          });
        },
      ],
      draw: [
        (u: uPlot) => {
          const l = live.current;
          if (!l.peaks?.length) return;
          const { ctx } = u;
          const dpr = devicePixelRatio || 1;
          ctx.save();
          ctx.font = `${Math.round(11 * dpr)}px sans-serif`;
          ctx.textAlign = "center";
          for (const p of l.peaks) {
            const s = l.series.find((x) => x.id === p.id);
            if (!s || (l.logY && !(p.value > 0))) continue;
            const x = u.valToPos(p.frequencyHz, "x", true);
            const y = u.valToPos(p.value, "y", true);
            if (x < u.bbox.left || x > u.bbox.left + u.bbox.width || y < u.bbox.top || y > u.bbox.top + u.bbox.height) continue;
            ctx.beginPath();
            ctx.arc(x, y, 4 * dpr, 0, 2 * Math.PI);
            ctx.fillStyle = s.color;
            ctx.strokeStyle = colors.surface;
            ctx.lineWidth = 2 * dpr;
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = colors.ink;
            ctx.fillText(hertz(p.frequencyHz), x, Math.max(u.bbox.top + 12 * dpr, y - 9 * dpr));
          }
          ctx.restore();
        },
      ],
    },
    plugins: [
      tooltipPlugin((u, idx) => {
        if (idx === null) return null;
        const f = u.data[0][idx];
        return {
          title: hertz(f),
          rows: live.current.series.map((s, i) => {
            const v = u.data[i + 1][idx];
            return { color: s.color, label: s.label, value: v === null || v === undefined ? "–" : live.current.valueText(v as number) };
          }),
        };
      }),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [structure]);
  const onReady = useCallback((u: uPlot | null) => {
    plot.current = u;
    if (u) charts.set(chartKey, u);
    else charts.delete(chartKey);
  }, [chartKey]);
  return (
    <div className="chart" style={{ height: height ?? "100%" }}>
      {series.length > 1 && (
        <div className="chart-label legend">
          {series.map((s) => (
            <span key={s.id}>
              <i style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <UPlotChart options={options} data={data} onReady={onReady} />
    </div>
  );
}

export function numberText(unit: string): (v: number) => string {
  return (v: number) => `${num(v, 5)} ${unit}`;
}
