"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn, execFileSync } = require("node:child_process");
const { hostResponses } = require("./host-responses.cjs");

test(
  "shared textures encode exact changing and repeated frames through real WebCodecs",
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
      VELOCAST_ELECTRON_SURFACE_MODE: "webcodecs",
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
    assert.equal((await responses.next()).surfaceMode, "webcodecs");
    await request({
      method: "load",
      url: pathToFileURL(html).href,
      width: 160,
      height: 100,
    });
    const opened = await request({
      method: "webcodecs-open",
      settings: { width: 160, height: 100, fps: 30, bitrate: 2_000_000 },
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
    const tagged = path.join(directory, "tagged.mp4");
    execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-r",
        "30",
        "-i",
        path.join(directory, "webcodecs.h264"),
        "-c:v",
        "copy",
        "-bsf:v",
        `h264_metadata=colour_primaries=${ids[color.primaries]}:transfer_characteristics=${ids[color.transfer]}:matrix_coefficients=${ids[color.matrix]}:video_full_range_flag=${Number(color.fullRange)}`,
        tagged,
      ],
      { windowsHide: true, timeout: 15_000 },
    );
    const pixels = execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        tagged,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      { windowsHide: true, timeout: 15_000 },
    );
    assert.equal(pixels.length, colors.length * 160 * 100 * 3);
    for (const [index, color] of colors.entries()) {
      const offset = (index * 160 * 100 + 50 * 160 + 80) * 3;
      for (let channel = 0; channel < 3; channel++) {
        assert.ok(
          Math.abs(pixels[offset + channel] - color[channel]) < 12,
          `frame ${index}: decoded ${[...pixels.subarray(offset, offset + 3)]}, expected ${color}`,
        );
      }
    }
    assert.equal(fs.existsSync(path.join(directory, "frame.bgra")), false);
    await request({ method: "close" });
  },
);
