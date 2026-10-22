// Messages between the UI thread and the engine worker. The worker owns every sample array; the UI holds settings,
// summaries and display-sized arrays only.
import type {
  ChannelStats, ColumnKind, ComputeProvenance, GeneratorSpec, ParseIssue, ParseOptions, SniffResult, TimestampDiagnostics,
  TimestampPolicy,
} from "@wavebench/core";
import type { ChainStep, DetrendMode, FftLengthRule, FrameQuantity, PadType, WindowName } from "@wavebench/dsp-cpu";
import type { ColorScale, HeatmapGrid, HeatmapView } from "@wavebench/plots";
import type { SelfTestRow } from "@wavebench/dsp-webgpu";

export type BackendPreference = "auto" | "cpu" | "webgpu";
export type SignalSource = "raw" | "processed";
export type TimeUnit = "s" | "ms" | "us" | "ns";

export interface SourceInfo {
  name: string;
  bytes: number | null;
  sha256: string | null;
  kind: "file" | "example" | "generated";
  names: string[];
  kinds: ColumnKind[];
  rowCount: number;
  timeOrigins: (string | null)[];
  issues: ParseIssue[];
  issueCount: number;
  columnIssueCounts: number[];
  rowsWithIssues: number;
  skippedCommentLines: number;
  skippedBlankLines: number;
  parseOptions: ParseOptions | null;
  generator: GeneratorSpec | null;
  parseMs: number;
}

export interface ChannelConfig {
  /** Column index in the source table. */
  column: number;
  label: string;
  enabled: boolean;
  /** physical = (raw - offset) * gain, in the signal unit. */
  offset: number;
  gain: number;
}

export type TimebaseConfig =
  | { mode: "rate"; sampleRateHz: number; startSec: number }
  | { mode: "column"; column: number; unit: TimeUnit; rateFrom: "fit" | "median"; policy: TimestampPolicy };

export interface DataConfig {
  channels: ChannelConfig[];
  /** Unit of the calibrated values (g, m/s^2, ..., count, V, unknown). */
  unit: string;
  /** Display unit, compatible with `unit`; values are converted exactly. */
  displayUnit: string;
  timebase: TimebaseConfig;
  /** Rows of the source used as the record (end exclusive). */
  rows: { start: number; end: number };
  magnitude: boolean;
}

export interface ChannelInfo {
  id: string;
  label: string;
  derived: boolean;
  /** Missing / non-numeric cells within the used rows. */
  missing: number;
}

export interface ConfigureResult {
  samples: number;
  sampleRateHz: number;
  startSec: number;
  /** Times of the first and last sample (the timestamps themselves in time-column mode). */
  firstTimeSec: number;
  lastTimeSec: number;
  /** Analyses are allowed (false for irregular or invalid timestamps). */
  usable: boolean;
  rateSource: "assigned" | "timestamp fit" | "timestamp median";
  diagnostics: TimestampDiagnostics | null;
  channels: ChannelInfo[];
  unit: string;
  conversion: number;
}

export interface StepSummary {
  index: number;
  description: string;
  sections?: number;
  realizedOrder?: number;
  maxPoleRadius?: number;
  roundingBound?: number;
  transientSamples?: number | null;
  padLength?: number;
  sos?: number[];
}

export interface ProcessResult {
  steps: StepSummary[];
  warnings: string[];
  edgeStart: number;
  edgeEnd: number;
  ms: number;
}

export interface Interval {
  /** Sample indices within the record, end exclusive. */
  start: number;
  end: number;
}

export interface FftSettings {
  window: WindowName;
  detrend: DetrendMode;
  fftLength: FftLengthRule;
}

export interface FrameSettings {
  window: WindowName;
  windowLength: number;
  overlapPercent: number;
  /** FFT length as a multiple of the window length (1, 2, 4, 8) or "pow2". */
  fftFactor: number | "pow2";
  detrend: DetrendMode;
}

export interface SpectrumChannel {
  id: string;
  re: Float64Array;
  im: Float64Array;
}

export interface SpectrumResult {
  channels: SpectrumChannel[];
  sampleRateHz: number;
  segmentLength: number;
  fftLength: number;
  windowSum: number;
  windowEnergy: number;
  enbwHz: number;
  binWidthHz: number;
  provenance: ComputeProvenance;
  notes: string[];
}

export interface WelchResult {
  channels: { id: string; psd: Float64Array }[];
  sampleRateHz: number;
  windowLength: number;
  hopLength: number;
  fftLength: number;
  frames: number;
  unusedSamples: number;
  enbwHz: number;
  binWidthHz: number;
  provenance: ComputeProvenance;
  notes: string[];
}

export interface StftMeta {
  channel: string;
  quantity: FrameQuantity;
  grid: HeatmapGrid;
  windowLength: number;
  hopLength: number;
  fftLength: number;
  /** Largest value, for the default colour range. */
  max: number;
  provenance: ComputeProvenance;
  notes: string[];
}

export interface FilterResponse {
  frequencies: Float64Array;
  steps: { index: number; description: string; magnitude: Float64Array; phaseDeg: Float64Array | null; groupDelaySamples: Float64Array | null }[];
  combined: { magnitude: Float64Array; phaseDeg: Float64Array | null; groupDelaySamples: Float64Array | null };
}

export interface GpuStatusInfo {
  available: boolean;
  reason: string | null;
  adapter: string | null;
  fallback: boolean;
  maxBufferMiB: number | null;
}

/** Every request may carry `rev`, the data revision, so that results are recomputed when the samples change. */
export type Request = RequestBody & { rev?: number };

export type RequestBody =
  | { type: "sniff"; file?: File; text?: string; name: string }
  | { type: "load"; file?: File; text?: string; name: string; kind: SourceInfo["kind"]; options: ParseOptions }
  | { type: "generate"; spec: GeneratorSpec; name: string }
  | { type: "configure"; config: DataConfig }
  | { type: "process"; steps: ChainStep[] }
  | { type: "timeView"; source: SignalSource; channels: string[]; tMin: number; tMax: number; width: number }
  | { type: "stats"; source: SignalSource; interval: Interval }
  | { type: "spectrum"; source: SignalSource; interval: Interval; settings: FftSettings; backend: BackendPreference }
  | { type: "welch"; source: SignalSource; interval: Interval; settings: FrameSettings; backend: BackendPreference }
  | { type: "stft"; source: SignalSource; interval: Interval; channel: string; settings: FrameSettings; quantity: FrameQuantity; backend: BackendPreference }
  | { type: "attachCanvas"; canvas: OffscreenCanvas }
  | { type: "renderStft"; view: HeatmapView; scale: ColorScale }
  | { type: "probeStft"; timeSec: number; frequencyHz: number }
  | { type: "stftImage"; width: number; height: number }
  | { type: "filterResponse"; scale: "log" | "linear"; points: number }
  | { type: "rows"; start: number; count: number }
  | { type: "export"; what: ExportKind; interval: Interval }
  | { type: "gpuStatus" }
  | { type: "gpuSelfTest" }
  | { type: "cancel"; target: number };

export type ExportKind = "processed-csv" | "raw-csv" | "stft-csv";

export type RequestType = Request["type"];

export interface Envelope {
  id: number;
  request: Request;
}

export type Reply =
  | { id: number; kind: "progress"; fraction: number; label?: string }
  | { id: number; kind: "done"; result: unknown }
  | { id: number; kind: "error"; code: string; message: string }
  | { id: number; kind: "event"; event: unknown };

export interface RowsResult {
  start: number;
  times: Float64Array;
  columns: { label: string; values: Float64Array }[];
}

export type StatsResult = { id: string; label: string; stats: ChannelStats | null; error: string | null }[];

export type { PadType, SelfTestRow };

export interface TimeViewResult {
  x: Float64Array;
  index: Float64Array;
  values: Float64Array[];
  exact: boolean;
  samples: number;
}

export type SniffReply = SniffResult & { name: string; bytes: number | null };
