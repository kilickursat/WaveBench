"""Generate deterministic examples and SciPy-oracle fixtures, with analytic checks.

This does not run or validate any browser, JavaScript FFT or GPU implementation.
Run from any directory: python reference/generate_fixtures.py
"""
from __future__ import annotations

import hashlib
import json
import platform
from pathlib import Path

import mpmath as mp
import numpy as np
import scipy
from scipy import signal

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures"
EXAMPLES = ROOT / "examples"
CHECKS: list[str] = []


def save_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def save_compact_json(path: Path, value: dict) -> None:
    """Engine fixtures are machine-read only; compact separators keep the repository small."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, separators=(",", ":"), allow_nan=False) + "\n", encoding="utf-8")


def check(name: str, actual, expected, *, rtol=1e-11, atol=1e-13) -> None:
    np.testing.assert_allclose(actual, expected, rtol=rtol, atol=atol, err_msg=name)
    CHECKS.append(name)


def spectra(x: np.ndarray, fs: float, window: np.ndarray, nfft: int) -> dict:
    """Explicit one-sided normalization, independently checked below with SciPy."""
    if x.ndim != 1 or len(x) != len(window) or nfft < len(x):
        raise ValueError("Invalid signal/window/FFT dimensions")
    if not np.isfinite(x).all() or not np.isfinite(window).all() or fs <= 0:
        raise ValueError("Nonfinite signal/window or invalid sample rate")
    energy = float(np.dot(window, window))
    gain = float(abs(window.sum()))
    if energy <= 0 or gain <= 0:
        raise ValueError("Window has zero energy or coherent gain")
    z = np.fft.rfft(x * window, n=nfft)
    factor = np.full(len(z), 2.0)
    factor[0] = 1.0
    if nfft % 2 == 0:
        factor[-1] = 1.0
    return {
        "frequencyHz": np.fft.rfftfreq(nfft, d=1.0 / fs).tolist(),
        "complexReal": z.real.tolist(),
        "complexImag": z.imag.tolist(),
        "peakAmplitude": (factor * np.abs(z) / gain).tolist(),
        "psd": (factor * np.abs(z) ** 2 / (fs * energy)).tolist(),
    }


ENGINE_SEED = 20261023
SCIPY_WINDOWS = {"rectangular": "boxcar", "hann": "hann", "hamming": "hamming",
                 "blackman": "blackman", "flattop": "flattop"}


def one_sided_factors(nfft: int) -> np.ndarray:
    factors = np.full(nfft // 2 + 1, 2.0)
    factors[0] = 1.0
    if nfft % 2 == 0:
        factors[-1] = 1.0
    return factors


def framed(x: np.ndarray, fs: float, w: np.ndarray, hop: int, nfft: int, detrend, output: str):
    """Complete-frame STFT with WaveBench's explicit one-sided scaling (frame-major rows)."""
    length = len(w)
    starts = np.arange(0, len(x) - length + 1, hop, dtype=np.int64)
    factors = one_sided_factors(nfft)
    rows = []
    for s in starts:
        seg = x[s:s + length]
        if detrend:
            seg = signal.detrend(seg, type=detrend)
        z = np.fft.rfft(w * seg, n=nfft)
        if output == "psd":
            rows.append(factors * abs(z) ** 2 / (fs * np.dot(w, w)))
        elif output == "power":
            rows.append(factors * abs(z) ** 2 / w.sum() ** 2)
        elif output == "peak":
            rows.append(factors * abs(z) / abs(w.sum()))
        else:
            raise ValueError(output)
    return starts, np.array(rows)


def fft_fixture(rng) -> None:
    cases = []
    for n in [1, 2, 3, 4, 5, 7, 8, 16, 31, 97, 100, 128, 255, 256, 360]:
        re, im = rng.standard_normal(n), rng.standard_normal(n)
        full, half = np.fft.fft(re + 1j * im), np.fft.rfft(re)
        cases.append({"n": n, "re": re.tolist(), "im": im.tolist(),
                      "fftRe": full.real.tolist(), "fftIm": full.imag.tolist(),
                      "rfftRe": half.real.tolist(), "rfftIm": half.imag.tolist()})
    x = rng.standard_normal(100)
    padded = np.fft.rfft(x, n=256)
    save_compact_json(FIXTURES / "fft-golden.json", {
        "schemaVersion": 1, "convention": "X[k] = sum_n x[n] exp(-2 pi i k n / N), numpy.fft",
        "cases": cases,
        "zeroPadded": {"input": x.tolist(), "n": 256, "rfftRe": padded.real.tolist(), "rfftIm": padded.imag.tolist()},
    })
    CHECKS.append("FFT fixture written for 15 transform sizes (powers of two, primes, composites)")


def window_fixture() -> None:
    cases = []
    for name, scipy_name in SCIPY_WINDOWS.items():
        for length in [1, 2, 3, 8, 15, 16, 64, 255]:
            periodic = signal.get_window(scipy_name, length, fftbins=True)
            symmetric = signal.get_window(scipy_name, length, fftbins=False)
            cases.append({"name": name, "length": length,
                          "periodic": periodic.tolist(), "symmetric": symmetric.tolist()})
    w = signal.get_window("hann", 256)
    check("Periodic Hann coherent gain is 0.5", w.sum() / 256, 0.5)
    check("Periodic Hann ENBW is 1.5 bins", 256 * np.dot(w, w) / w.sum() ** 2, 1.5)
    w = signal.get_window("flattop", 256)
    check("Periodic flat-top coherent gain equals a0", w.sum() / 256, 0.21557895)
    save_compact_json(FIXTURES / "windows-golden.json", {
        "schemaVersion": 1, "source": "scipy.signal.get_window(name, L, fftbins=True|False)",
        "scipyNames": SCIPY_WINDOWS, "cases": cases,
    })


def detrend_fixture(rng) -> None:
    cases = []
    for n in [1, 2, 3, 10, 257]:
        x = rng.standard_normal(n) + 0.3 * np.arange(n) + 5.0
        cases.append({"input": x.tolist(),
                      "constant": signal.detrend(x, type="constant").tolist(),
                      "linear": signal.detrend(x, type="linear").tolist()})
    save_compact_json(FIXTURES / "detrend-golden.json", {"schemaVersion": 1, "source": "scipy.signal.detrend",
                                                  "cases": cases})
    CHECKS.append("Detrend fixture written (constant, linear; lengths 1 to 257)")


# ---------------------------------------------------------------------------------------------------------------
# Exact references: the same designs in 50-digit arithmetic (an implementation independent of SciPy), so that
# Float64 results can be judged against the true values rather than against another Float64 implementation.
mp.mp.dps = 50


def exact_butterworth(btype: str, order: int, edges: list, fs: float):
    proto = [-mp.exp(1j * mp.pi * m / (2 * order)) for m in range(-order + 1, order, 2)]
    warped = [4 * mp.tan(mp.pi * (2 * mp.mpf(e) / fs) / 2) for e in edges]
    if btype == "lowpass":
        z, p, k = [], [v * warped[0] for v in proto], warped[0] ** order
    elif btype == "highpass":
        z, p = [mp.mpc(0)] * order, [warped[0] / v for v in proto]
        k = mp.re(1 / mp.fprod([-v for v in proto]))
    else:
        bw, wo = warped[1] - warped[0], mp.sqrt(warped[0] * warped[1])
        if btype == "bandpass":
            base = [v * bw / 2 for v in proto]
            z, k = [mp.mpc(0)] * order, bw ** order
        else:
            base = [(bw / 2) / v for v in proto]
            z = [mp.mpc(0, wo)] * order + [mp.mpc(0, -wo)] * order
            k = mp.re(1 / mp.fprod([-v for v in proto]))
        p = [v + mp.sqrt(v * v - wo * wo) for v in base] + [v - mp.sqrt(v * v - wo * wo) for v in base]
    zz = [(4 + v) / (4 - v) for v in z] + [mp.mpc(-1)] * (len(p) - len(z))
    pz = [(4 + v) / (4 - v) for v in p]
    kz = k * mp.re(mp.fprod([4 - v for v in z]) / mp.fprod([4 - v for v in p]))
    return zz, pz, kz


def exact_poly(roots: list) -> list:
    c = [mp.mpc(1)]
    for r in roots:
        nxt = [mp.mpc(0)] * (len(c) + 1)
        for i, v in enumerate(c):
            nxt[i] += v
            nxt[i + 1] -= v * r
        c = nxt
    return [mp.re(v) for v in c]


def exact_run(b: list, a: list, xs: list, steady=None) -> list:
    """Direct-form recursion; `steady` starts from the state of a constant input held forever."""
    n = len(a) - 1
    gain = sum(b) / sum(a)
    xp = [steady if steady is not None else mp.mpf(0)] * n
    yp = [steady * gain if steady is not None else mp.mpf(0)] * n
    out = []
    for v in xs:
        acc = b[0] * v + sum(b[i + 1] * xp[i] for i in range(n)) - sum(a[i + 1] * yp[i] for i in range(n))
        xp = [v] + xp[:-1]
        yp = [acc] + yp[:-1]
        out.append(acc)
    return out


def exact_filtfilt(b: list, a: list, xs: list, padlen: int, padtype: str) -> list:
    if padtype == "odd":
        ext = [2 * xs[0] - xs[i] for i in range(padlen, 0, -1)] + xs + [2 * xs[-1] - xs[-1 - i] for i in range(1, padlen + 1)]
    elif padtype == "even":
        ext = [xs[i] for i in range(padlen, 0, -1)] + xs + [xs[-1 - i] for i in range(1, padlen + 1)]
    elif padtype == "constant":
        ext = [xs[0]] * padlen + xs + [xs[-1]] * padlen
    else:
        ext, padlen = list(xs), 0
    y = exact_run(b, a, ext, steady=ext[0])[::-1]
    y = exact_run(b, a, y, steady=y[0])[::-1]
    return y[padlen:len(y) - padlen] if padlen else y


def scipy_padlen(sos: np.ndarray) -> int:
    return 3 * (2 * len(sos) + 1 - min(int((sos[:, 2] == 0).sum()), int((sos[:, 5] == 0).sum())))


def conditioning_gate(max_pole_radius: float) -> float:
    """Normalised-L2 gate for Float64 filtering: rounding is amplified like 1/delta^2, delta = 1 - max|p|."""
    delta = 1.0 - max_pole_radius
    return max(1e-12, 1e-15 / delta ** 2)


def norm_error(approx, exact, reference_norm) -> float:
    return float(mp.sqrt(sum((mp.mpf(a) - e) ** 2 for a, e in zip(approx, exact))) / reference_norm)


def butterworth_fixture(rng) -> None:
    n = np.arange(160)
    x = rng.standard_normal(160) + 2.0 * np.sin(2 * np.pi * 0.05 * n) + 0.5
    designs = [
        ("lowpass", 1, [100.0], 1000.0), ("lowpass", 2, [100.0], 1000.0), ("lowpass", 4, [100.0], 1024.0),
        ("lowpass", 5, [12.5], 1000.0), ("lowpass", 8, [400.0], 1000.0), ("lowpass", 10, [0.5], 1000.0),
        ("lowpass", 3, [490.0], 1000.0), ("lowpass", 6, [1.0], 10000.0),
        ("highpass", 1, [0.5], 100.0), ("highpass", 2, [10.0], 1000.0), ("highpass", 4, [0.2], 1024.0),
        ("highpass", 7, [300.0], 1000.0), ("highpass", 3, [250.0], 2000.5),
        ("bandpass", 1, [10.0, 40.0], 200.0), ("bandpass", 2, [45.0, 55.0], 1000.0),
        ("bandpass", 3, [5.0, 300.0], 1000.0), ("bandpass", 4, [100.0, 120.0], 1024.0),
        ("bandpass", 5, [1.0, 2.0], 500.0),
        ("bandstop", 1, [45.0, 55.0], 1000.0), ("bandstop", 2, [48.0, 52.0], 1000.0),
        ("bandstop", 3, [100.0, 300.0], 1024.0), ("bandstop", 4, [10.0, 200.0], 1000.0),
    ]
    entries = []
    for btype, order, edges, fs in designs:
        wn = edges[0] if len(edges) == 1 else edges
        sos = signal.butter(order, wn, btype=btype, fs=fs, output="sos")
        _, poles, _ = signal.butter(order, wn, btype=btype, fs=fs, output="zpk")
        if not np.all(abs(poles) < 1):
            raise AssertionError(f"unstable reference design {btype} {order} {edges}")
        _, at_edges = signal.freqz_sos(sos, worN=np.array(edges), fs=fs)
        check(f"Butterworth {btype} N={order} {edges} Hz: |H| = 1/sqrt(2) at the band edges",
              abs(at_edges), np.full(len(edges), 1 / np.sqrt(2)), rtol=1e-9, atol=0)
        probe = sorted({0.0, 0.25 * fs, 0.45 * fs, *(e * m for e in edges for m in (0.5, 1.0, 1.5))})
        probe = np.array([f for f in probe if f < fs / 2])
        _, h = signal.freqz_sos(sos, worN=probe, fs=fs)
        zi = signal.sosfilt_zi(sos)
        zz, pz, kz = exact_butterworth(btype, order, edges, fs)
        b_exact, a_exact = [kz * c for c in exact_poly(zz)], exact_poly(pz)
        h_exact = [kz * mp.fprod([mp.exp(2j * mp.pi * f / fs) - v for v in zz]) /
                   mp.fprod([mp.exp(2j * mp.pi * f / fs) - v for v in pz]) for f in probe]
        gate = conditioning_gate(float(abs(poles).max()))
        h_norm = mp.sqrt(sum(abs(v) ** 2 for v in h_exact))
        h_err = float(mp.sqrt(sum(abs(mp.mpc(a, b) - e) ** 2 for a, b, e in zip(h.real, h.imag, h_exact))) / h_norm)
        if h_err > gate:
            raise AssertionError(f"scipy response outside the conditioning gate for {btype} {order} {edges}")
        entry = {
            "response": btype, "prototypeOrder": order, "edgesHz": edges, "sampleRateHz": fs,
            "sos": sos.tolist(), "maxPoleRadius": float(abs(poles).max()), "conditioningGate": gate,
            "probeHz": probe.tolist(), "hRe": h.real.tolist(), "hIm": h.imag.tolist(),
            "exactHRe": [float(mp.re(v)) for v in h_exact], "exactHIm": [float(mp.im(v)) for v in h_exact],
            "sosfiltZi": zi.tolist(),
            "causalZeroState": signal.sosfilt(sos, x).tolist(),
            "causalSteadyState": signal.sosfilt(sos, x, zi=zi * x[0])[0].tolist(),
            "zeroPhaseOdd": signal.sosfiltfilt(sos, x).tolist(),
        }
        xs = [mp.mpf(float(v)) for v in x]
        x_norm = mp.sqrt(sum(v * v for v in xs))
        exact = {
            "causalZeroState": exact_run(b_exact, a_exact, xs),
            "causalSteadyState": exact_run(b_exact, a_exact, xs, steady=xs[0]),
            "zeroPhaseOdd": exact_filtfilt(b_exact, a_exact, xs, scipy_padlen(sos), "odd"),
        }
        if len(entries) % 7 == 0:
            for key, pad in [("zeroPhaseEven", "even"), ("zeroPhaseConstant", "constant"), ("zeroPhaseNone", None)]:
                entry[key] = signal.sosfiltfilt(sos, x, padtype=pad).tolist()
                exact[key] = exact_filtfilt(b_exact, a_exact, xs, scipy_padlen(sos), pad or "none")
        for key, values in exact.items():
            if norm_error(entry[key], values, x_norm) > gate:
                raise AssertionError(f"scipy {key} outside the conditioning gate for {btype} {order} {edges}")
            entry["exact" + key[0].upper() + key[1:]] = [float(v) for v in values]
        entries.append(entry)
    CHECKS.append("SciPy Butterworth responses and outputs agree with 50-digit references within max(1e-12, 1e-15/delta^2)")
    notches = []
    for f0, q, fs in [(50.0, 30.0, 1000.0), (60.0, 5.0, 1000.0), (100.0, 100.0, 1024.0), (0.5, 0.7, 100.0)]:
        b, a = signal.iirnotch(f0, q, fs)
        sos = np.concatenate((b, a))[None, :]
        _, h0 = signal.freqz_sos(sos, worN=np.array([f0]), fs=fs)
        if abs(h0[0]) > 1e-12:
            raise AssertionError("notch is not a zero at f0")
        notches.append({"f0Hz": f0, "q": q, "sampleRateHz": fs, "sos": sos.tolist(),
                        "causalZeroState": signal.sosfilt(sos, x).tolist(),
                        "zeroPhaseOdd": signal.sosfiltfilt(sos, x).tolist()})
    CHECKS.append("iirnotch designs have an exact zero at f0")
    save_compact_json(FIXTURES / "butterworth-golden.json", {
        "schemaVersion": 1, "source": "scipy.signal.butter(output='sos'), iirnotch, sosfilt, sosfiltfilt",
        "input": x.tolist(), "designs": entries, "notches": notches,
        "notes": "sosfiltfilt uses SciPy's default padlen = 3 * (2 * sections + 1 - min(b2==0, a2==0))",
    })


def welch_fixture(rng) -> None:
    fs = 1000.0
    t = np.arange(2400) / fs
    x = 0.1 * rng.standard_normal(2400) + 0.3 * np.sin(2 * np.pi * 50 * t) + 0.05 * t + 1.0
    configs = [
        ("hann", 256, 128, 256, "constant", "density", 1000.0),
        ("hann", 256, 64, 512, "linear", "density", 1000.0),
        ("hamming", 255, 128, 255, False, "density", 999.5),
        ("flattop", 500, 500, 1000, "constant", "spectrum", 1000.0),
        ("rectangular", 300, 150, 300, False, "density", 1000.0),
        ("blackman", 1000, 250, 2048, "linear", "spectrum", 2048.0),
    ]
    cases = []
    for name, length, hop, nfft, detrend, scaling, rate in configs:
        w = signal.get_window(SCIPY_WINDOWS[name], length)
        f, pxx = signal.welch(x, fs=rate, window=w, nperseg=length, noverlap=length - hop, nfft=nfft,
                              detrend=detrend, scaling=scaling, return_onesided=True, average="mean")
        _, rows = framed(x, rate, w, hop, nfft, detrend, "psd" if scaling == "density" else "power")
        check(f"Welch {name} L={length} H={hop} M={nfft}: explicit frame mean matches scipy.welch",
              rows.mean(axis=0), pxx, rtol=1e-10, atol=1e-18)
        cases.append({"window": name, "windowLength": length, "hopLength": hop, "fftLength": nfft,
                      "detrend": detrend or "none", "scaling": scaling, "sampleRateHz": rate,
                      "segments": len(rows), "frequencyHz": f.tolist(), "expected": pxx.tolist()})
    w = np.ones(300)
    _, rows = framed(x, fs, w, 300, 300, False, "psd")
    segments = x[: len(rows) * 300].reshape(len(rows), 300)
    check("Rectangular Welch integrates to the mean square of its segments",
          rows.mean(axis=0).sum() * fs / 300, (segments ** 2).mean(), rtol=1e-12)
    save_compact_json(FIXTURES / "welch-golden.json", {"schemaVersion": 1, "source": "scipy.signal.welch(average='mean')",
                                                "input": x.tolist(), "cases": cases})


def stft_fixture() -> None:
    fs = 1000.0
    t = np.arange(800) / fs
    x = 0.2 * np.sin(2 * np.pi * 64 * t) + 0.12 * signal.chirp(t, 20, t[-1], 300) + 0.05 * t + 0.3
    configs = [
        ("hann", 128, 32, 128, None, "psd"),
        ("hann", 100, 25, 256, "constant", "psd"),
        ("blackman", 257, 64, 512, "linear", "peak"),
        ("flattop", 200, 200, 200, None, "power"),
    ]
    cases = []
    for name, length, hop, nfft, detrend, output in configs:
        w = signal.get_window(SCIPY_WINDOWS[name], length)
        starts, rows = framed(x, fs, w, hop, nfft, detrend, output)
        times = (starts + length / 2) / fs
        if length % 2 == 0 and (length // 2) % hop == 0:
            sft = signal.ShortTimeFFT(w, hop=hop, fs=fs, mfft=nfft, fft_mode="onesided", phase_shift=None)
            p0 = (length // 2) // hop
            if detrend:
                z = sft.stft_detrend(x, detrend, p0=p0, p1=p0 + len(starts))
            else:
                z = sft.stft(x, p0=p0, p1=p0 + len(starts))
            factors = one_sided_factors(nfft)[None, :]
            scaled = {"psd": factors * abs(z.T) ** 2 / (fs * np.dot(w, w)),
                      "power": factors * abs(z.T) ** 2 / w.sum() ** 2,
                      "peak": factors * abs(z.T) / abs(w.sum())}[output]
            check(f"STFT {name} L={length} H={hop} M={nfft}: matches ShortTimeFFT", rows, scaled,
                  rtol=1e-10, atol=1e-15)
            check(f"STFT {name} L={length} H={hop}: frame centres match ShortTimeFFT", times,
                  sft.t(len(x), p0=p0, p1=p0 + len(starts)))
        cases.append({"window": name, "windowLength": length, "hopLength": hop, "fftLength": nfft,
                      "detrend": detrend or "none", "output": output, "sampleRateHz": fs,
                      "frameTimesSec": times.tolist(), "frequencyHz": np.fft.rfftfreq(nfft, 1 / fs).tolist(),
                      "expectedFrameMajor": rows.tolist()})
    save_compact_json(FIXTURES / "stft-golden.json", {
        "schemaVersion": 1, "input": x.tolist(), "cases": cases,
        "timeConvention": "frame start + L/2 samples (equals ShortTimeFFT centre for even L)",
    })


def spectrum_extra_fixture(rng) -> None:
    fs = 1000.0
    t = np.arange(1024) / fs
    cases = []
    tone = 0.2 * np.sin(2 * np.pi * 50.37 * t + 0.3) + 1.0
    w = signal.get_window("flattop", 1024)
    result = spectra(signal.detrend(tone, type="constant"), fs, w, 1024)
    peak = max(result["peakAmplitude"])
    if abs(peak - 0.2) / 0.2 > 2e-3:
        raise AssertionError(f"flat-top amplitude error too large: {peak}")
    CHECKS.append("Flat-top window recovers an off-bin 0.2 amplitude tone within 0.2 %")
    cases.append(("offbin_flattop_constant", tone, "flattop", 1024, "constant", result))
    trend = 0.05 * t + 0.1 * np.cos(2 * np.pi * 123.0 * t) + 0.01 * rng.standard_normal(len(t))
    segment = trend[:700]
    w = signal.get_window("hann", 700)
    result = spectra(signal.detrend(segment, type="linear"), fs, w, 1024)
    _, pxx = signal.periodogram(segment, fs=fs, window=w, nfft=1024, detrend="linear", scaling="density")
    check("Linear detrend + zero padding PSD matches scipy.periodogram", result["psd"], pxx)
    cases.append(("linear_detrend_hann_padded", segment, "hann", 1024, "linear", result))
    odd = 0.3 * np.cos(2 * np.pi * 77.0 * t[:600]) + 0.02 * rng.standard_normal(600)
    w = signal.get_window("blackman", 600)
    result = spectra(odd, fs, w, 600)
    _, pxx = signal.periodogram(odd, fs=fs, window=w, nfft=600, detrend=False, scaling="density")
    check("Blackman non-power-of-two PSD matches scipy.periodogram", result["psd"], pxx)
    cases.append(("blackman_exact_600", odd, "blackman", 600, "none", result))
    save_compact_json(FIXTURES / "spectrum-extra-golden.json", {"schemaVersion": 1, "cases": [
        {"name": name, "sampleRateHz": fs, "input": x.tolist(), "windowName": wname, "windowConvention": "periodic",
         "fftLength": nfft, "detrend": detrend,
         "expected": {k: v for k, v in res.items() if k != "frequencyHz"}}
        for name, x, wname, nfft, detrend, res in cases]})


def stats_fixture(rng) -> None:
    x = 0.3 * rng.standard_normal(1001) + 0.7
    rms = float(np.sqrt(np.mean(x ** 2)))
    save_compact_json(FIXTURES / "stats-golden.json", {"schemaVersion": 1, "input": x.tolist(), "expected": {
        "count": len(x), "mean": float(x.mean()), "rms": rms, "acRms": float(x.std(ddof=0)),
        "std": float(x.std(ddof=0)), "min": float(x.min()), "max": float(x.max()),
        "peakAbs": float(abs(x).max()), "peakToPeak": float(x.max() - x.min()),
        "crestFactor": float(abs(x).max() / rms)}})
    CHECKS.append("Statistics fixture written (population denominators)")


def engine_fixtures() -> None:
    """Fixtures consumed by the TypeScript engines (tests/unit and the WebGPU browser check)."""
    rng = np.random.default_rng(ENGINE_SEED)
    fft_fixture(rng)
    window_fixture()
    detrend_fixture(rng)
    butterworth_fixture(rng)
    welch_fixture(rng)
    stft_fixture()
    spectrum_extra_fixture(rng)
    stats_fixture(rng)


def main() -> None:
    FIXTURES.mkdir(parents=True, exist_ok=True)
    EXAMPLES.mkdir(parents=True, exist_ok=True)
    fs = 1024.0
    n = np.arange(256, dtype=np.float64)
    sine = 0.5 * np.sin(2 * np.pi * 64.0 * n / fs)
    odd_n = np.arange(255, dtype=np.float64)
    impulse = np.zeros(256)
    impulse[31] = 1.0
    cases = [
        ("bin_centered_sine", sine, fs, 256, "rectangular", np.ones(256)),
        ("dc", np.full(256, 1.25), fs, 256, "rectangular", np.ones(256)),
        ("nyquist", 0.75 * (-1.0) ** n, fs, 256, "rectangular", np.ones(256)),
        ("odd_last_bin", 0.4 * np.cos(2 * np.pi * 127 * odd_n / 255),
         1020.0, 255, "rectangular", np.ones(255)),
        ("zero_padded_sine", sine, fs, 1024, "rectangular", np.ones(256)),
        ("hann_two_tones", sine + 0.2 * np.sin(2 * np.pi * 128 * n / fs) + 0.25,
         fs, 256, "hann-periodic", signal.windows.hann(256, sym=False)),
        ("zero", np.zeros(128), fs, 128, "rectangular", np.ones(128)),
        ("impulse", impulse, fs, 256, "rectangular", np.ones(256)),
    ]
    generated: dict[str, dict] = {}
    for name, x, rate, nfft, window_name, w in cases:
        result = spectra(x, rate, w, nfft)
        frequencies, expected_psd = signal.periodogram(
            x, fs=rate, window=w, nfft=nfft, detrend=False,
            return_onesided=True, scaling="density",
        )
        check(name + ": frequency bins", result["frequencyHz"], frequencies)
        check(name + ": PSD matches scipy.periodogram", result["psd"], expected_psd)
        check(name + ": integrated window-weighted energy",
              np.sum(result["psd"]) * rate / nfft,
              np.dot(x * w, x * w) / np.dot(w, w))
        payload = {
            "name": name, "sampleRateHz": rate, "inputUnit": "m/s^2",
            "input": x.tolist(), "window": w.tolist(), "windowName": window_name,
            "fftLength": nfft, "detrend": "none", "expected": result,
        }
        generated[name] = payload
    check("sine peak amplitude", generated["bin_centered_sine"]["expected"]["peakAmplitude"][16], 0.5)
    check("DC is not doubled", generated["dc"]["expected"]["peakAmplitude"][0], 1.25)
    check("Nyquist is not doubled", generated["nyquist"]["expected"]["peakAmplitude"][-1], 0.75)
    check("Odd final bin is doubled", generated["odd_last_bin"]["expected"]["peakAmplitude"][-1], 0.4)
    check("Zero padding preserves tone amplitude", generated["zero_padded_sine"]["expected"]["peakAmplitude"][64], 0.5)
    save_json(FIXTURES / "spectra-golden.json", {"schemaVersion": 1, "cases": list(generated.values())})

    # Complete-frame STFT and Welch, with no per-frame detrending.
    t = np.arange(512, dtype=np.float64) / fs
    x = 0.2 * np.sin(2 * np.pi * 64 * t) + 0.12 * signal.chirp(t, 20, t[-1], 180)
    length, hop, nfft = 64, 16, 64
    w = signal.windows.hann(length, sym=False)
    starts = np.arange(0, len(x) - length + 1, hop, dtype=np.int64)
    raw = np.array([np.fft.rfft(w * x[s:s + length], n=nfft) for s in starts])
    factors = np.full(nfft // 2 + 1, 2.0)
    factors[[0, -1]] = 1.0
    psd = factors[None, :] * abs(raw) ** 2 / (fs * np.dot(w, w))
    oracle = signal.ShortTimeFFT(w, hop=hop, fs=fs, mfft=nfft,
                                 fft_mode="onesided", phase_shift=None)
    p0 = (length // 2) // hop
    oracle_z = oracle.stft(x, p0=p0, p1=p0 + len(starts), padding="zeros")
    check("STFT magnitude matches SciPy complete interior frames", abs(raw), abs(oracle_z.T))
    frame_times = (starts + length / 2) / fs
    check("STFT center times match SciPy", frame_times, oracle.t(len(x), p0=p0, p1=p0 + len(starts)))
    welch_f, welch_psd = signal.welch(
        x, fs=fs, window=w, nperseg=length, noverlap=length-hop,
        nfft=nfft, detrend=False, scaling="density", return_onesided=True, average="mean",
    )
    check("Mean STFT PSD matches Welch with identical frame conventions", psd.mean(axis=0), welch_psd)
    save_json(FIXTURES / "stft-welch-golden.json", {
        "schemaVersion": 1, "sampleRateHz": fs, "inputUnit": "m/s^2", "input": x.tolist(),
        "window": w.tolist(), "windowConvention": "periodic-hann", "windowLength": length,
        "hopLength": hop, "fftLength": nfft, "detrend": "none",
        "boundary": "complete-frames-only", "timeConvention": "frame-start-plus-half-window",
        "frequencyHz": welch_f.tolist(), "frameTimesSec": frame_times.tolist(),
        "expectedPsdFrameMajor": psd.tolist(), "expectedWelchPsd": welch_psd.tolist(),
    })

    # SOS outputs are authoritative SciPy fixtures for future implementations.
    x_filter = np.sin(2 * np.pi * 32 * t) + 0.3 * np.sin(2 * np.pi * 256 * t)
    sos = signal.butter(4, 100, fs=fs, btype="lowpass", output="sos")
    padlen = 15
    causal = signal.sosfilt(sos, x_filter)  # zero initial conditions explicitly
    zero_phase = signal.sosfiltfilt(sos, x_filter, padtype="odd", padlen=padlen)
    _, poles, _ = signal.sos2zpk(sos)
    if not np.all(abs(poles) < 1):
        raise AssertionError("Reference filter unstable")
    CHECKS.append("Reference SOS poles are inside unit circle")
    _, h_cutoff = signal.freqz_sos(sos, worN=np.array([100.0]), fs=fs)
    check("Single-pass Butterworth design cutoff magnitude", abs(h_cutoff[0]), 1 / np.sqrt(2))
    check("Forward-backward cutoff magnitude is squared", abs(h_cutoff[0]) ** 2, 0.5)
    if not np.isfinite(causal).all() or not np.isfinite(zero_phase).all():
        raise AssertionError("Filter fixture contains nonfinite output")
    CHECKS.append("Filter fixtures contain finite values")
    save_json(FIXTURES / "filter-golden.json", {
        "schemaVersion": 1, "sampleRateHz": fs, "inputUnit": "m/s^2",
        "input": x_filter.tolist(), "family": "butterworth", "response": "lowpass",
        "prototypeOrder": 4, "cutoffHz": 100, "sos": sos.tolist(),
        "causalInitialState": "all-zero", "expectedCausal": causal.tolist(),
        "zeroPhasePadding": "odd", "zeroPhasePadLength": padlen,
        "expectedZeroPhase": zero_phase.tolist(),
    })

    # Public synthetic demonstration data in g; not field measurements.
    rng = np.random.default_rng(20261022)
    t_demo = np.arange(8192, dtype=np.float64) / fs
    ax = 0.2 * np.sin(2 * np.pi * 50 * t_demo) + 0.05 * np.sin(2 * np.pi * 120 * t_demo)
    ax += 0.003 * rng.standard_normal(len(t_demo))
    ay = 0.12 * signal.chirp(t_demo, 20, t_demo[-1], 180) + 0.003 * rng.standard_normal(len(t_demo))
    az = 1 + 0.08 * np.sin(2 * np.pi * 80 * t_demo) + 0.003 * rng.standard_normal(len(t_demo))
    az += 0.15 * np.exp(-((t_demo - 4) / 0.02) ** 2)
    values = np.column_stack((ax, ay, az))
    np.savetxt(EXAMPLES / "acceleration-raw.csv", values, delimiter=",", header="ax_g,ay_g,az_g",
               comments="", fmt="%.12g")
    np.savetxt(EXAMPLES / "acceleration-with-time.csv", np.column_stack((t_demo, values)),
               delimiter=",", header="time_s,ax_g,ay_g,az_g", comments="", fmt="%.12g")
    check("Synthetic example has 8192 rows and three channels", values.shape, (8192, 3), rtol=0, atol=0)
    check("Synthetic last sample timestamp", t_demo[-1], 8191 / 1024)

    engine_fixtures()

    summary = {
        "status": "passed", "checkCount": len(CHECKS), "checks": CHECKS,
        "scope": "Python reference generation and analytic/internal cross-checks only",
        "notValidated": ["browser UI", "JavaScript FFT", "WebGPU kernels", "real sensor calibration"],
    }
    save_json(ROOT / "reference" / "validation-summary.json", summary)
    manifest_files = list(FIXTURES.glob("*.json")) + list(EXAMPLES.glob("*.csv")) + [
        EXAMPLES / "example.recipe.json", Path(__file__).resolve(), ROOT / "reference" / "requirements.txt",
    ]
    hashes = {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(manifest_files)}
    save_json(ROOT / "reference" / "manifest.json", {
        "environment": {"python": platform.python_version(), "numpy": np.__version__, "scipy": scipy.__version__},
        "seed": 20261022, "example": {"synthetic": True, "sampleRateHz": fs,
            "samplesPerChannel": 8192, "unit": "g", "origin": "generated, not observed"},
        "filesSha256": hashes,
    })
    print(f"Reference generation passed: {len(CHECKS)} checks.")
    print("No browser app, JS DSP engine or GPU kernels were executed.")


if __name__ == "__main__":
    main()
