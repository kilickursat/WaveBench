import { useState } from "react";
import { compatibleUnits, MAX_GENERATED_SAMPLES, type GeneratorSpec, type SignalComponent } from "@wavebench/core";
import { generate } from "../state/actions";
import { setState, useApp } from "../state/store";
import { int, num } from "../lib/format";
import { Icon, Modal, Select } from "./ui";

type Kind = SignalComponent["kind"];

const KIND_LABELS: Record<Kind, string> = { sine: "Sine", dc: "Offset", chirp: "Linear chirp", noise: "White noise", pulse: "Gaussian pulse" };

const FIELDS: Record<Kind, { key: string; label: string }[]> = {
  sine: [{ key: "frequencyHz", label: "f (Hz)" }, { key: "amplitude", label: "amplitude" }, { key: "phaseDeg", label: "phase (°)" }],
  dc: [{ key: "value", label: "value" }],
  chirp: [{ key: "f0Hz", label: "f₀ (Hz)" }, { key: "f1Hz", label: "f₁ (Hz)" }, { key: "amplitude", label: "amplitude" }],
  noise: [{ key: "rms", label: "std. dev." }, { key: "seed", label: "seed" }],
  pulse: [{ key: "timeSec", label: "t₀ (s)" }, { key: "widthSec", label: "width (s)" }, { key: "amplitude", label: "amplitude" }],
};

const DEFAULTS: Record<Kind, SignalComponent> = {
  sine: { kind: "sine", frequencyHz: 50, amplitude: 0.1, phaseDeg: 0 },
  dc: { kind: "dc", value: 1 },
  chirp: { kind: "chirp", f0Hz: 10, f1Hz: 200, amplitude: 0.1 },
  noise: { kind: "noise", rms: 0.01, seed: 1 },
  pulse: { kind: "pulse", timeSec: 1, widthSec: 0.02, amplitude: 0.2 },
};

interface Draft {
  rate: number;
  duration: number;
  unit: string;
  channels: { name: string; components: SignalComponent[] }[];
}

const PRESETS: { name: string; detail: string; draft: Draft }[] = [
  {
    name: "Tone check",
    detail: "0.2 g at 50 Hz on X; an off-bin 120.37 Hz tone on Y; noise on 1 g on Z",
    draft: {
      rate: 1000, duration: 10, unit: "g", channels: [
        { name: "X", components: [{ kind: "sine", frequencyHz: 50, amplitude: 0.2, phaseDeg: 0 }] },
        { name: "Y", components: [{ kind: "sine", frequencyHz: 120.37, amplitude: 0.1, phaseDeg: 30 }, { kind: "dc", value: 0.5 }] },
        { name: "Z", components: [{ kind: "dc", value: 1 }, { kind: "noise", rms: 0.01, seed: 3 }] },
      ],
    },
  },
  {
    name: "Chirp, pulse and noise",
    detail: "a 5–400 Hz sweep, a shock at 6 s, white noise of known PSD (2σ²/fs)",
    draft: {
      rate: 2000, duration: 12, unit: "m/s^2", channels: [
        { name: "X", components: [{ kind: "chirp", f0Hz: 5, f1Hz: 400, amplitude: 1 }, { kind: "noise", rms: 0.02, seed: 1 }] },
        { name: "Y", components: [{ kind: "noise", rms: 0.1, seed: 2 }] },
        { name: "Z", components: [{ kind: "dc", value: 9.80665 }, { kind: "pulse", timeSec: 6, widthSec: 0.005, amplitude: 4 }, { kind: "noise", rms: 0.02, seed: 4 }] },
      ],
    },
  },
  {
    name: "Rotating machine",
    detail: "29.6 Hz shaft line with harmonics, a 148 Hz component and noise",
    draft: {
      rate: 5000, duration: 20, unit: "g", channels: [
        { name: "X", components: [{ kind: "sine", frequencyHz: 29.6, amplitude: 0.05, phaseDeg: 0 }, { kind: "sine", frequencyHz: 59.2, amplitude: 0.02, phaseDeg: 40 }, { kind: "sine", frequencyHz: 148, amplitude: 0.01, phaseDeg: 0 }, { kind: "noise", rms: 0.004, seed: 11 }] },
        { name: "Y", components: [{ kind: "sine", frequencyHz: 29.6, amplitude: 0.03, phaseDeg: 90 }, { kind: "noise", rms: 0.004, seed: 12 }] },
        { name: "Z", components: [{ kind: "dc", value: 1 }, { kind: "sine", frequencyHz: 88.8, amplitude: 0.008, phaseDeg: 0 }, { kind: "noise", rms: 0.003, seed: 13 }] },
      ],
    },
  },
];

export function GeneratorDialog() {
  const open = useApp((s) => s.generatorOpen);
  if (!open) return null;
  return <GeneratorForm />;
}

function GeneratorForm() {
  const [d, setD] = useState<Draft>(structuredClone(PRESETS[0].draft));
  const samples = Math.round(d.rate * d.duration);
  const nyquist = d.rate / 2;
  const tooHigh = d.channels.flatMap((c) => c.components).some((c) => (c.kind === "sine" && c.frequencyHz >= nyquist) || (c.kind === "chirp" && Math.max(c.f0Hz, c.f1Hz) >= nyquist));
  const problem =
    !(d.rate > 0) ? "The sampling rate must be positive." :
    !(samples >= 2) ? "Increase the duration: at least two samples are needed." :
    samples > MAX_GENERATED_SAMPLES ? `At most ${int(MAX_GENERATED_SAMPLES)} samples per channel.` :
    null;
  const setComponent = (ci: number, ki: number, patch: Partial<Record<string, number>>) =>
    setD({ ...d, channels: d.channels.map((c, i) => (i !== ci ? c : { ...c, components: c.components.map((k, j) => (j === ki ? ({ ...k, ...patch } as SignalComponent) : k)) })) });
  const close = () => setState({ generatorOpen: false });
  const spec: GeneratorSpec = { sampleRateHz: d.rate, samples, unit: d.unit, channels: d.channels };
  return (
    <Modal
      title="Signal generator"
      onClose={close}
      width={820}
      footer={
        <>
          <span className="problem">{problem}</span>
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn primary" disabled={!!problem} onClick={() => void generate(spec)}>Generate</button>
        </>
      }
    >
      <div className="form-row">
        <label>
          Preset
          <Select value="" options={[{ value: "", label: "Choose…" }, ...PRESETS.map((p, i) => ({ value: String(i), label: p.name }))]} onChange={(v) => v !== "" && setD(structuredClone(PRESETS[Number(v)].draft))} />
        </label>
        <label>
          Sampling rate (Hz)
          <input className="input" inputMode="decimal" value={d.rate} onChange={(e) => setD({ ...d, rate: Number(e.target.value) })} />
        </label>
        <label>
          Duration (s)
          <input className="input" inputMode="decimal" value={d.duration} onChange={(e) => setD({ ...d, duration: Number(e.target.value) })} />
        </label>
        <label>
          Unit
          <Select value={d.unit} options={compatibleUnits("g").map((u) => ({ value: u.id, label: u.label }))} onChange={(v) => setD({ ...d, unit: v })} />
        </label>
      </div>
      <p className="hint" style={{ marginTop: -4 }}>
        {int(samples)} samples per channel · Nyquist {num(nyquist)} Hz{tooHigh ? " · a component is at or above Nyquist and will alias" : ""}. Generated data are labelled
        synthetic; noise is reproducible from its seed.
      </p>
      {d.channels.map((c, ci) => (
        <div key={ci} style={{ marginTop: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, maxWidth: 420 }}>
            <input className="input" style={{ width: 90 }} value={c.name} aria-label="Channel name" onChange={(e) => setD({ ...d, channels: d.channels.map((x, i) => (i === ci ? { ...x, name: e.target.value } : x)) })} />
            <Select<string>
              ariaLabel={`Add a component to ${c.name}`}
              value=""
              options={[{ value: "", label: "Add component…" }, ...(Object.keys(KIND_LABELS) as Kind[]).map((k) => ({ value: k, label: KIND_LABELS[k] }))]}
              onChange={(k) => k && setD({ ...d, channels: d.channels.map((x, i) => (i === ci ? { ...x, components: [...x.components, { ...DEFAULTS[k as Kind] }] } : x)) })}
            />
          </div>
          {c.components.map((k, ki) => (
            <div className="component" key={ki}>
              <span>{KIND_LABELS[k.kind]}</span>
              {FIELDS[k.kind].map((f) => (
                <label key={f.key} className="gen-field">
                  <small>{f.label}</small>
                  <input className="input" inputMode="decimal" aria-label={`${KIND_LABELS[k.kind]} ${f.label}`} value={(k as unknown as Record<string, number>)[f.key]} onChange={(e) => setComponent(ci, ki, { [f.key]: Number(e.target.value) })} />
                </label>
              ))}
              {Array.from({ length: 3 - FIELDS[k.kind].length }, (_, i) => <span key={i} />)}
              <button className="btn ghost icon small" aria-label="Remove component" onClick={() => setD({ ...d, channels: d.channels.map((x, i) => (i === ci ? { ...x, components: x.components.filter((_, j) => j !== ki) } : x)) })}>
                <Icon name="trash" size={14} />
              </button>
            </div>
          ))}
        </div>
      ))}
    </Modal>
  );
}
