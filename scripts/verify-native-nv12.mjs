// End-to-end acceptance for the explicit Electron NV12 -> native addon path.
// All generated fixture files, media, and evidence live under --output.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
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
import {
  assertFrameOracle,
  compareDecodedPixels,
  COLORS,
  FPS,
  FRAME_STATES,
  HEIGHT,
  WIDTH,
} from "./electron-renderer-oracle.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Map();
const allowed = new Set([
  "--renderer",
  "--addon",
  "--electron",
  "--host-script",
  "--output",
  "--core",
]);
for (let at = 2; at < process.argv.length; at += 2) {
  const name = process.argv[at],
    value = process.argv[at + 1];
  if (!allowed.has(name) || !value || value.startsWith("--") || args.has(name))
    throw new Error(`Invalid verification option ${name ?? ""}`);
  args.set(name, value);
}
for (const name of [
  "--renderer",
  "--addon",
  "--electron",
  "--host-script",
  "--output",
])
  if (!args.has(name))
    throw new Error(
      "Usage: node scripts/verify-native-nv12.mjs --renderer RENDERER --addon ADDON.node --electron ELECTRON.exe --host-script main.cjs --output TEMP_DIRECTORY [--core CORE_DIST]",
    );
if (process.platform !== "win32")
  throw new Error("Native NV12 verification requires Windows");
const renderer = resolve(args.get("--renderer"));
const addon = resolve(args.get("--addon"));
const electron = resolve(args.get("--electron"));
const hostScript = resolve(args.get("--host-script"));
const output = resolve(args.get("--output"));
const core = resolve(
  args.get("--core") ?? join(repository, "packages/core/dist"),
);
// Windows may expose the same temp directory with an 8.3 short user name.
const underTemp = relative(await realpath(tmpdir()), output);
if (
  !underTemp ||
  underTemp === ".." ||
  underTemp.startsWith(`..${sep}`) ||
  isAbsolute(underTemp)
)
  throw new Error(
    "--output must be a task-specific directory below the OS temporary directory",
  );
for (const file of [
  renderer,
  addon,
  electron,
  hostScript,
  join(core, "index.js"),
])
  assert((await stat(file)).isFile(), `Missing input: ${file}`);
await mkdir(output, { recursive: true });
const runDirectory = await mkdtemp(join(output, "native-nv12-"));
const fixture = join(runDirectory, "fixture");
await cp(core, join(fixture, "core"), { recursive: true });

const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:black}canvas{display:block}</style></head><body><canvas id="scene" width="${WIDTH}" height="${HEIGHT}"></canvas><script type="module">
import {registerFrameAdapter} from './core/index.js';
const states=${JSON.stringify(FRAME_STATES)}, colors=${JSON.stringify(COLORS)};
const canvas=document.getElementById('scene'),g=canvas.getContext('2d',{alpha:false});
registerFrameAdapter('nv12-dynamic',{id:'nv12-dynamic',getDurationFrames:()=>states.length,
seekFrame(frame,context){if(context.inputProps?.failAt===frame)throw Error('fixture.intentional_failure');
const color=colors[states[frame]];g.fillStyle='rgb('+color.join(',')+')';g.fillRect(0,0,${WIDTH},${HEIGHT});
g.fillStyle='white';g.font='20px monospace';g.fillText('frame '+frame,8,28);
for(let bit=0;bit<8;bit++){g.fillStyle=((frame>>bit)&1)?'#ffffff':'#000000';g.fillRect(8+bit*20,90,14,16);}}
},{width:${WIDTH},height:${HEIGHT},fps:${FPS},target:'#scene',rootElement:'#scene'});
registerFrameAdapter('nv12-static',{id:'nv12-static',getDurationFrames:()=>6,
init(){g.fillStyle='rgb(32,64,192)';g.fillRect(0,0,${WIDTH},${HEIGHT});},
seekFrame(){/* Exactly identical composition across all frames. */}
},{width:${WIDTH},height:${HEIGHT},fps:${FPS},target:'#scene',rootElement:'#scene'});
</script></body></html>`;
await writeFile(join(fixture, "index.html"), html);

const server = createServer(async (request, response) => {
  try {
    const name = decodeURIComponent(
      new URL(request.url, "http://localhost").pathname,
    ).slice(1);
    const target = resolve(fixture, name || "index.html");
    const within = relative(fixture, target);
    if (
      within === ".." ||
      within.startsWith(`..${sep}`) ||
      isAbsolute(within)
    ) {
      response.writeHead(403).end();
      return;
    }
    const bytes = await readFile(target);
    response.setHeader(
      "Content-Type",
      target.endsWith(".js") ? "text/javascript" : "text/html",
    );
    response.end(bytes);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((done, fail) => {
  server.once("error", fail);
  server.listen(0, "127.0.0.1", done);
});
const url = `http://127.0.0.1:${server.address().port}/index.html`;
const env = {
  ...process.env,
  VELOCAST_NATIVE_NV12: "1",
  VELOCAST_NATIVE_ENCODER_ADDON: addon,
  VELOCAST_ELECTRON_BINARY: electron,
  VELOCAST_ELECTRON_HOST_SCRIPT: hostScript,
};
delete env.ELECTRON_RUN_AS_NODE;

async function run(
  executable,
  commandArgs,
  {
    timeoutMs = 120_000,
    captureLimit = 16 * 1024 * 1024,
    allowFailure = false,
  } = {},
) {
  const child = spawn(executable, commandArgs, {
    cwd: runDirectory,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [],
    stderr = [];
  let stdoutLength = 0,
    stderrLength = 0,
    timedOut = false;
  child.stdout.on("data", (chunk) => {
    stdoutLength += chunk.length;
    if (stdoutLength <= captureLimit) stdout.push(chunk);
    else child.kill();
  });
  child.stderr.on("data", (chunk) => {
    stderrLength += chunk.length;
    if (stderrLength <= captureLimit) stderr.push(chunk);
    else child.kill();
  });
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid)
      spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
  }, timeoutMs);
  let code;
  try {
    code = await new Promise((done, fail) => {
      child.once("error", fail);
      child.once("close", done);
    });
  } finally {
    clearTimeout(timer);
  }
  const result = {
    code,
    timedOut,
    stdout: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr),
  };
  if (
    (!allowFailure && code !== 0) ||
    timedOut ||
    stdoutLength > captureLimit ||
    stderrLength > captureLimit
  )
    throw new Error(
      `${basename(executable)} exited ${code}, timeout=${timedOut}: ${result.stderr.toString().slice(-4000)}`,
    );
  return result;
}

async function probe(media) {
  const result = await run("ffprobe", [
    "-v",
    "error",
    "-count_frames",
    "-show_entries",
    "stream=codec_type,codec_name,pix_fmt,width,height,nb_read_frames,color_range,color_space,color_primaries,color_transfer,start_time,duration:format=duration",
    "-of",
    "json",
    media,
  ]);
  return JSON.parse(result.stdout.toString());
}

async function decode(media) {
  return (
    await run(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        media,
        "-map",
        "0:v:0",
        "-fps_mode",
        "passthrough",
        "-pix_fmt",
        "rgba",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      { captureLimit: WIDTH * HEIGHT * 4 * (FRAME_STATES.length + 2) },
    )
  ).stdout;
}

function verifyStream(metadata, frames) {
  const streams = metadata.streams.filter(
    (stream) => stream.codec_type === "video",
  );
  assert.equal(streams.length, 1, "exactly one video stream");
  const video = streams[0];
  assert.equal(video.codec_name, "h264");
  assert.equal(video.pix_fmt, "yuv420p"); // H.264 exposes NV12's 4:2:0 samples as planar decode.
  assert.equal(video.width, WIDTH);
  assert.equal(video.height, HEIGHT);
  assert.equal(Number(video.nb_read_frames), frames);
  assert.equal(video.color_range, "tv");
  assert.equal(video.color_space, "bt709");
  assert.equal(video.color_primaries, "bt709");
  assert.equal(video.color_transfer, "bt709");
  assert(
    Math.abs(Number(video.start_time)) < 0.005,
    `video PTS is not rebased: ${video.start_time}`,
  );
  assert(
    Math.abs(Number(metadata.format.duration) - frames / FPS) < 0.1,
    "video duration mismatch",
  );
  return video;
}

const cases = [
  {
    name: "dynamic",
    composition: "nv12-dynamic",
    expected: FRAME_STATES.map((_, frame) => frame),
  },
  {
    name: "range",
    composition: "nv12-dynamic",
    range: { startFrame: 7, endFrame: 14 },
    expected: [7, 8, 9, 10, 11, 12, 13],
  },
  { name: "static", composition: "nv12-static", expected: [0, 1, 2, 3, 4, 5] },
];
const results = {
  status: "running",
  startedAt: new Date().toISOString(),
  inputs: { renderer, addon, electron, hostScript, core, url },
  cases: [],
};
const resultPath = join(runDirectory, "verification.json");
async function persist() {
  await writeFile(resultPath, `${JSON.stringify(results, null, 2)}\n`);
}
try {
  await persist();
  for (const item of cases) {
    const media = join(runDirectory, `${item.name}.mp4`);
    const reportPath = join(runDirectory, `${item.name}.report.json`);
    const job = {
      mode: "composition",
      composition_id: item.composition,
      serve_url: url,
      output: media,
      codec: "h264",
      pixel_format: "nv12",
      acceleration: "required",
      concurrency: 1,
      assembly_mode: "reference",
      bitrate_bps: 12_000_000,
      report_path: reportPath,
      ...(item.range ? { output_range: item.range } : {}),
    };
    await run(renderer, ["--job-json", JSON.stringify(job)]);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    const metadata = await probe(media);
    const video = verifyStream(metadata, item.expected.length);
    const pixels = await decode(media);
    assert.equal(pixels.length, item.expected.length * WIDTH * HEIGHT * 4);
    if (item.name !== "static") {
      assertFrameOracle(pixels, item.expected);
    } else {
      const stride = WIDTH * HEIGHT * 4;
      const expectedColor = [32, 64, 192];
      for (let frame = 0; frame < item.expected.length; frame++) {
        const image = pixels.subarray(frame * stride, (frame + 1) * stride);
        const at = (50 * WIDTH + 150) * 4;
        for (let channel = 0; channel < 3; channel++)
          assert(
            Math.abs(image[at + channel] - expectedColor[channel]) <= 25,
            `static frame ${frame} color mismatch`,
          );
        if (frame > 0)
          compareDecodedPixels(pixels.subarray(0, stride), image, {
            maxMae: 5,
            maxOutlierFraction: 0.01,
          });
      }
    }
    for (const field of [
      "frames_expected",
      "frames_rendered",
      "frames_encoded",
    ])
      assert.equal(
        report[field],
        item.expected.length,
        `${item.name} ${field}`,
      );
    assert.equal(report.capture_backend, "electron_native_nv12");
    assert.equal(report.conversion_backend, "d3d11_nv12_copy");
    assert.match(report.encoder_backend, /^h264_(qsv|nvenc|amf)$/);
    assert.equal(report.surface_format_in, "nv12");
    assert.equal(
      report.cpu_readback_frames,
      0,
      "CPU readback must remain zero",
    );
    assert.equal(report.dropped_frames, 0);
    assert.equal(report.stale_frames, 0);
    assert.equal(report.fallback_used, false, "fallback must remain disabled");
    assert.equal(report.surface_format_encoder, "nv12");
    results.cases.push({
      name: item.name,
      media,
      reportPath,
      frames: item.expected.length,
      codec: video.codec_name,
      pixelFormat: video.pix_fmt,
      colorSpace: video.color_space,
      colorRange: video.color_range,
      startTime: video.start_time,
    });
    await persist();
  }
  // A render failure must abort the addon and preserve the previously published
  // video at the same destination. This also exercises native temp-file cleanup.
  const preservedMedia = join(runDirectory, "dynamic.mp4");
  const before = createHash("sha256")
    .update(await readFile(preservedMedia))
    .digest("hex");
  const failProps = join(runDirectory, "fail-at-7.json");
  await writeFile(failProps, JSON.stringify({ failAt: 7 }));
  const failedJob = {
    mode: "composition",
    composition_id: "nv12-dynamic",
    serve_url: url,
    output: preservedMedia,
    codec: "h264",
    pixel_format: "nv12",
    acceleration: "required",
    concurrency: 1,
    assembly_mode: "reference",
    bitrate_bps: 12_000_000,
    input_props_path: failProps,
    report_path: join(runDirectory, "failure.report.json"),
  };
  const failure = await run(
    renderer,
    ["--job-json", JSON.stringify(failedJob)],
    { allowFailure: true },
  );
  assert.notEqual(
    failure.code,
    0,
    "intentional render failure unexpectedly succeeded",
  );
  const after = createHash("sha256")
    .update(await readFile(preservedMedia))
    .digest("hex");
  assert.equal(
    after,
    before,
    "failed native encode replaced the published video",
  );
  results.cases.push({
    name: "failure-preserves-output",
    exitCode: failure.code,
    media: preservedMedia,
    sha256: after,
    stderrTail: failure.stderr.toString().slice(-1000),
  });
  results.status = "verified";
  results.completedAt = new Date().toISOString();
  await persist();
  console.log(`Native NV12 acceptance verified: ${resultPath}`);
} catch (error) {
  results.status = "failed";
  results.error = String(error?.stack || error);
  results.completedAt = new Date().toISOString();
  await persist();
  throw error;
} finally {
  await new Promise((done) => server.close(done));
}
