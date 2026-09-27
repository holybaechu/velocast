import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [outputArgument, label = "measurement"] = process.argv.slice(2);
if (!outputArgument)
  throw new Error(
    "Usage: node scripts/benchmark-video-frame-source.mjs OUTPUT_DIRECTORY [LABEL]",
  );

const output = resolve(outputArgument);
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

const fixtureSpecs = [
  ["motion-a.mp4", "testsrc2=size=1920x1080:rate=30:duration=6"],
  ["motion-b.mp4", "smptebars=size=1920x1080:rate=30:duration=6"],
];
for (const [name, source] of fixtureSpecs) {
  const path = join(output, name);
  await command("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    source,
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
}

async function referenceHashes(path) {
  const output = await command(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      path,
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
  );
  return output
    .toString("utf8")
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(",").at(-1).trim());
}

const events = [];
const sources = await Promise.all(
  fixtureSpecs.map(async ([name]) => {
    const path = join(output, name);
    return openVideoFrameSource(
      { path, sourceHash: sha256(await readFile(path)) },
      { onCommand: (event) => events.push({ source: name, ...event }) },
    );
  }),
);
const sequence = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 45, 46, 47, 90, 91, 30, 31, 90, 31,
];
const started = performance.now();
const rows = await Promise.all(
  sources.map(async (source, sourceIndex) => {
    const repeatHashes = new Map();
    const measurements = [];
    for (const frameIndex of sequence) {
      const frame = await source.frameAt(frameIndex / 30);
      if (frame.pts !== frameIndex * 512)
        throw new Error(
          `source ${sourceIndex} frame ${frameIndex} returned PTS ${frame.pts}`,
        );
      const digest = sha256(frame.rgba);
      const previous = repeatHashes.get(frameIndex);
      if (previous && previous !== digest)
        throw new Error(`source ${sourceIndex} repeated frame changed pixels`);
      repeatHashes.set(frameIndex, digest);
      measurements.push({
        frameIndex,
        elapsedMs: frame.elapsedMs,
        cacheHit: frame.cacheHit,
        rgbaSha256: digest,
      });
    }
    return measurements;
  }),
);
const workloadMs = performance.now() - started;
await Promise.all(sources.map((source) => source.close()));
const references = await Promise.all(
  fixtureSpecs.map(([name]) => referenceHashes(join(output, name))),
);
for (const [sourceIndex, measurements] of rows.entries())
  for (const measurement of measurements)
    if (
      measurement.rgbaSha256 !== references[sourceIndex][measurement.frameIndex]
    )
      throw new Error(
        `source ${sourceIndex} frame ${measurement.frameIndex} differs from independent FFmpeg RGBA reference`,
      );

const misses = rows.flat().filter((row) => !row.cacheHit);
const result = {
  label,
  generatedAt: new Date().toISOString(),
  fixture: {
    sources: fixtureSpecs.length,
    width: 1920,
    height: 1080,
    fps: 30,
    durationSeconds: 6,
    gopFrames: 120,
  },
  workload: {
    sequence,
    requests: rows.flat().length,
    uncachedRequests: misses.length,
  },
  workloadMs,
  requestsPerSecond: rows.flat().length / (workloadMs / 1000),
  ffmpegDecodeProcesses: events.filter((event) =>
    event.command.includes("rawvideo"),
  ).length,
  referencePixelMatches: rows.flat().length,
  maxReportedRequestMs: Math.max(...rows.flat().map((row) => row.elapsedMs)),
  measurements: rows,
};
await writeFile(
  join(output, `${label}.json`),
  `${JSON.stringify(result, null, 2)}\n`,
);
await writeFile(
  join(output, "reference-hashes.json"),
  `${JSON.stringify(
    {
      fixtureSha256: Object.fromEntries(
        await Promise.all(
          fixtureSpecs.map(async ([name]) => [
            name,
            sha256(await readFile(join(output, name))),
          ]),
        ),
      ),
      rgbaSha256ByFrame: references,
    },
    null,
    2,
  )}\n`,
);
console.log(JSON.stringify({ ...result, measurements: undefined }, null, 2));
