"""Compare real AAC output with the pre-AAC stereo PCM oracle, including priming.

Inputs are the synthetic known-sample React gate, not replacement song media.
Every FFmpeg/ffprobe execution and its literal output/exit is retained. The gate
is at least as strict as 60fps even for an inexpensive low-fps long-duration video.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import numpy as np

spec = importlib.util.spec_from_file_location("offset_oracle", Path(__file__).with_name("audio-alignment-oracle.py"))
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)
directory = Path(sys.argv[1]).resolve()
events, results = [], []


def execute(command):
    result = subprocess.run(command, cwd=directory, capture_output=True, text=True, encoding="utf-8", errors="replace")
    event = {"command": command, "cwd": str(directory), "stdout": result.stdout,
             "stderr": result.stderr, "exitStatus": result.returncode}
    events.append(event)
    (directory / "alignment-commands.json").write_text(json.dumps(events, indent=2), encoding="utf-8")
    if result.returncode:
        raise RuntimeError(event)
    return result.stdout


for name in ("full", "range"):
    actual_path = directory / f"{name}.aac-decoded.f32"
    video_path = directory / f"{name}.mp4"
    reference_path = directory / f"{name}.reference.f32"
    execute(["ffmpeg", "-hide_banner", "-v", "error", "-y", "-i", str(video_path),
             "-map", "0:a:0", "-vn", "-ac", "2", "-ar", "48000", "-c:a", "pcm_f32le", "-f", "f32le", str(actual_path)])
    stream_metadata = json.loads(execute(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(video_path)]))
    packets = json.loads(execute(["ffprobe", "-v", "error", "-select_streams", "a:0", "-read_intervals", "%+#2", "-show_packets", "-of", "json", str(video_path)]))
    reference = np.fromfile(reference_path, dtype="<f4").reshape(-1, 2)[:, 0]
    actual = np.fromfile(actual_path, dtype="<f4").reshape(-1, 2)[:, 0]
    length = min(len(reference), len(actual))
    rate = 48000
    window = rate // 2
    starts = [rate // 4, length // 2 - window // 2, length - rate * 3 // 4]
    composition = json.loads((directory / f"{name}.result.json").read_text(encoding="utf-8"))["composition"]
    threshold = min(rate / composition["fps"], rate / 60)
    measurements = []
    for label, start in zip(("start", "middle", "end"), starts):
        result = oracle.measure_offset(reference, actual, start, window, rate // 10)
        result.update({"position": label, "startSample": start, "windowSamples": window})
        assert abs(result["lagSamples"]) <= threshold, result
        assert result["correlation"] >= 0.99, result
        measurements.append(result)
    results.append({"name": name, "status": "pass", "referenceSamples": len(reference),
                    "decodedSamples": len(actual), "thresholdSamples": threshold,
                    "measurements": measurements, "metadata": stream_metadata, "firstAudioPackets": packets,
                    "videoSha256": hashlib.sha256(video_path.read_bytes()).hexdigest(),
                    "referenceSha256": hashlib.sha256(reference_path.read_bytes()).hexdigest()})
    (directory / "alignment-results.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
print(json.dumps({"status": "pass", "outputs": len(results), "positions": 6,
                  "lagSamples": [item["lagSamples"] for result in results for item in result["measurements"]]}))
