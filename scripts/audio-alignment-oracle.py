"""Measure reference/output offsets from identically decoded mono float32 PCM.

Decode both inputs with the same FFmpeg -ac 1 -ar RATE -f f32le options.
The --self-test mode checks in-memory vectors with known offsets and gain.
"""

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np


def measure_offset(source, output, start, length, maximum_lag):
    if start < maximum_lag or start + length + maximum_lag > len(output):
        raise ValueError("Correlation window exceeds output PCM bounds")
    reference = source[start : start + length].astype(np.float64)
    candidate = output[start - maximum_lag : start + length + maximum_lag].astype(np.float64)
    if len(reference) != length or not np.isfinite(reference).all() or not np.isfinite(candidate).all():
        raise ValueError("Invalid PCM samples/window")
    reference -= reference.mean()
    energy = np.dot(reference, reference)
    if energy <= 1e-12:
        raise ValueError("Cannot measure alignment in a silent reference window")
    count = 1 << (len(reference) + len(candidate) - 2).bit_length()
    cross = np.fft.irfft(np.fft.rfft(candidate, count) * np.fft.rfft(reference[::-1], count), count)
    cross = cross[length - 1 : len(candidate)]
    sums = np.concatenate(([0.0], np.cumsum(candidate)))
    squares = np.concatenate(([0.0], np.cumsum(candidate * candidate)))
    variance = (squares[length:] - squares[:-length]) - (sums[length:] - sums[:-length]) ** 2 / length
    correlations = cross / np.sqrt(energy * np.maximum(variance, 1e-30))
    index = int(np.argmax(correlations))
    return {"lagSamples": index - maximum_lag, "correlation": float(np.clip(correlations[index], -1, 1)), "gainRatio": float(cross[index] / energy)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-pcm", type=Path)
    parser.add_argument("--output-pcm", type=Path)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--sample-rate", type=int, default=48000)
    parser.add_argument("--fps", type=int, default=60)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        source = np.random.default_rng(61).normal(0, 0.1, 20000).astype(np.float32)
        for lag in [-23, 0, 17]:
            target = np.pad(source, (lag, 0)) if lag >= 0 else source[-lag:]
            result = measure_offset(source, target * 0.3, 4000, 4000, 100)
            assert result["lagSamples"] == lag, result
            assert result["correlation"] > 0.99999, result
            assert abs(result["gainRatio"] - 0.3) < 0.000001, result
        print(json.dumps({"test": "in-memory known signed delay and gain vectors", "cases": 3, "outcome": "pass"}))
        return
    if not args.source_pcm or not args.output_pcm or not args.report:
        parser.error("--source-pcm, --output-pcm and --report are required")
    if args.sample_rate <= 0 or args.fps <= 0:
        parser.error("sample rate and fps must be positive")
    source = np.fromfile(args.source_pcm, dtype="<f4")
    output = np.fromfile(args.output_pcm, dtype="<f4")
    duration = min(len(source), len(output)) / args.sample_rate
    starts = [1.0, duration / 2 - 1, duration - 3]
    windows = []
    for start_seconds in starts:
        result = measure_offset(source, output, round(start_seconds * args.sample_rate), args.sample_rate * 2, args.sample_rate // 10)
        result.update({"startSeconds": start_seconds, "windowSeconds": 2, "lagSeconds": result["lagSamples"] / args.sample_rate})
        result["withinOneFrame"] = abs(result["lagSamples"]) <= args.sample_rate / args.fps
        result["correlationPass"] = result["correlation"] >= 0.9
        windows.append(result)
    report = {"schemaVersion": 1, "numpyVersion": np.__version__, "sampleRate": args.sample_rate, "fps": args.fps, "sourcePcm": {"path": str(args.source_pcm.resolve()), "samples": len(source), "sha256": hashlib.sha256(args.source_pcm.read_bytes()).hexdigest()}, "outputPcm": {"path": str(args.output_pcm.resolve()), "samples": len(output), "sha256": hashlib.sha256(args.output_pcm.read_bytes()).hexdigest()}, "method": "normalized FFT cross-correlation, +/-100ms search; positive lag means output audio occurs later", "windows": windows, "passed": all(window["withinOneFrame"] and window["correlationPass"] for window in windows), "scope": "Audio waveform alignment only; use separate video PTS/frame checks for the A/V timeline."}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({"passed": report["passed"], "windows": windows}))
    if not report["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
