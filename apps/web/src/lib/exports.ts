import { csvText, unitDef } from "@wavebench/core";
import type uPlot from "uplot";
import { engine } from "../engine/client";
import { getState, notify, setState } from "../state/store";
import { applyConfig, errorText, runChain } from "../state/actions";
import { download, stem } from "./download";
import { buildRecipe, parseRecipe, recipeConfig, type Recipe } from "./recipe";
import { results } from "./results";
import { fftPhase, fftValues, frequencyAxis, quantityUnitAscii, welchValues } from "./spectra";
import { VERSION } from "./version";
import { seconds } from "./format";
import { colormapCss } from "@wavebench/plots";

/** Charts currently on screen, for the figure export. */
export const charts = new Map<string, uPlot>();

const fmt = (v: number) => (Number.isFinite(v) ? String(v) : "");

function name(suffix: string, ext: string): string {
  return `${stem(getState().source?.name ?? "wavebench")}_${suffix}.${ext}`;
}

function labelOf(id: string): string {
  return getState().configured?.channels.find((c) => c.id === id)?.label ?? id;
}

export function exportSpectrumCsv(): void {
  const r = results.fft;
  const unit = getState().config?.displayUnit ?? "unknown";
  if (!r) return notify("warning", "Compute a spectrum first.");
  const { value, settings } = r;
  const f = frequencyAxis(value.channels[0]?.re.length ?? 0, value.binWidthHz);
  const columns = value.channels.map((c) => ({ head: csvText(`${labelOf(c.id)}_${settings.output}_${quantityUnitAscii(unit, settings.output)}`), v: fftValues(value, c, settings.output) }));
  if (settings.phase) for (const c of value.channels) columns.push({ head: csvText(`${labelOf(c.id)}_phase_deg`), v: fftPhase(value, c) });
  const lines = [["frequency_Hz", ...columns.map((c) => c.head)].join(",")];
  for (let k = 0; k < f.length; k++) lines.push([fmt(f[k]), ...columns.map((c) => fmt(c.v[k]))].join(","));
  download(name("spectrum", "csv"), lines.join("\n") + "\n");
}

export function exportWelchCsv(): void {
  const r = results.welch;
  const unit = getState().config?.displayUnit ?? "unknown";
  if (!r) return notify("warning", "Compute a PSD first.");
  const { value, settings } = r;
  const f = frequencyAxis(value.channels[0]?.psd.length ?? 0, value.binWidthHz);
  const columns = value.channels.map((c) => ({ head: csvText(`${labelOf(c.id)}_${settings.output}_${quantityUnitAscii(unit, settings.output)}`), v: welchValues(value, c.psd, settings.output) }));
  const lines = [["frequency_Hz", ...columns.map((c) => c.head)].join(",")];
  for (let k = 0; k < f.length; k++) lines.push([fmt(f[k]), ...columns.map((c) => fmt(c.v[k]))].join(","));
  download(name("psd_welch", "csv"), lines.join("\n") + "\n");
}

export function exportStatsCsv(): void {
  const r = results.stats;
  const unit = unitDef(getState().config?.displayUnit ?? "unknown").ascii;
  if (!r) return notify("warning", "Open the Statistics tab first.");
  const keys = ["count", "mean", "rms", "acRms", "min", "max", "peakAbs", "peakToPeak", "crestFactor"] as const;
  const lines = [["channel", "signal", "first_sample", "end_sample", ...keys.map((k) => (k === "count" || k === "crestFactor" ? k : `${k}_${unit}`))].join(",")];
  for (const row of r.value) {
    lines.push([csvText(row.label), r.signal, r.interval[0], r.interval[1], ...keys.map((k) => (row.stats ? fmt(row.stats[k] ?? NaN) : ""))].join(","));
  }
  download(name("statistics", "csv"), lines.join("\n") + "\n");
}

export async function exportSignals(kind: "processed-csv" | "raw-csv" | "stft-csv"): Promise<void> {
  const s = getState();
  if (!s.interval) return;
  try {
    const text = await engine.call<string>({ type: "export", what: kind, interval: kind === "stft-csv" ? s.interval : { start: 0, end: s.configured?.samples ?? 0 } });
    download(name(kind === "stft-csv" ? "spectrogram" : kind === "raw-csv" ? "calibrated" : "processed", "csv"), text);
  } catch (e) {
    notify("error", errorText(e));
  }
}

export function exportFilters(): void {
  const p = getState().process;
  if (!p || !p.steps.some((s) => s.sos)) return notify("warning", "No filters are applied.");
  const fs = getState().configured?.sampleRateHz;
  const json = {
    sampleRateHz: fs,
    format: "second-order sections, rows [b0, b1, b2, a0, a1, a2], a0 = 1, direct form II transposed",
    filters: p.steps.filter((s) => s.sos).map((s) => ({
      description: s.description, realizedOrder: s.realizedOrder, maxPoleRadius: s.maxPoleRadius, roundingBound: s.roundingBound,
      sos: Array.from({ length: s.sos!.length / 6 }, (_, i) => s.sos!.slice(6 * i, 6 * i + 6)),
    })),
  };
  download(name("filters", "json"), JSON.stringify(json, null, 2), "application/json");
}

export function currentRecipe(): Recipe | null {
  const s = getState();
  if (!s.source || !s.config || !s.interval) return null;
  return buildRecipe({
    version: VERSION, source: s.source, config: s.config, configured: s.configured, chain: s.chainApplied, process: s.process,
    interval: s.interval, signal: s.analysisSource, fft: s.fft, welch: s.welch, stft: s.stft, backend: s.backend,
  });
}

export function exportRecipe(): void {
  const r = currentRecipe();
  if (!r) return notify("warning", "Open data first.");
  download(name("recipe", "json"), JSON.stringify(r, null, 2) + "\n", "application/json");
}

export async function loadRecipe(file: File): Promise<void> {
  const s = getState();
  try {
    const recipe = parseRecipe(JSON.parse(await file.text()));
    if (!s.source) {
      notify("warning", "Open the data file first: a recipe holds the settings, not the measurements.");
      return;
    }
    if (recipe.input.sha256 && s.source.sha256 && recipe.input.sha256 !== s.source.sha256) {
      notify("warning", `This recipe was made for a different file (${recipe.input.name}); settings are applied by column name.`);
    }
    const { config, missing } = recipeConfig(recipe, s.source);
    if (!config) {
      notify("error", `The recipe needs columns that this file does not have: ${missing.join(", ")}`);
      return;
    }
    if (missing.length) notify("warning", `Columns not found and skipped: ${missing.join(", ")}`);
    // Configure first (a fresh configuration resets some defaults), then apply the recipe's own settings on top.
    setState({ chainApplied: [] });
    await applyConfig(config, true);
    const configured = getState().configured;
    if (!configured) return;
    const n = configured.samples;
    const start = Math.max(0, Math.min(recipe.interval.startSample, n - 1));
    const end = Math.max(start + 1, Math.min(recipe.interval.endSample, n));
    const ids = configured.channels.map((c) => c.id);
    setState({
      fft: recipe.analyses.fft,
      welch: recipe.analyses.welch,
      stft: { ...recipe.analyses.stft, channel: recipe.analyses.stft.channel && ids.includes(recipe.analyses.stft.channel) ? recipe.analyses.stft.channel : ids[0] ?? null },
      analysisSource: recipe.analyses.signal,
      backend: recipe.compute.preference,
      interval: { start, end },
    });
    if (configured.usable) await runChain(recipe.processing.steps, true);
    notify("info", `Recipe applied (${recipe.application.name} ${recipe.application.version}).`);
  } catch (e) {
    notify("error", `Recipe: ${errorText(e)}`);
  }
}

/** The spectrogram's colour scale, to the right of its plot area. */
function drawColorBar(ctx: CanvasRenderingContext2D, u: uPlot, y: number, px: (v: number) => number): void {
  const st = getState().stft;
  const meta = results.stft!;
  const factor = st.quantity === "peak" ? 20 : 10;
  const top = st.topDb ?? (meta.max > 0 ? Math.ceil(factor * Math.log10(meta.max)) : 0);
  const x = Math.min(u.bbox.left + u.bbox.width + px(14), u.ctx.canvas.width - px(52));
  const y0 = y + u.bbox.top;
  const h = u.bbox.height;
  for (let i = 0; i < h; i++) {
    ctx.fillStyle = colormapCss(st.colormap, 1 - i / Math.max(1, h - 1));
    ctx.fillRect(x, y0 + i, px(12), 1);
  }
  ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--ink-2").trim() || "#444";
  ctx.font = `${px(11)}px sans-serif`;
  ctx.fillText(`${top} dB`, x + px(16), y0 + px(5));
  ctx.fillText(`${top - st.rangeDb} dB`, x + px(16), y0 + h - px(5));
}

/** Legend entries drawn next to a chart: colour key and text, read from the chart's label overlay. */
function legendOf(u: uPlot): { color: string | null; text: string }[] {
  const holder = u.root.closest(".chart")?.parentElement?.closest(".chart") ?? u.root.closest(".chart");
  const label = holder?.querySelector(".chart-label");
  if (!label) return [];
  const items = label.querySelectorAll("span");
  const entries = items.length ? [...items] : [label];
  return entries.map((el) => ({ color: (el.querySelector("i") as HTMLElement | null)?.style.background || null, text: el.textContent?.trim() ?? "" })).filter((e) => e.text);
}

/** One PNG with the time plot(s) and the visible analysis plot(s), as drawn on screen, with legends and context. */
export async function exportFigure(): Promise<void> {
  const list = [...charts.entries()].filter(([, u]) => u.root.isConnected && u.root.offsetParent !== null);
  if (!list.length) return notify("warning", "Nothing to export yet.");
  const s = getState();
  const css = getComputedStyle(document.body);
  const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const dpr = window.devicePixelRatio || 1;
  const px = (v: number) => Math.round(v * dpr);
  const width = Math.max(...list.map(([, u]) => u.ctx.canvas.width));
  const gap = px(8);
  const head = px(30);
  const foot = px(26);
  const height = head + list.reduce((h, [, u]) => h + u.ctx.canvas.height + gap, 0) + foot;
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = token("--surface", "#fcfcfb");
  ctx.fillRect(0, 0, width, height);
  const ink = token("--ink", "#1b1b19");
  const muted = token("--muted", "#7b7a74");
  ctx.textBaseline = "middle";
  ctx.font = `600 ${px(13)}px sans-serif`;
  ctx.fillStyle = ink;
  const iv = s.interval && s.configured ? `${seconds(s.configured.firstTimeSec + s.interval.start / s.configured.sampleRateHz)} – ${seconds(s.configured.firstTimeSec + (s.interval.end - 1) / s.configured.sampleRateHz)}` : "";
  ctx.fillText(`${s.source?.name ?? ""}  ·  analysis interval ${iv}`, px(12), head / 2);
  ctx.font = `${px(11)}px sans-serif`;
  ctx.fillStyle = muted;
  ctx.textAlign = "right";
  ctx.fillText(`WaveBench ${VERSION}`, width - px(12), head / 2);
  ctx.textAlign = "left";
  let y = head;
  for (const [key, u] of list) {
    if (key.startsWith("stft")) {
      try {
        const bitmap = await engine.call<ImageBitmap | null>({ type: "stftImage", width: Math.round(u.bbox.width), height: Math.round(u.bbox.height) });
        if (bitmap) ctx.drawImage(bitmap, u.bbox.left, y + u.bbox.top);
      } catch {
        // the axes are still exported
      }
    }
    ctx.drawImage(u.ctx.canvas, 0, y);
    if (key.startsWith("stft") && results.stft) drawColorBar(ctx, u, y, px);
    let x = px(64);
    ctx.font = `${px(12)}px sans-serif`;
    for (const entry of legendOf(u)) {
      if (entry.color) {
        ctx.fillStyle = entry.color;
        ctx.fillRect(x, y + px(9), px(12), px(3));
        x += px(17);
      }
      ctx.fillStyle = ink;
      ctx.fillText(entry.text, x, y + px(11));
      x += ctx.measureText(entry.text).width + px(14);
    }
    y += u.ctx.canvas.height + gap;
  }
  const statusLine = document.querySelector(".panel.analysis .status-line");
  const status = statusLine ? [...statusLine.children].map((c) => c.textContent?.replace(/\s+/g, " ").trim()).filter(Boolean).join("  ·  ") : "";
  if (status) {
    ctx.font = `${px(11)}px sans-serif`;
    ctx.fillStyle = muted;
    ctx.fillText(status.slice(0, 240), px(12), height - foot / 2);
  }
  out.toBlob((blob) => blob && download(name("figure", "png"), blob, "image/png"), "image/png");
}
