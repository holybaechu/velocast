import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
for (const name of ["root", "state", "runtime", "host-requirements", "output"])
  if (!args[name]) throw new Error(`missing --${name}`);
const root = resolve(args.root);
const runtime = resolve(args.runtime);
const require = createRequire(import.meta.url);
const { runMediaOperation } = require(join(runtime, "electron-host/media-client.cjs"));
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
  "software-preference",
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
const videoEvidence = await Promise.all(videos.map((video) => verifyVideo(video)));
const repeat = await verifyVideo({
  ...videos[0],
  role: "original-lyrics-repeat",
  path: join(root, "evidence/npm-original-lyrics-repeat.mp4"),
  step: "npm-original-lyrics-repeat",
});
const software = await verifyVideo({
  ...videos[1],
  role: "software-preference",
  path: join(root, "evidence/pnpm-software-preference.mp4"),
  step: "software-preference",
});
const softwareAttempt = state.steps["software-preference"].attempts.at(-1);
const softwareRequest = JSON.parse(
  readFileSync(softwareAttempt.request.path, "utf8"),
);
const acceleration = softwareRequest.argv.indexOf("--acceleration");
const accelerationArgs = softwareRequest.argv.filter(
  (value) => value === "--acceleration" || value.startsWith("--acceleration="),
);
if (
  accelerationArgs.length !== 1 ||
  acceleration < 0 ||
  softwareRequest.argv[acceleration + 1] !== "off"
)
  throw new Error(
    "software preference request must specify --acceleration off",
  );
const softwareReport = JSON.parse(
  readFileSync(
    join(root, "evidence/pnpm-software-preference.report.json"),
    "utf8",
  ),
);
if (
  softwareReport.webcodecs?.hardware_acceleration !== "prefer-software" ||
  softwareReport.webcodecs?.hardware_encoder_verified !== false ||
  softwareReport.capture_backend !== "electron_compositor_snapshot" ||
  softwareReport.conversion_backend !== "chromium_webcodecs" ||
  !softwareReport.encoder_backend?.startsWith("electron_webcodecs_") ||
  softwareReport.cpu_readback_frames !== software.frames ||
  ["frames_expected", "frames_rendered", "frames_encoded"].some(
    (key) => softwareReport[key] !== software.frames,
  )
)
  throw new Error(
    "software preference report does not confirm the requested WebCodecs behavior",
  );
const mediaOptions = {
  electronBinary: join(runtime, "electron/electron.exe"),
  hostScript: join(runtime, "electron-host/main.cjs"),
};
const [firstFrames, repeatFrames] = await Promise.all([
  runMediaOperation({ kind: "frame-hashes", path: videos[0].path, maxFrames: videos[0].frames }, mediaOptions),
  runMediaOperation({ kind: "frame-hashes", path: repeat.path, maxFrames: videos[0].frames }, mediaOptions),
]);
if (firstFrames.frameCount !== videos[0].frames || repeatFrames.frameCount !== videos[0].frames ||
    JSON.stringify(firstFrames.hashes) !== JSON.stringify(repeatFrames.hashes))
  throw new Error("original lyrics deterministic decoded frames differ");
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
    softwarePreference: true,
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
    "hardware-encoder-selection-proof",
    "stale-source-version-rejection",
    "watch-command-child-cleanup",
  ],
  hostRequirements,
  videos: [...videoEvidence, repeat, software],
  cache: { root: join(root, "cache"), leftovers },
  publication: { upload: false, publicRelease: false, supportedManifestFlip: false },
  state: { path: resolve(args.state), sha256: sha256(resolve(args.state)) },
};
writeFileSync(resolve(args.output), `${JSON.stringify(output, null, 2)}\n`);

async function verifyVideo(video) {
  if (!existsSync(video.path)) throw new Error(`video missing: ${video.path}`);
  const probe = await runMediaOperation({ kind: "probe", path: video.path, frames: true }, {
    electronBinary: join(runtime, "electron/electron.exe"),
    hostScript: join(runtime, "electron-host/main.cjs"),
  });
  const attempt = state.steps[video.step].attempts.at(-1);
  const cliResult = JSON.parse(readFileSync(attempt.stdout.path, "utf8"));
  if (
    cliResult.request?.range?.startFrame !== video.sourceRange.startFrame ||
    cliResult.request?.range?.endFrame !== video.sourceRange.endFrame
  )
    throw new Error(
      `source range mismatch: ${video.role}: ${JSON.stringify(cliResult.request?.range)}`,
    );
  const visual = probe.video;
  const audio = probe.audio;
  if (
    visual?.frameCount !== video.frames ||
    Math.abs(visual.duration - video.frames / Number(video.fps.split("/")[0])) > 1 / Number(video.fps.split("/")[0]) ||
    audio?.sampleRate !== Number(video.audioRate)
  )
    throw new Error(`video metadata mismatch: ${video.role}`);
  return {
    ...video,
    bytes: readFileSync(video.path).length,
    sha256: sha256(video.path),
    video: {
      codec: visual.codec,
      frames: visual.frameCount,
      fps: video.fps,
      duration: Number(visual.duration),
    },
    audio: {
      codec: audio.codec,
      sampleRate: audio.sampleRate,
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
