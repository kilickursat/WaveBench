# Roadmap

## Status of the original backlog (0.1.0)

| ID | Deliverable | Status |
| --- | --- | --- |
| WB-001 | Vite, React and TypeScript workspace | Done: strict TypeScript, exact dependency versions, lockfile, one build for the site and the offline file |
| WB-002 | CSV/TSV preview and mapping | Done: delimiter, decimal mark, header and metadata detection with overrides; column roles; issues with line numbers |
| WB-003 | Timebase inspector | Done: assigned rate, or time column (s/ms/µs/ns/ISO 8601) with order, gap and jitter diagnostics and remedies |
| WB-004 | Dataset and operation registry | Partly: raw arrays are immutable and every result is keyed by a data revision; no undo/redo history yet |
| WB-005 | Linked time plots and worksheet | Done: synced cursors, viewport separate from the analysis interval, spectrogram frame shown on the time plot, data table |
| WB-006 | CPU windowing and real FFT | Done: any length (radix-2 and Bluestein), five windows, all one-sided quantities |
| WB-007 | Periodogram and Welch | Done, with band RMS and the Parseval check against the time-domain RMS |
| WB-008 | SOS filter design and evaluation | Done: Butterworth (4 responses) and notch; causal and zero-phase; responses of what is applied; conditioning bound |
| WB-009 | CPU STFT and spectrogram | Done: complete frames, L/2 frame times, dB reference and range shown |
| WB-010 | GPU capability service | Done: adapter and limits, error scopes, device loss, CPU fallback (tested without an adapter) |
| WB-011 | WGSL batched FFT/STFT | Done: framing with detrend, Stockham FFT, scaling, Welch reductions; validated on SwiftShader |
| WB-012 | GPU spectrogram rendering | Done: drawn from the GPU buffer in the worker's OffscreenCanvas, no read-back; Canvas 2D fallback |
| WB-013 | Memory limits, batching, cancellation | Partly: cell limit, GPU batching within device limits, superseded requests cancelled; no measured memory ceiling |
| WB-014 | Recipe export and reload | Done: settings, conventions and input hash; applied to a file by column names |
| WB-015 | Examples and documentation | Done: synthetic examples with a recipe, user guide, numerical contract, validation record |

## Next

Ordered by usefulness for vibration work; each needs its own reference tests before it is enabled.

1. **Resampling and decimation** with anti-alias FIR filtering (scipy.signal.resample_poly as reference), so long,
   fast records can be analysed at a lower rate without aliasing.
2. **Validation on real GPUs** – collect *Check this GPU* results from users (NVIDIA, AMD, Intel, Apple, mobile).
3. **Cross-spectral analysis**: cross-spectrum, coherence and transfer function (H1/H2) between channels.
4. **Integration to velocity and displacement** in the frequency domain with an explicit high-pass, and drift
   diagnostics; never presented without its assumptions.
5. **Long records**: streaming import beyond memory, min/max pyramids, chunked causal filtering with carried state.
6. **More analyses**: envelope (Hilbert) spectra, order tracking, octave and third-octave bands, Lomb-Scargle for
   irregular timestamps.
7. **Formats**: XLSX, WAV, binary loggers (e.g. vendor CSV dialects), HDF5 via a WASM reader.
8. **Figures**: vector (SVG/PDF) export with editable labels.
9. **Undo/redo** of processing and settings; multiple datasets side by side.
