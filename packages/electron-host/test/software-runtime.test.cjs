"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");
const { hostResponses } = require("./host-responses.cjs");
const { stopOwnedWindowsTree } = require("./owned-windows-tree.cjs");

async function joinHost(closed, timeoutMs) {
  let timer;
  try {
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Host close timeout")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Opt in: this launches real browsers sequentially. Repeated fresh processes
// catch compositor/load races that a warmed browser hides.
const repeats = Number(process.env.VELOCAST_ELECTRON_TEST_REPEATS || 25);
if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 100) {
  throw new Error("VELOCAST_ELECTRON_TEST_REPEATS must be an integer from 1 to 100");
}
test("real software host survives repeated fresh processes", {
  skip: !process.env.VELOCAST_ELECTRON_TEST_BINARY,
  timeout: 55_000,
}, async (suite) => {
  for (let iteration = 1; iteration <= repeats && !suite.signal.aborted; iteration++) {
    await suite.test(`captures exact frames and cleans leases (${iteration}/${repeats})`, { timeout: 30_000 }, async (t) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "velocast-host-runtime-"));
      const profileDirectory = path.join(directory, "profile");
      fs.mkdirSync(profileDirectory, { mode: 0o700 });
      const html = path.join(directory, "scene.html");
      fs.writeFileSync(html, '<style>html,body{margin:0;background:rgb(0,255,0)}#alpha{width:20px;height:20px;background:rgba(255,0,0,.5)}</style><div id="alpha"></div>');
      const env = { ...process.env, VELOCAST_ELECTRON_SURFACE_MODE: "software", VELOCAST_ELECTRON_FRAME_DIRECTORY: directory, VELOCAST_ELECTRON_PROFILE_DIRECTORY: profileDirectory };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(process.env.VELOCAST_ELECTRON_TEST_BINARY, [path.resolve(__dirname, "../main.cjs")], { env, detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      const closed = new Promise((resolve, reject) => {
        child.once("close", resolve);
        child.once("error", reject);
      });
      // Spawn errors are also reported by hostResponses; teardown observes this
      // rejection even when the handshake is the first failing assertion.
      void closed.catch(() => {});
      const responses = hostResponses(child);
      const next = () => responses.next();
      let sequence = 0;
      const request = async (command) => {
        child.stdin.write(`${JSON.stringify({ id: ++sequence, ...command })}\n`);
        const response = await next();
        assert.equal(response.id, sequence);
        assert.equal(response.ok, true, response.error);
        return response;
      };
      t.after(async () => {
        child.stdin.end();
        try {
          try {
            await joinHost(closed, 1000);
          } catch {
            if (process.platform === "win32") {
              await stopOwnedWindowsTree(child);
            } else {
              try { process.kill(-child.pid, "SIGKILL"); }
              catch (error) { if (error.code !== "ESRCH") throw error; }
            }
            await joinHost(closed, 5000);
          }
        } catch (error) {
          throw new Error("Host cleanup failed; owned scratch retained: " + directory, { cause: error });
        } finally {
          responses.close();
        }
        // Electron's process/pipe closure precedes delayed Windows profile-handle
        // release. Node's bounded native retries still fail persistent locks.
        await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        assert.equal(fs.existsSync(directory), false);
      });
      const ready = await next();
      assert.equal(ready.surfaceMode, "software");
      if (process.env.VELOCAST_CAPTURE_EXPECTATION === "unavailable") {
        child.stdin.write(`${JSON.stringify({ id: ++sequence, method: "load", url: pathToFileURL(html).href, width: 160, height: 100 })}\n`);
        let unavailable = await next();
        assert.equal(unavailable.id, sequence);
        if (unavailable.ok) {
          child.stdin.write(`${JSON.stringify({ id: ++sequence, method: "paint", generation: 0, copy: true })}\n`);
          unavailable = await next();
          assert.equal(unavailable.id, sequence);
        }
        assert.equal(unavailable.ok, false);
        assert.match(unavailable.error, /^capture\.(compositor_unavailable: (disabled_software|unavailable_software)|shared_texture_unavailable|shared_texture_timeout: .+)$/);
        assert.equal(fs.existsSync(path.join(directory, "frame.bgra")), false);
        await request({ method: "close" });
        return;
      }
      await request({ method: "load", url: pathToFileURL(html).href, width: 160, height: 100 });
      const capture = async (generation, width, height) => {
        const metadata = await request({ method: "paint", generation, copy: true });
        assert.equal(metadata.generation, generation);
        assert.equal(metadata.width, width);
        assert.equal(metadata.height, height);
        assert.equal(metadata.byteLength, width * height * 4);
        assert.equal(metadata.handle, undefined);
        assert.equal(metadata.textureId, undefined);
        assert.ok(JSON.stringify(metadata).length < 512);
        const pixels = fs.readFileSync(path.join(directory, "frame.bgra"));
        assert.equal(pixels.length, metadata.byteLength);
        await request({ method: "release", softwareFrameId: metadata.softwareFrameId });
        assert.equal(fs.existsSync(path.join(directory, "frame.bgra")), false);
        return pixels;
      };
      const first = await capture(1, 160, 100);
      assert.deepEqual([...first.subarray((50 * 160 + 50) * 4, (50 * 160 + 50) * 4 + 4)], [0, 255, 0, 255]);
      assert.deepEqual([...first.subarray(0, 4)], [0, 127, 128, 255]);
      assert.deepEqual(await capture(2, 160, 100), first);
      await request({ method: "execute", script: 'document.body.style.background="rgb(0,0,255)";document.documentElement.style.background="rgb(0,0,255)";' });
      const changed = await capture(3, 160, 100);
      assert.deepEqual([...changed.subarray((50 * 160 + 50) * 4, (50 * 160 + 50) * 4 + 4)], [255, 0, 0, 255]);
      const pngPath = path.join(directory, "changed.png");
      const png = await request({ method: "png", outputPath: pngPath, expectedWidth: 160, expectedHeight: 100 });
      const pngBytes = fs.readFileSync(pngPath);
      assert.equal(png.width, 160);
      assert.equal(png.height, 100);
      assert.equal(png.bytes, pngBytes.length);
      assert.equal(png.captureBackend, "electron_shared_texture");
      assert.equal(png.cpuReadback, true);
      assert.equal(pngBytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.equal(pngBytes.readUInt32BE(16), 160);
      assert.equal(pngBytes.readUInt32BE(20), 100);
      await request({ method: "resize", width: 192, height: 112 });
      assert.equal(fs.existsSync(path.join(directory, "frame.bgra")), false);
      const resized = await capture(4, 192, 112);
      assert.deepEqual([...resized.subarray((50 * 192 + 50) * 4, (50 * 192 + 50) * 4 + 4)], [255, 0, 0, 255]);
      // A valid black composition must be accepted, including unchanged repeats.
      await request({ method: "execute", script: 'document.body.innerHTML="";document.body.style.background="black";document.documentElement.style.background="black";' });
      const black = await capture(5, 192, 112);
      for (let pixel = 0; pixel < black.length; pixel += 4) {
        assert.deepEqual([...black.subarray(pixel, pixel + 4)], [0, 0, 0, 255]);
      }
      assert.deepEqual(await capture(6, 192, 112), black);
      // Reload at the same dimensions so stale pixels cannot hide behind geometry.
      await request({ method: "load", url: pathToFileURL(html).href, width: 192, height: 112 });
      const reloaded = await capture(7, 192, 112);
      assert.deepEqual([...reloaded.subarray((50 * 192 + 50) * 4, (50 * 192 + 50) * 4 + 4)], [0, 255, 0, 255]);
      assert.deepEqual([...reloaded.subarray(0, 4)], [0, 127, 128, 255]);
      // Every execute/capture pair must observe its own compositor result,
      // even when colors revisit older states or the requested frame is black.
      const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255], [0, 0, 0], [0, 255, 0]];
      for (const [index, [red, green, blue]] of colors.entries()) {
        await request({ method: "execute", script: `document.body.style.background="rgb(${red},${green},${blue})";document.documentElement.style.background="rgb(${red},${green},${blue})";` });
        const pixels = await capture(8 + index, 192, 112);
        assert.deepEqual([...pixels.subarray((50 * 192 + 50) * 4, (50 * 192 + 50) * 4 + 4)], [blue, green, red, 255]);
      }
      // Close while a file lease is held must remove it, just as error/EOF cleanup does.
      await request({ method: "paint", generation: 8 + colors.length, copy: true });
      await request({ method: "close" });
      child.stdin.end();
      await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once("exit", resolve));
      assert.equal(fs.existsSync(path.join(directory, "frame.bgra")), false);
      assert.equal(child.exitCode, 0, responses.stderr());
    });
  }
});
