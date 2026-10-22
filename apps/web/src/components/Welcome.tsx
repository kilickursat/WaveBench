import { openExample } from "../state/actions";
import { setState } from "../state/store";

export function Welcome({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="welcome">
      <div className="welcome-card">
        <h1>Signal analysis in the browser</h1>
        <p>
          Open a record of sensor samples, such as a 3-axis accelerometer log, set or check its timebase, filter it, and look at it
          in time and frequency: FFT spectra, Welch PSD and STFT spectrograms.
        </p>
        <div className="drop-target">
          <p style={{ margin: "0 0 10px" }}>Drop a CSV, TSV or TXT file here, or</p>
          <button className="btn primary" onClick={onOpen}>
            Open file…
          </button>
        </div>
        <div className="welcome-grid">
          <button className="tile" onClick={() => void openExample("with-time")}>
            <b>Example with time column</b>
            <span>Synthetic 3-axis record, 8,192 samples at 1024 Hz: tones, a chirp, a pulse and a 1 g offset.</span>
          </button>
          <button className="tile" onClick={() => void openExample("rate-only")}>
            <b>Example without timestamps</b>
            <span>The same samples; the sampling rate is entered, as for most raw logger files.</span>
          </button>
          <button className="tile" onClick={() => setState({ generatorOpen: true })}>
            <b>Signal generator</b>
            <span>Signals with known amplitudes and frequencies, to check the scaling for yourself.</span>
          </button>
        </div>
        <p className="fine">
          Files are read on this device and never uploaded. Spectra, PSD and filters are computed in Float64 and checked against
          SciPy; spectrograms can run on WebGPU.
        </p>
      </div>
    </div>
  );
}
