// Windows Electron GPU acceptance. Requires a built CLI/core, native renderer,
// FFmpeg/FFprobe and the Electron host. Never substitutes a CPU path.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertComparable,
  assertFrameOracle,
  assertGpuTelemetry,
  assertMediaTiming,
  cancellationMarkerPath,
  compareDecodedPixels,
  firstRenderedFrame,
  median,
  splitRawFrames,
  COLORS,
  FPS,
  FRAME_STATES,
  HEIGHT,
  WIDTH,
} from "./electron-renderer-oracle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = new Map();
const allowedOptions = new Set([
  "--renderer",
  "--output",
  "--profile",
  "--runs",
  "--segments",
  "--codec",
  "--bitrate",
  "--reference",
]);
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index],
    value = process.argv[index + 1];
  if (!key?.startsWith("--") || !value || value.startsWith("--"))
    throw new Error("Expected --key value arguments");
  if (!allowedOptions.has(key))
    throw new Error(`Unknown verification option: ${key}`);
  options.set(key, value);
}
const renderer = options.get("--renderer"),
  outputArg = options.get("--output");
if (!renderer || !outputArg || process.platform !== "win32")
  throw new Error(
    "Usage on Windows: node scripts/verify-electron-renderer.mjs --renderer C:\\path\\velocast-renderer.exe --output C:\\path\\results [--profile smoke|benchmark] [--runs 2] [--segments true] [--bitrate 12M]",
  );
const runs = Number(options.get("--runs") ?? 2);
if (!Number.isInteger(runs) || runs < 1 || runs > 10)
  throw new Error("--runs must be 1..10");
const profile = options.get("--profile") ?? "smoke";
if (!["smoke", "benchmark"].includes(profile))
  throw new Error("--profile must be smoke or benchmark");
const dimensions =
  profile === "benchmark"
    ? { width: 1920, height: 1080, fps: 60 }
    : { width: WIDTH, height: HEIGHT, fps: FPS };
const { width, height, fps } = dimensions;
const states =
  profile === "benchmark"
    ? Array.from(
        { length: 240 },
        (_, frame) => FRAME_STATES[frame % FRAME_STATES.length],
      )
    : FRAME_STATES;
const durationSeconds = states.length / fps,
  staticFrames = 6;
const segments = options.get("--segments") === "true";
const codec = options.get("--codec") ?? "h264",
  bitrate = options.get("--bitrate") ?? "12M";
if (codec !== "h264")
  throw new Error(
    "This initial color and frame oracle is validated for --codec h264 only",
  );
const output = resolve(outputArg),
  binary = resolve(renderer),
  cli = join(root, "packages/cli/dist/bin.js");
const fixture = join(output, "fixture"),
  source = join(fixture, "source"),
  reportFile = join(output, "comparison.json");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const results = {
  status: "running",
  scope:
    "Windows required-GPU H.264 acceptance; PNG/software paths have a separate portable gate",
  startedAt: new Date().toISOString(),
  settings: {
    profile,
    runs,
    segments,
    codec,
    bitrate,
    width,
    height,
    fps,
    frames: states.length,
    workers: 1,
    acceleration: "required",
    pixelFormat: "nv12",
    assembly: "reference",
  },
  environment: {},
  cases: [],
  failures: [],
};
await mkdir(source, { recursive: true });

async function command(
  args,
  { cwd = output, env = process.env, timeoutMs = 180_000 } = {},
) {
  const started = performance.now();
  const child = spawn(args[0], args.slice(1), { cwd, env, windowsHide: true });
  const stdout = [],
    stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
    });
  }, timeoutMs);
  let code;
  try {
    code = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", done);
    });
  } finally {
    clearTimeout(timer);
  }
  return {
    command: args,
    exitCode: code,
    timedOut,
    wallMs: Math.round(performance.now() - started),
    stdout: Buffer.concat(stdout).toString(),
    stderr: Buffer.concat(stderr).toString(),
  };
}
async function checked(args, settings) {
  const result = await command(args, settings);
  if (result.exitCode !== 0 || result.timedOut)
    throw new Error(
      `${args[0]} failed (${result.exitCode}, timeout=${result.timedOut}): ${result.stderr.slice(-3000)}`,
    );
  return result;
}
async function persist() {
  await writeFile(reportFile, JSON.stringify(results, null, 2));
}
function recordFailure(name, error) {
  results.failures.push({ name, error: String(error) });
}
async function independent(name, work) {
  try {
    return await work();
  } catch (error) {
    recordFailure(name, error);
    await persist();
    return null;
  }
}
const pause = (milliseconds) =>
  new Promise((done) => setTimeout(done, milliseconds));
async function version(exe, args = ["-version"]) {
  try {
    const r = await command([exe, ...args], { timeoutMs: 10_000 });
    return r.exitCode === 0
      ? r.stdout.split(/\r?\n/)[0]
      : r.stderr.slice(0, 200);
  } catch (error) {
    return String(error);
  }
}
async function probe(path) {
  const result = await checked([
    "ffprobe",
    "-v",
    "error",
    "-count_frames",
    "-show_entries",
    "stream=codec_type,codec_name,pix_fmt,color_range,color_space,width,height,nb_read_frames,sample_rate,channels,start_time,duration:format=duration",
    "-of",
    "json",
    path,
  ]);
  return JSON.parse(result.stdout);
}
// Raw decode needs byte-preserving collection, unlike command()'s text output.
async function decodeBytes(args) {
  const child = spawn("ffmpeg", args, { windowsHide: true });
  const chunks = [],
    errors = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  child.stderr.on("data", (chunk) => errors.push(chunk));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
    });
  }, 60_000);
  let code;
  try {
    code = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", done);
    });
  } finally {
    clearTimeout(timer);
  }
  if (code !== 0 || timedOut)
    throw new Error(
      `decode failed (${code}, timeout=${timedOut}): ${Buffer.concat(errors).toString()}`,
    );
  return Buffer.concat(chunks);
}
async function* decodedFrames(path) {
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
    { windowsHide: true },
  );
  const errors = [];
  child.stderr.on("data", (chunk) => errors.push(chunk));
  const finished = new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", done);
  });
  const timer = setTimeout(
    () =>
      spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
      }),
    profile === "benchmark" ? 300_000 : 60_000,
  );
  try {
    for await (const frame of splitRawFrames(child.stdout, width * height * 4))
      yield frame;
    const exitCode = await finished;
    if (exitCode !== 0)
      throw new Error(
        `video decode failed (${exitCode}): ${Buffer.concat(errors).toString()}`,
      );
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
  }
}
async function verifyVideo(path, expected) {
  let position = 0;
  for await (const pixels of decodedFrames(path)) {
    if (position >= expected.length)
      throw new Error(`decoded extra frame ${position}`);
    assertFrameOracle(pixels, [expected[position]], { width, height, states });
    position++;
  }
  if (position !== expected.length)
    throw new Error(`decoded ${position} frames; expected ${expected.length}`);
}
async function compareVideos(firstPath, secondPath) {
  const first = decodedFrames(firstPath)[Symbol.asyncIterator](),
    second = decodedFrames(secondPath)[Symbol.asyncIterator]();
  let frames = 0,
    totalMae = 0,
    largestError = 0,
    largestOutlierFraction = 0;
  try {
    while (true) {
      const [a, b] = await Promise.all([first.next(), second.next()]);
      if (a.done || b.done) {
        if (a.done !== b.done)
          throw new Error(`decoded paired frame count differs at ${frames}`);
        break;
      }
      const stats = compareDecodedPixels(a.value, b.value);
      totalMae += stats.mae;
      largestError = Math.max(largestError, stats.maximumError);
      largestOutlierFraction = Math.max(
        largestOutlierFraction,
        stats.outlierFraction,
      );
      frames++;
    }
  } finally {
    await Promise.all([first.return?.(), second.return?.()]);
  }
  return {
    frames,
    meanFrameMae: totalMae / frames,
    maximumError: largestError,
    maximumOutlierFraction: largestOutlierFraction,
  };
}
async function inspectAudio(path) {
  const pcm = await decodeBytes([
    "-v",
    "error",
    "-i",
    path,
    "-map",
    "0:a:0",
    "-ar",
    "48000",
    "-ac",
    "1",
    "-f",
    "s16le",
    "pipe:1",
  ]);
  if (pcm.length % 2) throw new Error(`odd audio PCM byte count ${pcm.length}`);
  const samples = pcm.length / 2;
  let energy = 0;
  for (let i = 0; i < pcm.length; i += 2) {
    const sample = pcm.readInt16LE(i);
    energy += sample * sample;
  }
  const rms = Math.sqrt(energy / samples);
  if (rms < 100) throw new Error(`audio appears silent: RMS ${rms}`);
  return { samples, rms };
}
async function nativeChildPid(cliPid) {
  const result = await command(
    [
      "powershell.exe",
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${cliPid}' | Where-Object { $_.Name -eq 'velocast-renderer.exe' } | Select-Object -ExpandProperty ProcessId`,
    ],
    { timeoutMs: 10_000 },
  );
  if (result.exitCode !== 0) return null;
  const pid = Number(result.stdout.trim().split(/\r?\n/)[0]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

try {
  await stat(binary);
  await stat(cli);
  await stat(join(root, "packages/core/dist/index.js"));
  const hostRequire = createRequire(
    join(root, "packages/electron-host/package.json"),
  );
  const electronBinary = resolve(
    process.env.VELOCAST_ELECTRON_BINARY?.trim() || hostRequire("electron"),
  );
  const electronHostScript = resolve(
    process.env.VELOCAST_ELECTRON_HOST_SCRIPT?.trim() ||
      join(root, "packages/electron-host/main.cjs"),
  );
  await stat(electronBinary);
  await stat(electronHostScript);
  const capabilitiesResult = await command([binary, "--capabilities-json"], {
    timeoutMs: 10_000,
  });
  let rendererCapabilities;
  try {
    rendererCapabilities =
      capabilitiesResult.exitCode === 0
        ? JSON.parse(capabilitiesResult.stdout)
        : null;
  } catch {
    rendererCapabilities = null;
  }
  const adaptersResult = await command(
    [
      "powershell.exe",
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,PNPDeviceID | ConvertTo-Json -Compress",
    ],
    { timeoutMs: 10_000 },
  );
  let gpuAdapters = null;
  try {
    gpuAdapters =
      adaptersResult.exitCode === 0
        ? [JSON.parse(adaptersResult.stdout)].flat()
        : null;
  } catch {
    gpuAdapters = null;
  }
  results.environment = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    gitRevision: (
      await checked(["git", "rev-parse", "HEAD"], { cwd: root })
    ).stdout.trim(),
    rendererSha256: sha(await readFile(binary)),
    rendererCapabilities,
    rendererCapabilitiesError: rendererCapabilities
      ? null
      : {
          exitCode: capabilitiesResult.exitCode,
          stderr: capabilitiesResult.stderr.slice(0, 500),
        },
    ffmpeg: await version("ffmpeg"),
    ffprobe: await version("ffprobe"),
    rustc: await version("rustc", ["--version"]),
    cargo: await version("cargo", ["--version"]),
    electronBinary,
    electronHostScript,
    electronVersion: hostRequire("electron/package.json").version,
    requestedElectronCaptureFps: hostRequire(
      "./capture-rate.cjs",
    ).resolveCaptureFrameRate(process.env.VELOCAST_ELECTRON_CAPTURE_FPS),
    gpuAdapters,
    gpuAdaptersError: gpuAdapters
      ? null
      : {
          exitCode: adaptersResult.exitCode,
          stderr: adaptersResult.stderr.slice(0, 500),
        },
  };
  await mkdir(join(source, "core"), { recursive: true });
  const { cp } = await import("node:fs/promises");
  await cp(join(root, "packages/core/dist"), join(source, "core"), {
    recursive: true,
  });
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:black}canvas{display:block}</style></head><body><canvas id="scene" width="${width}" height="${height}"></canvas><script type="module">
import {registerFrameAdapter} from './core/index.js';
const states=${JSON.stringify(states)},colors=${JSON.stringify(COLORS)};
const canvas=document.getElementById('scene'),g=canvas.getContext('2d',{alpha:false});
g.scale(${width / WIDTH},${height / HEIGHT});
registerFrameAdapter('electron-spike',{id:'electron-spike',getDurationFrames:()=>states.length,
getAudioPlan:()=>({sampleRate:48000,durationSamples:${durationSeconds * 48000},clips:[{source:'tone.wav',startSample:0,sourceStartSample:0,durationSamples:${durationSeconds * 48000},gain:0.2}]}),
async seekFrame(frame,context){if(context.inputProps?.failAt===frame)throw Error('fixture.intentional_failure');
const color=colors[states[frame]];g.fillStyle='rgb('+color.join(',')+')';g.fillRect(0,0,${WIDTH},${HEIGHT});
g.fillStyle='white';g.font='20px monospace';g.fillText('frame '+frame+' state '+states[frame],8,28);
for(let bit=0;bit<8;bit++){g.fillStyle=((frame>>bit)&1)?'#ffffff':'#000000';g.fillRect(8+bit*20,90,14,16);}
}}, {width:${width},height:${height},fps:${fps},target:'#scene',rootElement:'#scene'});
registerFrameAdapter('electron-static',{id:'electron-static',getDurationFrames:()=>6,
init(){g.fillStyle='rgb(32,64,192)';g.fillRect(0,0,${WIDTH},${HEIGHT});},
getAudioPlan:()=>({sampleRate:48000,durationSamples:${(staticFrames * 48000) / fps},clips:[{source:'tone.wav',startSample:0,sourceStartSample:0,durationSamples:${(staticFrames * 48000) / fps},gain:0.2}]}),
seekFrame(){/* Pixel-identical and no canvas mutation across every seek. */}
}, {width:${width},height:${height},fps:${fps},target:'#scene',rootElement:'#scene'});
</script></body></html>`;
  await writeFile(join(source, "index.html"), html);
  await writeFile(join(fixture, "fail.json"), JSON.stringify({ failAt: 7 }));
  await checked([
    "ffmpeg",
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:sample_rate=48000:duration=${durationSeconds}`,
    "-ac",
    "2",
    "-c:a",
    "pcm_s16le",
    join(source, "tone.wav"),
  ]);
  await writeFile(
    join(fixture, "velocast.config.mjs"),
    `export default ${JSON.stringify({ entry: "source/index.html", renderer: { binary, snapshotRoot: "source", acceleration: "required", concurrency: 1, assembly: "reference", codec, pixelFormat: "nv12", bitrate } })};\n`,
  );
  results.fixture = {
    htmlSha256: sha(await readFile(join(source, "index.html"))),
    toneSha256: sha(await readFile(join(source, "tone.wav"))),
  };
  await persist();
  const envFor = () => {
    const env = { ...process.env };
    env.VELOCAST_RENDERER_BINARY = binary;
    env.VELOCAST_ELECTRON_BINARY = electronBinary;
    env.VELOCAST_ELECTRON_HOST_SCRIPT = electronHostScript;
    delete env.VELOCAST_EXPERIMENTAL_BROWSER;
    delete env.VELOCAST_BROWSER;
    return env;
  };
  async function cancelAfterRenderedFrame(backend) {
    const name = `${backend}-cancel-preserves-output`;
    const previous = join(output, `${backend}-1.mp4`),
      before = sha(await readFile(previous));
    const events = join(output, `${name}-${Date.now()}.jsonl`);
    const args = [
      process.execPath,
      cli,
      "render",
      "electron-spike",
      "--config",
      join(fixture, "velocast.config.mjs"),
      "--output",
      previous,
      "--events",
      events,
      "--acceleration",
      "required",
      "--concurrency",
      "1",
      "--assembly",
      "reference",
      "--codec",
      codec,
      "--pixel-format",
      "nv12",
      "--bitrate",
      bitrate,
      "--json",
    ];
    const entry = { backend, name, events, status: "running" };
    results.cases.push(entry);
    await persist();
    const child = spawn(args[0], args.slice(1), {
      cwd: fixture,
      env: envFor(backend),
      windowsHide: true,
    });
    const stdout = [],
      stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    let finished = false,
      spawnError = null;
    const closed = new Promise((done) => {
      child.once("error", (error) => {
        spawnError = error;
        finished = true;
        done(null);
      });
      child.once("close", (code) => {
        finished = true;
        done(code);
      });
    });
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        if (child.pid)
          spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
            windowsHide: true,
          });
      },
      profile === "benchmark" ? 600_000 : 180_000,
    );
    try {
      let nativePid = null,
        observedFrame = null;
      const observationDeadline =
        Date.now() + (profile === "benchmark" ? 180_000 : 60_000);
      while (!finished && Date.now() < observationDeadline) {
        if (!nativePid && child.pid)
          nativePid = await nativeChildPid(child.pid);
        try {
          observedFrame = firstRenderedFrame(await readFile(events, "utf8"));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (nativePid && observedFrame !== null) break;
        await pause(40);
      }
      if (!nativePid || observedFrame === null || finished) {
        if (!finished) await closed;
        throw new Error(
          `${name}: native PID/frame event was not observed before completion${spawnError ? `: ${spawnError}` : ""}`,
        );
      }
      const marker = cancellationMarkerPath(events, nativePid);
      await writeFile(marker, "", { flag: "wx" });
      const exitCode = await closed;
      const preserved = before === sha(await readFile(previous));
      let result = null;
      try {
        result = JSON.parse(Buffer.concat(stdout).toString());
      } catch {}
      Object.assign(entry, {
        status:
          exitCode !== 0 &&
          !timedOut &&
          preserved &&
          result?.status === "failure" &&
          result.error?.code === "renderer.cancelled"
            ? "passed"
            : "failed",
        nativePid,
        observedFrame,
        marker,
        exitCode,
        timedOut,
        preserved,
        resultStatus: result?.status ?? null,
        errorCode: result?.error?.code ?? null,
        stderr: Buffer.concat(stderr).toString().slice(-1000),
      });
      await persist();
      if (entry.status !== "passed")
        throw new Error(
          `${name}: cancellation did not fail cooperatively while preserving the completed output`,
        );
      return entry;
    } catch (error) {
      entry.status = "failed";
      entry.error = String(error);
      await persist();
      throw error;
    } finally {
      if (!finished) await closed;
      clearTimeout(timer);
    }
  }
  const render = async (
    backend,
    name,
    extra = [],
    expected = states.map((_, i) => i),
  ) => {
    const file = join(output, `${name}.mp4`),
      telemetryFile = join(output, `${name}.telemetry.json`);
    const concurrencyIndex = extra.indexOf("--concurrency"),
      assemblyIndex = extra.indexOf("--assembly");
    const concurrency =
      concurrencyIndex < 0 ? "1" : extra[concurrencyIndex + 1];
    const assembly = assemblyIndex < 0 ? "reference" : extra[assemblyIndex + 1];
    const overridden = new Set([
      ...(concurrencyIndex < 0 ? [] : [concurrencyIndex, concurrencyIndex + 1]),
      ...(assemblyIndex < 0 ? [] : [assemblyIndex, assemblyIndex + 1]),
    ]);
    const remaining = extra.filter((_, index) => !overridden.has(index));
    const args = [
      process.execPath,
      cli,
      "render",
      "electron-spike",
      "--config",
      join(fixture, "velocast.config.mjs"),
      "--output",
      file,
      "--acceleration",
      "required",
      "--concurrency",
      concurrency,
      "--assembly",
      assembly,
      "--codec",
      codec,
      "--pixel-format",
      "nv12",
      "--bitrate",
      bitrate,
      "--report",
      telemetryFile,
      "--json",
      ...remaining,
    ];
    const execution = await command(args, {
      cwd: fixture,
      env: envFor(backend),
      timeoutMs: profile === "benchmark" ? 600_000 : 180_000,
    });
    const entry = {
      backend,
      name,
      args: extra,
      wallMs: execution.wallMs,
      exitCode: execution.exitCode,
      timedOut: execution.timedOut,
      stdout: execution.stdout.slice(-5000),
      stderr: execution.stderr.slice(-5000),
    };
    results.cases.push(entry);
    await persist();
    try {
      if (execution.exitCode !== 0 || execution.timedOut)
        throw new Error(
          `${name}: renderer failed: ${execution.stderr.slice(-1000)}`,
        );
      const metadata = JSON.parse(execution.stdout),
        telemetry = JSON.parse(await readFile(telemetryFile, "utf8"));
      if (
        metadata.status !== "success" ||
        metadata.sourceMode !== "snapshot" ||
        !metadata.renderSession?.sourceVersion
      )
        throw new Error(`${name}: unpinned or failed CLI result`);
      assertGpuTelemetry(telemetry, backend, expected.length);
      const media = await probe(file),
        video = media.streams.find((stream) => stream.codec_type === "video"),
        audio = media.streams.find((stream) => stream.codec_type === "audio");
      if (!video || !audio)
        throw new Error(`${name}: missing video/audio stream`);
      if (
        video.width !== width ||
        video.height !== height ||
        Number(video.nb_read_frames) !== expected.length
      )
        throw new Error(
          `${name}: wrong video dimensions/frame count: ${JSON.stringify(video)}`,
        );
      if (Number(audio.sample_rate) !== 48000)
        throw new Error(
          `${name}: wrong audio sample rate: ${JSON.stringify(audio)}`,
        );
      if (!video.color_range || !video.color_space)
        throw new Error(`${name}: missing video color range/matrix metadata`);
      await verifyVideo(file, expected);
      const audioSignal = await inspectAudio(file);
      assertMediaTiming(media, audioSignal.samples, expected.length, fps);
      Object.assign(entry, {
        status: "passed",
        sourceVersion: metadata.renderSession.sourceVersion,
        telemetry,
        ffprobe: media,
        audioSignal,
        codec_name: video.codec_name,
        pix_fmt: video.pix_fmt,
        color_range: video.color_range ?? null,
        color_space: video.color_space ?? null,
        width: video.width,
        height: video.height,
        sample_rate: audio.sample_rate,
        channels: audio.channels,
      });
      await persist();
      return entry;
    } catch (error) {
      entry.status = "failed";
      entry.error = String(error);
      await persist();
      throw error;
    }
  };
  const timings = [];
  let firstEntry;
  for (let index = 0; index < runs; index++) {
    const entry = await render("electron", `electron-${index + 1}`);
    timings.push(entry.wallMs);
    const reference =
      index === 0 ? options.get("--reference") : join(output, "electron-1.mp4");
    if (reference) {
      await independent(
        `electron-${index + 1}-decoded-comparison`,
        async () => {
          if (firstEntry) assertComparable(firstEntry, entry);
          const comparison = await compareVideos(
            resolve(reference),
            join(output, `electron-${index + 1}.mp4`),
          );
          results.cases.push({
            name: `electron-${index + 1}-decoded-comparison`,
            status: "passed",
            ...comparison,
          });
        },
      );
    }
    firstEntry ??= entry;
    await persist();
  }
  results.timingsMs = timings;
  results.referenceTiming = {
    electronMedianWallMs: median(timings),
    note: "End-to-end CLI wall time; native startup and frame wait subdivisions are in each telemetry report. One reference worker.",
  };
  const rangeStart = profile === "benchmark" ? 60 : 5,
    rangeEnd = profile === "benchmark" ? 120 : 12;
  const rangeExpected = Array.from(
    { length: rangeEnd - rangeStart },
    (_, index) => rangeStart + index,
  );
  for (const backend of ["electron"])
    await independent(`${backend}-range`, () =>
      render(
        backend,
        `${backend}-range`,
        ["--start-frame", String(rangeStart), "--end-frame", String(rangeEnd)],
        rangeExpected,
      ),
    );
  for (const backend of ["electron"]) {
    const name = `${backend}-exact-static`,
      file = join(output, `${name}.mp4`),
      telemetryFile = join(output, `${name}.telemetry.json`);
    const entry = { backend, name };
    results.cases.push(entry);
    await persist();
    try {
      const execution = await checked(
        [
          process.execPath,
          cli,
          "render",
          "electron-static",
          "--config",
          join(fixture, "velocast.config.mjs"),
          "--output",
          file,
          "--acceleration",
          "required",
          "--concurrency",
          "1",
          "--assembly",
          "reference",
          "--codec",
          codec,
          "--pixel-format",
          "nv12",
          "--bitrate",
          bitrate,
          "--report",
          telemetryFile,
          "--json",
        ],
        { cwd: fixture, env: envFor(backend) },
      );
      const result = JSON.parse(execution.stdout),
        telemetry = JSON.parse(await readFile(telemetryFile, "utf8"));
      if (
        result.status !== "success" ||
        result.sourceMode !== "snapshot" ||
        !result.renderSession?.sourceVersion
      )
        throw new Error(`${name}: unpinned or failed result`);
      assertGpuTelemetry(telemetry, backend, 6);
      const media = await probe(file),
        video = media.streams.find((stream) => stream.codec_type === "video");
      if (
        Number(video?.nb_read_frames) !== 6 ||
        video.width !== width ||
        video.height !== height
      )
        throw new Error(`${name}: wrong video stream`);
      if (!video.color_range || !video.color_space)
        throw new Error(`${name}: missing video color metadata`);
      const signal = await inspectAudio(file);
      assertMediaTiming(media, signal.samples, 6, fps);
      let first,
        count = 0;
      const perFrame = [];
      for await (const pixels of decodedFrames(file)) {
        if (!first) {
          first = pixels;
          const point =
            (Math.floor((30 * height) / HEIGHT) * width +
              Math.floor((170 * width) / WIDTH)) *
            4;
          if (Math.abs(first[point] - COLORS[0][0]) > 25)
            throw new Error(`${name}: static scene was not initialized`);
        } else
          perFrame.push(
            compareDecodedPixels(first, pixels, {
              maxMae: 4,
              maxOutlierFraction: 0.01,
            }),
          );
        count++;
      }
      if (count !== 6)
        throw new Error(`${name}: decoded ${count} static frames`);
      Object.assign(entry, {
        status: "passed",
        sourceVersion: result.renderSession.sourceVersion,
        telemetry,
        ffprobe: media,
        perFrame,
        wallMs: execution.wallMs,
      });
      await persist();
    } catch (error) {
      entry.status = "failed";
      entry.error = String(error);
      recordFailure(name, error);
      await persist();
    }
  }
  if (segments) {
    // Optional two-worker investigation; the reference cases above remain the gate.
    for (const backend of ["electron"]) {
      const entry = await independent(`${backend}-segments`, () =>
        render(backend, `${backend}-segments`, [
          "--assembly",
          "segments",
          "--concurrency",
          "2",
          "--verify-segments",
        ]),
      );
      if (entry)
        entry.segmentNote =
          "Two-worker report; compare separately from single-worker reference timing.";
    }
  }
  for (const backend of ["electron"]) {
    await independent(`${backend}-failure-preserves-output`, async () => {
      const previous = join(output, `${backend}-1.mp4`),
        before = sha(await readFile(previous));
      const failure = await command(
        [
          process.execPath,
          cli,
          "render",
          "electron-spike",
          "--config",
          join(fixture, "velocast.config.mjs"),
          "--output",
          previous,
          "--input-props-file",
          join(fixture, "fail.json"),
          "--acceleration",
          "required",
          "--concurrency",
          "1",
          "--assembly",
          "reference",
          "--codec",
          codec,
          "--pixel-format",
          "nv12",
          "--bitrate",
          bitrate,
          "--json",
        ],
        { cwd: fixture, env: envFor(backend) },
      );
      const preserved = before === sha(await readFile(previous));
      const entry = {
        backend,
        name: `${backend}-failure-preserves-output`,
        exitCode: failure.exitCode,
        timedOut: failure.timedOut,
        preserved,
        stderr: failure.stderr.slice(-1000),
        status:
          failure.exitCode !== 0 && !failure.timedOut && preserved
            ? "passed"
            : "failed",
      };
      results.cases.push(entry);
      await persist();
      if (entry.status !== "passed")
        throw new Error(
          `${entry.name}: intentional failure did not preserve completed video`,
        );
    });
  }
  for (const backend of ["electron"])
    await independent(`${backend}-cancel-preserves-output`, () =>
      cancelAfterRenderedFrame(backend),
    );
  results.status = results.failures.length ? "failed" : "passed";
  if (results.failures.length) {
    results.error = results.failures
      .map((item) => `${item.name}: ${item.error}`)
      .join("\n");
    process.exitCode = 1;
  }
} catch (error) {
  results.status = "failed";
  results.error = String(error?.stack ?? error);
  process.exitCode = 1;
} finally {
  results.finishedAt = new Date().toISOString();
  await persist();
  console.log(
    JSON.stringify(
      { status: results.status, report: reportFile, error: results.error },
      null,
      2,
    ),
  );
}
