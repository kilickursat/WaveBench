/** Where a numerical result was computed. Every displayed or exported result carries this. */
export type Backend = "cpu" | "webgpu";
export type Precision = "float64" | "float32";

export interface ComputeProvenance {
  backend: Backend;
  precision: Precision;
  /** Wall-clock time of the request in the engine, including GPU upload and readback where used. */
  elapsedMs: number;
  /** GPU adapter description when backend is webgpu. */
  adapter?: string;
}

export const PRECISION_OF: Record<Backend, Precision> = { cpu: "float64", webgpu: "float32" };
