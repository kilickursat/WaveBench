// Package aliases shared by the Vite app build and the Vitest config. The packages are source folders inside
// this repository; they are not published separately (yet).
import { fileURLToPath } from "node:url";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export const aliases = {
  "@wavebench/core": here("./packages/core/src/index.ts"),
  "@wavebench/dsp-cpu": here("./packages/dsp-cpu/src/index.ts"),
  "@wavebench/dsp-webgpu": here("./packages/dsp-webgpu/src/index.ts"),
  "@wavebench/plots": here("./packages/plots/src/index.ts"),
};
