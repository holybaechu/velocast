// Full CLI acceptance for native Mediabunny codecs, containers, ranges and assembly.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2)
  args.set(process.argv[i], process.argv[i + 1]);
if (!args.get("--renderer") || !args.get("--output"))
  throw new Error("Required: --renderer EXE --output NEW-TEMP-DIRECTORY");
const output = resolve(args.get("--output")),
  renderer = resolve(args.get("--renderer"));
const relativeOutput = relative(root, output);
if (
  !isAbsolute(relativeOutput) &&
  relativeOutput !== ".." &&
  !relativeOutput.startsWith(`..${sep}`)
)
  throw new Error("Output must be outside the repository");
await mkdir(output, { recursive: false });
const source = join(output, "source");
await mkdir(source);
await cp(join(root, "packages/core/dist"), join(source, "core"), {
  recursive: true,
});
const bundled = args.get("--bundled") === "true";
const runtimeRoot = dirname(renderer);
const runtime = bundled
  ? JSON.parse(
      await readFile(join(runtimeRoot, "electron-runtime.json"), "utf8"),
    )
  : null;
const requireHost = createRequire(
  join(
    bundled
      ? join(runtimeRoot, "electron-host")
      : join(root, "packages/electron-host"),
    "package.json",
  ),
);
const { wavHeader } = requireHost("./media-runtime.cjs");
const { createMediaSession } = requireHost("./media-client.cjs");
const samples = 24000,
  pcm = Buffer.alloc(samples * 4);
for (let i = 0; i < samples; i++)
  pcm.writeFloatLE(0.1 * Math.sin((2 * Math.PI * 440 * i) / 48000), i * 4);
await writeFile(
  join(source, "tone.wav"),
  Buffer.concat([wavHeader(samples, 48000, 1), pcm]),
);
await writeFile(
  join(source, "index.html"),
  `<!doctype html><html><style>html,body{margin:0}</style><canvas width="160" height="96"></canvas><script type="module">
import {registerFrameAdapter} from './core/index.js';
const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d',{alpha:false});
registerFrameAdapter('formats',{id:'formats',getDurationFrames:()=>6,seekFrame(frame){ctx.fillStyle=frame%2?'rgb(30,180,60)':'rgb(180,30,60)';ctx.fillRect(0,0,160,96)},getAudioPlan:()=>({sampleRate:48000,durationSamples:24000,clips:[{source:'tone.wav',startSample:0,sourceStartSample:0,durationSamples:24000,gain:1}]})},{width:160,height:96,fps:12,target:'canvas',rootElement:'canvas'});
</script></html>`,
);
const config = join(output, "velocast.config.mjs");
await writeFile(
  config,
  `export default ${JSON.stringify({ entry: "source/index.html", renderer: { snapshotRoot: "source", binary: renderer, mediaBackend: "native", acceleration: "off", concurrency: 1, assembly: "reference", bitrate: "2M" } })};\n`,
);
const execute = promisify(execFile);
const cli = async (file, codec, audioCodec, extra = []) => {
  const { stdout } = await execute(
    process.execPath,
    [
      join(root, "packages/cli/dist/bin.js"),
      "render",
      "formats",
      "--config",
      config,
      "--output",
      file,
      "--codec",
      codec,
      "--audio-codec",
      audioCodec,
      "--report",
      `${file}.json`,
      "--json",
      ...extra,
    ],
    {
      cwd: output,
      windowsHide: true,
      timeout: 180000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  assert.equal(JSON.parse(stdout).status, "success");
};
const results = [];
let media;
try {
  media = await createMediaSession({
    electronBinary: bundled
      ? resolve(runtimeRoot, runtime.electron)
      : requireHost("electron"),
    timeoutMs: 120000,
  });
  const verify = async (file, codec, audioCodec, frames, firstFrame = 0) => {
    const metadata = await media.run({
      kind: "probe",
      path: file,
      frames: true,
    });
    assert.equal(metadata.video.codec, codec === "h264" ? "avc" : codec);
    assert.equal(metadata.video.frameCount, frames);
    assert.equal(metadata.audio.codec, audioCodec);
    assert.ok(Math.abs(metadata.video.duration - frames / 12) < 0.01);
    assert.ok(Math.abs(metadata.video.firstTimestamp) < 0.000001);
    for (let frame = 0; frame < frames; frame++) {
      const decoded = `${file}.${frame}.rgba`;
      const timestamp =
        (metadata.video.frames[frame].pts * metadata.video.timeBase.numerator) /
        metadata.video.timeBase.denominator;
      // WebM/Matroska timestamps use millisecond ticks. Verify their actual PTS
      // and decode each encoded frame, including timestamps rounded upward.
      assert.ok(Math.abs(timestamp - frame / 12) < 0.001);
      await media.run({
        kind: "frame",
        path: file,
        timestamp,
        outputPath: decoded,
        format: "rgba",
      });
      const bytes = await readFile(decoded);
      assert.equal(bytes.length, 160 * 96 * 4);
      const expected = (firstFrame + frame) % 2 ? [30, 180, 60] : [180, 30, 60];
      expected.forEach((value, channel) =>
        assert.ok(
          Math.abs(bytes[(48 * 160 + 80) * 4 + channel] - value) < 25,
          `${codec} frame ${frame}: decoded ${[...bytes.subarray((48 * 160 + 80) * 4, (48 * 160 + 80) * 4 + 3)]}, expected ${expected}; channel ${channel}`,
        ),
      );
    }
    const decodedAudio = `${file}.f32`;
    await media.run({
      kind: "decode-audio",
      path: file,
      outputPath: decodedAudio,
      format: "f32",
      sampleRate: 48000,
      channels: 1,
    });
    const audio = await readFile(decodedAudio);
    assert.ok(Math.abs(audio.length / 4 - frames * 4000) <= 2048);
    let energy = 0;
    for (let i = 0; i < audio.length; i += 4)
      energy += audio.readFloatLE(i) ** 2;
    const rms = Math.sqrt(energy / (audio.length / 4));
    assert.ok(rms > 0.04 && rms < 0.1, `unexpected audio RMS ${rms}`);
    const telemetry = JSON.parse(await readFile(`${file}.json`, "utf8"));
    assert.equal(telemetry.frames_encoded, frames);
    assert.equal(telemetry.capture_backend, "electron_bitmap");
    assert.equal(telemetry.cpu_readback_frames, frames);
    assert.match(
      telemetry.encoder_backend,
      codec === "vp9" && process.platform === "win32" && process.arch === "x64"
        ? /webcodecs/
        : /native/,
    );
    results.push({ file, codec, audioCodec, frames, audioRms: rms });
    console.log(JSON.stringify(results.at(-1)));
  };
  for (const [codec, audioCodec, container] of [
    ["h264", "aac", "mp4"],
    ["vp9", "opus", "webm"],
    ["vp8", "vorbis", "webm"],
    ["av1", "mp3", "mkv"],
    ["hevc", "flac", "mkv"],
    ["prores", "pcm-s16", "mov"],
  ]) {
    const file = join(output, `${codec}.${container}`);
    await cli(file, codec, audioCodec, ["--media-backend", "auto"]);
    await verify(file, codec, audioCodec, 6);
  }
  const range = join(output, "range.webm");
  await cli(range, "vp9", "opus", [
    "--media-backend",
    "auto",
    "--start-frame",
    "1",
    "--end-frame",
    "4",
  ]);
  await verify(range, "vp9", "opus", 3, 1);
  const segments = join(output, "segments.mov");
  await cli(segments, "prores", "pcm-s16", [
    "--concurrency",
    "2",
    "--assembly",
    "segments",
  ]);
  await verify(segments, "prores", "pcm-s16", 6);
  const preserved = join(output, "invalid.webm");
  await writeFile(preserved, "previous output");
  await assert.rejects(cli(preserved, "h264", "aac"));
  assert.equal(await readFile(preserved, "utf8"), "previous output");
  results.push({
    case: "invalid-combination-preserves-output",
    status: "passed",
  });
} finally {
  await media?.close();
  await writeFile(
    join(output, "results.json"),
    `${JSON.stringify(results, null, 2)}\n`,
  );
}
