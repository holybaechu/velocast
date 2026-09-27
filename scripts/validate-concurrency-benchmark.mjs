// Verify completed measurements without changing their original reports.
// Segment boundaries change encoder state, so compare hosts at matched worker
// counts and independently read the fixture's frame identity strip.
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  assertFrameOracle,
  FRAME_STATES,
  WIDTH,
  HEIGHT,
  median,
  splitRawFrames,
} from "./electron-renderer-oracle.mjs";

const reportFile = process.argv[2] && resolve(process.argv[2]);
if (!reportFile)
  throw new Error(
    "Usage: node scripts/validate-concurrency-benchmark.mjs PATH/summary.json",
  );
const source = JSON.parse(await readFile(reportFile, "utf8"));
if (source.status === "running")
  throw new Error(
    "Wait for all resource measurements to finish before decoding frames.",
  );
const frames = Number(source.referenceVideo.nb_read_frames);
if (
  !Number.isInteger(frames) ||
  frames < 1 ||
  source.referenceVideo.width % WIDTH ||
  source.referenceVideo.height % HEIGHT
)
  throw new Error(
    "This validator requires the standard electron-spike frame-oracle fixture at an integer scale.",
  );
const states = Array.from(
  { length: frames },
  (_, frame) => FRAME_STATES[frame % FRAME_STATES.length],
);
const output = join(dirname(reportFile), "concurrency-validation.json");
const report = {
  status: "running",
  measuredReport: reportFile,
  measuredRevision: source.gitRevision,
  sourceVersion: source.sourceVersion,
  validation:
    "Every frame's state and identity strip; exact full-resolution decoded YUV against the same-worker-count Electron baseline; media metadata and frozen source identity; consistent native audio PCM.",
  cases: [],
  summaries: [],
};
const persist = () => writeFile(output, JSON.stringify(report, null, 2) + "\n");
await persist();

function child(binary, args) {
  const proc = spawn(binary, args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const errors = [];
  proc.stderr.on("data", (data) => errors.push(data));
  const timer = setTimeout(() => proc.kill(), 60_000);
  const done = new Promise((done, reject) => {
    proc.once("error", reject);
    proc.once("close", done);
  }).finally(() => clearTimeout(timer));
  return { proc, done, stderr: () => Buffer.concat(errors).toString() };
}
async function verifyFrames(video) {
  const { proc, done, stderr } = child("ffmpeg", [
    "-v",
    "error",
    "-i",
    video,
    "-map",
    "0:v:0",
    "-vf",
    `scale=${WIDTH}:${HEIGHT}:flags=neighbor`,
    "-fps_mode",
    "passthrough",
    "-pix_fmt",
    "rgba",
    "-f",
    "rawvideo",
    "pipe:1",
  ]);
  let count = 0;
  try {
    for await (const pixels of splitRawFrames(
      proc.stdout,
      WIDTH * HEIGHT * 4,
    )) {
      if (count >= frames) throw new Error("Extra output frame");
      assertFrameOracle(pixels, [count], {
        width: WIDTH,
        height: HEIGHT,
        states,
      });
      count++;
    }
    if ((await done) !== 0 || count !== frames)
      throw new Error(`Frame oracle ${count}/${frames}: ${stderr()}`);
  } finally {
    if (proc.exitCode === null) proc.kill();
  }
}
async function comparePixels(reference, video) {
  const { proc, done, stderr } = child("ffmpeg", [
    "-hide_banner",
    "-i",
    reference,
    "-i",
    video,
    "-lavfi",
    "psnr",
    "-an",
    "-f",
    "null",
    process.platform === "win32" ? "NUL" : "/dev/null",
  ]);
  proc.stdout.resume();
  if ((await done) !== 0) throw new Error(stderr());
  return stderr();
}
let expectedAudioHash;
for (const measured of source.cases) {
  const configuration = source.configurations.find(
    (c) => c.id === measured.configuration,
  );
  const entry = {
    name: measured.name,
    configuration: measured.configuration,
    originalStatus: measured.status,
    originalError: measured.error,
    status: "running",
  };
  report.cases.push(entry);
  try {
    if (
      !configuration ||
      configuration.host !== "electron" ||
      configuration.assembly !== "segments"
    )
      throw new Error("Expected segment-assembly configuration");
    if (
      measured.exitCode !== 0 ||
      (measured.error &&
        measured.error !==
          "Error: Decoded frames differ from the verified reference.")
    )
      throw new Error(
        `Measurement failed before pixel equality: ${measured.error}`,
      );
    const directory = dirname(measured.resourceReport);
    const telemetry = JSON.parse(
      await readFile(
        join(directory, `${measured.name}.telemetry.json`),
        "utf8",
      ),
    );
    const result = JSON.parse(
      await readFile(join(directory, `${measured.name}.stdout.log`), "utf8"),
    );
    if (
      result.status !== "success" ||
      result.sourceMode !== "snapshot" ||
      result.renderSession?.sourceVersion !== source.sourceVersion
    )
      throw new Error("Render status or source identity changed");
    if (
      telemetry.capture_backend !==
        `${configuration.host}_d3d11_shared_texture` ||
      telemetry.cpu_readback_frames !== 0 ||
      telemetry.fallback_used ||
      telemetry.frames_encoded !== frames ||
      telemetry.encoder_backend !== "h264_mf" ||
      telemetry.worker_backend_compatibility !== "compatible"
    )
      throw new Error("Unexpected worker/capture/encoder accounting");
    expectedAudioHash ??= telemetry.audio?.pcm_sha256;
    const fpsParts = source.referenceVideo.avg_frame_rate
      .split("/")
      .map(Number);
    if (
      !expectedAudioHash ||
      telemetry.audio?.pcm_sha256 !== expectedAudioHash ||
      telemetry.audio.duration_samples !==
        (frames * 48000 * fpsParts[1]) / fpsParts[0]
    )
      throw new Error("Native mixed audio differs across trials");
    const video = join(directory, `${measured.name}.mp4`);
    await verifyFrames(video);
    const controls = source.cases.filter((c) => {
      const candidate = source.configurations.find(
        (config) => config.id === c.configuration,
      );
      return (
        candidate?.host === "electron" &&
        candidate.workers === configuration.workers
      );
    });
    const control =
      controls.find(
        (c) =>
          source.configurations.find((config) => config.id === c.configuration)
            ?.variant === "electron-baseline",
      ) ?? controls[0];
    if (!control) throw new Error("No same-worker-count Electron control");
    const pixels = await comparePixels(
      join(dirname(control.resourceReport), `${control.name}.mp4`),
      video,
    );
    await writeFile(
      join(directory, `${measured.name}.matched-workers-pixels.log`),
      pixels,
    );
    if (!/PSNR y:inf u:inf v:inf average:inf/.test(pixels))
      throw new Error("Decoded pixels differ at matched concurrency");
    const serialComparison = await readFile(
      join(directory, `${measured.name}.pixels.log`),
      "utf8",
    );
    const psnr = serialComparison.match(/PSNR .*average:(inf|[\d.]+)/)?.[1];
    if (!psnr)
      throw new Error("Missing full-resolution serial reference comparison");
    Object.assign(entry, {
      status: "passed",
      workers: configuration.workers,
      host: configuration.host,
      variant: configuration.variant ?? configuration.host,
      frameIdentityAndOrderPassed: true,
      matchedConcurrencyPixelsIdentical: true,
      serialReferencePixelsIdentical: psnr === "inf",
      serialReferencePsnrDb: psnr === "inf" ? "infinity" : Number(psnr),
      audioPcmSha256: expectedAudioHash,
      ...Object.fromEntries(
        [
          "elapsedSeconds",
          "privateResidentMiB",
          "privateCommittedMiB",
          "packageEnergyJoules",
          "packageAverageWatts",
          "idlePackageWatts",
          "memoryCoverageIncomplete",
        ].map((key) => [key, measured[key]]),
      ),
    });
  } catch (error) {
    entry.status = "failed";
    entry.error = String(error);
  }
  await persist();
  console.log(
    JSON.stringify({
      name: entry.name,
      status: entry.status,
      error: entry.error,
      serialReferencePsnrDb: entry.serialReferencePsnrDb,
    }),
  );
}
for (const configuration of source.configurations) {
  const trials = report.cases.filter(
    (c) =>
      c.configuration === configuration.id &&
      c.status === "passed" &&
      !c.memoryCoverageIncomplete &&
      c.privateResidentMiB !== null &&
      c.packageEnergyJoules !== null,
  );
  const summary = {
    configuration: configuration.id,
    host: configuration.host,
    variant: configuration.variant ?? configuration.host,
    workers: configuration.workers,
    validTrials: trials.length,
    requestedTrials: source.runs,
  };
  for (const field of [
    "elapsedSeconds",
    "privateResidentMiB",
    "privateCommittedMiB",
    "packageEnergyJoules",
    "packageAverageWatts",
    "idlePackageWatts",
  ]) {
    const values = trials.map((c) => c[field]);
    summary[field] = values.length === source.runs ? median(values) : null;
    summary[`${field}Range`] = values.length
      ? [Math.min(...values), Math.max(...values)]
      : null;
  }
  report.summaries.push(summary);
}
report.status =
  report.cases.every((c) => c.status === "passed") &&
  report.summaries.every((s) => s.validTrials === source.runs)
    ? "passed"
    : "incomplete";
report.finishedAt = new Date().toISOString();
await persist();
console.log(
  JSON.stringify(
    { status: report.status, summaries: report.summaries },
    null,
    2,
  ),
);
process.exitCode = report.status === "passed" ? 0 : 1;
