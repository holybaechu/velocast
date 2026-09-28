"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createMediaSession } = require("../media-client.cjs");
function wave(data, rate, channels) {
  const bytes = Buffer.alloc(44 + data.length * 4);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(3, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * channels * 4, 28);
  bytes.writeUInt16LE(channels * 4, 32);
  bytes.writeUInt16LE(32, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(data.length * 4, 40);
  for (let i = 0; i < data.length; i++) bytes.writeFloatLE(data[i], 44 + i * 4);
  return bytes;
}
test(
  "real WebCodecs decode filters 96 kHz downsampling and preserves 44.1 kHz stereo timing",
  { timeout: 60000 },
  async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "velocast-resampler-real-"),
    );
    let session;
    try {
      const high = Float32Array.from({ length: 24000 }, (_, i) =>
        Math.sin((2 * Math.PI * 30000 * i) / 96000),
      );
      const highPath = path.join(root, "high.wav");
      await fs.writeFile(highPath, wave(high, 96000, 1));
      session = await createMediaSession({ timeoutMs: 30000 });
      const highOutput = path.join(root, "high.f32");
      await session.run({
        kind: "decode-audio",
        path: highPath,
        outputPath: highOutput,
        sampleRate: 48000,
        channels: 1,
        format: "f32",
      });
      const bytes = await fs.readFile(highOutput);
      assert.equal(bytes.length, 12000 * 4);
      let energy = 0;
      for (let i = 256; i < 11744; i++) energy += bytes.readFloatLE(i * 4) ** 2;
      const rms = Math.sqrt(energy / (11744 - 256));
      assert.ok(rms < 0.0001, `30 kHz aliases into output: RMS ${rms}`);
      const stereo = new Float32Array(11025 * 2);
      stereo[4410 * 2] = 1;
      stereo[6615 * 2 + 1] = 0.5;
      const stereoPath = path.join(root, "stereo.wav");
      await fs.writeFile(stereoPath, wave(stereo, 44100, 2));
      const stereoOutput = path.join(root, "stereo.f32");
      await session.run({
        kind: "decode-audio",
        path: stereoPath,
        outputPath: stereoOutput,
        sampleRate: 48000,
        channels: 2,
        format: "f32",
      });
      const converted = await fs.readFile(stereoOutput);
      assert.equal(converted.length, 12000 * 8);
      let left = 0,
        right = 0;
      for (let i = 0; i < 12000; i++) {
        if (converted.readFloatLE(i * 8) > converted.readFloatLE(left * 8))
          left = i;
        if (
          converted.readFloatLE(i * 8 + 4) >
          converted.readFloatLE(right * 8 + 4)
        )
          right = i;
      }
      assert.equal(left, 4800);
      assert.equal(right, 7200);
      assert.equal(converted.readFloatLE(left * 8 + 4), 0);
      assert.equal(converted.readFloatLE(right * 8), 0);
    } finally {
      await session?.close();
      const absolute = await fs.realpath(root);
      assert.equal(path.dirname(absolute), await fs.realpath(os.tmpdir()));
      assert.ok(path.basename(absolute).startsWith("velocast-resampler-real-"));
      await fs.rm(absolute, { recursive: true, force: true });
    }
  },
);
