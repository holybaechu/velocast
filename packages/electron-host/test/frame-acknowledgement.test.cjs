"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const hostRequire = require("node:module").createRequire(
  path.resolve(__dirname, "../webcodecs-host.cjs"),
);
const { frameTiming } = require("../webcodecs-codec.cjs");

function fixture(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "velocast-frame-ack-"),
  );
  const module = { exports: {} };
  vm.runInNewContext(
    `(function(require,module,__dirname){${fs.readFileSync(path.join(__dirname, "../webcodecs-host.cjs"), "utf8")}\n})`,
    { setTimeout, clearTimeout },
  )(
    (name) =>
      name === "electron/main"
        ? { ipcMain: { on() {}, off() {} } }
        : hostRequire(name),
    module,
    __dirname,
  );
  const host = new module.exports.WebCodecsHost(directory);
  host.config = {};
  host.settings = { fps: 30 };
  host.videoFile = path.join(directory, "partial.mp4");
  t.after(async () => {
    await host.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return host;
}

test("only the exact frame, token, sequence and timestamps acknowledge a snapshot", async (t) => {
  for (const change of [
    { frame: 239 },
    { token: "stale" },
    { index: 1 },
    { timestamp: 1 },
  ]) {
    const host = fixture(t);
    host.command = async () => ({
      index: 0,
      ...frameTiming(0, 30),
      frames: 1,
      encodedFrames: 0,
      frame: 240,
      token: "seek-1",
      ...change,
    });
    await assert.rejects(
      host.encode(Buffer.from("png"), 0, 240, "seek-1"),
      /invalid.*acknowledgement/,
    );
    assert.equal(host.frames, 0);
  }
});

test("cancellation rejects an in-flight snapshot submission and destroys its encoder", async (t) => {
  const host = fixture(t);
  let destroyed = false;
  host.window = {
    webContents: { send() {} },
    isDestroyed: () => destroyed,
    destroy() {
      destroyed = true;
    },
  };
  const rejected = assert.rejects(
    host.encode(Buffer.from("png"), 0, 240, "seek-1"),
    /webcodecs.closed/,
  );
  await host.dispose();
  await rejected;
  assert.equal(destroyed, true);
  assert.equal(host.frames, 0);
  assert.equal(host.pending, null);
});
