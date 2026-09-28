// End-to-end authored source-video and audio check using generated media.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { deflateSync } from "node:zlib";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [rendererArgument, outputArgument] = process.argv.slice(2);
assert(rendererArgument && outputArgument,
  "Usage: node scripts/verify-footage-native.mjs RENDERER NEW-OUTPUT-DIRECTORY");
const renderer = resolve(rendererArgument), output = resolve(outputArgument);
const outputRelative = relative(root, output);
assert(outputRelative === ".." || outputRelative.startsWith(`..${sep}`) || isAbsolute(outputRelative),
  "Output directory must be outside the repository");
assert((await stat(renderer)).isFile(), `renderer missing: ${renderer}`);
await mkdir(output, { recursive: false });
assert.equal((await readdir(output)).length, 0);
const fixture = join(output, "fixture"), publicDir = join(fixture, "public");
await mkdir(publicDir, { recursive: true });
const require = createRequire(import.meta.url);
const { runMediaOperation } = require(join(root, "packages/electron-host/media-client.cjs"));
const media = (operation) => runMediaOperation(operation);
const width = 160, height = 90, sourceFrames = 8, durationFrames = 16, fps = 12;

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ -1) >>> 0;
}
function chunk(name, data) {
  const type = Buffer.from(name), size = Buffer.alloc(4), crc = Buffer.alloc(4);
  size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([size, type, data, crc]);
}
function png(color, frame) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const rows = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    for (let x = 0; x < width; x++) {
      const white = y < 15 && x >= 8 && x < 8 + 8 * 18 && (frame & (1 << Math.floor((x - 8) / 18)));
      const at = row + 1 + x * 3;
      for (let c = 0; c < 3; c++) rows[at + c] = white ? 255 : color[c];
    }
  }
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
const sourcePaths = [];
for (const [name, color] of [["red", [210, 30, 30]], ["blue", [30, 50, 210]]]) {
  const paths = [];
  for (let frame = 0; frame < sourceFrames; frame++) {
    const path = join(output, `${name}-${frame}.png`);
    await writeFile(path, png(color, frame)); paths.push(path);
  }
  const video = join(publicDir, `${name}.mp4`);
  await media({ kind: "encode-frames", framePaths: paths, width, height, fps: 6,
    bitrate: 500000, codec: "h264", outputPath: video });
  sourcePaths.push(video);
  for (const path of paths) await unlink(path);
}
const samples = Math.round(durationFrames / fps * 48000), tone = Buffer.alloc(44 + samples * 4);
tone.write("RIFF", 0); tone.writeUInt32LE(tone.length - 8, 4); tone.write("WAVEfmt ", 8);
tone.writeUInt32LE(16, 16); tone.writeUInt16LE(1, 20); tone.writeUInt16LE(2, 22);
tone.writeUInt32LE(48000, 24); tone.writeUInt32LE(192000, 28);
tone.writeUInt16LE(4, 32); tone.writeUInt16LE(16, 34);
tone.write("data", 36); tone.writeUInt32LE(samples * 4, 40);
for (let i = 0; i < samples; i++) {
  const sample = Math.round(32767 * 0.125 * Math.sin(2 * Math.PI * 440 * i / 48000));
  tone.writeInt16LE(sample, 44 + i * 4); tone.writeInt16LE(sample, 46 + i * 4);
}
await writeFile(join(publicDir, "tone.wav"), tone);
await writeFile(join(fixture, "index.html"),
  '<!doctype html><html><body><div id="composition"></div><script type="module" src="/scene.jsx"></script></body></html>');
await writeFile(join(fixture, "scene.jsx"), `import React from "react";
import { registerReactComposition, VideoClip, VideoFrameProvider, requestSnapshotVideoFrame } from "@velocast/react";
function Scene(){return <main style={{display:'flex',width:320,height:90}}><VideoClip src="red.mp4" muted={true} style={{width:160,height:90}}/><VideoClip src="blue.mp4" muted={true} style={{width:160,height:90}}/></main>}
registerReactComposition("footage-native",{component:()=> <VideoFrameProvider getFrame={requestSnapshotVideoFrame}><Scene/></VideoFrameProvider>,width:320,height:90,fps:${fps},durationFrames:${durationFrames},target:"#composition",audio:{sampleRate:48000,durationSamples:${samples},clips:[{source:"tone.wav",startSample:0,sourceStartSample:0,durationSamples:${samples},gain:0.2}]}});
`);
const cliRequire = createRequire(join(root, "packages/cli/package.json"));
const viteRequire = createRequire(cliRequire.resolve("vitest/package.json"));
const { build } = await import(pathToFileURL(viteRequire.resolve("vite")).href);
await build({ root: fixture, configFile: false, base: "./", resolve: { alias: {
  "@velocast/react": join(root, "packages/react/dist/index.js"),
  "@velocast/core": join(root, "packages/core/dist/index.js"),
  react: join(root, "packages/react/node_modules/react"),
  "react-dom": join(root, "packages/react/node_modules/react-dom"),
} }, build: { outDir: "dist", emptyOutDir: true } });
const config = join(fixture, "velocast.config.mjs");
await writeFile(config, `export default ${JSON.stringify({ entry:"dist/index.html", renderer:{ binary:renderer, snapshotRoot:"dist", codec:"h264", pixelFormat:"yuv420p", acceleration:"auto", concurrency:1, assembly:"reference" } })};\n`);
const video = join(output, "composed.mp4"), report = join(output, "report.json");
try {
  execFileSync(process.execPath, [join(root, "packages/cli/dist/bin.js"), "render", "footage-native", "--config", config,
    "--output", video, "--report", report, "--json"], { cwd: fixture, env: { ...process.env, VELOCAST_MEDIA_TRACE: join(output, "capture-pixels.jsonl") }, timeout: 300000, windowsHide: true, stdio: "pipe" });
} catch (error) {
  throw new Error(`native footage render failed: ${error.stderr?.toString() || error.message}`);
}
const probe = await media({ kind: "probe", path: video, frames: true });
assert.equal(probe.video?.frameCount, durationFrames);
assert.equal(probe.video?.width, 320); assert.equal(probe.video?.height, 90);
assert.equal(probe.audio?.sampleRate, 48000);
const telemetry = JSON.parse(await readFile(report, "utf8"));
assert.equal(telemetry.encoder_backend, "electron_native_h264");
assert.equal(telemetry.cpu_readback_frames, durationFrames);
assert.equal(telemetry.frames_encoded, durationFrames);
const checked = [];
for (const frame of [0, 1, 2, 5, 6, 13, 15]) {
  const raw = join(output, `decoded-${frame}.rgba`);
  await media({ kind: "frame", path: video, timestamp: frame / fps, outputPath: raw, format: "rgba" });
  const pixels = await readFile(raw); await unlink(raw);
  for (const [side, x, color] of [["red", 70, [210,30,30]], ["blue", 230, [30,50,210]]]) {
    const at = (50 * 320 + x) * 4;
    for (let c = 0; c < 3; c++) assert(Math.abs(pixels[at + c] - color[c]) < 35, `${side} frame ${frame}: decoded ${[...pixels.subarray(at, at + 3)]}, expected ${color}`);
    const origin = side === "red" ? 0 : 160;
    for (let bit = 0; bit < 3; bit++) {
      const marker = (8 * 320 + origin + 13 + bit * 18) * 4;
      const expected = (Math.floor(frame / 2) & (1 << bit)) ? [255,255,255] : color;
      for (let c = 0; c < 3; c++) assert(Math.abs(pixels[marker + c] - expected[c]) < 45,
        `${side} frame ${frame} source identity bit ${bit}`);
    }
  }
  checked.push(frame);
}
const pcmPath = join(output, "decoded-audio.f32");
await media({ kind: "decode-audio", path: video, outputPath: pcmPath, sampleRate: 48000, channels: 1, format: "f32" });
const pcm = await readFile(pcmPath); await unlink(pcmPath);
assert(Math.abs(pcm.length / 4 - samples) < 2048, "authored audio sample count");
let energy = 0;
for (let at = 0; at < pcm.length; at += 4) energy += pcm.readFloatLE(at) ** 2;
const rms = Math.sqrt(energy / (pcm.length / 4));
assert(rms > 0.008 && rms < 0.03, `authored audio RMS ${rms}`);
await writeFile(join(output, "verification.json"), `${JSON.stringify({status:"verified",sourceHashes:await Promise.all(sourcePaths.map(async path=>createHash("sha256").update(await readFile(path)).digest("hex"))),frames:durationFrames,checked,audioSamples:pcm.length/4,audioRms:rms},null,2)}\n`);
console.log(`FOOTAGE_NATIVE_VERIFIED: frames=${durationFrames} samples=${pcm.length/4}`);
