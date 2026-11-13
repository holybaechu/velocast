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

const mode = "webcodecs";
for (const [width, height] of [
  [160, 100],
  [3840, 2160],
]) {
  test(
    `shared texture transactions encode changing and repeated frames through Mediabunny WebCodecs (${width}x${height})`,
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
        `<style>html,body{margin:0;background:lime}</style>
<script>
  window.captureInputEvents = [];
  for (const type of ['wheel', 'mousewheel', 'focus', 'blur', 'focusin', 'focusout'])
    window.addEventListener(type, (event) => captureInputEvents.push(event.type), true);
</script>`,
      );
      const env = {
        ...process.env,
        VELOCAST_ELECTRON_SURFACE_MODE: mode,
        VELOCAST_ELECTRON_FRAME_DIRECTORY: directory,
        VELOCAST_ELECTRON_PROFILE_DIRECTORY: profile,
      };
      delete env.ELECTRON_RUN_AS_NODE;
      const hostScript = path.resolve(__dirname, "../main.cjs");
      const child = spawn(
        process.env.VELOCAST_WEBCODECS_TEST_BINARY,
        [hostScript],
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
        // Exercise constructor clamping on displays smaller than the viewport.
        width: 4096,
        height: 2160,
      });
      await request({ method: "resize", width, height });
      await request({
        method: "execute",
        script: `window.__velocastRenderer = ${fs.readFileSync(
          path.resolve(
            __dirname,
            "../../../crates/renderer/browser/runtime.js",
          ),
          "utf8",
        )}`,
      });
      // Draw once before opening the encoder; later no-op seeks must retain the
      // initialized Canvas2D content as well as continuously changing scenes.
      await request({
        method: "execute",
        script: `const canvas=document.createElement('canvas');canvas.id='once';canvas.width=${width};canvas.height=${height};document.body.append(canvas);const ctx=canvas.getContext('2d');ctx.fillStyle='rgb(32,64,192)';ctx.fillRect(0,0,${width},${height})`,
      });
      const loadedInput = await request({
        method: "execute",
        token: "input-loaded",
        script:
          "window.__velocastRenderer.report('input-loaded', 'velocast-script-result:', () => ({events: [...captureInputEvents], focused: document.hasFocus()}))",
      });
      assert.deepEqual(JSON.parse(loadedInput.result), {
        events: [],
        focused: true,
      });
      await request({
        method: "execute",
        script:
          "const input=document.createElement('input');input.id='capture-focus';input.style.cssText='position:fixed;right:0;bottom:0;width:1px;height:1px';document.body.append(input);input.focus({preventScroll:true});captureInputEvents.length=0;",
      });
      const inputStateScript =
        "({events: [...captureInputEvents], focused: document.hasFocus(), active: document.activeElement.id, scrollX, scrollY})";
      async function inputState(token) {
        const response = await request({
          method: "execute",
          token,
          script: `window.__velocastRenderer.report('${token}', 'velocast-script-result:', () => ${inputStateScript})`,
        });
        return JSON.parse(response.result);
      }
      const initialInputState = await inputState("input-baseline");
      assert.equal(initialInputState.active, "capture-focus");
      assert.deepEqual(initialInputState.events, []);
      const audioRate = 44100;
      const audioSamples = audioRate / 5;
      const opened = await request({
        method: "webcodecs-open",
        settings: {
          mediaBackend: "webcodecs",
          hardwareAcceleration: "prefer-software",
          startFrame: 0,
          width,
          height,
          fps: 30,
          bitrate: 2_000_000,
          outputPath: path.join(directory, "video.mp4"),
        },
        audio: {
          codec: "opus",
          plan: {
            sampleRate: audioRate,
            durationSamples: audioSamples,
            clips: [],
          },
          sources: {},
        },
      });
      assert.equal(opened.config.hardwareAcceleration, "prefer-software");
      assert.equal(opened.config.cpuReadback, false);
      const colors = [
        [32, 64, 192],
        [32, 64, 192],
        [0, 255, 0],
        [255, 0, 0],
        [0, 0, 255],
        [0, 0, 255],
        [0, 0, 0],
        [0, 255, 0],
      ];
      for (const [index, color] of colors.entries()) {
        const token = `frame-${index}`;
        const seekScript =
          index < 2
            ? ""
            : `document.getElementById('once')?.remove();document.documentElement.style.background = document.body.style.background = 'rgb(${color.join(",")})';`;
        const frame = await request({
          method: "webcodecs-frame",
          index,
          frame: index,
          token,
          // Match production paint readiness before acknowledging the exact token.
          script: `window.__velocastRenderer.report('${token}', 'velocast-script-result:', () => window.__velocastRenderer.completeFrame(() => {${seekScript}}, undefined, true))`,
        });
        assert.equal(frame.frame, index);
        assert.equal(frame.token, token);
        assert.equal(frame.timestamp, Math.round((index * 1_000_000) / 30));
        assert.equal(frame.frames, index + 1);
        assert.equal(frame.handle, undefined);
        assert.equal(frame.width, width);
        assert.equal(frame.cpuReadback, false);
        assert.equal(frame.captureBackend, "electron_shared_texture");
        assert.deepEqual(
          await inputState(`input-after-${index}`),
          initialInputState,
          "compositor fences must preserve scene input, focus and scrolling",
        );
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
      assert.equal(finished.audio.codec, "opus");
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
        assert.equal(pixels.length, width * height * 4);
        const offset =
          (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
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
}
