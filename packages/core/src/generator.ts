// Deterministic synthetic signals with known content, for checking scaling and filters against expectations
// (e.g. a 0.2 g, 50 Hz sine must read 0.2 g peak with a flat-top window; white noise of standard deviation s has a
// one-sided PSD of 2 s^2 / fs). Generated data are labelled as synthetic everywhere they appear.
import { assertInteger, assertPositiveFinite, WaveBenchError } from "./errors";

export type SignalComponent =
  | { kind: "sine"; frequencyHz: number; amplitude: number; phaseDeg: number }
  | { kind: "dc"; value: number }
  /** Linear chirp cos(2 pi (f0 t + (f1 - f0) t^2 / (2 T))), T = time of the last sample (scipy.signal.chirp). */
  | { kind: "chirp"; f0Hz: number; f1Hz: number; amplitude: number }
  /** White Gaussian noise with standard deviation `rms`, from a seeded xoshiro128** generator. */
  | { kind: "noise"; rms: number; seed: number }
  /** a exp(-((t - t0) / w)^2) */
  | { kind: "pulse"; timeSec: number; widthSec: number; amplitude: number };

export interface GeneratorSpec {
  sampleRateHz: number;
  samples: number;
  unit: string;
  channels: { name: string; components: SignalComponent[] }[];
}

export const MAX_GENERATED_SAMPLES = 20_000_000;

export function generateSignals(spec: GeneratorSpec): Float64Array[] {
  assertPositiveFinite(spec.sampleRateHz, "sample rate");
  assertInteger(spec.samples, 2, "number of samples");
  if (spec.samples > MAX_GENERATED_SAMPLES) throw new WaveBenchError("TOO_LARGE", `at most ${MAX_GENERATED_SAMPLES} samples per channel`);
  const fs = spec.sampleRateHz;
  const n = spec.samples;
  const lastTime = (n - 1) / fs;
  return spec.channels.map((channel) => {
    const x = new Float64Array(n);
    for (const c of channel.components) {
      switch (c.kind) {
        case "sine": {
          const phase = (c.phaseDeg * Math.PI) / 180;
          for (let i = 0; i < n; i++) x[i] += c.amplitude * Math.sin(2 * Math.PI * c.frequencyHz * (i / fs) + phase);
          break;
        }
        case "dc":
          for (let i = 0; i < n; i++) x[i] += c.value;
          break;
        case "chirp": {
          const rate = (c.f1Hz - c.f0Hz) / lastTime;
          for (let i = 0; i < n; i++) {
            const t = i / fs;
            x[i] += c.amplitude * Math.cos(2 * Math.PI * (c.f0Hz * t + 0.5 * rate * t * t));
          }
          break;
        }
        case "noise": {
          const gauss = gaussianSource(c.seed);
          for (let i = 0; i < n; i++) x[i] += c.rms * gauss();
          break;
        }
        case "pulse":
          for (let i = 0; i < n; i++) {
            const u = (i / fs - c.timeSec) / c.widthSec;
            x[i] += c.amplitude * Math.exp(-u * u);
          }
          break;
      }
    }
    return x;
  });
}

/** xoshiro128** (Blackman & Vigna), seeded through splitmix32; 32-bit outputs. */
export function xoshiro128(seed: number): () => number {
  let s = seed >>> 0;
  const split = () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
  let a = split();
  let b = split();
  let c = split();
  let d = split();
  return () => {
    const result = Math.imul(rotl(Math.imul(b, 5) >>> 0, 7), 9) >>> 0;
    const t = (b << 9) >>> 0;
    c ^= a;
    d ^= b;
    b ^= c;
    a ^= d;
    c ^= t;
    d = rotl(d, 11);
    return result;
  };
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** Standard normal deviates by the Box-Muller transform. */
export function gaussianSource(seed: number): () => number {
  const next = xoshiro128(seed);
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    const u1 = (next() + 1) / 4294967296;
    const u2 = next() / 4294967296;
    const r = Math.sqrt(-2 * Math.log(u1));
    spare = r * Math.sin(2 * Math.PI * u2);
    return r * Math.cos(2 * Math.PI * u2);
  };
}
