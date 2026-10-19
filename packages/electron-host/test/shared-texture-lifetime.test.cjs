"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { frameTiming } = require("../webcodecs-codec.cjs");
function fixture({ importFails = false, transferFails = false } = {}) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "velocast-texture-lease-"),
  );
  const releases = [];
  let host,
    sourceReleases = 0,
    importReleases = 0;
  const module = { exports: {} };
  const dependencies = {
    "electron/main": {
      ipcMain: { on() {}, off() {} },
      sharedTexture: {
        importSharedTexture({ allReferencesReleased }) {
          if (importFails) throw new Error("import failed");
          releases.push(allReferencesReleased);
          return {
            release() {
              importReleases++;
            },
          };
        },
        async sendSharedTexture(_texture, { index }) {
          if (transferFails) throw new Error("transfer failed");
          host.pending.resolve({
            index,
            ...frameTiming(index, 30),
            frames: index + 1,
            encodedFrames: 0,
          });
        },
      },
    },
    "./media-io.cjs": { absolute: (value) => value },
    "./media-settings.cjs": {},
    "./webcodecs-codec.cjs": { frameTiming },
  };
  vm.runInNewContext(
    `(function(require,module,__dirname){${fs.readFileSync(path.join(__dirname, "../webcodecs-host.cjs"), "utf8")}\n})`,
    { setTimeout, clearTimeout },
  )((name) => dependencies[name] ?? require(name), module, __dirname);
  host = new module.exports.WebCodecsHost(directory);
  host.config = { backend: "webcodecs", pixelFormat: "yuv420p" };
  host.settings = { fps: 30, width: 160, height: 100 };
  host.window = {
    webContents: { mainFrame: {} },
    isDestroyed: () => false,
    destroy() {},
  };
  host.videoFile = path.join(directory, "never-created.mp4");
  return {
    host,
    releases,
    texture: () => ({
      textureInfo: {},
      release() {
        sourceReleases++;
      },
    }),
    counts: () => ({ sourceReleases, importReleases }),
    async close() {
      await host.dispose();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}
test("submission permits buffered textures, bounds leases, and drains before final releases", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 32; i++) await f.host.encode(f.texture(), i);
    assert.equal(f.host.leases.size, 32);
    assert.equal(f.counts().sourceReleases, 0);
    let accepted = false;
    const next = f.host.encode(f.texture(), 32).then(() => {
      accepted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(accepted, false);
    f.releases.shift()();
    await next;
    assert.equal(f.host.peakTextureLeases, 32);
    f.host.command = async (method) => {
      assert.equal(method, "finish");
      assert.equal(f.host.leases.size, 32);
      for (const release of f.releases.splice(0)) release();
      return { frames: 33, video: { frameCount: 33, width: 160, height: 100 } };
    };
    const result = await f.host.finish();
    assert.equal(result.outstandingTextureLeases, 0);
    assert.equal(f.counts().sourceReleases, 33);
    assert.equal(f.counts().importReleases, 33);
  } finally {
    await f.close();
  }
});
for (const kind of ["import", "transfer"])
  test(`${kind} failure releases owned handles without waiting for an encode reply`, async () => {
    const f = fixture({
      importFails: kind === "import",
      transferFails: kind === "transfer",
    });
    try {
      await assert.rejects(
        f.host.encode(f.texture(), 0),
        /shared_texture_unavailable/,
      );
      if (kind === "transfer")
        for (const release of f.releases.splice(0)) release();
      assert.equal(f.counts().sourceReleases, 1);
      assert.equal(f.host.frames, 0);
    } finally {
      await f.close();
    }
  });

test("cancellation destroys the consumer before releasing buffered source textures", async () => {
  const f = fixture();
  try {
    await f.host.encode(f.texture(), 0);
    assert.equal(f.counts().sourceReleases, 0);
    f.host.window.destroy = () => {
      for (const release of f.releases.splice(0)) release();
    };
    await f.host.dispose();
    assert.equal(f.counts().sourceReleases, 1);
    assert.equal(f.host.leases.size, 0);
  } finally {
    await f.close();
  }
});
