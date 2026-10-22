import { unitDef, type GeneratorSpec } from "@wavebench/core";
import type { ChainStep } from "@wavebench/dsp-cpu";
import exampleWithTime from "../../../../examples/acceleration-with-time.csv?raw";
import { engine, EngineError } from "../engine/client";
import type { ConfigureResult, DataConfig, GpuStatusInfo, ProcessResult, SelfTestRow, SniffReply, SourceInfo, TimeUnit } from "../engine/protocol";
import { DEFAULT_POLICY, DEFAULT_STFT, DEFAULT_WELCH, fittingWindow, type ColumnRole, type ImportDraft } from "./model";
import { getState, notify, setState } from "./store";

export function errorText(e: unknown): string {
  return e instanceof EngineError || e instanceof Error ? e.message : String(e);
}

function busy(label: string | null, fraction: number | null = null): void {
  setState({ busy: label ? { label, fraction } : null });
}

// ---------------------------------------------------------------------------------------------------------------
// Import

const TIME_NAME = /^(t|time|timestamp|date[ _-]?time|zeit|temps|tiempo|sec|seconds|elapsed)\b|(^|[_ (\[])(time|timestamp)([_ )\]]|$)/i;

function guessUnit(names: string[]): string {
  const text = names.join(" ");
  if (/m\s*\/\s*s\s*(\^?\s*2|²)|m\s*s\s*\^?-2|mps2/i.test(text)) return "m/s^2";
  if (/(^|[_ (\[])mg([_ )\]]|$)/i.test(text)) return "mg";
  if (/(^|[_ (\[])g([_ )\]]|$)/i.test(text)) return "g";
  if (/(^|[_ (\[])gal([_ )\]]|$)/i.test(text)) return "Gal";
  if (/(^|[_ (\[])m?v([_ )\]]|$)/i.test(text)) return /(^|[_ (\[])mv/i.test(text) ? "mV" : "V";
  if (/count|lsb|adc|raw/i.test(text)) return "count";
  return "unknown";
}

function guessTimeUnit(name: string): TimeUnit {
  if (/(^|[_ (\[])(ms|msec|millis)/i.test(name)) return "ms";
  if (/(^|[_ (\[])(us|µs|usec|micros)/i.test(name)) return "us";
  if (/(^|[_ (\[])(ns|nsec|nanos)/i.test(name)) return "ns";
  return "s";
}

export function draftFromSniff(sniff: SniffReply, base: { name: string; kind: SourceInfo["kind"]; file?: File; text?: string }): ImportDraft {
  let timeColumn = sniff.columnKinds.findIndex((k) => k === "datetime" || k === "time-of-day");
  if (timeColumn < 0) timeColumn = sniff.columnNames.findIndex((n, i) => sniff.columnKinds[i] === "number" && TIME_NAME.test(n.trim()));
  const roles: ColumnRole[] = sniff.columnKinds.map((k, i) => (i === timeColumn ? "time" : k === "number" ? "signal" : "ignore"));
  const signalNames = sniff.columnNames.filter((_, i) => roles[i] === "signal");
  return {
    ...base,
    sniff,
    options: {
      delimiter: sniff.delimiter, decimal: sniff.decimal, skipLines: sniff.skipLines, hasHeader: sniff.hasHeader,
      columnNames: sniff.hasHeader ? undefined : sniff.columnNames, columnKinds: sniff.columnKinds,
    },
    roles,
    unit: guessUnit(signalNames),
    timeUnit: timeColumn >= 0 ? guessTimeUnit(sniff.columnNames[timeColumn]) : "s",
    rate: "",
    start: "0",
  };
}

export async function openFile(file: File): Promise<void> {
  busy("Reading file");
  try {
    const sniff = await engine.call<SniffReply>({ type: "sniff", file, name: file.name });
    setState({ importDraft: draftFromSniff(sniff, { name: file.name, kind: "file", file }) });
  } catch (e) {
    notify("error", `${file.name}: ${errorText(e)}`);
  } finally {
    busy(null);
  }
}

/** Validation message for the import dialog, or null when it can be imported. */
export function importProblem(d: ImportDraft): string | null {
  if (!d.roles.includes("signal")) return "Choose at least one signal column.";
  if (d.roles.filter((r) => r === "time").length > 1) return "Choose one time column at most.";
  if (!d.roles.includes("time")) {
    const fs = Number(d.rate);
    if (!d.rate.trim() || !Number.isFinite(fs) || fs <= 0) return "Enter the sampling rate: without a time column it cannot be inferred from the values.";
    if (!Number.isFinite(Number(d.start))) return "The start time must be a number.";
  }
  return null;
}

export async function confirmImport(d: ImportDraft): Promise<void> {
  const problem = importProblem(d);
  if (problem) {
    notify("error", problem);
    return;
  }
  setState({ importDraft: null });
  busy("Reading", 0);
  try {
    const source = await engine.call<SourceInfo>(
      { type: "load", file: d.file, text: d.text, name: d.name, kind: d.kind, options: d.options },
      { onProgress: (f, label) => busy(label ?? "Reading", f) },
    );
    const timeColumn = d.roles.indexOf("time");
    const config: DataConfig = {
      channels: d.roles.flatMap((r, i) => (r === "signal" ? [{ column: i, label: source.names[i], enabled: true, offset: 0, gain: 1 }] : [])),
      unit: d.unit,
      displayUnit: d.unit,
      timebase:
        timeColumn >= 0
          ? { mode: "column", column: timeColumn, unit: d.timeUnit, rateFrom: "fit", policy: DEFAULT_POLICY }
          : { mode: "rate", sampleRateHz: Number(d.rate), startSec: Number(d.start) || 0 },
      rows: { start: 0, end: source.rowCount },
      magnitude: false,
    };
    setState({ source, chainDraft: [], chainApplied: [], process: null, processError: null, hidden: [], highlight: null });
    if (source.issueCount) {
      notify("warning", `${source.issueCount.toLocaleString()} cells could not be read as numbers; they are kept as missing values (see Data).`);
    }
    if (d.note) notify("info", d.note);
    await applyConfig(config, true);
  } catch (e) {
    notify("error", `${d.name}: ${errorText(e)}`);
  } finally {
    busy(null);
  }
}

export async function openExample(which: "with-time" | "rate-only"): Promise<void> {
  const text = which === "with-time"
    ? exampleWithTime
    : exampleWithTime.split("\n").map((line) => line.slice(line.indexOf(",") + 1)).join("\n");
  const name = which === "with-time" ? "acceleration-with-time.csv" : "acceleration-raw.csv";
  busy("Opening example");
  try {
    const sniff = await engine.call<SniffReply>({ type: "sniff", text, name });
    const draft = draftFromSniff(sniff, { name, kind: "example", text });
    draft.unit = "g";
    if (which === "rate-only") {
      draft.rate = "1024";
      draft.note = "Synthetic example without timestamps: the sampling rate 1024 Hz comes from its recipe (examples/example.recipe.json).";
    } else draft.note = "Synthetic example (generated, not measured): 3 axes in g, timestamps at 1024 Hz.";
    await confirmImport(draft);
  } catch (e) {
    notify("error", errorText(e));
    busy(null);
  }
}

export async function generate(spec: GeneratorSpec): Promise<void> {
  setState({ generatorOpen: false });
  busy("Generating");
  try {
    const source = await engine.call<SourceInfo>({ type: "generate", spec, name: "Generated signals" });
    setState({ source, chainDraft: [], chainApplied: [], process: null, processError: null, hidden: [], highlight: null });
    await applyConfig({
      channels: spec.channels.map((c, i) => ({ column: i, label: c.name, enabled: true, offset: 0, gain: 1 })),
      unit: spec.unit,
      displayUnit: spec.unit,
      timebase: { mode: "rate", sampleRateHz: spec.sampleRateHz, startSec: 0 },
      rows: { start: 0, end: spec.samples },
      magnitude: false,
    }, true);
  } catch (e) {
    notify("error", errorText(e));
  } finally {
    busy(null);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Configuration and processing

export async function applyConfig(config: DataConfig, fresh = false): Promise<void> {
  try {
    unitDef(config.unit);
    const configured = await engine.call<ConfigureResult>({ type: "configure", config });
    const n = configured.samples;
    setState((s) => {
      const samplesChanged = !s.configured || s.configured.samples !== n;
      // A new rate or start time moves every sample in time: the visible range (in seconds) must follow.
      const spanChanged = !s.configured || s.configured.firstTimeSec !== configured.firstTimeSec || s.configured.lastTimeSec !== configured.lastTimeSec;
      const full = { start: 0, end: n };
      const fullView = { tMin: configured.firstTimeSec, tMax: configured.lastTimeSec };
      const ids = configured.channels.map((c) => c.id);
      return {
        config,
        configured,
        configError: null,
        dataRev: s.dataRev + 1,
        interval: fresh || samplesChanged || !s.interval ? full : s.interval,
        view: fresh || samplesChanged || spanChanged || !s.view ? fullView : s.view,
        hidden: s.hidden.filter((h) => ids.includes(h)),
        welch: fresh ? { ...s.welch, windowLength: fittingWindow(DEFAULT_WELCH.windowLength, n) } : s.welch,
        stft: {
          ...s.stft,
          windowLength: fresh ? fittingWindow(n > 200_000 ? 1024 : DEFAULT_STFT.windowLength, n) : s.stft.windowLength,
          channel: s.stft.channel && ids.includes(s.stft.channel) ? s.stft.channel : ids[0] ?? null,
        },
      };
    });
    if (configured.usable) await runChain(getState().chainApplied, true);
    else setState({ process: null });
  } catch (e) {
    setState({ config, configError: errorText(e) });
  }
}

export async function runChain(steps: ChainStep[], quiet = false): Promise<void> {
  busy("Filtering");
  try {
    const process = await engine.call<ProcessResult>({ type: "process", steps });
    setState((s) => ({ chainApplied: steps, chainDraft: steps, process, processError: null, dataRev: s.dataRev + 1 }));
    if (!quiet || process.warnings.length) for (const w of process.warnings) notify("warning", w);
  } catch (e) {
    setState({ processError: errorText(e) });
    if (!quiet) notify("error", errorText(e));
  } finally {
    busy(null);
  }
}

export function updateConfig(patch: Partial<DataConfig>): void {
  const config = getState().config;
  if (!config) return;
  void applyConfig({ ...config, ...patch });
}

// ---------------------------------------------------------------------------------------------------------------
// GPU

export async function initGpu(): Promise<GpuStatusInfo | null> {
  try {
    const gpu = await engine.call<GpuStatusInfo>({ type: "gpuStatus" });
    setState({ gpu });
    return gpu;
  } catch (e) {
    setState({ gpu: { available: false, reason: errorText(e), adapter: null, fallback: false, maxBufferMiB: null } });
    return null;
  }
}

export async function runSelfTest(): Promise<void> {
  setState({ selfTest: { running: true, rows: [], error: null } });
  try {
    await engine.call<SelfTestRow[]>({ type: "gpuSelfTest" }, {
      onEvent: (row) => setState((s) => ({ selfTest: { running: true, rows: [...(s.selfTest?.rows ?? []), row as SelfTestRow], error: null } })),
    });
    setState((s) => ({ selfTest: { running: false, rows: s.selfTest?.rows ?? [], error: null } }));
  } catch (e) {
    setState((s) => ({ selfTest: { running: false, rows: s.selfTest?.rows ?? [], error: errorText(e) } }));
  }
}
