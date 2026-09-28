"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { hostResponses } = require("./host-responses.cjs");

for (const mode of ["webcodecs", "bitmap"])
  test(
    `${mode} captures encode changing and repeated frames through real WebCodecs`,
    {
      skip: !process.env.VELOCAST_WEBCODECS_TEST_BINARY,
      timeout: 60_000,
    },
    async (t) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "velocast-webcodecs-runtime-"),
      );
      const profile = path.join(directory, "profile");
      fs.mkdirSync(profile);
      const html = path.join(directory, "scene.html");
      fs.writeFileSync(
        html,
        "<style>html,body{margin:0;background:lime}</style>",
      );
      const env = {
        ...process.env,
        VELOCAST_ELECTRON_SURFACE_MODE: mode,
        VELOCAST_ELECTRON_FRAME_DIRECTORY: directory,
        VELOCAST_ELECTRON_PROFILE_DIRECTORY: profile,
      };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(
        process.env.VELOCAST_WEBCODECS_TEST_BINARY,
        [path.resolve(__dirname, "../main.cjs")],
        { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
      const responses = hostResponses(child);
      t.after(async () => {
        child.stdin.end();
        if (child.exitCode === null) {
          await Promise.race([
            new Promise((resolve) => child.once("exit", resolve)),
            new Promise((resolve) => setTimeout(resolve, 1000)),
          ]);
        }
        if (child.exitCode === null) {
          child.kill();
          await new Promise((resolve) => child.once("exit", resolve));
        }
        responses.close();
        fs.rmSync(directory, {
          recursive: true,
          force: true,
          maxRetries: 8,
          retryDelay: 100,
        });
      });
      let id = 0;
      const request = async (command) => {
        child.stdin.write(`${JSON.stringify({ id: ++id, ...command })}\n`);
        const result = await responses.next();
        assert.equal(result.id, id);
        assert.equal(result.ok, true, `${result.error}\n${responses.stderr()}`);
        return result;
      };
      assert.equal((await responses.next()).surfaceMode, mode);
      await request({
        method: "load",
        url: pathToFileURL(html).href,
        width: 160,
        height: 100,
      });
      const audioRate = mode === "bitmap" ? 44100 : 48000;
      const audioSamples = audioRate / 5;
      const opened = await request({
        method: "webcodecs-open",
        settings: {
          mediaBackend: "webcodecs",
          width: 160,
          height: 100,
          fps: 30,
          bitrate: 2_000_000,
          outputPath: path.join(directory, "video.mp4"),
        },
        audio: {
          codec: mode === "bitmap" ? "opus" : "auto",
          plan: {
            sampleRate: audioRate,
            durationSamples: audioSamples,
            clips: [],
          },
          sources: {},
        },
      });
      assert.equal(opened.config.hardwareAcceleration, "prefer-hardware");
      const colors = [
        [0, 255, 0],
        [255, 0, 0],
        [0, 0, 255],
        [0, 0, 255],
        [0, 0, 0],
        [0, 255, 0],
      ];
      for (const [index, color] of colors.entries()) {
        await request({
          method: "execute",
          script: `document.documentElement.style.background = document.body.style.background = 'rgb(${color.join(",")})'`,
        });
        const frame = await request({ method: "webcodecs-frame", index });
        assert.equal(frame.timestamp, Math.round((index * 1_000_000) / 30));
        assert.equal(frame.frames, index + 1);
        assert.equal(frame.handle, undefined);
        assert.equal(frame.width, 160);
        assert.equal(frame.cpuReadback, mode === "bitmap");
      }
      const finished = await request({ method: "webcodecs-finish" });
      assert.equal(finished.frames, colors.length);
      const ids = { bt709: 1, bt470bg: 5, smpte170m: 6, "iec61966-2-1": 13 };
      const color = finished.colorSpace;
      assert.ok(
        color &&
          [color.primaries, color.transfer, color.matrix].every(
            (value) => value in ids,
          ),
      );
      assert.equal(typeof color.fullRange, "boolean");
      assert.equal(finished.video.frameCount, colors.length);
      assert.equal(finished.audio.sampleRate, 48000);
      assert.equal(finished.audio.channels, 2);
      assert.equal(finished.audio.sourceSampleRate, audioRate);
      if (mode === "bitmap") assert.equal(finished.audio.codec, "opus");
      assert.equal(
        finished.audio.pcmSha256,
        createHash("sha256")
          .update(Buffer.alloc(audioSamples * 8))
          .digest("hex"),
      );
      assert.equal(finished.video.firstTimestamp, 0);
      assert.ok(Math.abs(finished.video.duration - colors.length / 30) < 1e-5);
      for (const [index, color] of colors.entries()) {
        const outputPath = path.join(directory, `${index}.rgba`);
        await request({
          method: "media-operation",
          operation: {
            kind: "frame",
            path: finished.path,
            timestamp: index / 30,
            outputPath,
            format: "rgba",
          },
        });
        const pixels = fs.readFileSync(outputPath);
        assert.equal(pixels.length, 160 * 100 * 4);
        const offset = (50 * 160 + 80) * 4;
        for (let channel = 0; channel < 3; channel++) {
          assert.ok(
            // The hardware H.264 path quantizes saturated primaries (blue 243
            // for source 255, confirmed with both Chromium and native decode).
            // Still reject the larger error from a wrong YUV color matrix.
            Math.abs(pixels[offset + channel] - color[channel]) <= 16,
            `frame ${index}: decoded ${[...pixels.subarray(offset, offset + 3)]}, expected ${color}`,
          );
        }
      }
      assert.equal(fs.existsSync(path.join(directory, "frame.bgra")), false);
      const concatenated = await request({
        method: "media-operation",
        operation: {
          kind: "concat",
          paths: [finished.path, finished.path],
          outputPath: path.join(directory, "concatenated.mp4"),
        },
      });
      assert.equal(concatenated.video.frameCount, colors.length * 2);
      assert.equal(concatenated.video.firstTimestamp, 0);
      assert.ok(
        Math.abs(concatenated.video.duration - (colors.length * 2) / 30) < 1e-5,
      );
      await request({ method: "close" });
    },
  );
