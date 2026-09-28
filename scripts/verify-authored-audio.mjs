import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [mode, binaryArgument, directoryArgument, secondsArgument = "3", fpsArgument = "60"] = process.argv.slice(2);
assert(["prepare", "run"].includes(mode) && binaryArgument && directoryArgument,
  "Usage: node scripts/verify-authored-audio.mjs prepare|run RENDERER OUTPUT_DIRECTORY [SECONDS=3] [FPS=60]");
const directory = resolve(directoryArgument), binary = resolve(binaryArgument);
const fixture = join(directory, "react"), dist = join(fixture, "dist");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const load = (path) => import(pathToFileURL(join(root, path)).href);
await mkdir(directory, { recursive: true });
const sampleRate = 48000, fps = Number(fpsArgument), seconds = Number(secondsArgument);
assert(Number.isSafeInteger(fps) && fps >= 1 && fps <= 60);
assert(Number.isSafeInteger(seconds) && seconds >= 3 && seconds <= 120);
const durationFrames = seconds * fps, durationSamples = sampleRate * seconds;
const channels = [new Float32Array(durationSamples), new Float32Array(durationSamples)];
let seed = 123456789;
for (let i = 0; i < durationSamples; i++) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const value = Math.fround(0.2 * Math.sin(i * 2 * Math.PI * 417 / sampleRate)
    + 0.07 * Math.sin(i * 2 * Math.PI * 1733 / sampleRate)
    + 0.03 * (seed / 0xffffffff - 0.5));
  channels[0][i] = channels[1][i] = i % 23999 === 0 ? 0.8 : value;
}
function interleave(pcm) {
  const bytes = Buffer.alloc(pcm.channels[0].length * 8);
  for (let i = 0; i < pcm.channels[0].length; i++)
    for (let c = 0; c < 2; c++) bytes.writeFloatLE(pcm.channels[c][i], i * 8 + c * 4);
  return bytes;
}
const sourcePcm = interleave({ channels });
const wav = Buffer.alloc(44 + sourcePcm.length);
wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(3, 20); wav.writeUInt16LE(2, 22);
wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 8, 28);
wav.writeUInt16LE(8, 32); wav.writeUInt16LE(32, 34); wav.write("data", 36);
wav.writeUInt32LE(sourcePcm.length, 40); sourcePcm.copy(wav, 44);
const plan = { sampleRate, durationSamples, clips: [
  { source: "tone.wav", startSample: -53, sourceStartSample: 101,
    durationSamples: durationSamples - 300, gain: 0.5,
    ...(process.argv.includes("--envelope") ? {volumeEnvelope:[
      {sample:0,gain:0},{sample:16384,gain:1},{sample:32768,gain:0.25},
      {sample:65536,gain:0.25},{sample:98304,gain:1},{sample:131072,gain:0},
    ]} : {}),
  },
] };

if (mode === "prepare") {
  await mkdir(join(fixture, "public"), { recursive: true });
  await writeFile(join(fixture, "public/tone.wav"), wav);
  await writeFile(join(fixture, "index.html"), '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}</style></head><body><script type="module" src="/scene.jsx"></script></body></html>');
  await writeFile(join(fixture, "scene.jsx"), `
import React from 'react';
import {registerReactComposition,useCurrentFrame} from '@velocast/react';
function Scene(){ const frame=useCurrentFrame();return <div style={{width:160,height:96,background:frame%2?'#345678':'#234567',color:'white'}}>Audio frame {frame}</div>; }
registerReactComposition('audio-hero',{width:160,height:96,fps:${fps},durationFrames:${durationFrames},component:Scene,defaultProps:{gain:0.5},audio:({inputProps})=>({...${JSON.stringify(plan)},clips:${JSON.stringify(plan.clips)}.map(c=>({...c,gain:inputProps.gain,source:inputProps.source??c.source}))})});
`);
  const cliRequire = createRequire(join(root, "packages/cli/package.json"));
  const require = createRequire(cliRequire.resolve("vitest/package.json"));
  const { build } = await import(pathToFileURL(require.resolve("vite")).href);
  await build({ root: fixture, configFile: false, base: "./", resolve: { alias: {
    "@velocast/react": join(root, "packages/react/dist/index.js"),
    "@velocast/core": join(root, "packages/core/dist/index.js"),
    react: join(root, "packages/react/node_modules/react"),
    "react-dom": join(root, "packages/react/node_modules/react-dom"),
  } }, build: { outDir: "dist", emptyOutDir: true } });
  await writeFile(join(directory, "prepared.json"), JSON.stringify({ binary, fixture, plan, sourceSha256: hash(wav) }, null, 2));
  console.log(`AUTHORED_AUDIO_PREPARED: ${directory}`);
  process.exit(0);
}

const { createInputSnapshot } = await load("packages/cli/dist/input-snapshot.js");
const { runRenderer } = await load("packages/cli/dist/renderer-process.js");
const { mixAudioPlanPcm } = await load("packages/cli/dist/audio-pcm-reference.js");
const { sliceAudioPlanByFrames } = await load("packages/core/dist/index.js");
const sources = new Map([["tone.wav", { sampleRate, channels }]]);
const reference = (selected) => interleave(mixAudioPlanPcm(selected, sources, 2));
let events = [];
try { events = JSON.parse(await readFile(join(directory, "command-executions.json"), "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const results = [];
await mkdir(join(directory, "cache"), { recursive: true });
const env = { ...process.env, TEMP: join(directory, "cache"), TMP: join(directory, "cache") };
async function render(name, snapshot, extra = {}, expectedFailure = false) {
  const output = join(directory, `${name}.mp4`);
  const job = { mode: "composition", composition_id: "audio-hero", serve_url: snapshot.url,
    render_session: snapshot.session, output, codec: "h264", acceleration: "off",
    concurrency: 1, assembly_mode: "reference", report_path: join(directory, `${name}.report.json`),
    result_path: join(directory, `${name}.result.json`), ...extra };
  const completed = events.findLast((event) => event.name === name && event.exitStatus === 0 && !event.error);
  if (completed && !expectedFailure) return { output: job.output, event: completed,
    report: JSON.parse(await readFile(job.report_path, "utf8")) };
  const event = { name, command: [binary, "--job-json", JSON.stringify(job)], cwd: root,
    startedAt: new Date().toISOString(), stdout: "", stderr: "" };
  try {
    await runRenderer(binary, job, { resolveProcessEnv: () => env, timeoutMs: seconds > 3 ? 300000 : 120000,
      spawnRenderer(executable, args, options) {
        event.command = [executable, ...args];
        const child = spawn(executable, args, { ...options, cwd: root });
        event.pid = child.pid;
        child.stdout.on("data", (bytes) => event.stdout += bytes);
        child.stderr.on("data", (bytes) => event.stderr += bytes);
        child.on("close", (code, signal) => { event.exitStatus = code; event.signal = signal; });
        return child;
      } });
  } catch (error) { event.error = String(error); }
  event.finishedAt = new Date().toISOString(); events.push(event);
  await writeFile(join(directory, "command-executions.json"), JSON.stringify(events, null, 2));
  assert.equal(Boolean(event.error), expectedFailure, `${name}: ${JSON.stringify(event)}`);
  return { output: job.output, event, report: expectedFailure ? null : JSON.parse(await readFile(job.report_path, "utf8")) };
}

await writeFile(join(dist, "tone.wav"), wav);
const snapshot = await createInputSnapshot({ root: dist, entryPath: "index.html" });
try {
  // Mutate the physical asset AFTER the snapshot has captured it. Both native
  // operations must still use the original frozen bytes, not this replacement.
  await writeFile(join(dist, "tone.wav"), Buffer.from("MUTATED AFTER FREEZE"));
  const full = await render("full", snapshot);
  const expectedFull = reference(plan);
  assert.equal(full.report.audio.pcm_sha256, hash(expectedFull));
  await writeFile(join(directory, "full.reference.f32"), expectedFull);
  results.push({ name: "full-frozen-asset", audio: full.report.audio, sourceVersion: snapshot.session.sourceVersion });
  const range = durationFrames === 180 ? { startFrame: 31, endFrame: 137 }
    : { startFrame: Math.floor(durationFrames * 0.2), endFrame: Math.floor(durationFrames * 0.8) };
  const slicedPlan = sliceAudioPlanByFrames(plan, range.startFrame, range.endFrame, fps, "round");
  const part = await render("range", snapshot, { output_range: range });
  const expectedPart = reference(slicedPlan);
  assert.equal(part.report.audio.pcm_sha256, hash(expectedPart));
  assert.equal(hash(expectedPart), hash(expectedFull.subarray(
    Math.round(range.startFrame * sampleRate / fps) * 8,
    Math.round(range.endFrame * sampleRate / fps) * 8)));
  await writeFile(join(directory, "range.reference.f32"), expectedPart);
  results.push({ name: "range-reference-and-full-slice", audio: part.report.audio });
  const priorHash = hash(await readFile(full.output));
  const propsPath = join(directory, "missing-source.json");
  await writeFile(propsPath, JSON.stringify({ source: "missing.wav" }));
  const failed = await render("missing-source", snapshot, { output: full.output, input_props_path: propsPath }, true);
  assert(failed.event.stderr.includes("audio.download_failed: expected HTTP 200"));
  assert.equal(hash(await readFile(full.output)), priorHash);
  results.push({ name: "download-404-preserves-prior-video", priorHash });
} finally {
  await snapshot.close();
  await writeFile(join(dist, "tone.wav"), wav);
  await writeFile(join(directory, "results.json"), JSON.stringify(results, null, 2));
}
const leftovers = await readdir(join(directory, ".velocast/tmp"));
assert.deepEqual(leftovers, []);
console.log(`AUTHORED_AUDIO_PASS: ${results.length} gates; exact full/range PCM; frozen source; prior output preserved`);
