import argparse
import json
import subprocess
from fractions import Fraction


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--target", required=True)
    parser.add_argument("--compare")
    args = parser.parse_args()

    probe = json.loads(
        subprocess.check_output(
            [
                "ffprobe",
                "-v",
                "error",
                "-count_frames",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=codec_name,width,height,avg_frame_rate,duration,pix_fmt,nb_frames,nb_read_frames",
                "-of",
                "json",
                args.video,
            ],
            text=True,
            timeout=300,
        )
    )
    streams = probe.get("streams", [])
    require(len(streams) == 1, "expected exactly one video stream")
    stream = streams[0]
    require(stream.get("codec_name") == "h264", f"unexpected codec {stream.get('codec_name')}")
    require(stream.get("width") == 3840 and stream.get("height") == 2160, "unexpected resolution")
    require(Fraction(stream.get("avg_frame_rate", "0/1")) == 60, "unexpected FPS")
    require(stream.get("pix_fmt") in {"yuv420p", "nv12"}, "unexpected pixel format")
    decoded = int(stream.get("nb_read_frames") or stream.get("nb_frames") or 0)
    require(decoded == 240, f"expected 240 decoded frames, got {decoded}")
    duration = float(stream.get("duration") or 0)
    require(abs(duration - 4.0) <= 1 / 60, f"unexpected duration {duration}")

    with open(args.report, "r", encoding="utf8") as handle:
        report = json.load(handle)
    for key in ("frames_expected", "frames_rendered", "frames_encoded"):
        require(report.get(key) == 240, f"expected {key}=240, got {report.get(key)!r}")
    require(report.get("cpu_readback_frames") == 0, "CPU readback was used")
    require(report.get("fallback_used") is False, "renderer fallback was used")
    if args.target.startswith("win32-"):
        if report.get("capture_backend") == "electron_d3d11_shared_texture":
            require(report.get("conversion_backend") in {"d3d11_video_processor", "d3d11_shader_nv12"}, "unexpected Windows conversion backend")
            require(str(report.get("encoder_backend", "")).endswith(("_amf", "_nvenc", "_qsv", "_mf")), "unexpected Windows encoder backend")
        else:
            require(report.get("capture_backend") == "electron_software_bgra", "unexpected Windows capture backend")
            require(report.get("encoder_backend") == "raw_bgra_ffmpeg_stdin", "unexpected Windows software encoder")
    elif args.target.startswith(("linux-", "darwin-")):
        require(report.get("capture_backend") == "electron_software_bgra", "unexpected software capture backend")
        require(report.get("encoder_backend") == "raw_bgra_ffmpeg_stdin", "unexpected software encoder")

    if args.compare:
        first = decoded_frame_hashes(args.video)
        second = decoded_frame_hashes(args.compare)
        require(first == second, "repeated render decoded frames are not deterministic")


def decoded_frame_hashes(path: str) -> bytes:
    return subprocess.check_output(
        ["ffmpeg", "-v", "error", "-i", path, "-map", "0:v:0", "-f", "framemd5", "-"],
        timeout=600,
    )


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(f"consumer.render_invalid: {message}")


if __name__ == "__main__":
    main()
