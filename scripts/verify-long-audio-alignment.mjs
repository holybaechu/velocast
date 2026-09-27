import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [pcmDirectory, outputDirectory] = process.argv.slice(2);
assert(pcmDirectory && outputDirectory, "Usage: node scripts/verify-long-audio-alignment.mjs MIX_PCM_DIRECTORY OUTPUT_DIRECTORY");
const source = resolve(pcmDirectory), output = resolve(outputDirectory), events = [];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
try {
  if ((await readdir(output)).length)
    throw new Error(`AUDIO_ALIGNMENT_OUTPUT_DIRECTORY_NOT_EMPTY: refusing to overwrite ${output}`);
} catch (error) { if (error.code !== "ENOENT") throw error; }
await mkdir(output, { recursive: true });
async function run(name, file, args) {
  const event = { name, command: [file, ...args], cwd: root, stdout: "", stderr: "", startedAt: new Date().toISOString() };
  const child = spawn(file, args, { cwd: root, windowsHide: true });
  child.stdout.on("data", (data) => event.stdout += data); child.stderr.on("data", (data) => event.stderr += data);
  await new Promise((done) => { child.once("error", (error) => { event.spawnError = String(error); event.exitStatus = 1; done(); }); child.once("close", (code, signal) => { event.exitStatus = code; event.signal = signal; done(); }); });
  event.finishedAt = new Date().toISOString(); events.push(event); await writeFile(join(output, "command-executions.json"), JSON.stringify(events, null, 2));
  assert.equal(event.exitStatus, 0, `${name}: ${event.stderr}`); return event;
}
const cases = [{ name: "full", frames: 120 }, { name: "range", frames: 72 }];
const inputs = {};
for (const item of cases) {
  const pcm = join(source, `native-shared-${item.name}.f32`), expectedBytes = item.frames * 48_000 * 2 * 4;
  assert.equal((await stat(pcm)).size, expectedBytes, `${item.name}: exact PCM input length`);
  inputs[item.name] = { path: pcm, bytes: expectedBytes, sha256: hash(await readFile(pcm)) };
  await run(`encode-${item.name}`, "ffmpeg", ["-hide_banner", "-v", "error", "-n", "-f", "lavfi", "-i", "color=c=black:s=16x16:r=1", "-f", "f32le", "-ar", "48000", "-ac", "2", "-i", pcm, "-frames:v", String(item.frames), "-t", String(item.frames), "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", join(output, `${item.name}.mp4`)]);
  await writeFile(join(output, `${item.name}.result.json`), JSON.stringify({ composition: { fps: 1, durationFrames: item.frames } }));
  await writeFile(join(output, `${item.name}.reference.f32`), await readFile(join(source, `native-shared-${item.name}.f32`)));
}
await run("aac-alignment", "python", [join(root, "scripts", "verify-audio-alignment.py"), output]);
const alignment = JSON.parse(await readFile(join(output, "alignment-results.json"), "utf8"));
for (const item of cases) {
  const probe = JSON.parse((await run(`probe-${item.name}`, "ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=codec_type,nb_read_frames,duration,start_time", "-of", "json", join(output, `${item.name}.mp4`)])).stdout);
  const video = probe.streams.find((stream) => stream.codec_type === "video"), audio = probe.streams.find((stream) => stream.codec_type === "audio");
  assert.equal(Number(video.nb_read_frames), item.frames, `${item.name}: exact video frame count`);
  assert(Math.abs(Number(video.duration) - Number(audio.duration)) <= 1 / 48_000, `${item.name}: video/audio duration mismatch`);
}
await writeFile(join(output, "verification.json"), JSON.stringify({ status: "verified", inputs, scope: "Finite 1fps video muxed against pre-existing verified two-signal PCM; strict video frame count/duration plus decoded AAC start/middle/end alignment.", alignment }, null, 2));
console.log("AUDIO_ALIGNMENT_LONG_AAC_PASS");
