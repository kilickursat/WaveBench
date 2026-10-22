import { DEFAULT_TIMESTAMP_POLICY, type ParseOptions, type SpectralQuantity } from "@wavebench/core";
import type { ChainStep, FrameQuantity } from "@wavebench/dsp-cpu";
import type { ColormapName } from "@wavebench/plots";
import type {
  BackendPreference, ConfigureResult, DataConfig, FftSettings, FrameSettings, GpuStatusInfo, Interval, ProcessResult,
  SelfTestRow, SniffReply, SourceInfo, TimeUnit,
} from "../engine/protocol";

export type Tab = "fft" | "welch" | "stft" | "filter" | "stats" | "data";
export type Theme = "system" | "light" | "dark";
export type ColumnRole = "time" | "signal" | "ignore";
export type Scale = "linear" | "log" | "db";

export interface ImportDraft {
  name: string;
  kind: SourceInfo["kind"];
  file?: File;
  text?: string;
  sniff: SniffReply;
  options: ParseOptions;
  roles: ColumnRole[];
  unit: string;
  timeUnit: TimeUnit;
  rate: string;
  start: string;
  note?: string;
}

export interface FftUi extends FftSettings {
  output: SpectralQuantity;
  yScale: Scale;
  xScale: "linear" | "log";
  phase: boolean;
}

export interface WelchUi extends FrameSettings {
  output: "psd" | "asd" | "power";
  yScale: Scale;
  xScale: "linear" | "log";
  bandLow: number | null;
  bandHigh: number | null;
}

export interface StftUi extends FrameSettings {
  channel: string | null;
  quantity: FrameQuantity;
  colormap: ColormapName;
  rangeDb: number;
  topDb: number | null;
}

export interface Notice {
  id: number;
  kind: "error" | "warning" | "info";
  text: string;
}

export interface AppState {
  theme: Theme;
  importDraft: ImportDraft | null;
  generatorOpen: boolean;
  busy: { label: string; fraction: number | null } | null;
  notices: Notice[];
  source: SourceInfo | null;
  /** Timestamp origin text when a time column is used. */
  config: DataConfig | null;
  configured: ConfigureResult | null;
  configError: string | null;
  chainDraft: ChainStep[];
  chainApplied: ChainStep[];
  process: ProcessResult | null;
  processError: string | null;
  /** Increments whenever the samples change (configure, process); part of every result key. */
  dataRev: number;
  interval: Interval | null;
  /** Visible time range of the time plot (seconds); changing it never changes a result. */
  view: { tMin: number; tMax: number } | null;
  timeSource: "raw" | "processed" | "both";
  layout: "stacked" | "overlay";
  axis: "time" | "samples";
  hidden: string[];
  analysisSource: "processed" | "raw";
  tab: Tab;
  fft: FftUi;
  welch: WelchUi;
  stft: StftUi;
  backend: BackendPreference;
  gpu: GpuStatusInfo | null;
  selfTest: { running: boolean; rows: SelfTestRow[]; error: string | null } | null;
  /** Time span of the spectrogram frame under the pointer, shown on the time plot. */
  highlight: { startSec: number; endSec: number } | null;
  sidebarOpen: boolean;
}

export const DEFAULT_FFT: FftUi = {
  window: "hann", detrend: "constant", fftLength: "exact", output: "peak", yScale: "linear", xScale: "linear", phase: false,
};

export const DEFAULT_WELCH: WelchUi = {
  window: "hann", windowLength: 1024, overlapPercent: 50, fftFactor: 1, detrend: "constant", output: "psd", yScale: "log",
  xScale: "linear", bandLow: null, bandHigh: null,
};

export const DEFAULT_STFT: StftUi = {
  window: "hann", windowLength: 256, overlapPercent: 75, fftFactor: 1, detrend: "constant", channel: null, quantity: "psd",
  colormap: "viridis", rangeDb: 80, topDb: null,
};

export const DEFAULT_POLICY = DEFAULT_TIMESTAMP_POLICY;

export function initialState(): AppState {
  let theme: Theme = "system";
  try {
    const t = localStorage.getItem("wavebench.theme");
    if (t === "light" || t === "dark") theme = t;
  } catch {
    // storage unavailable: keep the system theme
  }
  return {
    theme, importDraft: null, generatorOpen: false, busy: null, notices: [], source: null, config: null, configured: null,
    configError: null, chainDraft: [], chainApplied: [], process: null, processError: null, dataRev: 0, interval: null,
    view: null, timeSource: "processed", layout: "stacked", axis: "time", hidden: [], analysisSource: "processed", tab: "fft",
    fft: DEFAULT_FFT, welch: DEFAULT_WELCH, stft: DEFAULT_STFT, backend: "auto", gpu: null, selfTest: null, highlight: null,
    sidebarOpen: false,
  };
}

/** A power of two near `target`, no larger than the record. */
export function fittingWindow(target: number, samples: number): number {
  let l = 1;
  while (l * 2 <= Math.min(target, samples)) l *= 2;
  return Math.max(2, l);
}
