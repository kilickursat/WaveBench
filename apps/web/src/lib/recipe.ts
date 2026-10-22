// Analysis recipe: everything needed to repeat a result except the measurements themselves (a recipe is not a data
// archive). Columns are referenced by name so a recipe can be applied to another file with the same layout.
import type { GeneratorSpec, ParseOptions, TimestampPolicy } from "@wavebench/core";
import type { ChainStep } from "@wavebench/dsp-cpu";
import type { BackendPreference, ConfigureResult, DataConfig, Interval, ProcessResult, SourceInfo, TimeUnit } from "../engine/protocol";
import type { FftUi, StftUi, WelchUi } from "../state/model";

export const RECIPE_SCHEMA = "wavebench.recipe/1";

export interface RecipeChannel {
  column: string;
  label: string;
  enabled: boolean;
  offset: number;
  gain: number;
}

export type RecipeTimebase =
  | { mode: "rate"; sampleRateHz: number; startSec: number }
  | { mode: "column"; column: string; unit: TimeUnit; rateFrom: "fit" | "median"; policy: TimestampPolicy };

export interface Recipe {
  schema: typeof RECIPE_SCHEMA;
  application: { name: "WaveBench"; version: string };
  created: string;
  input: {
    kind: SourceInfo["kind"];
    name: string;
    bytes: number | null;
    sha256: string | null;
    rows: number;
    columns: string[];
    parse: ParseOptions | null;
    generator: GeneratorSpec | null;
  };
  record: {
    channels: RecipeChannel[];
    unit: string;
    displayUnit: string;
    timebase: RecipeTimebase;
    rows: { start: number; end: number };
    magnitude: boolean;
  };
  resolved: {
    samples: number;
    sampleRateHz: number;
    startSec: number;
    rateSource: string;
    timestampQuality: string | null;
  } | null;
  processing: { steps: ChainStep[]; filters: { index: number; description: string; sos: number[]; realizedOrder?: number; maxPoleRadius?: number; roundingBound?: number }[] };
  interval: { startSample: number; endSample: number };
  analyses: { signal: "processed" | "raw"; fft: FftUi; welch: WelchUi; stft: StftUi };
  compute: { preference: BackendPreference };
  conventions: Record<string, string>;
}

export const CONVENTIONS: Record<string, string> = {
  windows: "periodic (DFT-even) generalised cosine windows, coefficients of scipy.signal.windows",
  spectrum: "X[k] = sum w[n] u[n] exp(-2 pi i k n / M); one-sided, C[k] = 1 at DC and even-M Nyquist, else 2",
  amplitude: "peak = C|X| / |sum w|; rms = peak / sqrt(2) except DC and even-M Nyquist; power = C|X|^2 / (sum w)^2",
  psd: "C|X|^2 / (fs sum w^2), unit^2/Hz; Welch = arithmetic mean of complete-frame PSDs",
  frames: "complete frames only; frame p covers [pH, pH + L); time = start + (pH + L/2) / fs",
  detrend: "per segment or frame, as scipy.signal.detrend (constant: mean, linear: least-squares line)",
  filters: "Butterworth by bilinear transform with pre-warped edges (scipy.signal.butter), second-order sections; notch as scipy.signal.iirnotch (Q = f0 / -3 dB width); zero-phase = forward-backward with scipy.signal.sosfiltfilt padding",
  decibels: "10 log10(P / 1 unit^2[/Hz]) for power-like values, 20 log10(A / 1 unit[/sqrt Hz]) for amplitudes",
};

export function buildRecipe(args: {
  version: string;
  source: SourceInfo;
  config: DataConfig;
  configured: ConfigureResult | null;
  chain: ChainStep[];
  process: ProcessResult | null;
  interval: Interval;
  signal: "processed" | "raw";
  fft: FftUi;
  welch: WelchUi;
  stft: StftUi;
  backend: BackendPreference;
}): Recipe {
  const { source, config } = args;
  const name = (i: number) => source.names[i] ?? `Column ${i + 1}`;
  const tb = config.timebase;
  return {
    schema: RECIPE_SCHEMA,
    application: { name: "WaveBench", version: args.version },
    created: new Date().toISOString(),
    input: {
      kind: source.kind, name: source.name, bytes: source.bytes, sha256: source.sha256, rows: source.rowCount,
      columns: source.names, parse: source.parseOptions, generator: source.generator,
    },
    record: {
      channels: config.channels.map((c) => ({ column: name(c.column), label: c.label, enabled: c.enabled, offset: c.offset, gain: c.gain })),
      unit: config.unit,
      displayUnit: config.displayUnit,
      timebase: tb.mode === "rate" ? tb : { mode: "column", column: name(tb.column), unit: tb.unit, rateFrom: tb.rateFrom, policy: tb.policy },
      rows: config.rows,
      magnitude: config.magnitude,
    },
    resolved: args.configured && {
      samples: args.configured.samples,
      sampleRateHz: args.configured.sampleRateHz,
      startSec: args.configured.startSec,
      rateSource: args.configured.rateSource,
      timestampQuality: args.configured.diagnostics?.quality ?? null,
    },
    processing: {
      steps: args.chain,
      filters: (args.process?.steps ?? []).filter((s) => s.sos).map((s) => ({
        index: s.index, description: s.description, sos: s.sos!, realizedOrder: s.realizedOrder, maxPoleRadius: s.maxPoleRadius,
        roundingBound: s.roundingBound,
      })),
    },
    interval: { startSample: args.interval.start, endSample: args.interval.end },
    analyses: { signal: args.signal, fft: args.fft, welch: args.welch, stft: args.stft },
    compute: { preference: args.backend },
    conventions: CONVENTIONS,
  };
}

export class RecipeError extends Error {}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate the structure of a parsed recipe (values are checked again when applied). */
export function parseRecipe(json: unknown): Recipe {
  if (!isObject(json)) throw new RecipeError("not a JSON object");
  if (json.schema !== RECIPE_SCHEMA) throw new RecipeError(`unsupported recipe schema "${String(json.schema)}" (expected ${RECIPE_SCHEMA})`);
  const record = json.record;
  if (!isObject(record) || !Array.isArray(record.channels) || !isObject(record.timebase)) throw new RecipeError("the recipe has no record section");
  for (const c of record.channels) {
    if (!isObject(c) || typeof c.column !== "string" || typeof c.offset !== "number" || typeof c.gain !== "number") {
      throw new RecipeError("each channel needs a column name, an offset and a gain");
    }
  }
  const tb = record.timebase;
  if (tb.mode === "rate") {
    if (typeof tb.sampleRateHz !== "number" || !(tb.sampleRateHz > 0)) throw new RecipeError("the sampling rate must be positive");
  } else if (tb.mode === "column") {
    if (typeof tb.column !== "string") throw new RecipeError("the time column must be named");
  } else throw new RecipeError("unknown timebase mode");
  if (!isObject(json.processing) || !Array.isArray(json.processing.steps)) throw new RecipeError("the recipe has no processing section");
  if (!isObject(json.interval) || typeof json.interval.startSample !== "number" || typeof json.interval.endSample !== "number") {
    throw new RecipeError("the recipe has no analysis interval");
  }
  if (!isObject(json.analyses)) throw new RecipeError("the recipe has no analysis settings");
  return json as unknown as Recipe;
}

/** Map a recipe's record onto the columns of the loaded source; null fields name what is missing. */
export function recipeConfig(recipe: Recipe, source: SourceInfo): { config: DataConfig | null; missing: string[] } {
  const index = (name: string) => source.names.indexOf(name);
  const missing: string[] = [];
  const channels = recipe.record.channels.flatMap((c) => {
    const i = index(c.column);
    if (i < 0) {
      missing.push(c.column);
      return [];
    }
    return [{ column: i, label: c.label, enabled: c.enabled, offset: c.offset, gain: c.gain }];
  });
  const tb = recipe.record.timebase;
  let timebase: DataConfig["timebase"];
  if (tb.mode === "rate") timebase = tb;
  else {
    const i = index(tb.column);
    if (i < 0) {
      missing.push(tb.column);
      return { config: null, missing };
    }
    timebase = { mode: "column", column: i, unit: tb.unit, rateFrom: tb.rateFrom, policy: tb.policy };
  }
  if (!channels.length) return { config: null, missing };
  const end = Math.min(recipe.record.rows.end, source.rowCount);
  return {
    config: {
      channels, unit: recipe.record.unit, displayUnit: recipe.record.displayUnit, timebase,
      rows: { start: Math.min(recipe.record.rows.start, end - 2), end }, magnitude: recipe.record.magnitude,
    },
    missing,
  };
}
