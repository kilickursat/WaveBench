import type { SpectrumResult, StatsResult, StftMeta, WelchResult } from "../engine/protocol";
import type { FftUi, WelchUi } from "../state/model";

/** Latest results shown on screen, for export. Not React state: never rendered from here. */
export const results: {
  fft: { value: SpectrumResult; settings: FftUi; signal: string; interval: [number, number] } | null;
  welch: { value: WelchResult; settings: WelchUi; signal: string; interval: [number, number] } | null;
  stats: { value: StatsResult; signal: string; interval: [number, number] } | null;
  stft: StftMeta | null;
} = { fft: null, welch: null, stats: null, stft: null };
