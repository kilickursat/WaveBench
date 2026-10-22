# @wavebench/plots

Rendering helpers shared by the CPU and GPU paths (charts themselves use uPlot in the app).

- `colormaps.ts` – exact 256-entry viridis, magma and inferno tables (CC0) and grey.
- `heatmap.ts` – the spectrogram cell mapping (cells centred on frame times and bin frequencies, max over covered
  cells) and a CPU renderer that matches the WGSL shader.
- `decimate.ts` – min/max envelopes per pixel column on linear or logarithmic axes. Display only.
