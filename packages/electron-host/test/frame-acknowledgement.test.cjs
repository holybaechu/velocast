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
function fixture(
  t,
  { change = {}, transferFailure = false, pending = false } = {},
) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "velocast-frame-ack-"),
  );
  let host,
    released = 0,
    importedReleased = 0,
    options;
  const mainFrame = {};
  const contents = { mainFrame };
  const sharedTexture = {
    importSharedTexture(value) {
      options = value;
      return {
        release() {
          importedReleased++;
        },
      };
    },
    async sendSharedTexture(target, identity) {
      assert.equal(target.frame, mainFrame);
      if (transferFailure) throw new Error("transfer failed");
      if (!pending)
        host.onResult(
          { sender: contents, senderFrame: mainFrame },
          {
            id: identity.id,
            result: {
              ...identity,
              ...frameTiming(identity.index, 30),
              frames: identity.index + 1,
              encodedFrames: 0,
              ...change,
            },
          },
        );
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(
    `(function(require,module,__dirname){${fs.readFileSync(path.join(__dirname, "../webcodecs-host.cjs"), "utf8")}\n})`,
    { setTimeout, clearTimeout },
  )(
    (name) =>
      name === "electron/main"
        ? { ipcMain: { on() {}, off() {} }, sharedTexture }
        : hostRequire(name),
    module,
    __dirname,
  );
  host = new module.exports.WebCodecsHost(directory);
  host.config = {};
  host.settings = { fps: 30 };
  host.videoFile = path.join(directory, "partial.mp4");
  let destroyed = false;
  host.window = {
    webContents: contents,
    isDestroyed: () => destroyed,
    destroy() {
      destroyed = true;
    },
  };
  const texture = {
    textureInfo: {},
    release() {
      released++;
    },
  };
  t.after(async () => {
    await host.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    host,
    texture,
    released: () => released,
    importedReleased: () => importedReleased,
    releaseGpu: () => options.allReferencesReleased(),
    destroyed: () => destroyed,
  };
}

test("only the exact frame, token, sequence and timestamps acknowledge a GPU frame", async (t) => {
  for (const change of [
    { frame: 239 },
    { token: "stale" },
    { index: 1 },
    { timestamp: 1 },
  ]) {
    const f = fixture(t, { change });
    await assert.rejects(
      f.host.encode(f.texture, 0, 240, "seek-1"),
      /invalid.*acknowledgement/,
    );
    assert.equal(f.host.frames, 0);
    assert.equal(f.importedReleased(), 1);
    f.releaseGpu();
    assert.equal(f.released(), 1);
  }
});

test("OSR source stays alive until every GPU reference has been released", async (t) => {
  const f = fixture(t);
  await f.host.encode(f.texture, 0, 240, "seek-1");
  assert.equal(f.host.frames, 1);
  assert.equal(f.importedReleased(), 1);
  assert.equal(f.released(), 0);
  f.releaseGpu();
  assert.equal(f.released(), 1);
});

test("failed transfer rejects pending work and releases its import", async (t) => {
  const f = fixture(t, { transferFailure: true });
  await assert.rejects(
    f.host.encode(f.texture, 0, 240, "seek-1"),
    /transfer failed/,
  );
  assert.equal(f.host.pending, null);
  assert.equal(f.importedReleased(), 1);
  f.releaseGpu();
  assert.equal(f.released(), 1);
});

test("invalid submissions release the source without importing", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.host.encode(f.texture, 1, 240, "seek-1"),
    /invalid_sequence/,
  );
  assert.equal(f.released(), 1);
  assert.equal(f.importedReleased(), 0);
});

test("cancellation rejects an in-flight GPU submission and destroys its encoder", async (t) => {
  const f = fixture(t, { pending: true });
  const rejected = assert.rejects(
    f.host.encode(f.texture, 0, 240, "seek-1"),
    /webcodecs.closed/,
  );
  const disposed = f.host.dispose();
  f.releaseGpu();
  await disposed;
  await rejected;
  assert.equal(f.destroyed(), true);
  assert.equal(f.host.frames, 0);
  assert.equal(f.host.pending, null);
  assert.equal(f.importedReleased(), 1);
  assert.equal(f.released(), 1);
});
