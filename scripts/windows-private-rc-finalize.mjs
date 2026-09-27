import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
for (const name of ["root", "state", "ffprobe", "host-requirements", "output"])
  if (!args[name]) throw new Error(`missing --${name}`);
const root = resolve(args.root);
const state = JSON.parse(readFileSync(resolve(args.state), "utf8"));
const hostRequirements = JSON.parse(
  readFileSync(resolve(args["host-requirements"]), "utf8"),
);
if (hostRequirements.validationStatus !== "validated")
  throw new Error("host requirements are not validated");
const requiredSteps = [
  "preflight-native-candidate",
  "preflight-packages",
  "npm-install",
  "pnpm-install",
  "fresh-setup",
  "cached-setup",
  "offline-setup",
  "concurrent-setup",
  "npm-original-lyrics",
  "pnpm-clip-caption-music",
  "npm-original-lyrics-repeat",
  "preview-browser",
  "corrupt-archive",
  "corrupt-cache",
  "version-mismatch",
  "cancel-render",
  "offline-empty-cache",
];
for (const id of requiredSteps)
  if (state.steps?.[id]?.status !== "complete")
    throw new Error(`private RC step is incomplete: ${id}`);
const videos = [
  {
    role: "original-lyrics",
    manager: "npm",
    path: join(root, "evidence/npm-original-lyrics.mp4"),
    frames: 240,
    fps: "60/1",
    audioRate: "48000",
    sourceRange: { startFrame: 820, endFrame: 1060 },
    step: "npm-original-lyrics",
  },
  {
    role: "clip-caption-music",
    manager: "pnpm",
    path: join(root, "evidence/pnpm-clip-caption-music.mp4"),
    frames: 12,
    fps: "10/1",
    audioRate: "48000",
    sourceRange: { startFrame: 0, endFrame: 12 },
    step: "pnpm-clip-caption-music",
  },
];
const videoEvidence = videos.map((video) => verifyVideo(video));
const repeat = verifyVideo({
  ...videos[0],
  role: "original-lyrics-repeat",
  path: join(root, "evidence/npm-original-lyrics-repeat.mp4"),
  step: "npm-original-lyrics-repeat",
});
if (repeat.sha256 !== videoEvidence[0].sha256)
  throw new Error("original lyrics deterministic repeat hash differs");
for (const name of [
  "preview-browser.json",
  "negative-corrupt-archive.json",
  "negative-corrupt-cache.json",
  "negative-version-mismatch.json",
  "negative-cancel-render.json",
  "negative-offline-empty-cache.json",
  "concurrent-setup.json",
]) {
  const value = JSON.parse(readFileSync(join(root, "evidence", name), "utf8"));
  if (value.status !== "PASS") throw new Error(`${name} did not pass`);
}
const leftovers = walk(join(root, "cache")).filter((path) =>
  /\.lock$|\.partial-|\.staging-/.test(path),
);
if (leftovers.length)
  throw new Error(`cache has temporary paths: ${leftovers.join(", ")}`);
const output = {
  schemaVersion: 1,
  status: "PASS",
  target: "win32-x64",
  frames: 240,
  packageManagers: ["npm", "pnpm"],
  scenarios: {
    scriptsDisabled: true,
    freshSetup: true,
    cachedSetup: true,
    offlineSetup: true,
    concurrentSetup: true,
    npmRender: true,
    pnpmRender: true,
    deterministicRepeat: true,
    softwarePath: true,
    previewFrame: true,
    previewRange: true,
    sourceRefresh: true,
    corruptArchive: true,
    corruptCache: true,
    versionMismatch: true,
    cancellation: true,
    offlineEmptyCache: true,
  },
  notRunInThisGate: [
    "automatic-software-fallback",
    "stale-source-version-rejection",
    "watch-command-child-cleanup",
  ],
  hostRequirements,
  videos: [...videoEvidence, repeat],
  cache: { root: join(root, "cache"), leftovers },
  publication: { upload: false, publicRelease: false, supportedManifestFlip: false },
  state: { path: resolve(args.state), sha256: sha256(resolve(args.state)) },
};
writeFileSync(resolve(args.output), `${JSON.stringify(output, null, 2)}\n`);

function verifyVideo(video) {
  if (!existsSync(video.path)) throw new Error(`video missing: ${video.path}`);
  const result = spawnSync(
    resolve(args.ffprobe),
    [
      "-v",
      "error",
      "-count_frames",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      video.path,
    ],
    { encoding: "utf8", windowsHide: true, timeout: 120_000 },
  );
  if (result.status !== 0)
    throw new Error(`ffprobe failed: ${result.stderr || result.error}`);
  const probe = JSON.parse(result.stdout);
  const attempt = state.steps[video.step].attempts.at(-1);
  const cliResult = JSON.parse(readFileSync(attempt.stdout.path, "utf8"));
  if (
    cliResult.request?.range?.startFrame !== video.sourceRange.startFrame ||
    cliResult.request?.range?.endFrame !== video.sourceRange.endFrame
  )
    throw new Error(
      `source range mismatch: ${video.role}: ${JSON.stringify(cliResult.request?.range)}`,
    );
  const visual = probe.streams.find((stream) => stream.codec_type === "video");
  const audio = probe.streams.find((stream) => stream.codec_type === "audio");
  if (
    Number(visual?.nb_read_frames) !== video.frames ||
    visual?.avg_frame_rate !== video.fps ||
    audio?.sample_rate !== video.audioRate
  )
    throw new Error(`video metadata mismatch: ${video.role}`);
  return {
    ...video,
    bytes: readFileSync(video.path).length,
    sha256: sha256(video.path),
    video: {
      codec: visual.codec_name,
      pixelFormat: visual.pix_fmt,
      frames: Number(visual.nb_read_frames),
      fps: visual.avg_frame_rate,
      duration: Number(visual.duration),
    },
    audio: {
      codec: audio.codec_name,
      sampleRate: Number(audio.sample_rate),
      channels: audio.channels,
      duration: Number(audio.duration),
    },
    sourceRange: cliResult.request.range,
  };
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function walk(path) {
  if (!existsSync(path)) return [];
  const output = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const absolute = join(path, entry.name);
    output.push(absolute);
    if (entry.isDirectory()) output.push(...walk(absolute));
  }
  return output;
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2)
    result[values[index].replace(/^--/, "")] = values[index + 1];
  return result;
}
