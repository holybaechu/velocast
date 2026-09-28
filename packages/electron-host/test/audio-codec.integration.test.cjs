"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { createMediaSession } = require("../media-client.cjs");
const { wavHeader } = require("../media-runtime.cjs");
test(
  "real Opus MP4 encode preserves a 44.1 kHz authored timeline and stereo impulse alignment",
  { timeout: 30000 },
  async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "velocast-opus-test-"),
    );
    let session;
    try {
      const rate = 44100,
        frames = rate / 2,
        pcm = Buffer.alloc(frames * 2 * 4);
      pcm.writeFloatLE(0.8, 4410 * 8);
      pcm.writeFloatLE(0.6, 13230 * 8 + 4);
      const input = path.join(directory, "impulse.wav"),
        output = path.join(directory, "opus.mp4"),
        decoded = path.join(directory, "decoded.f32");
      fs.writeFileSync(input, Buffer.concat([wavHeader(frames, rate, 2), pcm]));
      session = await createMediaSession({ timeoutMs: 15000 });
      const result = await session.run({
        kind: "encode-audio",
        path: input,
        outputPath: output,
        audioCodec: "opus",
      });
      assert.equal(result.audio.codec, "opus");
      assert.equal(result.audio.sampleRate, 48000);
      assert.equal(result.audio.sourceSampleRate, 44100);
      assert.equal(result.audio.requestedCodec, "opus");
      assert.equal(result.audio.fallbackUsed, false);
      assert.ok(
        Math.abs(result.audio.duration - 0.5) <= 0.02 + 1 / 48000,
        `encoded duration ${result.audio.duration}`,
      );
      const audio = await session.run({
        kind: "decode-audio",
        path: output,
        outputPath: decoded,
        format: "f32",
        sampleRate: 48000,
        channels: 2,
        duration: 0.5,
      });
      assert.equal(audio.samples, 24000);
      const bytes = fs.readFileSync(decoded),
        peaks = [0, 0];
      for (let i = 0; i < 24000; i++)
        for (let channel = 0; channel < 2; channel++) {
          if (
            Math.abs(bytes.readFloatLE(i * 8 + channel * 4)) >
            Math.abs(bytes.readFloatLE(peaks[channel] * 8 + channel * 4))
          )
            peaks[channel] = i;
        }
      assert.ok(
        Math.abs(peaks[0] - 4800) <= 2,
        `left impulse shifted: ${peaks[0]}`,
      );
      assert.ok(
        Math.abs(peaks[1] - 14400) <= 2,
        `right impulse shifted: ${peaks[1]}`,
      );
      assert.ok(Math.abs(bytes.readFloatLE(peaks[0] * 8)) > 0.2);
      assert.ok(Math.abs(bytes.readFloatLE(peaks[1] * 8 + 4)) > 0.15);
    } finally {
      await session?.close();
      fs.rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 100,
      });
    }
  },
);
