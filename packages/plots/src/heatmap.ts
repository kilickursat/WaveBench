// Spectrogram raster mapping shared by the CPU renderer and the WebGPU fragment shader (packages/dsp-webgpu).
// Cell (p, k) covers t in [t_p - hop/2, t_p + hop/2) and f in [f_k - df/2, f_k + df/2): columns centred on the
// frame times, rows on the bin frequencies. When several cells fall into one pixel, the pixel shows their maximum,
// so a short event is never lost by zooming out (sampled with a stride above 32 cells per axis).
import { colormapRgba, type ColormapName } from "./colormaps";

export interface HeatmapGrid {
  frames: number;
  bins: number;
  /** Time of the centre of frame 0, seconds. */
  firstTimeSec: number;
  /** H / fs. */
  hopSec: number;
  /** fs / M. */
  binWidthHz: number;
}

export interface HeatmapView {
  tMin: number;
  tMax: number;
  fMin: number;
  fMax: number;
  width: number;
  height: number;
}

export interface ColorScale {
  /** "db": 10 log10(v / ref) for power-like values, 20 log10(v / ref) for amplitudes; "linear": v itself. */
  mode: "db" | "linear";
  dbFactor: 10 | 20;
  reference: number;
  /** Colour range in display units (dB or linear). Values below lo get the lowest colour. */
  lo: number;
  hi: number;
  colormap: ColormapName;
}

export const MAX_CELLS_PER_AXIS = 32;

/** Continuous cell coordinates of the view edges: u along frames, v along bins (v increases with frequency). */
export function cellCoordinates(grid: HeatmapGrid, view: HeatmapView): { u0: number; u1: number; v0: number; v1: number } {
  const t0 = grid.firstTimeSec - grid.hopSec / 2;
  return {
    u0: (view.tMin - t0) / grid.hopSec,
    u1: (view.tMax - t0) / grid.hopSec,
    v0: view.fMin / grid.binWidthHz + 0.5,
    v1: view.fMax / grid.binWidthHz + 0.5,
  };
}

/** Normalised colour position in [0, 1]; NaN for no value. */
export function colorPosition(v: number, scale: ColorScale): number {
  if (!(v === v)) return NaN;
  let d: number;
  if (scale.mode === "db") d = v > 0 ? scale.dbFactor * Math.log10(v / scale.reference) : -Infinity;
  else d = v;
  const t = (d - scale.lo) / (scale.hi - scale.lo);
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
}

/** Pixel range -> inclusive cell range, clamped to the grid; null when the pixel lies outside the data. */
function cellRange(a: number, b: number, count: number): [number, number] | null {
  const lo = Math.max(0, Math.floor(a));
  const hi = Math.min(count - 1, Math.ceil(b) - 1);
  return lo > hi ? null : [lo, hi];
}

/** RGBA pixels (row 0 = top = highest frequency); transparent outside the data. */
export function renderHeatmap(
  values: ArrayLike<number>,
  grid: HeatmapGrid,
  view: HeatmapView,
  scale: ColorScale,
): Uint8ClampedArray {
  const { width, height } = view;
  const out = new Uint8ClampedArray(width * height * 4);
  const { u0, u1, v0, v1 } = cellCoordinates(grid, view);
  const lut = colormapRgba(scale.colormap);
  const columns: ([number, number] | null)[] = [];
  for (let x = 0; x < width; x++) columns.push(cellRange(u0 + ((u1 - u0) * x) / width, u0 + ((u1 - u0) * (x + 1)) / width, grid.frames));
  for (let y = 0; y < height; y++) {
    const rows = cellRange(v1 - ((v1 - v0) * (y + 1)) / height, v1 - ((v1 - v0) * y) / height, grid.bins);
    if (!rows) continue;
    const sk = Math.max(1, Math.floor((rows[1] - rows[0] + 1) / MAX_CELLS_PER_AXIS));
    for (let x = 0; x < width; x++) {
      const cols = columns[x];
      if (!cols) continue;
      const sp = Math.max(1, Math.floor((cols[1] - cols[0] + 1) / MAX_CELLS_PER_AXIS));
      let best = -Infinity;
      for (let p = cols[0]; p <= cols[1]; p += sp) {
        const row = p * grid.bins;
        for (let k = rows[0]; k <= rows[1]; k += sk) {
          const v = values[row + k];
          if (v > best) best = v;
        }
      }
      const t = colorPosition(best === -Infinity ? NaN : best, scale);
      if (Number.isNaN(t)) continue;
      const i = Math.round(t * 255) * 4;
      const o = (y * width + x) * 4;
      out[o] = lut[i];
      out[o + 1] = lut[i + 1];
      out[o + 2] = lut[i + 2];
      out[o + 3] = 255;
    }
  }
  return out;
}

/** The cell under a point, or null outside the grid. */
export function cellAt(grid: HeatmapGrid, timeSec: number, frequencyHz: number): { frame: number; bin: number } | null {
  const frame = Math.floor((timeSec - (grid.firstTimeSec - grid.hopSec / 2)) / grid.hopSec);
  const bin = Math.floor(frequencyHz / grid.binWidthHz + 0.5);
  if (frame < 0 || frame >= grid.frames || bin < 0 || bin >= grid.bins) return null;
  return { frame, bin };
}
