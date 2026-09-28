// End-to-end regression for stale 4K Electron bitmap captures at segment starts.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i]?.startsWith("--") || !process.argv[i + 1])
    throw new Error("Expected --key value");
  options.set(process.argv[i], process.argv[i + 1]);
}
if (!options.has("--renderer") || !options.has("--output"))
  throw new Error(
    "Required: --renderer EXE --output NEW-TEMP-DIR [--frames 24] [--repeats 3] [--mode both|reference|segments] [--all-frames true]",
  );
const renderer = resolve(options.get("--renderer"));
const output = resolve(options.get("--output"));
const canonicalOutput = join(
  realpathSync.native(dirname(output)),
  basename(output),
);
const repositoryRelative = relative(realpathSync.native(root), canonicalOutput);
if (
  repositoryRelative !== ".." &&
  !repositoryRelative.startsWith(`..${sep}`) &&
  !isAbsolute(repositoryRelative)
)
  throw new Error("Output must be outside the repository");
const tempRoots = [tmpdir(), process.env.RUNNER_TEMP].filter(Boolean);
const insideTemp = tempRoots.some((directory) => {
  const candidate = relative(realpathSync.native(directory), canonicalOutput);
  return (
    candidate !== "" &&
    candidate !== ".." &&
    !candidate.startsWith(`..${sep}`) &&
    !isAbsolute(candidate)
  );
});
if (!insideTemp)
  throw new Error(
    "Output must be a new directory beneath the OS temporary directory",
  );
const frames = Number(options.get("--frames") ?? 24);
const repeats = Number(options.get("--repeats") ?? 3);
const mode = options.get("--mode") ?? "both";
const allFrames = options.get("--all-frames") ?? "false";
if (
  !Number.isInteger(frames) ||
  frames < 1 ||
  frames > 240 ||
  !Number.isInteger(repeats) ||
  repeats < 1 ||
  repeats > 20 ||
  !["both", "reference", "segments"].includes(mode) ||
  !["true", "false"].includes(allFrames) ||
  (mode !== "reference" && frames < 4)
)
  throw new Error(
    "Invalid frames, repeats, or mode (segments need at least four frames)",
  );

// Copy the repository scene and its browser dependencies to a self-contained
// static snapshot. Only the adapter's duration is shortened: the GSAP scene
// and its initial frame-72 preview retain the original 240-frame timeline.
const source = join(output, "source");
await mkdir(output, { recursive: false });
await mkdir(join(source, "src"), { recursive: true });
await cp(
  join(root, "apps/playground/src/product-hero.js"),
  join(source, "src/product-hero.js"),
);
const main = await readFile(join(root, "apps/playground/src/main.js"), "utf8");
const durationDeclaration =
  "durationFrames: productHeroComposition.durationFrames,";
assert.ok(
  main.includes(durationDeclaration),
  "Playground adapter duration declaration changed",
);
await writeFile(
  join(source, "src/main.js"),
  main.replace(durationDeclaration, `durationFrames: ${frames},`),
);
await cp(
  join(root, "apps/playground/src/style.css"),
  join(source, "src/style.css"),
);
await cp(
  join(root, "apps/playground/node_modules/gsap/dist/gsap.min.js"),
  join(source, "gsap.min.js"),
);
await cp(
  join(root, "packages/gsap/browser/velocast-gsap.global.js"),
  join(source, "velocast-gsap.global.js"),
);
let html = await readFile(join(root, "apps/playground/index.html"), "utf8");
html = html
  .replace("./node_modules/gsap/dist/gsap.min.js", "./gsap.min.js")
  .replace(
    "../../packages/gsap/browser/velocast-gsap.global.js",
    "./velocast-gsap.global.js",
  )
  .replace(
    '<script src="./src/main.js"></script>',
    '<script src="./src/barcode.js"></script>\n    <script src="./src/main.js"></script>',
  );
await writeFile(join(source, "index.html"), html);
await writeFile(
  join(source, "src/barcode.js"),
  `(() => {
  const scene = globalThis.VelocastPlaygroundProductHero;
  const original = scene.createProductHeroTimeline;
  scene.createProductHeroTimeline = (gsap, target) => {
    const cells = [];
    const strip = document.createElement('div');
    strip.style.cssText = 'position:absolute;left:32px;top:32px;z-index:99;display:flex;gap:4px;padding:6px;background:#555';
    for (let bit = 0; bit < 8; bit++) {
      const cell = document.createElement('div');
      cell.style.cssText = 'width:56px;height:56px;background:#111';
      strip.append(cell);
      cells.push(cell);
    }
    target.append(strip);
    return original(gsap, target, (frame) => {
      scene.renderProductHeroFrame(target, frame);
      const number = scene.productHeroFrameMetrics(frame).frame;
      for (let bit = 0; bit < 8; bit++)
        cells[bit].style.background = number & (1 << bit) ? '#fff' : '#111';
    });
  };
})();\n`,
);
const config = join(output, "velocast.config.mjs");
const eventLog = join(output, "renderer.events.jsonl");
await writeFile(
  config,
  `export default ${JSON.stringify({
    entry: "source/index.html",
    renderer: {
      snapshotRoot: "source",
      binary: renderer,
      mediaBackend: "native",
      acceleration: "off",
      concurrency: 1,
      assembly: "reference",
      bitrate: "16M",
      eventLogPath: eventLog,
    },
  })};\n`,
);

const requireHost = createRequire(
  join(root, "packages/electron-host/package.json"),
);
const { createMediaSession } = requireHost("./media-client.cjs");
const electronBinary =
  process.env.VELOCAST_ELECTRON_BINARY ?? requireHost("electron");
const hostScript =
  process.env.VELOCAST_ELECTRON_HOST_SCRIPT ??
  join(root, "packages/electron-host/main.cjs");
if (!isAbsolute(hostScript))
  throw new Error("VELOCAST_ELECTRON_HOST_SCRIPT must be an absolute path");
const env = {
  ...process.env,
  VELOCAST_RENDERER_BINARY: renderer,
  VELOCAST_ELECTRON_BINARY: electronBinary,
  VELOCAST_ELECTRON_HOST_SCRIPT: hostScript,
};
delete env.ELECTRON_RUN_AS_NODE;
const run = promisify(execFile);
const report = {
  status: "running",
  frames,
  repeats,
  renderer,
  allFrames: allFrames === "true",
  cases: [],
};
const save = () =>
  writeFile(
    join(output, "results.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
await save();

async function render(name, assembly, concurrency) {
  const video = join(output, `${name}.mp4`);
  const telemetry = join(output, `${name}.json`);
  const { stdout } = await run(
    process.execPath,
    [
      join(root, "packages/cli/dist/bin.js"),
      "render",
      "product-hero",
      "--config",
      config,
      "--output",
      video,
      "--report",
      telemetry,
      "--codec",
      "h264",
      "--pixel-format",
      "yuv420p",
      "--media-backend",
      "native",
      "--acceleration",
      "off",
      "--concurrency",
      String(concurrency),
      "--assembly",
      assembly,
      "--json",
    ],
    {
      cwd: output,
      env,
      windowsHide: true,
      timeout: Math.max(180_000, frames * 5000),
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  assert.equal(JSON.parse(stdout).status, "success", `${name} CLI result`);
  const stats = JSON.parse(await readFile(telemetry, "utf8"));
  assert.equal(stats.capture_backend, "electron_bitmap");
  assert.equal(stats.frames_encoded, frames);
  assert.equal(stats.cpu_readback_frames, frames);
  assert.equal(
    stats.mode,
    assembly === "segments" ? "parallel_segments" : "reference_native",
  );
  const plan = (await readFile(eventLog, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((event) => event.event === "pipeline_plan_resolved");
  assert.ok(plan, `${name}: missing pipeline plan event`);
  assert.equal(
    plan.route,
    assembly === "segments" ? "parallel_segments" : "serial_reference",
  );
  assert.equal(plan.effective_concurrency, concurrency);
  assert.equal(plan.segment_count, concurrency);
  return { video, stats };
}

function decodeBarcode(pixels, frame) {
  assert.equal(
    pixels.length,
    3840 * 2160 * 4,
    `Frame ${frame}: decoded dimensions`,
  );
  let observed = 0;
  for (let bit = 0; bit < 8; bit++) {
    // The target is captured at 3840x2160, with the barcode at its top left.
    const x = 32 + 6 + bit * 60 + 28;
    const y = 32 + 6 + 28;
    const offset = (y * 3840 + x) * 4;
    const [r, g, b] = pixels.subarray(offset, offset + 3);
    const average = (r + g + b) / 3;
    assert.ok(
      average < 70 || average > 180,
      `Frame ${frame}, bit ${bit}: undecodable RGB ${r},${g},${b}`,
    );
    if (average > 180) observed |= 1 << bit;
  }
  assert.equal(
    observed,
    frame,
    `Output frame ${frame} contains scene frame ${observed}`,
  );
}

let media;
try {
  media = await createMediaSession({ electronBinary, env, timeoutMs: 120_000 });
  for (let repetition = 1; repetition <= repeats; repetition++) {
    for (const [assembly, concurrency] of [
      ["reference", 1],
      ["segments", 4],
    ]) {
      if (mode !== "both" && mode !== assembly) continue;
      const name = `${assembly}-${repetition}`;
      const started = performance.now();
      try {
        const { video, stats } = await render(name, assembly, concurrency);
        const probe = await media.run({
          kind: "probe",
          path: video,
          frames: true,
        });
        assert.equal(
          probe.video?.frameCount,
          frames,
          `${name}: output frame count`,
        );
        assert.equal(probe.video?.codec, "avc", `${name}: output codec`);
        const sampleFrames = report.allFrames
          ? Array.from({ length: frames }, (_, frame) => frame)
          : assembly === "reference"
            ? [...new Set([0, Math.min(1, frames - 1), frames - 1])]
            : [
                ...new Set(
                  Array.from({ length: 4 }, (_, worker) => {
                    const base = Math.floor(frames / 4);
                    const extra = Math.min(worker, frames % 4);
                    return worker * base + extra;
                  }).flatMap((start) => [
                    start,
                    Math.min(start + 1, frames - 1),
                  ]),
                ),
              ];
        for (const frame of sampleFrames) {
          const decoded = join(output, `${name}-${frame}.rgba`);
          const pts = probe.video.frames[frame].pts;
          const timeBase = probe.video.timeBase;
          const timestamp = (pts * timeBase.numerator) / timeBase.denominator;
          assert.ok(
            Math.abs(timestamp - frame / 60) < 0.00001,
            `${name}: unexpected timestamp for frame ${frame}`,
          );
          let decodeError;
          try {
            await media.run({
              kind: "frame",
              path: video,
              // Decode inside the frame interval. Native chunks round to
              // microseconds; an exact container boundary can select the
              // preceding sample without indicating wrong encoded pixels.
              timestamp: timestamp + 0.5 / 60,
              outputPath: decoded,
              format: "rgba",
            });
            decodeBarcode(await readFile(decoded), frame);
          } catch (error) {
            decodeError = error;
            throw error;
          } finally {
            try {
              await unlink(decoded);
            } catch (error) {
              if (error.code !== "ENOENT")
                throw decodeError
                  ? new AggregateError(
                      [decodeError, error],
                      "Frame decoding and cleanup failed",
                      { cause: decodeError },
                    )
                  : error;
            }
          }
        }
        report.cases.push({
          name,
          status: "passed",
          frames,
          sampledFrames: sampleFrames,
          captureBackend: stats.capture_backend,
          elapsedMs: Math.round(performance.now() - started),
        });
      } catch (error) {
        report.cases.push({ name, status: "failed", error: String(error) });
      }
      await save();
      console.log(JSON.stringify(report.cases.at(-1)));
    }
  }
} catch (error) {
  report.cases.push({
    name: "harness",
    status: "failed",
    error: String(error),
  });
  console.log(JSON.stringify(report.cases.at(-1)));
} finally {
  try {
    await media?.close();
  } catch (error) {
    report.cases.push({
      name: "media-session-close",
      status: "failed",
      error: String(error),
    });
    console.log(JSON.stringify(report.cases.at(-1)));
  }
}
report.status = report.cases.every((item) => item.status === "passed")
  ? "passed"
  : "failed";
await save();
if (report.status === "failed") process.exitCode = 1;
