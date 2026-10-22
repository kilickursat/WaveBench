import { useState } from "react";
import { compatibleUnits, UNITS, unitLabel } from "@wavebench/core";
import { describeFilter, isBandSpec, MAX_ORDER, validateFilterSpec, type ChainStep, type FilterSpec } from "@wavebench/dsp-cpu";
import { applyConfig, runChain, updateConfig } from "../state/actions";
import { DEFAULT_POLICY } from "../state/model";
import { setState, useApp } from "../state/store";
import type { DataConfig, TimeUnit } from "../engine/protocol";
import { channelColor, chartColors } from "../lib/colors";
import { hertz, int, num, percent, seconds } from "../lib/format";
import { useDark } from "../lib/hooks";
import { Field, Icon, NumberField, Section, Segmented, Select } from "./ui";

export function Sidebar() {
  const open = useApp((s) => s.sidebarOpen);
  const source = useApp((s) => s.source);
  if (!source) return <aside className={`sidebar ${open ? "open" : ""}`} />;
  return (
    <aside className={`sidebar ${open ? "open" : ""}`}>
      <DataSection />
      <TimebaseSection />
      <ChannelsSection />
      <ProcessingSection />
    </aside>
  );
}

function DataSection() {
  const source = useApp((s) => s.source)!;
  const config = useApp((s) => s.config);
  const used = config?.channels.filter((c) => c.enabled).map((c) => c.column) ?? [];
  const usedIssues = used.reduce((n, c) => n + (source.columnIssueCounts[c] ?? 0), 0);
  const firstIssue = source.issues.find((i) => i.column !== null && used.includes(i.column));
  const rows = config?.rows ?? { start: 0, end: source.rowCount };
  return (
    <Section title="Data">
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <strong style={{ wordBreak: "break-all" }}>{source.name}</strong>
        {source.kind !== "file" && <span className="badge">synthetic</span>}
      </div>
      <dl className="kv">
        <dt>Rows</dt>
        <dd>{int(source.rowCount)}</dd>
        <dt>Columns</dt>
        <dd>{source.names.length}</dd>
        {source.bytes !== null && (
          <>
            <dt>Size</dt>
            <dd>{num(source.bytes / 1024, 4)} KiB</dd>
          </>
        )}
        {source.sha256 && (
          <>
            <dt>SHA-256</dt>
            <dd title={source.sha256} style={{ fontFamily: "var(--mono)" }}>{source.sha256.slice(0, 12)}…</dd>
          </>
        )}
      </dl>
      {usedIssues > 0 && (
        <div className="callout warn">
          <strong>{int(usedIssues)} missing or unreadable values</strong>
          They stay missing (never zero). Filters and transforms refuse a channel with gaps; choose rows without them below.
          {firstIssue && <div className="hint">First at line {firstIssue.line}{firstIssue.token ? `: “${firstIssue.token}”` : ""}.</div>}
        </div>
      )}
      {config && (
        <Field label="Rows used" wide title="Rows of the file used as the record (1-based, inclusive)">
          <div className="input-unit">
            <NumberField ariaLabel="First row" integer min={1} max={source.rowCount - 1} value={rows.start + 1} onCommit={(v) => v !== null && v - 1 < rows.end - 1 && updateConfig({ rows: { start: v - 1, end: rows.end } })} />
            <em>–</em>
            <NumberField ariaLabel="Last row" integer min={2} max={source.rowCount} value={rows.end} onCommit={(v) => v !== null && v > rows.start + 1 && updateConfig({ rows: { start: rows.start, end: v } })} />
          </div>
        </Field>
      )}
    </Section>
  );
}

function TimebaseSection() {
  const source = useApp((s) => s.source)!;
  const config = useApp((s) => s.config);
  const configured = useApp((s) => s.configured);
  const configError = useApp((s) => s.configError);
  const axis = useApp((s) => s.axis);
  if (!config) return configError ? <Section title="Timebase"><div className="callout bad">{configError}</div></Section> : null;
  const tb = config.timebase;
  const candidates = source.names
    .map((n, i) => ({ n, i }))
    .filter(({ i }) => source.kinds[i] !== "text" && source.kinds[i] !== "empty" && !config.channels.some((c) => c.column === i && c.enabled));
  const setTimebase = (timebase: DataConfig["timebase"]) => updateConfig({ timebase });
  const d = configured?.diagnostics;
  const quality = d?.quality;
  return (
    <Section title="Timebase">
      <Segmented
        label="Timebase source"
        value={tb.mode}
        options={[
          { value: "rate", label: "Sampling rate" },
          { value: "column", label: "Time column", disabled: candidates.length === 0, title: candidates.length ? undefined : "No column is free to serve as time" },
        ]}
        onChange={(m) => {
          if (m === "rate") setTimebase({ mode: "rate", sampleRateHz: configured?.sampleRateHz ?? 1000, startSec: configured?.startSec ?? 0 });
          else if (candidates.length) setTimebase({ mode: "column", column: candidates[0].i, unit: "s", rateFrom: "fit", policy: DEFAULT_POLICY });
        }}
      />
      {tb.mode === "rate" ? (
        <>
          <Field label="Sampling rate">
            <div className="input-unit">
              <NumberField ariaLabel="Sampling rate in hertz" min={Number.MIN_VALUE} value={tb.sampleRateHz} onCommit={(v) => v !== null && v > 0 && setTimebase({ ...tb, sampleRateHz: v })} />
              <em>Hz</em>
            </div>
          </Field>
          <Field label="Start time">
            <div className="input-unit">
              <NumberField ariaLabel="Start time in seconds" value={tb.startSec} onCommit={(v) => v !== null && setTimebase({ ...tb, startSec: v })} />
              <em>s</em>
            </div>
          </Field>
        </>
      ) : (
        <>
          <Field label="Column">
            <Select value={tb.column} options={candidates.map(({ n, i }) => ({ value: i, label: n }))} onChange={(i) => setTimebase({ ...tb, column: i })} />
          </Field>
          {source.kinds[tb.column] === "number" && (
            <Field label="Unit">
              <Select<TimeUnit> value={tb.unit} options={[{ value: "s", label: "seconds" }, { value: "ms", label: "milliseconds" }, { value: "us", label: "microseconds" }, { value: "ns", label: "nanoseconds" }]} onChange={(u) => setTimebase({ ...tb, unit: u })} />
            </Field>
          )}
          <Field label="Rate from" title="The least-squares fit uses every timestamp and tolerates coarse timestamp resolution">
            <Select value={tb.rateFrom} options={[{ value: "fit", label: "Least-squares fit" }, { value: "median", label: "Median interval" }]} onChange={(r) => setTimebase({ ...tb, rateFrom: r })} />
          </Field>
          <Field label="Tolerance" title="Largest allowed distance of a timestamp from the uniform grid">
            <div className="input-unit">
              <NumberField ariaLabel="Tolerance in percent of the interval" min={0.001} max={50} value={Number((tb.policy.maxResidualFraction * 100).toPrecision(6))} onCommit={(v) => v !== null && setTimebase({ ...tb, policy: { ...tb.policy, maxResidualFraction: v / 100 } })} />
              <em>% dt</em>
            </div>
          </Field>
          {d && (
            <div className={`callout ${quality === "uniform-within-policy" ? "good" : quality === "irregular" ? "warn" : "bad"}`}>
              <strong>
                {quality === "uniform-within-policy" ? "Uniform within the tolerance" : quality === "irregular" ? "Irregular timestamps" : "Invalid timestamps"}
              </strong>
              {d.reasons.map((r, i) => <div key={i}>{r}</div>)}
              <dl className="kv">
                <dt>Median interval</dt>
                <dd>{d.medianIntervalSec ? seconds(d.medianIntervalSec) : "–"}</dd>
                <dt>Rate, fit</dt>
                <dd>{d.sampleRateFromFitHz ? hertz(d.sampleRateFromFitHz) : "–"}</dd>
                <dt>Rate, median</dt>
                <dd>{d.sampleRateFromMedianHz ? hertz(d.sampleRateFromMedianHz) : "–"}</dd>
                <dt>Largest deviation</dt>
                <dd>{d.maxResidualSec !== null && d.fitIntervalSec ? percent(d.maxResidualSec / d.fitIntervalSec) + " of dt" : "–"}</dd>
                <dt>Gaps</dt>
                <dd>{d.gapCount}</dd>
              </dl>
              {quality !== "uniform-within-policy" && (
                <div className="actions">
                  {d.sampleRateFromFitHz && quality === "irregular" && (
                    <button className="btn small" title="Treat the record as uniformly sampled at the fitted rate (stated in the recipe)" onClick={() => setTimebase({ mode: "rate", sampleRateHz: Number(d.sampleRateFromFitHz!.toPrecision(10)), startSec: configured?.startSec ?? 0 })}>
                      Use {hertz(Number(d.sampleRateFromFitHz.toPrecision(6)))} as sampling rate
                    </button>
                  )}
                  {d.longestSegment && d.gapCount > 0 && d.longestSegment.end - d.longestSegment.start >= 2 && (
                    <button className="btn small" onClick={() => {
                      const r0 = config.rows.start;
                      void applyConfig({ ...config, rows: { start: r0 + d.longestSegment!.start, end: r0 + d.longestSegment!.end } });
                    }}>
                      Use rows {int(config.rows.start + d.longestSegment.start + 1)}–{int(config.rows.start + d.longestSegment.end)} (no gaps)
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
      {configured && !configured.usable && (
        <dl className="kv">
          <dt>Samples N</dt>
          <dd>{int(configured.samples)}</dd>
          <dt>First to last timestamp</dt>
          <dd>{seconds(configured.lastTimeSec - configured.firstTimeSec)}</dd>
        </dl>
      )}
      {configured?.usable && (
        <dl className="kv">
          <dt>Samples N</dt>
          <dd>{int(configured.samples)}</dd>
          <dt>Interval 1/fs</dt>
          <dd>{seconds(1 / configured.sampleRateHz)}</dd>
          <dt>Span N/fs</dt>
          <dd>{seconds(configured.samples / configured.sampleRateHz)}</dd>
          <dt>Last sample</dt>
          <dd>{seconds(configured.lastTimeSec)}</dd>
          <dt>Nyquist fs/2</dt>
          <dd>{hertz(configured.sampleRateHz / 2)}</dd>
        </dl>
      )}
      {tb.mode === "column" && source.timeOrigins[tb.column] && <p className="hint">Time zero is {source.timeOrigins[tb.column]}.</p>}
      <Field label="Time axis">
        <Segmented label="Time axis" value={axis} options={[{ value: "time", label: "Seconds" }, { value: "samples", label: "Samples" }]} onChange={(a) => setState({ axis: a })} />
      </Field>
    </Section>
  );
}

function ChannelsSection() {
  const source = useApp((s) => s.source)!;
  const config = useApp((s) => s.config);
  const configured = useApp((s) => s.configured);
  const dark = useDark();
  const [calibration, setCalibration] = useState(false);
  if (!config) return null;
  const colors = chartColors(dark);
  const ids = configured?.channels.map((c) => c.id) ?? [];
  const numeric = source.names.map((n, i) => ({ n, i })).filter(({ i }) => source.kinds[i] === "number" && !(config.timebase.mode === "column" && config.timebase.column === i));
  const setChannels = (channels: DataConfig["channels"]) => updateConfig({ channels });
  const channelFor = (i: number) => config.channels.find((c) => c.column === i);
  const units = compatibleUnits(config.unit);
  return (
    <Section title="Channels">
      <Field label="Signal unit" title="The unit the values in the file are in (after calibration)">
        <Select value={config.unit} options={UNITS.map((u) => ({ value: u.id, label: u.label }))} onChange={(u) => updateConfig({ unit: u, displayUnit: u })} />
      </Field>
      {units.length > 1 && (
        <Field label="Show in" title="Converted exactly: 1 g = 9.80665 m/s²">
          <Select value={config.displayUnit} options={units.map((u) => ({ value: u.id, label: u.label }))} onChange={(u) => updateConfig({ displayUnit: u })} />
        </Field>
      )}
      <div style={{ marginTop: 8 }}>
        {numeric.map(({ n, i }) => {
          const c = channelFor(i);
          const id = `c${i}`;
          return (
            <div className="channel" key={i}>
              <input
                type="checkbox"
                aria-label={`Use ${n}`}
                checked={!!c?.enabled}
                onChange={(e) => {
                  const exists = !!c;
                  const next = exists
                    ? config.channels.map((x) => (x.column === i ? { ...x, enabled: e.target.checked } : x))
                    : [...config.channels, { column: i, label: n, enabled: true, offset: 0, gain: 1 }].sort((a, b) => a.column - b.column);
                  setChannels(next);
                }}
              />
              <span className="swatch" style={{ background: c?.enabled ? channelColor(colors, ids, id) : "transparent", border: c?.enabled ? "none" : "1px solid var(--border-strong)" }} />
              <input
                type="text"
                aria-label={`Label of ${n}`}
                defaultValue={c?.label ?? n}
                key={c?.label ?? n}
                disabled={!c?.enabled}
                onBlur={(e) => c && e.target.value.trim() && e.target.value !== c.label && setChannels(config.channels.map((x) => (x.column === i ? { ...x, label: e.target.value.trim().slice(0, 40) } : x)))}
              />
              <small title={`Column ${i + 1}: ${n}`}>{c && c.label !== n ? n : `col ${i + 1}`}</small>
            </div>
          );
        })}
        {configured?.channels.filter((c) => c.missing > 0).map((c) => (
          <p className="hint" key={c.id}>{c.label}: {int(c.missing)} missing samples</p>
        ))}
      </div>
      <label className="field wide" style={{ gridTemplateColumns: "18px 1fr", display: "grid" }}>
        <input type="checkbox" checked={config.magnitude} disabled={config.channels.filter((c) => c.enabled).length < 2} onChange={(e) => updateConfig({ magnitude: e.target.checked })} />
        <span>
          Add |a| = √(x² + y² + z²)
          <span className="hint" style={{ display: "block", margin: 0 }}>A derived, nonlinear channel from the processed axes: its spectrum is not a sum of the axis spectra.</span>
        </span>
      </label>
      <button className="btn small ghost" onClick={() => setCalibration((v) => !v)} aria-expanded={calibration}>
        <Icon name={calibration ? "up" : "down"} size={14} /> Calibration
      </button>
      {calibration && (
        <div style={{ marginTop: 6 }}>
          <p className="hint">value = (raw − offset) × gain, in {unitLabel(config.unit)}. Identity (0, 1) leaves the file values unchanged.</p>
          {config.channels.filter((c) => c.enabled).map((c) => (
            <div key={c.column} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, alignItems: "center", margin: "4px 0" }}>
              <span>{c.label}</span>
              <NumberField ariaLabel={`Offset of ${c.label}`} value={c.offset} onCommit={(v) => v !== null && setChannels(config.channels.map((x) => (x.column === c.column ? { ...x, offset: v } : x)))} />
              <NumberField ariaLabel={`Gain of ${c.label}`} value={c.gain} onCommit={(v) => v !== null && v !== 0 && setChannels(config.channels.map((x) => (x.column === c.column ? { ...x, gain: v } : x)))} />
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

const FILTER_TYPES = [
  { value: "lowpass", label: "Low-pass" },
  { value: "highpass", label: "High-pass" },
  { value: "bandpass", label: "Band-pass" },
  { value: "bandstop", label: "Band-stop" },
  { value: "notch", label: "Notch" },
] as const;

type FilterType = (typeof FILTER_TYPES)[number]["value"];

function specOfType(type: FilterType, fs: number, previous?: FilterSpec): FilterSpec {
  const n = fs / 2;
  const f = (v: number) => Number(Math.min(v, n * 0.9).toPrecision(3));
  const order = previous && previous.family === "butterworth" ? Math.min(previous.order, type === "bandpass" || type === "bandstop" ? MAX_ORDER.bandpass : MAX_ORDER.lowpass) : 4;
  switch (type) {
    case "lowpass":
      return { family: "butterworth", response: "lowpass", order, cutoffHz: f(Math.min(100, n / 4)) };
    case "highpass":
      return { family: "butterworth", response: "highpass", order, cutoffHz: f(Math.min(1, n / 100)) };
    case "bandpass":
      return { family: "butterworth", response: "bandpass", order: Math.min(order, 4), lowHz: f(n / 20), highHz: f(n / 4) };
    case "bandstop":
      return { family: "butterworth", response: "bandstop", order: Math.min(order, 4), lowHz: f(n / 12), highHz: f(n / 8) };
    case "notch":
      return { family: "notch", centerHz: f(Math.min(50, n / 4)), q: 30 };
  }
}

function typeOf(spec: FilterSpec): FilterType {
  return spec.family === "notch" ? "notch" : spec.response;
}

function ProcessingSection() {
  const draft = useApp((s) => s.chainDraft);
  const applied = useApp((s) => s.chainApplied);
  const process = useApp((s) => s.process);
  const processError = useApp((s) => s.processError);
  const configured = useApp((s) => s.configured);
  const [editing, setEditing] = useState<number | null>(null);
  if (!configured) return null;
  const fs = configured.sampleRateHz;
  const dirty = JSON.stringify(draft) !== JSON.stringify(applied);
  const invalid = draft.some((s) => s.kind === "filter" && s.enabled && validateFilterSpec(s.spec, fs) !== null);
  const setDraft = (steps: ChainStep[]) => setState({ chainDraft: steps });
  const update = (i: number, step: ChainStep) => setDraft(draft.map((s, j) => (j === i ? step : s)));
  const move = (i: number, d: number) => {
    const next = draft.slice();
    const [s] = next.splice(i, 1);
    next.splice(i + d, 0, s);
    setDraft(next);
  };
  return (
    <Section title="Processing">
      {!configured.usable && <p className="hint">Processing needs a uniform timebase.</p>}
      {draft.length === 0 && <p className="hint">No processing: analyses use the calibrated samples. Filters run on the whole record before the analysis interval is cut.</p>}
      {draft.map((step, i) => {
        const appliedStep = process?.steps.find((s) => s.index === i);
        const problem = step.kind === "filter" ? validateFilterSpec(step.spec, fs) : null;
        return (
          <div key={i} className={`step ${step.enabled ? "" : "disabled"}`}>
            <div className="step-head">
              <input type="checkbox" checked={step.enabled} aria-label="Enabled" onChange={(e) => update(i, { ...step, enabled: e.target.checked })} />
              <div className="title">
                {step.kind === "detrend" ? (step.mode === "constant" ? "Remove mean" : "Remove linear trend") : describeFilter(step.spec)}
                <small>
                  {step.kind === "detrend" ? "over the whole record" : step.mode === "zero-phase" ? "zero-phase, forward-backward" : "causal, single pass"}
                </small>
              </div>
              <button className="btn ghost icon small" aria-label="Edit" aria-expanded={editing === i} onClick={() => setEditing(editing === i ? null : i)}><Icon name="edit" size={14} /></button>
              <button className="btn ghost icon small" aria-label="Remove" onClick={() => { setDraft(draft.filter((_, j) => j !== i)); setEditing(null); }}><Icon name="trash" size={14} /></button>
            </div>
            {(editing === i || problem) && (
              <div className="step-body">
                {draft.length > 1 && (
                  <div className="row-actions" style={{ marginTop: 6 }}>
                    <span className="hint" style={{ margin: 0, alignSelf: "center" }}>Step {i + 1} of {draft.length}</span>
                    <button className="btn small" disabled={i === 0} onClick={() => { move(i, -1); setEditing(i - 1); }}><Icon name="up" size={14} /> Earlier</button>
                    <button className="btn small" disabled={i === draft.length - 1} onClick={() => { move(i, 1); setEditing(i + 1); }}><Icon name="down" size={14} /> Later</button>
                  </div>
                )}
                {step.kind === "detrend" ? (
                  <Field label="Remove">
                    <Select value={step.mode} options={[{ value: "constant", label: "Mean" }, { value: "linear", label: "Linear trend" }]} onChange={(m) => update(i, { ...step, mode: m })} />
                  </Field>
                ) : (
                  <FilterEditor step={step} fs={fs} onChange={(s) => update(i, s)} />
                )}
                {problem && <div className="callout bad">{problem}</div>}
              </div>
            )}
            {appliedStep && !dirty && step.kind === "filter" && (
              <div className="step-body hint" style={{ marginTop: 0 }}>
                Order {appliedStep.realizedOrder} as {appliedStep.sections} sections · max |pole| {num(appliedStep.maxPoleRadius ?? NaN, 8)}
                {appliedStep.transientSamples ? ` · start-up ≈ ${seconds(appliedStep.transientSamples / fs)}` : ""}
              </div>
            )}
          </div>
        );
      })}
      <div className="row-actions">
        <button className="btn small" disabled={!configured.usable} onClick={() => { setDraft([...draft, { kind: "filter", enabled: true, spec: specOfType("lowpass", fs), mode: "zero-phase", initial: "zero", padding: "odd" }]); setEditing(draft.length); }}>
          <Icon name="plus" size={14} /> Filter
        </button>
        <button className="btn small" disabled={!configured.usable} onClick={() => setDraft([...draft, { kind: "detrend", enabled: true, mode: "constant" }])}>
          <Icon name="plus" size={14} /> Remove mean
        </button>
      </div>
      {(dirty || processError) && (
        <div className="row-actions">
          <button className="btn primary small" disabled={!dirty || invalid || !configured.usable} onClick={() => { void runChain(draft); setEditing(null); }}>
            Apply
          </button>
          <button className="btn small" disabled={!dirty} onClick={() => setDraft(applied)}>Revert</button>
          {dirty && <span className="hint" style={{ margin: 0, alignSelf: "center" }}>Results use the applied chain until you apply.</span>}
        </div>
      )}
      {processError && <div className="callout bad">{processError}</div>}
      {process && !dirty && process.edgeStart > 0 && (
        <p className="hint">
          Filter start-up regions (99.9 % of the impulse-response energy) are shaded on the time plot: {seconds(process.edgeStart / fs)}
          {process.edgeEnd > 0 ? " at each end" : " at the start"}.
        </p>
      )}
    </Section>
  );
}

function FilterEditor({ step, fs, onChange }: { step: Extract<ChainStep, { kind: "filter" }>; fs: number; onChange: (s: ChainStep) => void }) {
  const spec = step.spec;
  const set = (patch: Partial<FilterSpec>) => onChange({ ...step, spec: { ...spec, ...patch } as FilterSpec });
  const hz = (label: string, value: number, key: string) => (
    <Field label={label}>
      <div className="input-unit">
        <NumberField ariaLabel={label} min={Number.MIN_VALUE} max={fs / 2} value={value} onCommit={(v) => v !== null && set({ [key]: v } as Partial<FilterSpec>)} />
        <em>Hz</em>
      </div>
    </Field>
  );
  return (
    <>
      <Field label="Type">
        <Select<FilterType> value={typeOf(spec)} options={FILTER_TYPES.map((t) => ({ value: t.value, label: t.label }))} onChange={(t) => onChange({ ...step, spec: specOfType(t, fs, spec) })} />
      </Field>
      {spec.family === "notch" ? (
        <>
          {hz("Centre", spec.centerHz, "centerHz")}
          <Field label="Q" title="Centre frequency divided by the -3 dB width">
            <NumberField ariaLabel="Quality factor" min={Number.MIN_VALUE} value={spec.q} onCommit={(v) => v !== null && set({ q: v })} />
          </Field>
          <p className="hint">-3 dB width {hertz(spec.centerHz / spec.q)}</p>
        </>
      ) : (
        <>
          {isBandSpec(spec) ? (
            <>
              {hz("Low edge", spec.lowHz, "lowHz")}
              {hz("High edge", spec.highHz, "highHz")}
            </>
          ) : hz("Cutoff", spec.cutoffHz, "cutoffHz")}
          <Field label="Order" title={spec.response === "bandpass" || spec.response === "bandstop" ? "Prototype order N; the filter has order 2N" : undefined}>
            <NumberField ariaLabel="Order" integer min={1} max={MAX_ORDER[spec.response]} value={spec.order} onCommit={(v) => v !== null && set({ order: v })} />
          </Field>
        </>
      )}
      <Field label="Application">
        <Select value={step.mode} options={[{ value: "zero-phase", label: "Zero-phase (forward-backward)" }, { value: "causal", label: "Causal (single pass)" }]} onChange={(m) => onChange({ ...step, mode: m })} />
      </Field>
      {step.mode === "zero-phase" ? (
        <Field label="Edge padding" title="Extension of the record before filtering (scipy.signal.sosfiltfilt)">
          <Select value={step.padding} options={[{ value: "odd", label: "Odd (default)" }, { value: "even", label: "Even" }, { value: "constant", label: "Constant" }, { value: "none", label: "None" }]} onChange={(p) => onChange({ ...step, padding: p })} />
        </Field>
      ) : (
        <Field label="Initial state">
          <Select value={step.initial} options={[{ value: "zero", label: "Zero" }, { value: "steady-state", label: "Steady state at the first sample" }]} onChange={(v) => onChange({ ...step, initial: v })} />
        </Field>
      )}
      <p className="hint">
        {step.mode === "zero-phase"
          ? "Forward-backward squares the magnitude: the cutoff is -6 dB, not -3 dB, and the effective order doubles. No delay."
          : "One pass: |H| is -3 dB at the cutoff, with phase delay (see Filter response)."}
      </p>
    </>
  );
}
