// Native Electron WebCodecs/frame gates shared by Windows and hosted Unix CI.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertFrameOracle,
  assertWebCodecsTelemetry,
  COLORS,
  FRAME_STATES,
  HEIGHT,
  WIDTH,
  cancellationMarkerPath,
  firstRenderedFrame,
} from "./electron-renderer-oracle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i]?.startsWith("--") || !process.argv[i + 1])
    throw new Error("Expected --key value");
  options.set(process.argv[i], process.argv[i + 1]);
}
if (!options.has("--renderer") || !options.has("--output"))
  throw new Error(
    "Required: --renderer EXE --output NEW-DIRECTORY [--frames 24] [--repeats 3] [--bundled true]",
  );
const renderer = resolve(options.get("--renderer")),
  output = resolve(options.get("--output"));
const outputRelative = relative(root, output);
if (
  outputRelative !== ".." &&
  !outputRelative.startsWith(`..${sep}`) &&
  !isAbsolute(outputRelative)
)
  throw new Error("Output directory must be outside the repository");
const frames = Number(options.get("--frames") ?? 24),
  repeats = Number(options.get("--repeats") ?? 3);
if (
  !Number.isInteger(frames) ||
  frames < 8 ||
  frames > 10000 ||
  !Number.isInteger(repeats) ||
  repeats < 1 ||
  repeats > 20
)
  throw new Error("Invalid frame/repeat bounds");
const env = {
  ...process.env,
  VELOCAST_RENDERER_BINARY: renderer,
  VELOCAST_NODE_BINARY: process.execPath,
};
const encoder = "webcodecs";
if (options.has("--encoder") && options.get("--encoder") !== "webcodecs")
  throw new Error(
    "The software encoder has been retired; WebCodecs is the default",
  );
delete env.VELOCAST_EXPERIMENTAL_ENCODER;
delete env.VELOCAST_BROWSER;
delete env.VELOCAST_EXPERIMENTAL_BROWSER;
if (options.get("--bundled") === "true") {
  delete env.VELOCAST_ELECTRON_BINARY;
  delete env.VELOCAST_ELECTRON_HOST_SCRIPT;
  delete env.CEF_PATH;
  const pathKey =
    Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  env[pathKey] =
    dirname(renderer) +
    (process.platform === "win32" ? ";" : ":") +
    (env[pathKey] ?? "");
}
const cli = join(root, "packages/cli/dist/bin.js"),
  fixture = join(output, "fixture"),
  source = join(fixture, "source");
const require = createRequire(import.meta.url);
const runtimeHost =
  options.get("--bundled") === "true"
    ? join(dirname(renderer), "electron-host")
    : join(root, "packages/electron-host");
const { runMediaOperation } = require(join(runtimeHost, "media-client.cjs"));
const mediaOptions = {
  env,
  ...(options.get("--bundled") === "true"
    ? {
        electronBinary: join(dirname(renderer), "electron", "electron.exe"),
        hostScript: join(runtimeHost, "main.cjs"),
      }
    : {}),
};
const media = (operation) => runMediaOperation(operation, mediaOptions);
await mkdir(dirname(output), { recursive: true });
await mkdir(output, { recursive: false });
await mkdir(source, { recursive: true });
const report = {
  status: "running",
  startedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  frames,
  repeats,
  renderer,
  encoder,
  cases: [],
};
const persist = () =>
  writeFile(
    join(output, "results.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
await persist();
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function command(
  binary,
  args,
  { allowFailure = false, binaryOutput = false, environment = env } = {},
) {
  const child = spawn(binary, args, {
    env: environment,
    cwd: fixture,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = [],
    err = [];
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      if (process.platform === "win32")
        spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
        });
      else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
    },
    Math.max(90_000, frames * 300),
  );
  child.stdout.on("data", (chunk) => out.push(chunk));
  child.stderr.on("data", (chunk) => err.push(chunk));
  let code;
  try {
    code = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", done);
    });
  } finally {
    clearTimeout(timer);
  }
  const stdout = Buffer.concat(out),
    stderr = Buffer.concat(err).toString();
  if (timedOut || (code !== 0 && !allowFailure))
    throw new Error(
      `${binary} failed (${code}, timeout=${timedOut}): ${stderr.slice(-4000)}\n${stdout.toString().slice(-1000)}`,
    );
  return { code, stdout: binaryOutput ? stdout : stdout.toString(), stderr };
}
async function gate(name, action) {
  const started = performance.now();
  try {
    const details = await action();
    report.cases.push({
      name,
      status: "passed",
      elapsedMs: Math.round(performance.now() - started),
      ...details,
    });
  } catch (error) {
    report.cases.push({ name, status: "failed", error: String(error) });
  }
  await persist();
  console.log(JSON.stringify(report.cases.at(-1)));
}
async function invoke(args, settings) {
  const result = await command(
    process.execPath,
    [cli, ...args, "--config", join(fixture, "velocast.config.mjs"), "--json"],
    settings,
  );
  const value = JSON.parse(result.stdout);
  if (result.code === 0 && value.status !== "success")
    throw new Error(`Unexpected result: ${result.stdout}`);
  return { ...result, value };
}
const states = Array.from(
  { length: frames },
  (_, frame) => FRAME_STATES[frame % FRAME_STATES.length],
);
async function checkPixels(path, expected, { exactStatic = false } = {}) {
  const png = path.toLowerCase().endsWith(".png");
  if (!png) {
    const probe = await media({ kind: "probe", path, frames: true });
    if (probe.video?.frameCount !== expected.length)
      throw new Error(
        `Decoded ${probe.video?.frameCount}/${expected.length} frames`,
      );
  }
  let first;
  for (let count = 0; count < expected.length; count++) {
    const outputPath = join(output, `decoded-${sha(path)}-${count}.rgba`);
    const details = await media(
      png
        ? { kind: "image-rgba", path, outputPath }
        : {
            kind: "frame",
            path,
            timestamp: count / 12,
            outputPath,
            format: "rgba",
          },
    );
    const pixels = await readFile(outputPath);
    await unlink(outputPath);
    if (
      details.width !== WIDTH ||
      details.height !== HEIGHT ||
      pixels.length !== WIDTH * HEIGHT * 4
    )
      throw new Error("Wrong decoded dimensions or pixel count");
    if (exactStatic) {
      first ??= pixels;
      if (!first.equals(pixels))
        throw new Error("Static output changed between frames");
      for (const [channel, value] of COLORS[0].entries())
        if (Math.abs(pixels[(30 * WIDTH + 170) * 4 + channel] - value) > 25)
          throw new Error(
            `Wrong static pixels at frame ${count}: ${[...pixels.subarray((30 * WIDTH + 170) * 4, (30 * WIDTH + 170) * 4 + 3)]}, expected ${COLORS[0]}`,
          );
    } else assertFrameOracle(pixels, [expected[count]], { states });
  }
  return expected.length;
}
const config = join(fixture, "velocast.config.mjs");
const sampleFrames = frames * 4000;
const wav = Buffer.alloc(44 + sampleFrames * 4);
wav.write("RIFF", 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(2, 22);
wav.writeUInt32LE(48000, 24);
wav.writeUInt32LE(192000, 28);
wav.writeUInt16LE(4, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(sampleFrames * 4, 40);
for (let i = 0; i < sampleFrames; i++) {
  const value = Math.round(
    32767 * 0.125 * Math.sin((2 * Math.PI * 440 * i) / 48000),
  );
  wav.writeInt16LE(value, 44 + i * 4);
  wav.writeInt16LE(value, 46 + i * 4);
}
await writeFile(join(source, "tone.wav"), wav);
await cp(join(root, "packages/core/dist"), join(source, "core"), {
  recursive: true,
});
await writeFile(
  config,
  `export default ${JSON.stringify({ entry: "source/index.html", renderer: { binary: renderer, snapshotRoot: "source", mediaBackend: "webcodecs", acceleration: "auto", concurrency: 1, assembly: "reference", codec: "h264", pixelFormat: "yuv420p", bitrate: "8M" } })};\n`,
);
await writeFile(
  join(source, "index.html"),
  `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:black}canvas{display:block}</style></head><body><canvas id="scene" width="${WIDTH}" height="${HEIGHT}"></canvas><script type="module">
import {registerFrameAdapter} from './core/index.js';
const states=${JSON.stringify(states)},colors=${JSON.stringify(COLORS)},g=document.querySelector('canvas').getContext('2d',{alpha:false});
const crop=document.createElement('div');crop.id='crop';crop.style.cssText='position:absolute;left:257px;top:173px;width:${WIDTH}px;height:${HEIGHT}px;background:rgb(32,64,192)';document.body.append(crop);
registerFrameAdapter('portable',{id:'portable',getDurationFrames:()=>states.length,getAudioPlan:()=>({sampleRate:48000,durationSamples:${frames * 4000},clips:[{source:'tone.wav',startSample:0,sourceStartSample:0,durationSamples:${frames * 4000},gain:0.2}]}),seekFrame(frame,context){if(context.inputProps?.failAt===frame)throw Error('fixture.intentional_failure');g.fillStyle='rgb('+colors[states[frame]].join(',')+')';g.fillRect(0,0,${WIDTH},${HEIGHT});for(let bit=0;bit<8;bit++){g.fillStyle=((frame>>bit)&1)?'#ffffff':'#000000';g.fillRect(8+bit*20,90,14,16);}}},{width:${WIDTH},height:${HEIGHT},fps:12,target:'#scene',rootElement:'#scene'});
registerFrameAdapter('static',{id:'static',getDurationFrames:()=>6,init(){g.fillStyle='rgb('+colors[0].join(',')+')';g.fillRect(0,0,${WIDTH},${HEIGHT});},seekFrame(){}},{width:${WIDTH},height:${HEIGHT},fps:12,target:'#scene',rootElement:'#scene'});
registerFrameAdapter('cancel',{id:'cancel',getDurationFrames:()=>300,seekFrame(){}},{width:${WIDTH},height:${HEIGHT},fps:12,target:'#scene',rootElement:'#scene'});
registerFrameAdapter('crop',{id:'crop',getDurationFrames:()=>1,seekFrame(){}},{width:${WIDTH},height:${HEIGHT},fps:12,target:'#crop',rootElement:'#crop'});
</script></body></html>`,
);
await writeFile(join(fixture, "fail.json"), JSON.stringify({ failAt: 3 }));
async function checkAudio(video, expectedFrames) {
  const outputPath = join(output, `decoded-audio-${sha(video)}.f32`);
  await media({
    kind: "decode-audio",
    path: video,
    outputPath,
    sampleRate: 48000,
    channels: 1,
    format: "f32",
  });
  const pcm = await readFile(outputPath);
  await unlink(outputPath);
  const samples = pcm.length / 4;
  if (
    !Number.isInteger(samples) ||
    Math.abs(samples - expectedFrames * 4000) > 2048
  )
    throw new Error(
      `Unexpected audio length ${samples} samples for ${expectedFrames} frames`,
    );
  let energy = 0;
  for (let at = 0; at < pcm.length; at += 4) energy += pcm.readFloatLE(at) ** 2;
  const rms = Math.sqrt(energy / samples);
  if (!Number.isFinite(rms) || rms < 0.012 || rms > 0.024)
    throw new Error(`Unexpected audio signal RMS ${rms}`);
  return { decodedAudioSamples: samples, audioRms: rms };
}
await gate("inspect", async () => {
  await invoke(["inspect", "portable"]);
});
await gate("png-frame", async () => {
  const png = join(output, "frame-3.png");
  await invoke(["frame", "portable", "--frame", "3", "--output", png]);
  await checkPixels(png, [3]);
});
await gate("png-offset-target", async () => {
  const png = join(output, "crop.png");
  await invoke(["frame", "crop", "--frame", "0", "--output", png]);
  await checkPixels(png, [0], { exactStatic: true });
});
for (let run = 1; run <= repeats; run++)
  await gate(`${encoder}-reference-${run}`, async () => {
    const video = join(output, `reference-${run}.mp4`),
      telemetry = join(output, `reference-${run}.json`);
    await invoke([
      "render",
      "portable",
      "--output",
      video,
      "--report",
      telemetry,
    ]);
    const decoded = await checkPixels(
      video,
      states.map((_, frame) => frame),
    );
    const data = JSON.parse(await readFile(telemetry, "utf8"));
    assertWebCodecsTelemetry(data, "electron", frames);
    if (
      data.encoder_backend !== "electron_webcodecs_h264" ||
      !["prefer-hardware", "no-preference"].includes(
        data.webcodecs?.hardware_acceleration,
      )
    )
      throw new Error(`Wrong ${encoder} selection: ${JSON.stringify(data)}`);
    return {
      decodedFrames: decoded,
      captureBackend: data.capture_backend,
      ...(await checkAudio(video, frames)),
    };
  });
await gate(`${encoder}-range`, async () => {
  const video = join(output, "range.mp4");
  await invoke([
    "render",
    "portable",
    "--start-frame",
    "3",
    "--end-frame",
    "7",
    "--output",
    video,
  ]);
  await checkPixels(video, [3, 4, 5, 6]);
  return checkAudio(video, 4);
});
await gate("unchanged-static", async () => {
  const video = join(output, "static.mp4");
  await invoke([
    "render",
    "static",
    "--output",
    video,
    "--report",
    join(output, "static.json"),
  ]);
  await checkPixels(video, Array(6).fill(0), { exactStatic: true });
});
await gate("software-preference", async () => {
  const video = join(output, "software-preference.mp4");
  await invoke([
    "render",
    "portable",
    "--acceleration",
    "off",
    "--output",
    video,
  ]);
  await checkPixels(
    video,
    states.map((_, frame) => frame),
  );
});
await gate("parallel-segments", async () => {
  const video = join(output, "parallel.mp4");
  await invoke([
    "render",
    "portable",
    "--concurrency",
    "2",
    "--assembly",
    "segments",
    "--output",
    video,
  ]);
  await checkPixels(
    video,
    states.map((_, frame) => frame),
  );
  return checkAudio(video, frames);
});
await gate("failure-preserves-output", async () => {
  const video = join(output, "reference-1.mp4"),
    before = sha(await readFile(video));
  const result = await invoke(
    [
      "render",
      "portable",
      "--input-props-file",
      join(fixture, "fail.json"),
      "--output",
      video,
    ],
    { allowFailure: true },
  );
  if (
    result.code === 0 ||
    result.value.status !== "failure" ||
    sha(await readFile(video)) !== before
  )
    throw new Error("Failure did not preserve previous output");
});
await gate("webcodecs-cancellation-preserves-output", async () => {
  const video = join(output, "reference-1.mp4"),
    before = sha(await readFile(video));
  const events = join(output, "cancel-events.jsonl");
  const require = createRequire(import.meta.url);
  const child = spawn(
    renderer,
    [
      "--job-json",
      JSON.stringify({
        mode: "composition",
        composition_id: "cancel",
        serve_url: pathToFileURL(join(source, "index.html")).href,
        output: video,
        codec: "h264",
        media_backend: "webcodecs",
        acceleration: "auto",
        pixel_format: "yuv420p",
        event_log_path: events,
      }),
    ],
    {
      env: {
        ...env,
        VELOCAST_ELECTRON_BINARY:
          mediaOptions.electronBinary ??
          require(join(root, "packages/electron-host/node_modules/electron")),
        VELOCAST_ELECTRON_HOST_SCRIPT: join(runtimeHost, "main.cjs"),
      },
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let ended = false,
    errors = "";
  child.stderr.on("data", (bytes) => {
    errors = (errors + bytes).slice(-16000);
  });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      ended = true;
      resolve(code);
    });
  });
  const timer = setTimeout(() => child.kill(), 45_000);
  try {
    let observed = null;
    while (!ended && observed === null) {
      try {
        observed = firstRenderedFrame(await readFile(events, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (observed === null)
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (ended || observed === null)
      throw new Error(`Render ended before cancellation: ${errors}`);
    await writeFile(cancellationMarkerPath(events, child.pid), "", {
      flag: "wx",
    });
    if (
      (await closed) === 0 ||
      !errors.includes("renderer.cancelled") ||
      sha(await readFile(video)) !== before
    )
      throw new Error(`Cancellation did not preserve output: ${errors}`);
    const leftovers = (await readdir(tmpdir())).filter((name) =>
      name.startsWith(`velocast-electron-${child.pid}-`),
    );
    if (leftovers.length)
      throw new Error(`Cancellation leaked host directories: ${leftovers}`);
    return { observedFrame: observed };
  } finally {
    clearTimeout(timer);
    if (!ended) {
      child.kill();
      await closed;
    }
  }
});
for (const args of [
  ["--acceleration", "required"],
  ["--pixel-format", "yuv444p"],
]) {
  await gate(`reject-${args.join("-")}`, async () => {
    const video = join(output, "reference-1.mp4"),
      before = sha(await readFile(video));
    const result = await invoke(
      ["render", "portable", ...args, "--output", video],
      { allowFailure: true },
    );
    if (
      result.code === 0 ||
      !(args[0] === "--acceleration"
        ? result.stdout.includes("encoder.hardware_guarantee_unsupported")
        : result.stdout.includes("encoder.pixel_format_unsupported")) ||
      sha(await readFile(video)) !== before
    )
      throw new Error(
        "Unsupported WebCodecs request succeeded or changed prior output",
      );
  });
}
await gate("shared-texture-auto-falls-back-to-bitmap", async () => {
  const video = join(output, "reference-1.mp4"),
    before = sha(await readFile(video)),
    marker = join(output, "bitmap-start-prior-output.sha256"),
    cpuMarker = join(output, "cpu-bitmap-start-prior-output.sha256"),
    attempts = join(output, "fallback-host-attempts.jsonl"),
    telemetry = join(output, "bitmap-fallback.json"),
    wrapper = join(output, "fallback-host.cjs"),
    realHost = join(runtimeHost, "main.cjs");
  await writeFile(
    wrapper,
    `"use strict";
const fs=require("node:fs"),crypto=require("node:crypto");
const video=process.env.VELOCAST_TEST_FALLBACK_VIDEO,marker=process.env.VELOCAST_TEST_BITMAP_MARKER,
  cpuMarker=process.env.VELOCAST_TEST_CPU_MARKER,attempts=process.env.VELOCAST_TEST_ATTEMPTS;
if(process.env.VELOCAST_ELECTRON_SURFACE_MODE==="bitmap"){
  const cpu=process.env.VELOCAST_ELECTRON_CPU_BITMAP==="1";
  fs.appendFileSync(attempts,JSON.stringify({mode:"bitmap",cpu})+"\\n");
  fs.writeFileSync(cpu?cpuMarker:marker,crypto.createHash("sha256").update(fs.readFileSync(video)).digest("hex"));
  if(process.env.VELOCAST_TEST_GPU_COMPOSITOR_UNAVAILABLE==="1"&&!cpu){
    const app=require("electron/main").app,original=app.getGPUFeatureStatus.bind(app);
    app.getGPUFeatureStatus=()=>({...original(),gpu_compositing:"disabled_software"});
    if(app.getGPUFeatureStatus().gpu_compositing!=="disabled_software")throw Error("GPU status fixture did not install");
  }
  require(${JSON.stringify(realHost)});
}else if(process.env.VELOCAST_ELECTRON_SURFACE_MODE==="webcodecs"){
  fs.appendFileSync(attempts,JSON.stringify({mode:"webcodecs",cpu:false})+"\\n");
  process.stdout.write(JSON.stringify({event:"ready",version:3,pid:process.pid})+"\\n");
  const input=fs.createReadStream(null,{fd:0,autoClose:true});let pending="";
  input.on("data",data=>{pending+=data.toString();const end=pending.indexOf("\\n");if(end<0)return;
    const request=JSON.parse(pending.slice(0,end));process.stdout.write(JSON.stringify({id:request.id,ok:false,error:"capture.shared_texture_unavailable: acceptance fixture"})+"\\n");input.pause();});
  input.resume();
}else{throw new Error("unexpected surface mode");}
`,
  );
  const electronBinary =
    mediaOptions.electronBinary ??
    require(join(root, "packages/electron-host/node_modules/electron"));
  await command(
    renderer,
    [
      "--job-json",
      JSON.stringify({
        mode: "composition",
        composition_id: "static",
        serve_url: pathToFileURL(join(source, "index.html")).href,
        output: video,
        report_path: telemetry,
        codec: "h264",
        media_backend: "webcodecs",
        acceleration: "auto",
        pixel_format: "yuv420p",
        assembly: "reference",
        concurrency: 1,
      }),
    ],
    {
      environment: {
        ...env,
        VELOCAST_ELECTRON_BINARY: electronBinary,
        VELOCAST_ELECTRON_HOST_SCRIPT: wrapper,
        VELOCAST_TEST_FALLBACK_VIDEO: video,
        VELOCAST_TEST_BITMAP_MARKER: marker,
        VELOCAST_TEST_CPU_MARKER: cpuMarker,
        VELOCAST_TEST_ATTEMPTS: attempts,
      },
    },
  );
  if ((await readFile(marker, "utf8")) !== before)
    throw new Error("Previous output changed before bitmap retry started");
  const data = JSON.parse(await readFile(telemetry, "utf8"));
  assertWebCodecsTelemetry(data, "electron", 6);
  if (data.capture_backend !== "electron_bitmap")
    throw new Error(`Wrong bitmap fallback telemetry: ${JSON.stringify(data)}`);
  if (sha(await readFile(video)) === before)
    throw new Error("Bitmap fallback did not publish new output");
  await checkPixels(video, Array(6).fill(0), { exactStatic: true });
  return { captureBackend: data.capture_backend, frames: data.frames_encoded };
});
await gate("gpu-compositor-auto-falls-back-to-fresh-cpu-bitmap", async () => {
  const video = join(output, "cpu-bitmap-fallback.mp4"),
    marker = join(output, "bitmap-start-prior-output.sha256"),
    cpuMarker = join(output, "cpu-bitmap-start-prior-output.sha256"),
    attempts = join(output, "fallback-host-attempts.jsonl"),
    telemetry = join(output, "cpu-bitmap-fallback.json"),
    wrapper = join(output, "fallback-host.cjs");
  // Begin with a valid, visibly changing prior video. The CPU retry must
  // preserve it until publication, then replace it with the static scene.
  await cp(join(output, "range.mp4"), video);
  const before = sha(await readFile(video));
  const electronBinary =
    mediaOptions.electronBinary ??
    require(join(root, "packages/electron-host/node_modules/electron"));
  await writeFile(attempts, "");
  await command(
    renderer,
    [
      "--job-json",
      JSON.stringify({
        mode: "composition",
        composition_id: "static",
        serve_url: pathToFileURL(join(source, "index.html")).href,
        output: video,
        report_path: telemetry,
        codec: "h264",
        media_backend: "webcodecs",
        acceleration: "auto",
        pixel_format: "yuv420p",
        assembly: "reference",
        concurrency: 1,
      }),
    ],
    {
      environment: {
        ...env,
        VELOCAST_ELECTRON_BINARY: electronBinary,
        VELOCAST_ELECTRON_HOST_SCRIPT: wrapper,
        VELOCAST_TEST_GPU_COMPOSITOR_UNAVAILABLE: "1",
        VELOCAST_TEST_FALLBACK_VIDEO: video,
        VELOCAST_TEST_BITMAP_MARKER: marker,
        VELOCAST_TEST_CPU_MARKER: cpuMarker,
        VELOCAST_TEST_ATTEMPTS: attempts,
      },
    },
  );
  const observed = (await readFile(attempts, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  if (
    JSON.stringify(observed) !==
    JSON.stringify([
      { mode: "webcodecs", cpu: false },
      { mode: "bitmap", cpu: false },
      { mode: "bitmap", cpu: true },
    ])
  )
    throw new Error(`Wrong retry sequence: ${JSON.stringify(observed)}`);
  if (
    (await readFile(marker, "utf8")) !== before ||
    (await readFile(cpuMarker, "utf8")) !== before
  )
    throw new Error("Previous output changed before fresh CPU retry started");
  const data = JSON.parse(await readFile(telemetry, "utf8"));
  assertWebCodecsTelemetry(data, "electron", 6);
  if (
    !data.fallback_used ||
    !data.fallback_reason?.includes("capture.shared_texture_unavailable") ||
    !data.fallback_reason?.includes("capture.gpu_compositor_unavailable") ||
    data.capture_backend !== "electron_bitmap"
  )
    throw new Error(`Wrong CPU fallback telemetry: ${JSON.stringify(data)}`);
  if (sha(await readFile(video)) === before)
    throw new Error("CPU bitmap retry did not publish new output");
  await checkPixels(video, Array(6).fill(0), { exactStatic: true });
  return { captureBackend: data.capture_backend, frames: data.frames_encoded };
});
report.status = report.cases.every((entry) => entry.status === "passed")
  ? "passed"
  : "failed";
report.finishedAt = new Date().toISOString();
await persist();
process.exitCode = report.status === "passed" ? 0 : 1;
