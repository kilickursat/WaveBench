// WGSL kernels. Float32 throughout. Trigonometric values never come from WGSL sin/cos (whose accuracy is only
// guaranteed to an absolute 2^-11 on [-pi, pi]): window samples and FFT twiddles are computed in Float64 on the
// CPU and uploaded as correctly rounded Float32 tables.

/** One workgroup per frame: optional detrend (workgroup reductions), window, zero padding to M. */
export const FRAME_WGSL = /* wgsl */ `
struct Params {
  L: u32, M: u32, hop: u32, first: u32,
  frames: u32, detrend: u32, gridX: u32, pad0: u32,
  center: f32, invSxx: f32, invL: f32, pad1: f32,
};
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> sig: array<f32>;
@group(0) @binding(2) var<storage, read> win: array<f32>;
@group(0) @binding(3) var<storage, read_write> outBuf: array<vec2<f32>>;

const WG: u32 = 256u;
var<workgroup> s0: array<f32, 256>;
var<workgroup> s1: array<f32, 256>;

@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let f = wid.x + wid.y * P.gridX;
  if (f >= P.frames) { return; }
  let base = P.first + f * P.hop;
  var a = 0.0;
  var b = 0.0;
  if (P.detrend != 0u) {
    for (var n = li; n < P.L; n += WG) {
      let v = sig[base + n];
      a += v;
      b += (f32(n) - P.center) * v;
    }
  }
  s0[li] = a;
  s1[li] = b;
  workgroupBarrier();
  for (var s = WG / 2u; s > 0u; s = s >> 1u) {
    if (li < s) {
      s0[li] += s0[li + s];
      s1[li] += s1[li + s];
    }
    workgroupBarrier();
  }
  let mean = s0[0] * P.invL;
  let slope = select(0.0, s1[0] * P.invSxx, P.detrend == 2u);
  let ob = f * P.M;
  for (var n = li; n < P.M; n += WG) {
    var v = 0.0;
    if (n < P.L) {
      var x = sig[base + n];
      if (P.detrend != 0u) { x = x - mean - slope * (f32(n) - P.center); }
      v = win[n] * x;
    }
    outBuf[ob + n] = vec2<f32>(v, 0.0);
  }
}
`;

/**
 * One radix-2 Stockham stage over a batch of transforms (E. Bainville's formulation): input pairs (i, i + M/2),
 * twiddle exp(-i pi k / p) with k = i mod p, outputs at j = 2i - k and j + p. Natural order after log2(M) stages.
 */
export const FFT_STAGE_WGSL = /* wgsl */ `
struct Params {
  M: u32, half: u32, p: u32, count: u32,
  gridX: u32, twStride: u32, pad0: u32, pad1: u32,
};
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> src: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec2<f32>>;
@group(0) @binding(3) var<storage, read> tw: array<vec2<f32>>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let idx = g.x + g.y * P.gridX;
  if (idx >= P.count) { return; }
  let b = idx / P.half;
  let i = idx - b * P.half;
  let k = i & (P.p - 1u);
  let base = b * P.M;
  let u0 = src[base + i];
  let v = src[base + i + P.half];
  let w = tw[k * P.twStride];
  let u1 = vec2<f32>(v.x * w.x - v.y * w.y, v.x * w.y + v.y * w.x);
  let j = (i << 1u) - k;
  dst[base + j] = u0 + u1;
  dst[base + j + P.p] = u0 - u1;
}
`;

/** One-sided scaling: mode 0 -> C |X|^2 s (PSD or power), mode 1 -> C |X| s (peak amplitude). */
export const POWER_WGSL = /* wgsl */ `
struct Params {
  M: u32, K: u32, frames: u32, outFrame: u32,
  mode: u32, gridX: u32, evenM: u32, pad0: u32,
  scale: f32, pad1: f32, pad2: f32, pad3: f32,
};
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> spec: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> outm: array<f32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let idx = g.x + g.y * P.gridX;
  if (idx >= P.frames * P.K) { return; }
  let f = idx / P.K;
  let k = idx - f * P.K;
  let X = spec[f * P.M + k];
  var c = 2.0;
  if (k == 0u || (P.evenM == 1u && k == P.M / 2u)) { c = 1.0; }
  let m2 = X.x * X.x + X.y * X.y;
  var v = c * m2 * P.scale;
  if (P.mode == 1u) { v = c * sqrt(m2) * P.scale; }
  outm[(P.outFrame + f) * P.K + k] = v;
}
`;

/** Partial sums over chunks of frames (Welch); the chunks are added in Float64 on the CPU. */
export const COLSUM_WGSL = /* wgsl */ `
struct Params {
  K: u32, frames: u32, chunk: u32, chunks: u32,
  outChunk: u32, gridX: u32, pad0: u32, pad1: u32,
};
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> m: array<f32>;
@group(0) @binding(2) var<storage, read_write> sums: array<f32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let idx = g.x + g.y * P.gridX;
  if (idx >= P.chunks * P.K) { return; }
  let c = idx / P.K;
  let k = idx - c * P.K;
  let f0 = c * P.chunk;
  let f1 = min(f0 + P.chunk, P.frames);
  var acc = 0.0;
  for (var f = f0; f < f1; f++) { acc += m[f * P.K + k]; }
  sums[(P.outChunk + c) * P.K + k] = acc;
}
`;

/**
 * Spectrogram raster, the same mapping as renderHeatmap in packages/plots: pixel columns -> frame cells,
 * rows -> bins (top = highest frequency), maximum over covered cells (strided above 32 per axis), colour LUT.
 */
export const RENDER_WGSL = /* wgsl */ `
struct View {
  u0: f32, du: f32, v1: f32, dv: f32,
  frames: u32, bins: u32, mode: u32, pad0: u32,
  dbFactor: f32, invRef: f32, lo: f32, invRange: f32,
};
@group(0) @binding(0) var<uniform> V: View;
@group(0) @binding(1) var<storage, read> cells: array<f32>;
@group(0) @binding(2) var<storage, read> lut: array<vec4<f32>, 256>;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  var corners = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(corners[i], 0.0, 1.0);
}

fn cellRange(a: f32, b: f32, count: u32) -> vec2<i32> {
  return vec2<i32>(max(0, i32(floor(a))), min(i32(count) - 1, i32(ceil(b)) - 1));
}

@fragment
fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let x = floor(pos.x);
  let y = floor(pos.y);
  let cols = cellRange(V.u0 + V.du * x, V.u0 + V.du * (x + 1.0), V.frames);
  let rows = cellRange(V.v1 - V.dv * (y + 1.0), V.v1 - V.dv * y, V.bins);
  if (cols.x > cols.y || rows.x > rows.y) { return vec4<f32>(0.0); }
  let sp = max(1, (cols.y - cols.x + 1) / 32);
  let sk = max(1, (rows.y - rows.x + 1) / 32);
  var best = -3.0e38;
  for (var p = cols.x; p <= cols.y; p += sp) {
    let row = u32(p) * V.bins;
    for (var k = rows.x; k <= rows.y; k += sk) { best = max(best, cells[row + u32(k)]); }
  }
  var d = best;
  if (V.mode == 1u) {
    d = select(-3.0e38, V.dbFactor * log2(best * V.invRef) * 0.30102999566398120, best > 0.0);
  }
  let t = clamp((d - V.lo) * V.invRange, 0.0, 1.0);
  return lut[u32(round(t * 255.0))];
}
`;

/** Maximum of a Float32 array: per-workgroup maxima, finished on the CPU. */
export const MAX_WGSL = /* wgsl */ `
struct Params { count: u32, perThread: u32, gridX: u32, pad0: u32 };
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> values: array<f32>;
@group(0) @binding(2) var<storage, read_write> partial: array<f32>;
var<workgroup> s: array<f32, 256>;

@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let w = wid.x + wid.y * P.gridX;
  let base = w * 256u * P.perThread;
  var m = -3.0e38;
  for (var j = 0u; j < P.perThread; j++) {
    let i = base + j * 256u + li;
    if (i < P.count) { m = max(m, values[i]); }
  }
  s[li] = m;
  workgroupBarrier();
  for (var st = 128u; st > 0u; st = st >> 1u) {
    if (li < st) { s[li] = max(s[li], s[li + st]); }
    workgroupBarrier();
  }
  if (li == 0u) { partial[w] = s[0]; }
}
`;
