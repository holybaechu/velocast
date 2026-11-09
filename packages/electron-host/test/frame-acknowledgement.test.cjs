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

function fixture(t, api = {}) {
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
        ? {
            ipcMain: { on() {}, off() {} },
            sharedTexture: {
              importSharedTexture: ({ allReferencesReleased }) => ({
                release: allReferencesReleased,
              }),
              sendSharedTexture: async () => {},
              ...api,
            },
          }
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

test("native import/transfer failures return the source exactly once", async (t) => {
  for (const stage of ["import", "send", "release"]) {
    let released = 0;
    const host = fixture(t, {
      importSharedTexture({ allReferencesReleased }) {
        if (stage === "import") throw new Error("import failed");
        return { release: allReferencesReleased };
      },
      sendSharedTexture() {
        throw new Error("send failed");
      },
    });
    host.initialize = async () => {};
    host.window = {
      webContents: { mainFrame: {} },
      isDestroyed: () => false,
      destroy() {},
    };
    const texture = {
      release() {
        released++;
        if (stage === "release") throw new Error("release failed");
      },
    };
    await assert.rejects(
      host.transfer(texture, { method: "frame" }),
      /import failed|send failed/,
    );
    assert.equal(released, 1);
    assert.equal(host.nativeLeases.size, 0);
    assert.equal(host.pending, null);
    if (stage === "release")
      await assert.rejects(host.drainNativeLeases(), /native_release_failed/);
  }
});

test("native source remains owned until all GPU references release, with bounded in-flight leases", async (t) => {
  let allReleased,
    released = 0,
    importedReleases = 0;
  const host = fixture(t, {
    importSharedTexture(options) {
      allReleased = options.allReferencesReleased;
      return {
        release() {
          importedReleases++;
        },
      };
    },
    async sendSharedTexture() {
      host.pending.resolve({});
    },
  });
  host.initialize = async () => {};
  host.window = {
    webContents: { mainFrame: {} },
    isDestroyed: () => false,
    destroy() {},
  };
  await host.transfer(
    {
      release() {
        released++;
      },
    },
    { method: "frame" },
  );
  assert.equal(importedReleases, 1);
  assert.equal(released, 0);
  assert.equal(host.nativeLeases.size, 1);
  const drained = host.drainNativeLeases();
  allReleased();
  allReleased();
  await drained;
  assert.equal(released, 1);
  for (let i = 0; i < 8; i++) host.nativeLeases.add({});
  await assert.rejects(
    host.transfer(
      {
        release() {
          released++;
        },
      },
      { method: "frame" },
    ),
    /native_lease_limit/,
  );
  assert.equal(released, 2);
  host.nativeLeases.clear();
});

test("only the exact frame, token, sequence and timestamps acknowledge a snapshot", async (t) => {
  for (const change of [
    { frame: 239 },
    { token: "stale" },
    { index: 1 },
    { timestamp: 1 },
  ]) {
    const host = fixture(t);
    host.transfer = async () => ({
      index: 0,
      ...frameTiming(0, 30),
      frames: 1,
      encodedFrames: 0,
      frame: 240,
      token: "seek-1",
      ...change,
    });
    await assert.rejects(
      host.encode({ release() {} }, 0, 240, "seek-1"),
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
    host.encode({ release() {} }, 0, 240, "seek-1"),
    /webcodecs.closed/,
  );
  await new Promise(setImmediate);
  await host.dispose();
  await rejected;
  assert.equal(destroyed, true);
  assert.equal(host.frames, 0);
  assert.equal(host.pending, null);
});
