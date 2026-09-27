import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [mode, binary, directory, legacyRenderer] = process.argv.slice(2);
if (!["prepare", "run"].includes(mode) || !binary || !directory)
  throw new Error(
    "Usage: node scripts/verify-public-output.mjs prepare|run RENDERER OUTPUT_DIRECTORY",
  );
const output = resolve(directory),
  renderer = resolve(binary),
  cli = join(root, "packages/cli/dist/bin.js");
await mkdir(output, { recursive: true });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

if (mode === "prepare") {
  const generic = join(output, "generic"),
    source = join(generic, "source");
  await mkdir(source, { recursive: true });
  await cp(join(root, "packages/core/dist"), join(source, "core"), {
    recursive: true,
  });
  await writeFile(
    join(source, "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}#scene{width:160px;height:96px;position:relative;color:white;font:16px monospace}#proof{position:absolute;bottom:0;height:12px;width:160px}</style></head><body><div id="scene"><span id="number"></span><div id="proof"></div></div><script type="module">
import {registerFrameAdapter} from './core/index.js';
const colors=['#101010','#202020','#303030','#404040','#505050','#606060','#707070','#808080','#909090','#a0a0a0','#b0b0b0','#c0c0c0'];
registerFrameAdapter('numbered',{id:'numbered',getDurationFrames:()=>12,
  async seekFrame(frame,context){
    if(context.inputProps?.failAt===frame)throw new Error('fixture.frame_failed');
    if(context.inputProps?.cancelAt===frame){
      setTimeout(()=>window.__velocastRenderer.cancel(),20);
      await new Promise((resolve,reject)=>context.signal.addEventListener('abort',()=>reject(context.signal.reason),{once:true}));
    }
    const root=document.getElementById('scene');root.style.background=colors[frame];
    document.getElementById('number').textContent=frame+' / '+context.durationFrames;
    document.getElementById('proof').style.background=context.durationFrames===12?'#00ff00':'#ff0000';
  }},{width:160,height:96,fps:6,target:'#scene',rootElement:'#scene'});
</script></body></html>`,
  );
  const config = {
    entry: "source/index.html",
    renderer: {
      binary: renderer,
      snapshotRoot: "source",
      acceleration: "off",
      concurrency: 1,
      assembly: "reference",
    },
  };
  await writeFile(
    join(generic, "velocast.config.mjs"),
    `export default ${JSON.stringify(config)};\n`,
  );
  await writeFile(join(generic, "fail.json"), JSON.stringify({ failAt: 3 }));
  await writeFile(
    join(generic, "cancel.json"),
    JSON.stringify({ cancelAt: 3 }),
  );
  const react = join(output, "react");
  const { createReactProject } = await import(
    pathToFileURL(join(root, "packages/cli/dist/init-command.js")).href
  );
  let existing;
  try {
    existing = JSON.parse(
      await readFile(join(react, "velocast-template.json"), "utf8"),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing) {
    if (
      existing.templateVersion !== 1 ||
      existing.compositionId !== "hello-react"
    )
      throw new Error("Existing React fixture has a different identity");
  } else await createReactProject(react, { cwd: root, env: {} });
  const cliRequire = createRequire(join(root, "packages/cli/package.json"));
  const require = createRequire(cliRequire.resolve("vitest/package.json"));
  const { build } = await import(pathToFileURL(require.resolve("vite")).href);
  await build({
    root: react,
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
  await writeFile(
    join(react, "velocast.config.mjs"),
    `export default ${JSON.stringify({ entry: "dist/index.html", renderer: { binary: renderer, snapshotRoot: "dist", acceleration: "off", concurrency: 1, assembly: "reference" } })};\n`,
  );
  await writeFile(
    join(output, "prepared.json"),
    JSON.stringify({ renderer, generic, react }, null, 2),
  );
  console.log(`PUBLIC_OUTPUT_PREPARED: ${output}`);
  process.exit(0);
}

const prepared = JSON.parse(
  await readFile(join(output, "prepared.json"), "utf8"),
);
let events = [];
try {
  events = JSON.parse(
    await readFile(join(output, "command-executions.json"), "utf8"),
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
async function command(name, args, cwd = output, expectedFailure = false) {
  const env = {
    ...process.env,
    INIT_CWD: cwd,
    TEMP: join(output, "cache"),
    TMP: join(output, "cache"),
  };
  await mkdir(env.TEMP, { recursive: true });
  const event = {
    name,
    attempt: events.filter((event) => event.name === name).length + 1,
    command: args,
    cwd,
    stdout: "",
    stderr: "",
    startedAt: new Date().toISOString(),
  };
  const child = spawn(args[0], args.slice(1), { cwd, env, windowsHide: true });
  child.stdout.on("data", (data) => (event.stdout += data));
  child.stderr.on("data", (data) => (event.stderr += data));
  const timeout = setTimeout(() => {
    event.timedOut = true;
    if (process.platform === "win32")
      spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
      });
    else child.kill("SIGKILL");
  }, 120_000);
  try {
    event.exitStatus = await new Promise((done, reject) => {
      child.on("error", reject);
      child.on("close", done);
    });
  } finally {
    clearTimeout(timeout);
  }
  events.push(event);
  await writeFile(
    join(output, "command-executions.json"),
    JSON.stringify(events, null, 2),
  );
  if (
    event.timedOut ||
    (expectedFailure ? event.exitStatus === 0 : event.exitStatus !== 0)
  )
    throw new Error(`${name} failed: ${JSON.stringify(event)}`);
  return event;
}
async function request(name, project, args, expectedFailure = false) {
  const event = await command(
    name,
    [
      process.execPath,
      cli,
      ...args,
      "--config",
      join(project, "velocast.config.mjs"),
      "--json",
    ],
    project,
    expectedFailure,
  );
  const result = JSON.parse(event.stdout);
  if (result.status !== (expectedFailure ? "failure" : "success"))
    throw new Error(`${name}: wrong status`);
  if (!result.renderSession?.sourceVersion || result.sourceMode !== "snapshot")
    throw new Error(`${name}: unpinned source`);
  return result;
}
async function rgba(name, video, width, height) {
  const path = join(output, `${name}.rgba`);
  await command(`decode-${name}`, [
    "ffmpeg",
    "-y",
    "-v",
    "error",
    "-i",
    video,
    "-fps_mode",
    "passthrough",
    "-pix_fmt",
    "rgba",
    "-f",
    "rawvideo",
    path,
  ]);
  const bytes = await readFile(path);
  if (bytes.length % (width * height * 4))
    throw new Error(`${name}: partial decoded frame`);
  return bytes;
}
function requireValue(value, message) {
  if (!value) throw new Error(message);
}

const generic = prepared.generic,
  react = prepared.react;
const listed = await request("list", generic, ["compositions"]);
requireValue(
  listed.compositions.some((c) => c.id === "numbered"),
  "missing composition",
);
const inspected = await request("inspect", generic, ["inspect", "numbered"]);
requireValue(
  inspected.composition.durationFrames === 12,
  "wrong original duration",
);
const png = join(output, "frame-3.png"),
  full = join(output, "full.mp4"),
  range = join(output, "range-3-7.mp4");
const frameResult = await request("frame", generic, [
  "frame",
  "numbered",
  "--frame",
  "3",
  "--output",
  png,
]);
await request("full", generic, ["render", "numbered", "--output", full]);
const rangeResult = await request("range", generic, [
  "render",
  "numbered",
  "--start-frame",
  "3",
  "--end-frame",
  "7",
  "--output",
  range,
]);
requireValue(
  rangeResult.composition.durationFrames === 12 &&
    rangeResult.request.range.startFrame === 3 &&
    rangeResult.request.range.endFrame === 7,
  "range lost original configuration",
);
requireValue(
  frameResult.renderSession.sourceVersion ===
    rangeResult.renderSession.sourceVersion,
  "unchanged input hash changed",
);
const image = await rgba("frame", png, 160, 96),
  whole = await rgba("full", full, 160, 96),
  part = await rgba("range", range, 160, 96),
  stride = 160 * 96 * 4;
requireValue(
  image.length === stride &&
    whole.length === 12 * stride &&
    part.length === 4 * stride,
  "wrong decoded frame count",
);
for (let frame = 0; frame < 4; frame++) {
  const point = frame * stride + (40 * 160 + 130) * 4;
  const expected = 16 * (frame + 4);
  requireValue(
    Math.abs(part[point] - expected) <= 3,
    `source frame mismatch at ${frame}`,
  );
  requireValue(
    part[frame * stride + (90 * 160 + 10) * 4 + 1] > 245,
    "composition duration changed during range",
  );
}
const pixel = (40 * 160 + 130) * 4;
requireValue(
  Math.abs(image[pixel] - whole[3 * stride + pixel]) <= 3 &&
    Math.abs(image[pixel] - part[pixel]) <= 3,
  "PNG/full/range first frame differs",
);
const probe = await command("range-pts", [
  "ffprobe",
  "-v",
  "error",
  "-select_streams",
  "v:0",
  "-show_entries",
  "stream=start_time,nb_frames,duration",
  "-of",
  "json",
  range,
]);
requireValue(
  Number(JSON.parse(probe.stdout).streams[0].start_time) === 0,
  "range PTS is not zero",
);
const original = hash(await readFile(png));
for (const [name, extra] of [
  ["invalid-frame", ["--frame", "12"]],
  [
    "frame-failure",
    ["--frame", "3", "--input-props-file", join(generic, "fail.json")],
  ],
  [
    "cancel",
    ["--frame", "3", "--input-props-file", join(generic, "cancel.json")],
  ],
]) {
  await request(
    name,
    generic,
    ["frame", "numbered", ...extra, "--output", png],
    true,
  );
  requireValue(
    hash(await readFile(png)) === original,
    `${name} replaced previous PNG`,
  );
}
const reactPng = join(output, "react-12.png"),
  reactRange = join(output, "react-12-18.mp4");
const reactZero = join(output, "react-0.png");
await request("react-frame-zero", react, [
  "frame",
  "hello-react",
  "--frame",
  "0",
  "--output",
  reactZero,
]);
await request("react-frame", react, [
  "frame",
  "hello-react",
  "--frame",
  "12",
  "--output",
  reactPng,
]);
requireValue(
  hash(await readFile(reactZero)) !== hash(await readFile(reactPng)),
  "React exact frames did not change",
);
const reactResult = await request("react-range", react, [
  "render",
  "hello-react",
  "--start-frame",
  "12",
  "--end-frame",
  "18",
  "--output",
  reactRange,
]);
requireValue(
  reactResult.composition.durationFrames === 90,
  "React duration was truncated",
);
const reactImage = await rgba("react-frame", reactPng, 640, 360),
  reactInitial = await rgba("react-zero", reactZero, 640, 360),
  reactVideo = await rgba("react-range", reactRange, 640, 360),
  reactStride = 640 * 360 * 4;
requireValue(
  reactImage.length === reactStride && reactVideo.length === 6 * reactStride,
  "React output frame count wrong",
);
let error = 0;
for (let i = 0; i < reactStride; i++)
  if (i % 4 !== 3) error += Math.abs(reactImage[i] - reactVideo[i]);
const mae = error / (640 * 360 * 3);
requireValue(mae < 4, `React PNG/range first frame MAE ${mae}`);
let changedPixels = 0,
  requestedError = 0,
  zeroError = 0;
for (let pixel = 0; pixel < reactStride; pixel += 4) {
  let change = 0;
  for (let channel = 0; channel < 3; channel++)
    change += Math.abs(
      reactImage[pixel + channel] - reactInitial[pixel + channel],
    );
  if (change <= 30) continue;
  changedPixels++;
  for (let channel = 0; channel < 3; channel++) {
    requestedError += Math.abs(
      reactImage[pixel + channel] - reactVideo[pixel + channel],
    );
    zeroError += Math.abs(
      reactInitial[pixel + channel] - reactVideo[pixel + channel],
    );
  }
}
requireValue(
  changedPixels > 10 && requestedError < zeroError / 2,
  "React range first frame resembles source zero instead of source twelve",
);
if (legacyRenderer) {
  const capabilities = await command("legacy-capabilities", [
    resolve(legacyRenderer),
    "--capabilities-json",
  ]);
  requireValue(
    JSON.parse(capabilities.stdout).outputApiVersion === undefined,
    "legacy fixture unexpectedly has new output API",
  );
  const config = join(generic, "legacy.config.mjs");
  await writeFile(
    config,
    `export default ${JSON.stringify({ entry: "source/index.html", renderer: { binary: resolve(legacyRenderer), snapshotRoot: "source", acceleration: "off" } })};\n`,
  );
  const event = await command(
    "legacy-frame-rejected",
    [
      process.execPath,
      cli,
      "frame",
      "numbered",
      "--frame",
      "3",
      "--output",
      png,
      "--config",
      config,
      "--json",
    ],
    generic,
    true,
  );
  requireValue(
    JSON.parse(event.stdout).error.code === "output.native_incompatible",
    "old native was not rejected explicitly",
  );
  requireValue(
    hash(await readFile(png)) === original,
    "old native request replaced prior output",
  );
}
const result = {
  status: "verified",
  renderer,
  rendererSha256: hash(await readFile(renderer)),
  generic: { frames: 12, range: [3, 7], frame: 3, failuresPreserved: 3 },
  react: {
    range: [12, 18],
    frame: 12,
    meanAbsoluteRgbError: mae,
    changedPixels,
    requestedFrameError: requestedError / (changedPixels * 3),
    wrongFrameZeroError: zeroError / (changedPixels * 3),
  },
  artifacts: { png, full, range, reactPng, reactRange },
};
await writeFile(
  join(output, "verification.json"),
  JSON.stringify(result, null, 2),
);
console.log(`PUBLIC_OUTPUT_VERIFIED: ${JSON.stringify(result)}`);
