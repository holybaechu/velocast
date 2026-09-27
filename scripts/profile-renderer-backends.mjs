// Compare complete render process trees; validate media after the measured window.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { median } from "./electron-renderer-oracle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = new Map();
const allowedOptions = new Set([
  "--renderer",
  "--fixture",
  "--reference",
  "--output",
  "--runs",
  "--workers",
  "--only",
  "--pwsh",
  "--baseline-electron-renderer",
  "--baseline-electron-host",
]);
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i]?.startsWith("--") || !process.argv[i + 1])
    throw new Error("Expected --key value arguments");
  if (!allowedOptions.has(process.argv[i]))
    throw new Error(`Unknown benchmark option: ${process.argv[i]}`);
  options.set(process.argv[i], process.argv[i + 1]);
}
for (const key of ["--renderer", "--fixture", "--reference", "--output"])
  if (!options.has(key))
    throw new Error(
      "Required: --renderer ELECTRON_EXE --fixture prepared-fixture-directory --reference verified-video --output NEW-directory [--workers 1,2,4,8] [--runs 3] [--only configuration-id]",
    );
if (process.platform !== "win32")
  throw new Error("Resource profiling requires Windows.");
const runs = Number(options.get("--runs") ?? 3);
if (!Number.isInteger(runs) || runs < 1 || runs > 10)
  throw new Error("--runs must be 1..10");
const renderer = resolve(options.get("--renderer"));
const baselineRenderer = options.get("--baseline-electron-renderer");
const baselineHost = options.get("--baseline-electron-host");
if (Boolean(baselineRenderer) !== Boolean(baselineHost))
  throw new Error(
    "Provide both --baseline-electron-renderer and --baseline-electron-host",
  );
const fixture = resolve(options.get("--fixture"));
const reference = resolve(options.get("--reference"));
const output = resolve(options.get("--output"));
const hostRequire = createRequire(
  join(root, "packages/electron-host/package.json"),
);
const electron = hostRequire("electron");
const captureRateConfigurations = [
  {
    id: "electron-1000",
    host: "electron",
    renderCaptureFps: 1000,
  },
];
const workerCounts = options.has("--workers")
  ? options.get("--workers").split(",").map(Number)
  : null;
if (
  workerCounts &&
  (workerCounts.length === 0 ||
    new Set(workerCounts).size !== workerCounts.length ||
    workerCounts.some(
      (value) => !Number.isInteger(value) || value < 1 || value > 16,
    ))
)
  throw new Error("--workers must contain unique integers from 1 to 16");
const availableConfigurations = workerCounts
  ? workerCounts.flatMap((workers) =>
      (baselineRenderer ? ["electron-baseline", "electron"] : ["electron"]).map(
        (variant) => ({
          id: `${variant}-1000-workers-${workers}`,
          host: "electron",
          variant,
          renderer:
            variant === "electron-baseline"
              ? resolve(baselineRenderer)
              : renderer,
          hostScript:
            variant === "electron-baseline"
              ? resolve(baselineHost)
              : join(root, "packages/electron-host/main.cjs"),
          workers,
          assembly: "segments",
          renderCaptureFps: 1000,
        }),
      ),
    )
  : captureRateConfigurations.map((configuration) => ({
      ...configuration,
      workers: 1,
      assembly: "reference",
    }));
const selectedId = options.get("--only");
if (selectedId && !availableConfigurations.some(({ id }) => id === selectedId))
  throw new Error(`Unknown --only configuration: ${selectedId}`);
const configurations = selectedId
  ? availableConfigurations.filter(({ id }) => id === selectedId)
  : availableConfigurations;
if (baselineRenderer && !workerCounts)
  throw new Error("Baseline comparison requires --workers");
for (const configuration of configurations) {
  const native = configuration.renderer ?? renderer;
  const script =
    configuration.hostScript ?? join(root, "packages/electron-host/main.cjs");
  configuration.rendererSha256 = createHash("sha256")
    .update(await readFile(native))
    .digest("hex");
  if (configuration.host === "electron")
    configuration.hostSha256 = createHash("sha256")
      .update(await readFile(script))
      .digest("hex");
}
const report = {
  status: "running",
  startedAt: new Date().toISOString(),
  runs,
  measurement:
    "100 ms process-tree memory samples; processor-package RAPL energy at 1 Hz with boundaries; 3-second idle baseline before each trial",
  rendererSha256: createHash("sha256")
    .update(await readFile(renderer))
    .digest("hex"),
  renderer,
  electronHostSha256: createHash("sha256")
    .update(await readFile(join(root, "packages/electron-host/main.cjs")))
    .digest("hex"),
  configurations,
  cases: [],
  summaries: [],
};
await mkdir(dirname(output), { recursive: true });
await mkdir(output);
const persist = () =>
  writeFile(join(output, "summary.json"), JSON.stringify(report, null, 2));

async function command(executable, args, env = process.env) {
  const child = spawn(executable, args, {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [],
    stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const code = await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", done);
  });
  return {
    code,
    stdout: Buffer.concat(stdout).toString(),
    stderr: Buffer.concat(stderr).toString(),
  };
}

const probe = await command("ffprobe", [
  "-v",
  "error",
  "-count_frames",
  "-select_streams",
  "v:0",
  "-show_entries",
  "stream=width,height,nb_read_frames,codec_name,avg_frame_rate",
  "-of",
  "json",
  reference,
]);
if (probe.code !== 0) throw new Error(probe.stderr);
const referenceVideo = JSON.parse(probe.stdout).streams[0];
report.referenceVideo = referenceVideo;
report.referenceSha256 = createHash("sha256")
  .update(await readFile(reference))
  .digest("hex");
report.gitRevision = (
  await command("git", ["rev-parse", "HEAD"])
).stdout.trim();
await persist();

for (let round = 0; round < runs; round++) {
  const order =
    round % 2
      ? [...configurations].reverse()
      : [
          ...configurations.slice(round % configurations.length),
          ...configurations.slice(0, round % configurations.length),
        ];
  for (const configuration of order) {
    const name = `${configuration.id}-${round + 1}`;
    const paths = {
      resources: join(output, `${name}.json`),
      video: join(output, `${name}.mp4`),
      telemetry: join(output, `${name}.telemetry.json`),
      command: join(output, `${name}.command.json`),
    };
    const entry = {
      name,
      configuration: configuration.id,
      status: "running",
      resourceReport: paths.resources,
    };
    report.cases.push(entry);
    await persist();
    try {
      await writeFile(
        paths.command,
        JSON.stringify(
          {
            executable: process.execPath,
            arguments: [
              join(root, "packages/cli/dist/bin.js"),
              "render",
              "electron-spike",
              "--config",
              join(fixture, "velocast.config.mjs"),
              "--output",
              paths.video,
              "--report",
              paths.telemetry,
              "--json",
              "--acceleration",
              "required",
              "--concurrency",
              String(configuration.workers),
              "--assembly",
              configuration.assembly,
              "--codec",
              "h264",
              "--pixel-format",
              "nv12",
              "--bitrate",
              "12M",
            ],
            workingDirectory: root,
            environment: {
              VELOCAST_RENDERER_BINARY: configuration.renderer ?? renderer,
              VELOCAST_ELECTRON_CAPTURE_FPS: "1000",
              VELOCAST_ELECTRON_BINARY: electron,
              VELOCAST_ELECTRON_HOST_SCRIPT:
                configuration.hostScript ??
                join(root, "packages/electron-host/main.cjs"),
            },
          },
          null,
          2,
        ),
      );
      const measured = await command(options.get("--pwsh") ?? "pwsh.exe", [
        "-NoProfile",
        "-File",
        join(root, "scripts/measure-renderer-resources.ps1"),
        "-CommandFile",
        paths.command,
        "-OutputPath",
        paths.resources,
        "-SampleIntervalMs",
        "100",
        "-IdleBaselineSeconds",
        "3",
        "-TimeoutSeconds",
        "180",
      ]);
      const resources = JSON.parse(await readFile(paths.resources, "utf8"));
      const tree = resources.ProcessTree;
      const packageEnergy = resources.ProcessorPackageEnergy;
      Object.assign(entry, {
        exitCode: tree.ExitCode,
        elapsedSeconds: tree.DurationSeconds,
        privateResidentMiB:
          tree.IncompleteMemoryCoverage ||
          tree.SampledPeakPrivateResidentBytes === null
            ? null
            : tree.SampledPeakPrivateResidentBytes / 1048576,
        privateCommittedMiB: tree.SampledPeakPrivateCommittedBytes / 1048576,
        summedWorkingSetMiB: tree.SampledPeakWorkingSetBytes / 1048576,
        memoryCoverageIncomplete: tree.IncompleteMemoryCoverage,
        transientExitedProcesses: tree.ExitedBeforeObservation,
        processReadFailures: tree.ProcessReadFailures,
        processes: tree.ObservedProcessCount,
        memorySamples: tree.SampleCount,
        meanSampleIntervalMs: tree.MeanSampleIntervalMs,
        maximumSampleIntervalMs: tree.MaximumSampleIntervalMs,
        packageEnergyJoules: packageEnergy.RenderWindow.Available
          ? packageEnergy.RenderWindow.Joules
          : null,
        packageAverageWatts: packageEnergy.RenderWindow.Available
          ? packageEnergy.RenderWindow.AverageWatts
          : null,
        energyCoverageSeconds: packageEnergy.RenderWindow.Available
          ? packageEnergy.RenderWindow.MeterCoverageSeconds
          : null,
        idlePackageWatts: packageEnergy.IdleBaseline.Available
          ? packageEnergy.IdleBaseline.AverageWatts
          : null,
        baselineSubtractedEstimateJoules:
          packageEnergy.BaselineSubtractedEstimate?.Joules ?? null,
      });
      if (measured.code !== 0 || tree.TimedOut || tree.Error)
        throw new Error(
          measured.stderr ||
            (await readFile(resources.StderrPath, "utf8")) ||
            `Profiler exit ${measured.code}`,
        );
      const result = JSON.parse(await readFile(resources.StdoutPath, "utf8"));
      const telemetry = JSON.parse(await readFile(paths.telemetry, "utf8"));
      if (result.status !== "success" || result.sourceMode !== "snapshot")
        throw new Error("Render did not succeed from a frozen source.");
      report.sourceVersion ??= result.renderSession?.sourceVersion;
      if (
        !report.sourceVersion ||
        result.renderSession?.sourceVersion !== report.sourceVersion
      )
        throw new Error("The frozen source changed between resource trials.");
      const expectedCapture = "electron_d3d11_shared_texture";
      if (
        telemetry.capture_backend !== expectedCapture ||
        telemetry.cpu_readback_frames !== 0 ||
        telemetry.frames_encoded !== Number(referenceVideo.nb_read_frames) ||
        telemetry.encoder_backend !== "h264_mf" ||
        telemetry.fallback_used ||
        telemetry.dropped_frames !== 0 ||
        telemetry.stale_frames !== 0 ||
        (configuration.assembly === "segments" &&
          telemetry.mode !== "parallel_segments") ||
        (configuration.workers > 1 &&
          telemetry.worker_backend_compatibility !== "compatible")
      )
        throw new Error(
          "Unexpected capture/encoder/frame accounting; results are not comparable.",
        );
      const media = await command("ffprobe", [
        "-v",
        "error",
        "-count_frames",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,nb_read_frames,codec_name,avg_frame_rate",
        "-of",
        "json",
        paths.video,
      ]);
      if (media.code !== 0) throw new Error(media.stderr);
      const video = JSON.parse(media.stdout).streams[0];
      if (JSON.stringify(video) !== JSON.stringify(referenceVideo))
        throw new Error(
          "Output dimensions, frame count, codec or FPS differ from reference.",
        );
      const pixels = await command("ffmpeg", [
        "-hide_banner",
        "-i",
        reference,
        "-i",
        paths.video,
        "-lavfi",
        "psnr",
        "-an",
        "-f",
        "null",
        "NUL",
      ]);
      await writeFile(join(output, `${name}.pixels.log`), pixels.stderr);
      const serialReferencePixelsIdentical =
        /PSNR y:inf u:inf v:inf average:inf/.test(pixels.stderr);
      if (
        pixels.code !== 0 ||
        (!workerCounts && !serialReferencePixelsIdentical)
      )
        throw new Error("Decoded frames differ from the verified reference.");
      Object.assign(entry, {
        status: "passed",
        sourceVersion: result.renderSession.sourceVersion,
        captureBackend: telemetry.capture_backend,
        encoderBackend: telemetry.encoder_backend,
        cpuReadbackFrames: telemetry.cpu_readback_frames,
        workers: configuration.workers,
        assembly: configuration.assembly,
        mode: telemetry.mode,
        nativeWallMs: telemetry.total_wall_ms,
        audioPcmSha256: telemetry.audio?.pcm_sha256,
        audioDurationSamples: telemetry.audio?.duration_samples,
        workerBackendCompatibility: telemetry.worker_backend_compatibility,
        decodedPixelsIdentical: serialReferencePixelsIdentical,
        ...(workerCounts ? { matchedConcurrencyValidation: "pending" } : {}),
      });
    } catch (error) {
      entry.status = "failed";
      entry.error = String(error);
    }
    await persist();
    console.log(JSON.stringify(entry));
  }
}
const fields = [
  "elapsedSeconds",
  "privateResidentMiB",
  "privateCommittedMiB",
  "summedWorkingSetMiB",
  "packageEnergyJoules",
  "packageAverageWatts",
  "idlePackageWatts",
  "baselineSubtractedEstimateJoules",
];
for (const configuration of configurations) {
  const trials = report.cases.filter(
    (entry) =>
      entry.configuration === configuration.id && entry.status === "passed",
  );
  const summary = {
    configuration: configuration.id,
    host: configuration.host,
    workers: configuration.workers,
    assembly: configuration.assembly,
    successfulTrials: trials.length,
    requestedTrials: runs,
  };
  for (const field of fields) {
    const values = trials
      .map((entry) => entry[field])
      .filter((value) => typeof value === "number" && Number.isFinite(value));
    summary[field] = values.length === runs ? median(values) : null;
  }
  report.summaries.push(summary);
}
report.status = report.cases.every(
  (entry) =>
    entry.status === "passed" &&
    entry.privateResidentMiB !== null &&
    entry.packageEnergyJoules !== null,
)
  ? "passed"
  : "incomplete";
report.finishedAt = new Date().toISOString();
if (workerCounts) report.status = "awaiting_concurrency_validation";
await persist();
if (workerCounts) {
  // Complete all measured windows before decoding the identity strip or
  // comparing hosts with the same segment boundaries.
  const checked = await command(process.execPath, [
    join(root, "scripts/validate-concurrency-benchmark.mjs"),
    join(output, "summary.json"),
  ]);
  const validation = JSON.parse(
    await readFile(join(output, "concurrency-validation.json"), "utf8"),
  );
  report.status = validation.status;
  report.summaries = validation.summaries;
  report.concurrencyValidationReport = join(
    output,
    "concurrency-validation.json",
  );
  for (const entry of report.cases)
    entry.matchedConcurrencyValidation =
      validation.cases.find((value) => value.name === entry.name)?.status ??
      "failed";
  await persist();
  if (checked.stderr) process.stderr.write(checked.stderr);
  process.exitCode = checked.code === 0 && report.status === "passed" ? 0 : 1;
} else process.exitCode = report.status === "passed" ? 0 : 1;
console.log(
  JSON.stringify(
    { status: report.status, summaries: report.summaries },
    null,
    2,
  ),
);
