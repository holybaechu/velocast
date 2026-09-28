import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const { runMediaOperation } = require(join(root, "packages/electron-host/media-client.cjs"));
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
for (const key of ["--video", "--report", "--target"])
  if (!args.get(key)) throw new Error(`consumer.render_invalid: missing ${key}`);
const video = resolve(args.get("--video"));
const probe = await runMediaOperation({ kind: "probe", path: video, frames: true });
const report = JSON.parse(readFileSync(resolve(args.get("--report")), "utf8"));
const requireValue = (condition, message) => {
  if (!condition) throw new Error(`consumer.render_invalid: ${message}`);
};
requireValue(probe.video?.codec === "avc" || probe.video?.codec === "h264", "expected H.264 video");
requireValue(probe.video.width === 3840 && probe.video.height === 2160, "unexpected resolution");
requireValue(probe.video.frameCount === 240, "expected 240 decoded frames");
requireValue(Math.abs(probe.video.duration - 4) <= 1 / 60, "unexpected duration");
for (const key of ["frames_expected", "frames_rendered", "frames_encoded"])
  requireValue(report[key] === 240, `expected ${key}=240`);
requireValue(report.conversion_backend === "mediabunny_native", "unexpected conversion backend");
requireValue(report.encoder_backend === "electron_native_h264", "unexpected encoder backend");
requireValue(report.cpu_readback_frames === 240, "native frame readbacks were not reported");
requireValue(["electron_shared_texture", "electron_bitmap"].includes(report.capture_backend), "unexpected capture backend");
if (args.get("--compare")) {
  const other = resolve(args.get("--compare"));
  const second = await runMediaOperation({ kind: "probe", path: other, frames: true });
  requireValue(second.video?.frameCount === probe.video.frameCount && second.video?.duration === probe.video.duration, "repeat metadata differs");
  const firstFrames = await runMediaOperation({ kind: "frame-hashes", path: video, maxFrames: 240 });
  const secondFrames = await runMediaOperation({ kind: "frame-hashes", path: other, maxFrames: 240 });
  requireValue(firstFrames.frameCount === 240 && secondFrames.frameCount === 240 &&
    firstFrames.hashes?.length === 240 && secondFrames.hashes?.length === 240,
    "repeat decoded frame count differs");
  requireValue(JSON.stringify(firstFrames.hashes) === JSON.stringify(secondFrames.hashes), "deterministic decoded frames differ");
}
