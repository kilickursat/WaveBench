# WaveBench web application

React application built with Vite into one self-contained HTML file (`dist/index.html`, copied to
`dist/wavebench-offline.html`). The engine worker (`src/engine/worker.ts`) owns all sample arrays and runs the CPU and
WebGPU engines; the UI thread holds settings and display-sized arrays only.

- `src/engine/` – the worker, its message protocol and the promise-based client.
- `src/state/` – the store, the state model and the actions (import, configure, process, GPU check).
- `src/components/` – top bar, sidebar, time panel, analysis views, dialogs, uPlot wrapper.
- `src/lib/` – formatting, colours, exports, recipes, request hook.

`window.wavebench` exposes the engine, actions and state for scripting from the browser console (and for the tests).
