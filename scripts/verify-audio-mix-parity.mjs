import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const supplied = process.argv.slice(2), flags = supplied.filter((value) => value.startsWith("--"));
const [mode, directoryArgument, dependencyProject, browserExecutable] = supplied.filter((value) => !value.startsWith("--"));
assert(["prepare", "run"].includes(mode) && directoryArgument,
  "Usage: node scripts/verify-audio-mix-parity.mjs prepare|run OUTPUT_DIRECTORY [REMOTION_PROJECT CHROME]");
const directory = resolve(directoryArgument), fixture = join(directory, "fixture"), sampleRate = 48_000;
const resume = flags.includes("--resume"), long = flags.includes("--long");
assert(flags.every((flag) => flag === "--resume" || flag === "--long"), "Only --resume and --long are supported");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function signal(kind, length) {
  return Float32Array.from({ length }, (_, i) => {
    if (kind === "voice") return Math.fround(0.42 * Math.sin(i * 2 * Math.PI * 431 / sampleRate) + (i % 997 === 0 ? 0.15 : 0));
    const frequency = kind === "music-left" ? 173 : 257;
    return Math.fround(0.18 * Math.sin(i * 2 * Math.PI * frequency / sampleRate) + 0.08 * Math.sin(i * 2 * Math.PI * (frequency + 71) / sampleRate));
  });
}
function wav(channels) {
  const body = Buffer.alloc(channels[0].length * channels.length * 4);
  for (let i = 0; i < channels[0].length; i++) for (let c = 0; c < channels.length; c++) body.writeFloatLE(channels[c][i], (i * channels.length + c) * 4);
  const result = Buffer.alloc(44 + body.length); result.write("RIFF"); result.writeUInt32LE(result.length - 8, 4); result.write("WAVEfmt ", 8);
  result.writeUInt32LE(16, 16); result.writeUInt16LE(3, 20); result.writeUInt16LE(channels.length, 22); result.writeUInt32LE(sampleRate, 24);
  result.writeUInt32LE(sampleRate * channels.length * 4, 28); result.writeUInt16LE(channels.length * 4, 32); result.writeUInt16LE(32, 34); result.write("data", 36); result.writeUInt32LE(body.length, 40); body.copy(result, 44); return result;
}
async function execute(name, file, args, binary = false) {
  const event = { name, command: [file, ...args], cwd: root, startedAt: new Date().toISOString(), stdout: binary ? undefined : "", stdoutBytes: 0, stderr: "" };
  const chunks = [], child = spawn(file, args, { cwd: root, windowsHide: true, env: process.env });
  child.stdout.on("data", (chunk) => { chunks.push(chunk); event.stdoutBytes += chunk.length; if (!binary) event.stdout += chunk; });
  child.stderr.on("data", (chunk) => event.stderr += chunk);
  await new Promise((done, reject) => { child.once("error", reject); child.once("close", (code, signal) => { event.exitStatus = code; event.signal = signal; done(); }); });
  event.finishedAt = new Date().toISOString(); let events = [];
  try { events = JSON.parse(await readFile(join(directory, "command-executions.json"), "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  events.push(event); await writeFile(join(directory, "command-executions.json"), JSON.stringify(events, null, 2));
  assert.equal(event.exitStatus, 0, `${name} failed: ${event.stderr}`); return Buffer.concat(chunks);
}
const totalSamples = long ? 5_760_000 : 24_000;
const voice = signal("voice", totalSamples + 1_000), musicLeft = signal("music-left", totalSamples + 1_000), musicRight = signal("music-right", totalSamples + 1_000);
const shared = Object.freeze({ sampleRate, durationSamples: totalSamples, clips: [
  { source: "voice.wav", startSample: -240, sourceStartSample: 360, durationSamples: totalSamples - 1_200, gain: 0.65 },
  { source: "music.wav", startSample: long ? 48_000 : 2_800, sourceStartSample: 250, durationSamples: totalSamples - (long ? 96_000 : 4_000), gain: 0.35 },
] });
const mono = Object.freeze({ sampleRate, durationSamples: 4_000, clips: [
  { source: "voice.wav", startSample: 400, sourceStartSample: 170, durationSamples: 3_200, gain: 0.7 },
] });
if (mode === "prepare") {
  let existing = [];
  try { existing = await readdir(directory); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing.length)
    throw new Error(`AUDIO_MIX_OUTPUT_DIRECTORY_NOT_EMPTY: use a new run directory; refusing to delete ${directory}`);
  await mkdir(fixture, { recursive: true });
  const voiceWav = wav([voice]), musicWav = wav([musicLeft, musicRight]);
  await writeFile(join(fixture, "voice.wav"), voiceWav); await writeFile(join(fixture, "music.wav"), musicWav);
  await writeFile(join(directory, "prepared.json"), JSON.stringify({ sampleRate, shared, mono, sources: { voiceSha256: hash(voiceWav), musicSha256: hash(musicWav) } }, null, 2));
  console.log(`AUDIO_MIX_MIX_PREPARED: ${directory}`); process.exit(0);
}
assert(dependencyProject && browserExecutable, "run requires REMOTION_PROJECT and CHROME");
for (const required of [
  "packages/core/dist/index.js",
  "packages/cli/dist/audio-plan-ffmpeg.js",
  "packages/cli/dist/audio-pcm-reference.js",
  "packages/preview/dist/web-audio-clock.js",
]) {
  try { await access(join(root, required)); }
  catch { throw new Error(`AUDIO_MIX_PREREQUISITE_MISSING: build ${required.split("/")[1]} before run (${required})`); }
}
const { buildAudioPlanFfmpegCommand } = await import(new URL("../packages/cli/dist/audio-plan-ffmpeg.js", import.meta.url));
const { mixAudioPlanPcm } = await import(new URL("../packages/cli/dist/audio-pcm-reference.js", import.meta.url));
const { sliceAudioPlan } = await import(new URL("../packages/core/dist/index.js", import.meta.url));
const absolute = (plan) => ({ ...plan, clips: plan.clips.map((clip) => ({ ...clip, source: join(fixture, clip.source) })) });
async function native(name, plan, channels) {
  const output = join(directory, `${name}.f32`), command = buildAudioPlanFfmpegCommand(absolute(plan), { outputPath: output, channelCount: channels, sourceChannelCounts: new Map([[join(fixture, "voice.wav"), 1], [join(fixture, "music.wav"), 2]]) });
  let bytes, reused = false;
  try { bytes = await readFile(output); reused = true; }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    await execute(name, "ffmpeg", command.args); bytes = await readFile(output);
  }
  if (reused) {
    if (!resume) throw new Error(`${name}: existing output requires --resume; refusing to overwrite evidence`);
    const events = JSON.parse(await readFile(join(directory, "command-executions.json"), "utf8"));
    assert(events.some((event) => event.name === name && event.exitStatus === 0), `${name}: --resume requires a recorded successful command`);
  }
  assert.equal(bytes.length, command.expectedBytes); return { output, bytes };
}
const monoNative = await native("native-mono-to-stereo", mono, 2);
const fullNative = await native("native-shared-full", shared, 2);
const rangeStart = long ? 1_152_000 : 4_000, rangeEnd = long ? 4_608_000 : 16_000;
const rangePlan = sliceAudioPlan(shared, rangeStart, rangeEnd), rangeNative = await native("native-shared-range", rangePlan, 2);
const sources = new Map([[join(fixture, "voice.wav"), { sampleRate, channels: [voice, voice] }], [join(fixture, "music.wav"), { sampleRate, channels: [musicLeft, musicRight] }]]);
const reference = mixAudioPlanPcm(absolute(shared), sources, 2);
const referenceBytes = Buffer.alloc(shared.durationSamples * 8); for (let i = 0; i < shared.durationSamples; i++) for (let c = 0; c < 2; c++) referenceBytes.writeFloatLE(reference.channels[c][i], (i * 2 + c) * 4);
await writeFile(join(directory, "reference-shared-stereo.f32"), referenceBytes);
function pcmError(actual, expected) { let max = 0, sum = 0; assert.equal(actual.length, expected.length); for (let offset = 0; offset < actual.length; offset += 4) { const difference = Math.abs(actual.readFloatLE(offset) - expected.readFloatLE(offset)); max = Math.max(max, difference); sum += difference; } return { max, mae: sum / (actual.length / 4) }; }
const require = createRequire(join(resolve(dependencyProject), "package.json")); const { openBrowser } = require("@remotion/renderer");
const server = createServer(async (request, response) => { try {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname === "/") { response.setHeader("content-type", "text/html"); response.end('<!doctype html><script type="importmap">{"imports":{"@velocast/core":"/core/index.js"}}</script>'); return; }
  const relative = pathname === "/clock.js" ? "packages/preview/dist/web-audio-clock.js" : /^\/core\/[a-zA-Z0-9_/-]+\.js$/.test(pathname) ? `packages/core/dist/${pathname.slice(6)}` : null;
  if (relative) { response.setHeader("content-type", "text/javascript"); response.end(await readFile(join(root, relative))); return; }
  if (pathname === "/native-mono.f32") { response.end(monoNative.bytes); return; } if (pathname === "/native-full.f32") { response.end(fullNative.bytes); return; }
  response.writeHead(404).end();
} catch { response.writeHead(500).end(); } });
await new Promise((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
let browser;
try {
  browser = await openBrowser("chrome", { browserExecutable: resolve(browserExecutable), logLevel: "error" }); const page = await browser.newPage(() => null, "error", false);
  await page.goto({ url: `http://127.0.0.1:${server.address().port}/`, timeout: 10_000 });
  const result = await page.evaluate(async ({ shared, mono, sampleRate }) => {
    const { prepareWebAudioClock } = await import("/clock.js");
    const signal = (kind, length) => Float32Array.from({length},(_,i)=>{if(kind==="voice")return Math.fround(.42*Math.sin(i*2*Math.PI*431/sampleRate)+(i%997===0?.15:0));const f=kind==="music-left"?173:257;return Math.fround(.18*Math.sin(i*2*Math.PI*f/sampleRate)+.08*Math.sin(i*2*Math.PI*(f+71)/sampleRate))});
    const voice=signal("voice",shared.durationSamples+1000), left=signal("music-left",shared.durationSamples+1000), right=signal("music-right",shared.durationSamples+1000);
    async function render(plan, path) { const offline=new OfflineAudioContext(2,plan.durationSamples,sampleRate); const context=new Proxy(offline,{get(t,p){if(p==="state")return"running";if(p==="resume"||p==="close")return async()=>{};const v=Reflect.get(t,p,t);return typeof v==="function"?v.bind(t):v}}); const clock=await prepareWebAudioClock(plan,{createContext:()=>context,loadBuffer:async(source)=>{const mono=source.endsWith("voice.wav"), b=offline.createBuffer(mono?1:2,mono?voice.length:left.length,sampleRate);b.copyToChannel(mono?voice:left,0);if(!mono)b.copyToChannel(right,1);return b}});await clock.play();const rendered=await offline.startRendering();await clock.dispose();const native=new Float32Array(await (await fetch(path)).arrayBuffer()),maxByChannel=[0,0],sumByChannel=[0,0];let first;for(let i=0;i<native.length;i++){const c=i%2,actual=rendered.getChannelData(c)[Math.floor(i/2)],d=Math.abs(actual-native[i]);if(!first&&d>1e-5)first={interleavedIndex:i,sample:Math.floor(i/2),channel:c,actual,native:native[i],difference:d};maxByChannel[c]=Math.max(maxByChannel[c],d);sumByChannel[c]+=d}const start=plan===mono?400:2800;return{max:Math.max(...maxByChannel),mae:(sumByChannel[0]+sumByChannel[1])/native.length,maxByChannel,maeByChannel:sumByChannel.map(v=>v/(native.length/2)),first,left:[...rendered.getChannelData(0).slice(start,start+16)],right:[...rendered.getChannelData(1).slice(start,start+16)],nativeLeft:Array.from({length:16},(_,i)=>native[(start+i)*2]),nativeRight:Array.from({length:16},(_,i)=>native[(start+i)*2+1])}; }
    return { mono:await render(mono,"/native-mono.f32"), shared:await render(shared,"/native-full.f32") };
  }, { shared: { ...shared, clips: shared.clips.map(c=>({...c,source:c.source})) }, mono: { ...mono, clips: mono.clips.map(c=>({...c,source:c.source})) }, sampleRate });
  const fullRange = fullNative.bytes.subarray(rangeStart * 8, rangeEnd * 8), rangeExact = fullRange.equals(rangeNative.bytes);
  const evidence = { status:"measured", shared, range:rangePlan, native:{ mono: { path: monoNative.output, sha256:hash(monoNative.bytes) }, full:{path:fullNative.output,sha256:hash(fullNative.bytes),referenceError:pcmError(fullNative.bytes,referenceBytes)}, range:{path:rangeNative.output,sha256:hash(rangeNative.bytes),fullRangeExact:rangeExact} }, browser:result, scope:"Actual FFmpeg PCM and OfflineAudioContext scheduling/rematrix measurement; no complete official CLI CEF composition/mux claim." };
  await writeFile(join(directory,"verification.json"),JSON.stringify(evidence,null,2));
  assert(result.mono.max <= 1e-6, `mono→stereo native/preview mismatch ${result.mono.max}`); assert(result.shared.max <= 1e-6, `shared native/preview mismatch ${result.shared.max}`); assert(rangeExact, "native full/range PCM differs");
  evidence.status="verified"; await writeFile(join(directory,"verification.json"),JSON.stringify(evidence,null,2)); console.log(`AUDIO_MIX_MIX_PASS: ${JSON.stringify({browser:result})}`);
} finally { await browser?.close(true,"error",false); await new Promise(done=>server.close(done)); }
