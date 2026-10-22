// Chart colours per theme. Channel hues are slots 1-8 of the validated categorical palette, assigned in fixed order
// by channel position (never by rank). The first three (blue, orange, aqua) pass the all-pairs colour-vision checks
// in both themes; the derived |a| channel uses neutral ink, as a de-emphasised derived series.

export interface ChartColors {
  surface: string;
  ink: string;
  secondary: string;
  muted: string;
  grid: string;
  axis: string;
  interval: string;
  edge: string;
  highlight: string;
  series: string[];
  derived: string;
}

const LIGHT: ChartColors = {
  surface: "#fcfcfb",
  ink: "#0b0b0b",
  secondary: "#52514e",
  muted: "#898781",
  grid: "#e1e0d9",
  axis: "#c3c2b7",
  interval: "rgba(42, 120, 214, 0.07)",
  edge: "rgba(137, 135, 129, 0.16)",
  highlight: "rgba(235, 104, 52, 0.14)",
  series: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"],
  derived: "#52514e",
};

const DARK: ChartColors = {
  surface: "#1a1a19",
  ink: "#f0efec",
  secondary: "#c3c2b7",
  muted: "#898781",
  grid: "#2c2c2a",
  axis: "#383835",
  interval: "rgba(57, 135, 229, 0.10)",
  edge: "rgba(137, 135, 129, 0.18)",
  highlight: "rgba(217, 89, 38, 0.20)",
  series: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
  derived: "#c3c2b7",
};

export function chartColors(dark: boolean): ChartColors {
  return dark ? DARK : LIGHT;
}

/**
 * Colour of a channel by its position among the configured channels (stable when others are hidden). Hues are
 * never cycled: channels past the eighth use neutral ink and are told apart by their panel label and legend.
 */
export function channelColor(colors: ChartColors, ids: string[], id: string): string {
  if (id === "mag") return colors.derived;
  const i = ids.filter((x) => x !== "mag").indexOf(id);
  return i >= 0 && i < colors.series.length ? colors.series[i] : colors.derived;
}
