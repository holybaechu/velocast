import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (!process.argv[2])
  throw new Error(
    "Usage: node scripts/benchmark-video-frame-cursors.mjs OUTPUT_DIRECTORY [repeat-only]",
  );
const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  output = resolve(process.argv[2]),
  repeatOnly = process.argv[3] === "repeat-only";
await mkdir(output, { recursive: true });
const { openVideoFrameSource } = await import(
  pathToFileURL(join(root, "packages/cli/dist/video-frame-source.js")).href
);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function command(binary, args, capture = false) {
  const child = spawn(binary, args, {
    stdio: ["ignore", capture ? "pipe" : "ignore", "pipe"],
    windowsHide: true,
  });
  const stdout = [];
  let stderr = "";
  child.stdout?.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
  const code = await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", done);
  });
  if (code !== 0) throw new Error(`${binary} exited ${code}: ${stderr}`);
  return Buffer.concat(stdout);
}

const media = join(output, "four-lane-long-gop.mp4");
await command("ffmpeg", [
  "-y",
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=1920x1080:rate=30:duration=8",
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
  media,
]);
const encoded = await readFile(media),
  sourceHash = sha256(encoded),
  referenceOutput = await command(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      media,
      "-map",
      "0:v:0",
      "-an",
      "-vf",
      "format=pix_fmts=rgba",
      "-fps_mode",
      "passthrough",
      "-f",
      "framehash",
      "-hash",
      "sha256",
      "pipe:1",
    ],
    true,
  ),
  references = referenceOutput
    .toString("utf8")
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(",").at(-1).trim());

function trackedTools(events) {
  let active = 0,
    maximum = 0;
  return {
    dependencies: {
      spawn(binary, args, options) {
        const child = spawn(binary, args, options);
        active++;
        maximum = Math.max(maximum, active);
        child.once("close", () => active--);
        return child;
      },
      onCommand: (event) => events.push(event),
    },
    maximum: () => maximum,
  };
}

async function run(name, sequence) {
  const events = [],
    tracker = trackedTools(events),
    source = await openVideoFrameSource(
      {
        path: media,
        sourceHash,
        limits: { maxQueuedRequests: 128 },
      },
      tracker.dependencies,
    ),
    started = performance.now();
  let frames;
  try {
    frames = await Promise.all(
      sequence.map((index) =>
        source.frameAt(source.metadata.frames[index].seconds),
      ),
    );
  } finally {
    await source.close();
  }
  const workloadMs = performance.now() - started;
  for (let request = 0; request < sequence.length; request++) {
    const index = sequence[request],
      frame = frames[request];
    if (
      frame.pts !== source.metadata.frames[index].pts ||
      sha256(frame.rgba) !== references[index]
    )
      throw new Error(`${name} request ${request} failed PTS/RGBA reference`);
  }
  return {
    name,
    sequence,
    workloadMs,
    requestsPerSecond: sequence.length / (workloadMs / 1000),
    decoderProcesses: events.filter((event) =>
      event.command.includes("rawvideo"),
    ).length,
    maximumLiveMediaProcesses: tracker.maximum(),
    exactPtsAndIndependentRgbaMatches: frames.length,
  };
}

async function runTwoSources(name, sequence) {
  const events = [],
    tracker = trackedTools(events),
    sources = await Promise.all(
      [0, 1].map(() =>
        openVideoFrameSource(
          {
            path: media,
            sourceHash,
            limits: { maxQueuedRequests: 128 },
          },
          tracker.dependencies,
        ),
      ),
    ),
    started = performance.now();
  let framesBySource;
  let sourceStats;
  try {
    framesBySource = await Promise.all(
      sources.map((source) =>
        Promise.all(
          sequence.map((index) =>
            source.frameAt(source.metadata.frames[index].seconds),
          ),
        ),
      ),
    );
    sourceStats = sources.map((source) => source.stats());
  } finally {
    await Promise.all(sources.map((source) => source.close()));
  }
  const workloadMs = performance.now() - started;
  for (const [sourceIndex, frames] of framesBySource.entries())
    for (let request = 0; request < sequence.length; request++) {
      const index = sequence[request],
        frame = frames[request];
      if (
        frame.pts !== sources[sourceIndex].metadata.frames[index].pts ||
        sha256(frame.rgba) !== references[index]
      )
        throw new Error(
          `${name} source ${sourceIndex} request ${request} failed PTS/RGBA reference`,
        );
    }
  const requests = sources.length * sequence.length;
  return {
    name,
    sources: sources.length,
    sequence,
    requests,
    workloadMs,
    requestsPerSecond: requests / (workloadMs / 1000),
    decoderProcesses: events.filter((event) =>
      event.command.includes("rawvideo"),
    ).length,
    maximumLiveMediaProcesses: tracker.maximum(),
    cacheHits: sourceStats.reduce((total, stats) => total + stats.cacheHits, 0),
    cacheFramesPerSource: sourceStats.map((stats) => stats.cachedFrames),
    exactPtsAndIndependentRgbaMatches: framesBySource.flat().length,
  };
}

const sequential = Array.from({ length: 100 }, (_, index) => index),
  laneStarts = [0, 60, 120, 180],
  interleaved = Array.from({ length: 25 }, (_, offset) =>
    laneStarts.map((start) => start + offset),
  ).flat(),
  repeatLaneStarts = [0, 15, 30, 45],
  repeatedInterleaved = Array.from({ length: 15 }, (_, offset) => {
    const frames = repeatLaneStarts.map((start) => start + offset);
    return [...frames, ...frames];
  }).flat(),
  results = repeatOnly
    ? [
        await runTwoSources(
          "two-sources-four-lanes-repeat-30-to-60",
          repeatedInterleaved,
        ),
      ]
    : [
        await run("single-sequential", sequential),
        await run("four-lanes-interleaved", interleaved),
        await runTwoSources("two-sources-four-lanes", interleaved),
        await runTwoSources(
          "two-sources-four-lanes-repeat-30-to-60",
          repeatedInterleaved,
        ),
      ],
  result = {
    generatedAt: new Date().toISOString(),
    fixture: {
      sourceSha256: sourceHash,
      width: 1920,
      height: 1080,
      fps: 30,
      durationSeconds: 8,
      gopFrames: 120,
      requestsPerPattern: 100,
      laneStarts,
      repeatLaneStarts,
    },
    results,
    ...(repeatOnly
      ? {}
      : {
          comparison: {
            processMultiplier:
              results[1].decoderProcesses / results[0].decoderProcesses,
            wallTimeMultiplier: results[1].workloadMs / results[0].workloadMs,
          },
        }),
  };
await writeFile(
  join(output, "cursor-benchmark.json"),
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(
  JSON.stringify(
    { ...result, results: results.map(({ sequence: _, ...row }) => row) },
    null,
    2,
  ),
);
