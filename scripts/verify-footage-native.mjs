import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  [rendererArgument, outputArgument] = process.argv.slice(2);
assert(
  rendererArgument && outputArgument,
  "Usage: node scripts/verify-footage-native.mjs RENDERER OUTPUT_DIRECTORY",
);
const renderer = resolve(rendererArgument),
  output = resolve(outputArgument),
  fixture = join(output, "fixture"),
  publicDirectory = join(fixture, "public"),
  dist = join(fixture, "dist"),
  assetDirectory = join(output, "assets"),
  eventPath = join(output, "command-executions.json"),
  durationFrames = 120,
  outputFps = 60,
  width = 1920,
  height = 1080,
  rendererDirectory = dirname(renderer),
  hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert((await stat(renderer)).isFile(), `renderer missing: ${renderer}`);
assert(
  process.env.PATH?.split(";")[0]?.toLowerCase() ===
    rendererDirectory.toLowerCase(),
  `PATH must include renderer directory first: ${rendererDirectory}`,
);
await mkdir(output, { recursive: true });
assert.equal(
  (await readdir(output)).length,
  0,
  "Output directory must be empty; evidence is never overwritten",
);
await mkdir(publicDirectory, { recursive: true });
await mkdir(assetDirectory, { recursive: true });

const executions = [];
async function command(name, file, args, options = {}) {
  const event = {
    name,
    command: [file, ...args],
    cwd: options.cwd ?? root,
    startedAt: new Date().toISOString(),
    stdout: "",
    stderr: "",
  };
  const child = spawn(file, args, {
    cwd: event.cwd,
    windowsHide: true,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (bytes) => (event.stdout += bytes.toString("utf8")));
  child.stderr.on("data", (bytes) => (event.stderr += bytes.toString("utf8")));
  const timer = setTimeout(() => {
    event.timedOut = true;
    spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
    });
  }, options.timeoutMs ?? 600_000);
  event.exitStatus = await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", done);
  }).finally(() => clearTimeout(timer));
  event.finishedAt = new Date().toISOString();
  event.elapsedMs =
    new Date(event.finishedAt).getTime() - new Date(event.startedAt).getTime();
  executions.push(event);
  await writeFile(eventPath, `${JSON.stringify(executions, null, 2)}\n`);
  assert.equal(
    event.exitStatus,
    0,
    `${name} failed:\n${event.stderr}\n${event.stdout}`,
  );
  assert(!event.timedOut, `${name} timed out`);
  return event;
}

async function rawCommand(name, file, args) {
  const chunks = [],
    event = {
      name,
      command: [file, ...args],
      cwd: root,
      startedAt: new Date().toISOString(),
      stdoutBytes: 0,
      stderr: "",
    },
    child = spawn(file, args, {
      cwd: root,
      windowsHide: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  child.stdout.on("data", (bytes) => {
    chunks.push(bytes);
    event.stdoutBytes += bytes.length;
  });
  child.stderr.on("data", (bytes) => (event.stderr += bytes.toString("utf8")));
  event.exitStatus = await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", done);
  });
  event.finishedAt = new Date().toISOString();
  executions.push(event);
  await writeFile(eventPath, `${JSON.stringify(executions, null, 2)}\n`);
  assert.equal(event.exitStatus, 0, `${name} failed:\n${event.stderr}`);
  return Buffer.concat(chunks);
}

function barcodeFilters(identityColor) {
  const filters = [
    "drawbox=x=0:y=0:w=1920:h=180:color=black:t=fill",
    `drawbox=x=1650:y=20:w=220:h=140:color=${identityColor}:t=fill`,
  ];
  for (let bit = 0; bit < 6; bit++)
    filters.push(
      `drawbox=x=${30 + bit * 240}:y=30:w=180:h=120:color=white:t=fill:enable='eq(mod(floor(n/${2 ** bit})\\,2)\\,1)'`,
    );
  return filters.join(",");
}

const sources = [
  {
    name: "clip-a.mp4",
    lavfi: "testsrc2=size=1920x1080:rate=30:duration=2",
    color: "red",
  },
  {
    name: "clip-b.mp4",
    lavfi: "testsrc=size=1920x1080:rate=30:duration=2",
    color: "blue",
  },
];
for (const source of sources) {
  const path = join(assetDirectory, source.name);
  await command(`generate-${source.name}`, "ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    source.lavfi,
    "-vf",
    barcodeFilters(source.color),
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "120",
    "-keyint_min",
    "120",
    "-sc_threshold",
    "0",
    "-threads",
    "1",
    path,
  ]);
  await cp(path, join(publicDirectory, source.name));
}

await writeFile(
  join(fixture, "index.html"),
  '<!doctype html><html><body><div id="composition"></div><script type="module" src="/scene.jsx"></script></body></html>',
);
await writeFile(
  join(fixture, "scene.jsx"),
  `import React from "react";
import { registerReactComposition, VideoClip, VideoFrameProvider, requestSnapshotVideoFrame } from "@velocast/react";
import "./style.css";
function Scene(){return <main><VideoClip src="clip-a.mp4" muted={true} className="left"/><VideoClip src="clip-b.mp4" muted={true} className="right"/></main>}
registerReactComposition("footage-native",{component:()=> <VideoFrameProvider getFrame={requestSnapshotVideoFrame}><Scene/></VideoFrameProvider>,width:${width},height:${height},fps:${outputFps},durationFrames:${durationFrames},target:"#composition"});
`,
);
await writeFile(
  join(fixture, "style.css"),
  `*{box-sizing:border-box}html,body,main{margin:0;width:1920px;height:1080px;overflow:hidden;background:#000}canvas{position:absolute;top:0;width:960px;height:1080px}.left{left:0}.right{left:960px}`,
);

const cliRequire = createRequire(join(root, "packages/cli/package.json")),
  require = createRequire(cliRequire.resolve("vitest/package.json")),
  { build } = await import(pathToFileURL(require.resolve("vite")).href);
await build({
  root: fixture,
  configFile: false,
  base: "./",
  resolve: {
    alias: {
      "@velocast/react": join(root, "packages/react/dist/index.js"),
      "@velocast/core": join(root, "packages/core/dist/index.js"),
      react: join(root, "packages/react/node_modules/react"),
      "react-dom": join(root, "packages/react/node_modules/react-dom"),
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});

const config = join(fixture, "velocast.config.mjs");
await writeFile(
  config,
  `export default ${JSON.stringify({ entry: "dist/index.html", renderer: { binary: renderer, snapshotRoot: "dist", codec: "h264", pixelFormat: "nv12", acceleration: "required" } })};\n`,
);
const cli = (name, args) =>
  command(
    name,
    process.execPath,
    [
      join(root, "packages/cli/dist/bin.js"),
      ...args,
      "--config",
      config,
      "--json",
    ],
    { timeoutMs: 600_000 },
  );
const reference = join(output, "reference.mp4"),
  segmented = join(output, "segmented.mp4"),
  referenceReport = join(output, "reference-report.json"),
  segmentedReport = join(output, "segmented-report.json"),
  referenceEvents = join(output, "reference-events.jsonl"),
  segmentedEvents = join(output, "segmented-events.jsonl");
const gateStarted = performance.now();
await cli("render-reference", [
  "render",
  "footage-native",
  "--output",
  reference,
  "--acceleration",
  "required",
  "--assembly",
  "reference",
  "--concurrency",
  "1",
  "--report",
  referenceReport,
  "--events",
  referenceEvents,
]);
await cli("render-segmented", [
  "render",
  "footage-native",
  "--output",
  segmented,
  "--acceleration",
  "required",
  "--assembly",
  "segments",
  "--concurrency",
  "4",
  "--verify-segments",
  "--report",
  segmentedReport,
  "--events",
  segmentedEvents,
]);
const nativeGateWallMs = performance.now() - gateStarted;

async function probe(name, path) {
  const event = await command(name, "ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-count_frames",
    "-show_frames",
    "-show_streams",
    "-show_entries",
    "stream=codec_name,pix_fmt,width,height,avg_frame_rate,time_base,start_time,duration,nb_read_frames:frame=best_effort_timestamp_time",
    "-of",
    "json",
    path,
  ]);
  return JSON.parse(event.stdout);
}
function verifyProbe(name, value) {
  assert.equal(value.streams.length, 1, `${name}: one video stream`);
  const stream = value.streams[0];
  assert.equal(
    Number(stream.nb_read_frames),
    durationFrames,
    `${name}: frame count`,
  );
  assert.equal(stream.width, width, `${name}: width`);
  assert.equal(stream.height, height, `${name}: height`);
  assert(
    Math.abs(Number(stream.start_time ?? 0)) < 0.001,
    `${name}: zero PTS origin`,
  );
  assert.equal(
    value.frames.length,
    durationFrames,
    `${name}: decoded PTS count`,
  );
  for (let index = 0; index < value.frames.length; index++)
    assert(
      Math.abs(
        Number(value.frames[index].best_effort_timestamp_time) -
          index / outputFps,
      ) < 0.001,
      `${name}: frame ${index} PTS drift`,
    );
  return stream;
}
const referenceProbe = await probe("probe-reference", reference),
  segmentedProbe = await probe("probe-segmented", segmented),
  referenceStream = verifyProbe("reference", referenceProbe),
  segmentedStream = verifyProbe("segmented", segmentedProbe),
  referenceTelemetry = JSON.parse(await readFile(referenceReport, "utf8")),
  segmentedTelemetry = JSON.parse(await readFile(segmentedReport, "utf8"));

function verifyTelemetry(name, telemetry, expectedMode) {
  assert.equal(telemetry.mode, expectedMode, `${name}: telemetry mode`);
  assert.equal(
    telemetry.frames_expected,
    durationFrames,
    `${name}: expected frames`,
  );
  assert.equal(
    telemetry.frames_rendered,
    durationFrames,
    `${name}: rendered frames`,
  );
  assert.equal(
    telemetry.frames_encoded,
    durationFrames,
    `${name}: encoded frames`,
  );
  assert.equal(telemetry.cpu_readback_frames, 0, `${name}: CPU readback`);
  assert.equal(telemetry.dropped_frames, 0, `${name}: dropped frames`);
  assert.equal(telemetry.stale_frames, 0, `${name}: stale frames`);
  assert.equal(telemetry.fallback_used, false, `${name}: fallback`);
  assert.equal(
    telemetry.capture_backend,
    "electron_d3d11_shared_texture",
    `${name}: capture backend`,
  );
  assert(
    ["d3d11_shader_nv12", "d3d11_video_processor"].includes(
      telemetry.conversion_backend,
    ),
    `${name}: GPU conversion backend ${telemetry.conversion_backend}`,
  );
  assert(
    ["h264_amf", "h264_nvenc", "h264_qsv", "h264_mf"].includes(
      telemetry.encoder_backend,
    ),
    `${name}: hardware encoder ${telemetry.encoder_backend}`,
  );
  assert.equal(telemetry.surface_format_in, "bgra", `${name}: input surface`);
  assert.equal(
    telemetry.surface_format_encoder,
    "nv12",
    `${name}: encoder surface`,
  );
}
verifyTelemetry("reference", referenceTelemetry, "reference_gpu");
verifyTelemetry("segmented", segmentedTelemetry, "parallel_segments");
assert.equal(
  segmentedTelemetry.worker_backend_compatibility,
  "compatible",
  "segment worker backends must be compatible",
);

const boundaryFrames = [29, 30, 31, 59, 60, 61, 89, 90, 91],
  sourceIds = [
    ...new Set(boundaryFrames.map((frame) => Math.floor(frame / 2))),
  ],
  candidateFrames = [
    ...new Set(
      sourceIds.flatMap((source) =>
        [-2, -1, 0, 1, 2]
          .map((delta) => (source + delta) * 2)
          .filter((frame) => frame >= 0 && frame < durationFrames),
      ),
    ),
  ].sort((a, b) => a - b),
  analysisWidth = 480,
  analysisHeight = 270,
  rgbFrameBytes = analysisWidth * analysisHeight * 3;
async function decodeSelected(name, path, frames) {
  const select = frames.map((frame) => `eq(n\\,${frame})`).join("+"),
    bytes = await rawCommand(name, "ffmpeg", [
      "-v",
      "error",
      "-i",
      path,
      "-vf",
      `select='${select}',scale=${analysisWidth}:${analysisHeight}:flags=area`,
      "-fps_mode",
      "passthrough",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ]);
  assert.equal(
    bytes.length,
    frames.length * rgbFrameBytes,
    `${name}: selected bytes`,
  );
  return new Map(
    frames.map((frame, index) => [
      frame,
      bytes.subarray(index * rgbFrameBytes, (index + 1) * rgbFrameBytes),
    ]),
  );
}
function roiMae(actual, expected, left, right, bottom = analysisHeight) {
  let difference = 0,
    count = 0;
  for (let y = 0; y < bottom; y++)
    for (let x = left; x < right; x++) {
      const offset = (y * analysisWidth + x) * 3;
      difference +=
        Math.abs(actual[offset] - expected[offset]) +
        Math.abs(actual[offset + 1] - expected[offset + 1]) +
        Math.abs(actual[offset + 2] - expected[offset + 2]);
      count += 3;
    }
  return difference / count;
}
const referenceFrames = await decodeSelected(
    "decode-reference-samples",
    reference,
    candidateFrames,
  ),
  segmentedFrames = await decodeSelected(
    "decode-segmented-boundaries",
    segmented,
    boundaryFrames,
  ),
  pixelRows = [];
for (const outputFrame of boundaryFrames) {
  const sourceFrame = Math.floor(outputFrame / 2),
    correctReferenceFrame = sourceFrame * 2,
    actual = segmentedFrames.get(outputFrame),
    correct = referenceFrames.get(correctReferenceFrame);
  assert(actual && correct, `missing boundary sample ${outputFrame}`);
  for (const [clip, left, right] of [
    ["left", 0, analysisWidth / 2],
    ["right", analysisWidth / 2, analysisWidth],
  ]) {
    const correctMae = roiMae(actual, correct, left, right),
      markerMae = roiMae(actual, correct, left, right, 45),
      wrong = candidateFrames
        .filter((frame) => Math.floor(frame / 2) !== sourceFrame)
        .map((frame) => ({
          sourceFrame: Math.floor(frame / 2),
          markerMae: roiMae(
            actual,
            referenceFrames.get(frame),
            left,
            right,
            45,
          ),
        }))
        .sort((a, b) => a.markerMae - b.markerMae)[0];
    assert(
      correctMae <= 8,
      `${clip} frame ${outputFrame}: full ROI MAE ${correctMae}`,
    );
    assert(
      markerMae <= 10,
      `${clip} frame ${outputFrame}: marker MAE ${markerMae}`,
    );
    assert(
      wrong.markerMae >= markerMae + 1,
      `${clip} frame ${outputFrame}: source marker is not unique (${markerMae} vs ${wrong.markerMae})`,
    );
    pixelRows.push({
      outputFrame,
      expectedSourceFrame: sourceFrame,
      clip,
      fullRoiMae: correctMae,
      markerMae,
      closestWrongSource: wrong,
    });
  }
}

const result = {
  status: "verified",
  renderer,
  rendererSha256: hash(await readFile(renderer)),
  nativeGateWallMs,
  composition: { width, height, fps: outputFps, durationFrames, clips: 2 },
  sources: Object.fromEntries(
    await Promise.all(
      sources.map(async (source) => [
        source.name,
        {
          sha256: hash(await readFile(join(assetDirectory, source.name))),
          width,
          height,
          fps: 30,
          frameBarcodeBits: 6,
        },
      ]),
    ),
  ),
  reference: {
    output: reference,
    stream: referenceStream,
    telemetry: referenceTelemetry,
  },
  segmented: {
    output: segmented,
    stream: segmentedStream,
    telemetry: segmentedTelemetry,
    concurrency: 4,
    assembly: "segments",
  },
  boundaryFrames,
  pixelRows,
};
await writeFile(
  join(output, "verification.json"),
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(
  `FOOTAGE_NATIVE_VERIFIED: ${JSON.stringify({
    nativeGateWallMs,
    boundarySamples: pixelRows.length,
    referenceBackend: [
      referenceTelemetry.capture_backend,
      referenceTelemetry.conversion_backend,
      referenceTelemetry.encoder_backend,
    ],
    segmentedBackend: [
      segmentedTelemetry.capture_backend,
      segmentedTelemetry.conversion_backend,
      segmentedTelemetry.encoder_backend,
    ],
    frames: Number(segmentedStream.nb_read_frames),
  })}`,
);
