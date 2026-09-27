// Native Electron software/frame gates shared by Windows and hosted Unix CI.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertFrameOracle,
  COLORS,
  FRAME_STATES,
  HEIGHT,
  WIDTH,
  cancellationMarkerPath,
  firstRenderedFrame,
  splitRawFrames,
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
    "Required: --renderer EXE --output NEW-DIRECTORY [--frames 24] [--repeats 3] [--bundled true] [--encoder software|webcodecs]",
  );
const renderer = resolve(options.get("--renderer")),
  output = resolve(options.get("--output"));
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
const env = { ...process.env, VELOCAST_RENDERER_BINARY: renderer };
const encoder = options.get("--encoder") ?? "software";
if (!["software", "webcodecs"].includes(encoder))
  throw new Error("Unknown encoder");
const webcodecs = encoder === "webcodecs";
if (webcodecs) env.VELOCAST_EXPERIMENTAL_ENCODER = "webcodecs";
else delete env.VELOCAST_EXPERIMENTAL_ENCODER;
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
  { allowFailure = false, binaryOutput = false } = {},
) {
  const child = spawn(binary, args, {
    env,
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
  const child = spawn(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      path,
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
    { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  const errors = [];
  child.stderr.on("data", (chunk) => errors.push(chunk));
  const closed = new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", done);
  });
  const timer = setTimeout(() => child.kill(), 90_000);
  let count = 0,
    first;
  try {
    for await (const pixels of splitRawFrames(
      child.stdout,
      WIDTH * HEIGHT * 4,
    )) {
      if (count >= expected.length) throw new Error("Extra decoded frame");
      if (exactStatic) {
        first ??= Buffer.from(pixels);
        if (!first.equals(pixels))
          throw new Error("Static output changed between frames");
        for (const [channel, value] of COLORS[0].entries())
          if (Math.abs(pixels[(30 * WIDTH + 170) * 4 + channel] - value) > 25)
            throw new Error("Wrong static pixels");
      } else assertFrameOracle(pixels, [expected[count]], { states });
      count++;
    }
    if ((await closed) !== 0 || count !== expected.length)
      throw new Error(
        `Decoded ${count}/${expected.length}: ${Buffer.concat(errors).toString()}`,
      );
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
  }
  return count;
}
const config = join(fixture, "velocast.config.mjs");
await command("ffmpeg", [
  "-v",
  "error",
  "-y",
  "-f",
  "lavfi",
  "-i",
  `sine=frequency=440:sample_rate=48000:duration=${frames / 12}`,
  "-ac",
  "2",
  "-c:a",
  "pcm_s16le",
  join(source, "tone.wav"),
]);
await cp(join(root, "packages/core/dist"), join(source, "core"), {
  recursive: true,
});
await writeFile(
  config,
  `export default ${JSON.stringify({ entry: "source/index.html", renderer: { binary: renderer, snapshotRoot: "source", acceleration: webcodecs ? "auto" : "off", concurrency: 1, assembly: "reference", codec: "h264", pixelFormat: "yuv420p", bitrate: "8M" } })};\n`,
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
  const decoded = await command(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      video,
      "-map",
      "0:a:0",
      "-ac",
      "1",
      "-ar",
      "48000",
      "-f",
      "f32le",
      "pipe:1",
    ],
    { binaryOutput: true },
  );
  const pcm = decoded.stdout,
    samples = pcm.length / 4;
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
    if (
      data.capture_backend !==
        (webcodecs
          ? "electron_shared_texture_webcodecs"
          : "electron_software_bgra") ||
      data.frames_encoded !== frames
    )
      throw new Error(`Wrong ${encoder} telemetry: ${JSON.stringify(data)}`);
    if (
      webcodecs &&
      (data.webcodecs?.hardware_encoder_verified !== false ||
        data.webcodecs?.uncompressed_readback_verified !== false ||
        data.encoder_backend !== "electron_webcodecs_h264" ||
        data.fallback_used)
    ) {
      throw new Error(`Wrong experimental guarantees: ${JSON.stringify(data)}`);
    }
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
  await invoke(["render", "static", "--output", video]);
  await checkPixels(video, Array(6).fill(0), { exactStatic: true });
});
if (!webcodecs)
  await gate("two-worker-software", async () => {
    const video = join(output, "parallel.mp4");
    await invoke([
      "render",
      "portable",
      "--concurrency",
      "2",
      "--assembly",
      "auto",
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
if (webcodecs) {
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
          acceleration: "auto",
          pixel_format: "yuv420p",
          event_log_path: events,
        }),
      ],
      {
        env: {
          ...env,
          VELOCAST_ELECTRON_BINARY: require(
            join(root, "packages/electron-host/node_modules/electron"),
          ),
          VELOCAST_ELECTRON_HOST_SCRIPT: join(
            root,
            "packages/electron-host/main.cjs",
          ),
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
    ["--acceleration", "off"],
    ["--concurrency", "2"],
    ["--assembly", "segments"],
    ["--codec", "hevc"],
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
        !result.stdout.includes("webcodecs.") ||
        sha(await readFile(video)) !== before
      )
        throw new Error(
          "Unsupported WebCodecs request succeeded or changed prior output",
        );
    });
  }
}
if (!webcodecs && process.platform !== "win32") {
  await gate("automatic-software-fallback", async () => {
    const video = join(output, "automatic.mp4"),
      telemetry = join(output, "automatic.json");
    await invoke([
      "render",
      "portable",
      "--acceleration",
      "auto",
      "--pixel-format",
      "nv12",
      "--output",
      video,
      "--report",
      telemetry,
    ]);
    await checkPixels(
      video,
      states.map((_, frame) => frame),
    );
    const data = JSON.parse(await readFile(telemetry, "utf8"));
    if (
      data.capture_backend !== "electron_software_bgra" ||
      data.fallback_used !== true ||
      !data.fallback_reason?.includes("electron.gpu_capture_unsupported")
    )
      throw new Error(
        "Portable automatic capture did not report its software fallback",
      );
  });
  await gate("required-gpu-rejected", async () => {
    const video = join(output, "reference-1.mp4"),
      before = sha(await readFile(video));
    const result = await invoke(
      [
        "render",
        "portable",
        "--acceleration",
        "required",
        "--pixel-format",
        "nv12",
        "--output",
        video,
      ],
      { allowFailure: true },
    );
    if (
      result.code === 0 ||
      !result.stdout.includes("electron.gpu_capture_unsupported") ||
      sha(await readFile(video)) !== before
    )
      throw new Error("Required GPU mode silently fell back or changed output");
  });
}
report.status = report.cases.every((entry) => entry.status === "passed")
  ? "passed"
  : "failed";
report.finishedAt = new Date().toISOString();
await persist();
process.exitCode = report.status === "passed" ? 0 : 1;
