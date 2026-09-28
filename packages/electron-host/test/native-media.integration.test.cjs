"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createMediaSession } = require("../media-client.cjs");
const { wavHeader } = require("../media-runtime.cjs");

test(
  "audio codec priming preserves stereo impulse positions",
  { skip: !process.env.VELOCAST_WEBCODECS_TEST_BINARY, timeout: 120000 },
  async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "velocast-codec-timing-"),
    );
    const session = await createMediaSession({
      electronBinary: process.env.VELOCAST_WEBCODECS_TEST_BINARY,
      timeoutMs: 30000,
    });
    try {
      const source = path.join(directory, "impulses.wav"),
        frames = 48000,
        peaks = [9600, 28800];
      const pcm = Buffer.alloc(frames * 8);
      pcm.writeFloatLE(0.8, peaks[0] * 8);
      pcm.writeFloatLE(0.7, peaks[1] * 8 + 4);
      fs.writeFileSync(
        source,
        Buffer.concat([wavHeader(frames, 48000, 2), pcm]),
      );
      for (const [codec, container] of [
        ["aac", "mp4"],
        ["opus", "webm"],
        ["mp3", "mkv"],
        ["flac", "mkv"],
        ["vorbis", "webm"],
        ["pcm-s16", "mov"],
        ["pcm-s24", "mov"],
        ["pcm-f32", "mov"],
      ]) {
        const encoded = path.join(directory, `${codec}.${container}`),
          decoded = path.join(directory, `${codec}.f32`);
        await session.run({
          kind: "encode-audio",
          mediaBackend: "native",
          path: source,
          outputPath: encoded,
          audioCodec: codec,
        });
        await session.run({
          kind: "decode-audio",
          path: encoded,
          outputPath: decoded,
          sampleRate: 48000,
          channels: 2,
          format: "f32",
        });
        const bytes = fs.readFileSync(decoded),
          actual = [0, 0];
        for (let i = 0; i < bytes.length / 8; i++)
          for (let channel = 0; channel < 2; channel++) {
            if (
              Math.abs(bytes.readFloatLE(i * 8 + channel * 4)) >
              Math.abs(bytes.readFloatLE(actual[channel] * 8 + channel * 4))
            )
              actual[channel] = i;
          }
        const tolerance = ["mkv", "webm"].includes(container) ? 48 : 2;
        actual.forEach((position, channel) =>
          assert.ok(
            Math.abs(position - peaks[channel]) <= tolerance,
            `${codec}/${container} impulse ${channel} shifted ${position - peaks[channel]} samples`,
          ),
        );
      }
    } finally {
      await session.close();
      fs.rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 100,
      });
    }
  },
);

test(
  "native video/audio codecs round-trip through real Electron and all containers",
  { skip: !process.env.VELOCAST_WEBCODECS_TEST_BINARY, timeout: 300000 },
  async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "velocast-native-test-"),
    );
    const session = await createMediaSession({
      electronBinary: process.env.VELOCAST_WEBCODECS_TEST_BINARY,
      timeoutMs: 120000,
    });
    try {
      const framePaths = ["red", "blue", "blue"].map((color, i) => {
        const file = path.join(directory, `${i}.bmp`);
        const bmp = Buffer.alloc(54 + 160 * 100 * 3);
        bmp.write("BM");
        bmp.writeUInt32LE(bmp.length, 2);
        bmp.writeUInt32LE(54, 10);
        bmp.writeUInt32LE(40, 14);
        bmp.writeInt32LE(160, 18);
        bmp.writeInt32LE(100, 22);
        bmp.writeUInt16LE(1, 26);
        bmp.writeUInt16LE(24, 28);
        for (let p = 54; p < bmp.length; p += 3)
          bmp[p + (color === "red" ? 2 : 0)] = 255;
        fs.writeFileSync(file, bmp);
        return file;
      });
      const source = path.join(directory, "source.wav");
      const pcm = Buffer.alloc(4800 * 4);
      for (let i = 0; i < 4800; i++)
        pcm.writeFloatLE(
          Math.sin((i * 2 * Math.PI * 440) / 48000) * 0.3,
          i * 4,
        );
      fs.writeFileSync(source, Buffer.concat([wavHeader(4800, 48000, 1), pcm]));
      for (const [codec, container, profile] of [
        ["h264", "mp4"],
        ["hevc", "mov"],
        ["av1", "mkv"],
        ["vp8", "webm"],
        ["vp9", "webm"],
        ["prores", "mov", "standard"],
        ["prores", "mov", "hq"],
      ]) {
        console.log(`native video ${codec}/${container}/${profile ?? "auto"}`);
        const outputPath = path.join(
          directory,
          `${codec}-${profile ?? "auto"}.${container}`,
        );
        const result = await session.run({
          kind: "encode-frames",
          mediaBackend: codec === "vp9" ? "auto" : "native",
          codec,
          container,
          videoProfile: profile,
          width: 160,
          height: 100,
          fps: 30,
          bitrate: 2000000,
          framePaths,
          outputPath,
        });
        console.log(`encoded ${codec}`);
        assert.equal(result.container, container);
        assert.equal(result.video.codec, codec === "h264" ? "avc" : codec);
        assert.equal(result.video.frameCount, 3);
        const hashes = await session.run({
          kind: "frame-hashes",
          path: outputPath,
        });
        console.log(`decoded ${codec}`);
        assert.equal(hashes.frameCount, 3);
        assert.notEqual(hashes.hashes[0], hashes.hashes[1]);
        assert.equal(hashes.hashes[1], hashes.hashes[2]);
        for (const [index, expected] of [
          [0, [255, 0, 0]],
          [1, [0, 0, 255]],
        ]) {
          const decoded = path.join(
            directory,
            `${codec}-${profile ?? "auto"}-${index}.rgba`,
          );
          await session.run({
            kind: "frame",
            path: outputPath,
            timestamp: index / 30 + 0.001,
            outputPath: decoded,
            format: "rgba",
          });
          const pixels = fs.readFileSync(decoded),
            offset = (50 * 160 + 80) * 4;
          expected.forEach((value, channel) =>
            assert.ok(
              Math.abs(pixels[offset + channel] - value) <= 16,
              `${codec} changed saturated color ${index}/${channel}: ${pixels[offset + channel]}`,
            ),
          );
        }
      }
      for (const codec of [
        "aac",
        "opus",
        "mp3",
        "flac",
        "vorbis",
        "pcm-s16",
        "pcm-s24",
        "pcm-f32",
      ]) {
        console.log(`native audio ${codec}`);
        const outputPath = path.join(directory, `audio-${codec}.mkv`);
        const result = await session.run({
          kind: "encode-audio",
          mediaBackend: "native",
          path: source,
          outputPath,
          audioCodec: codec,
        });
        assert.equal(result.audio.codec, codec);
        const decoded = path.join(directory, `${codec}.f32`);
        await session.run({
          kind: "decode-audio",
          path: outputPath,
          outputPath: decoded,
          sampleRate: 48000,
          channels: 1,
          format: "f32",
        });
        const decodedBytes = fs.readFileSync(decoded);
        assert.ok(
          decodedBytes.length >= (4800 - 48) * 4,
          `${codec} truncated the last audio packet`,
        );
        assert.ok(
          decodedBytes.length <= (4800 + 2048) * 4,
          `${codec} added excessive audio padding`,
        );
        let energy = 0;
        for (let i = 0; i < decodedBytes.length; i += 4)
          energy += decodedBytes.readFloatLE(i) ** 2;
        assert.ok(
          Math.sqrt(energy / (decodedBytes.length / 4)) > 0.1,
          `${codec} lost the audio signal`,
        );
      }
    } finally {
      await session.close();
      fs.rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 100,
      });
    }
  },
);
