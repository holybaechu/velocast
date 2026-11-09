"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const hostRequire = require("node:module").createRequire(path.join(__dirname, "../main.cjs"));
const { NativeCapture } = require("../native-capture.cjs");

const turn = () => new Promise(setImmediate);
function fixture() {
  const contents = new EventEmitter();
  let viewport, finishFence, capture, windows = 0;
  const physical = { width: 70, height: 63 };
  contents.debugger = {
    isAttached: () => true,
    async sendCommand(_method, metrics) {
      viewport = { width: metrics.width, height: metrics.height };
    },
  };
  contents.executeJavaScript = async () => viewport;
  contents.executeJavaScriptInIsolatedWorld = () => new Promise((resolve) => { finishFence = resolve; });
  contents.startPainting = contents.stopPainting = contents.setFrameRate = contents.setWindowOpenHandler = () => {};
  contents.isOffscreen = () => true;
  const dependencies = {
    "electron/main": {
      app: {
        on() {},
        commandLine: { appendSwitch() {} },
        whenReady: () => new Promise(() => {}),
        getAppMetrics: () => [],
      },
      BrowserWindow: class extends EventEmitter {
        constructor() { super(); windows++; this.webContents = contents; }
        isDestroyed() { return false; }
        setContentSize() {}
        getContentSize() { return [physical.width, physical.height]; }
        async loadURL() {}
      },
    },
    "./native-capture.cjs": {
      NativeCapture: class extends NativeCapture {
        constructor(webContents) { super(webContents); capture = this; }
      },
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(
    `(function(require,module){${fs.readFileSync(path.join(__dirname, "../main.cjs"), "utf8")}\nmodule.exports={dispatch};})`,
    { process: { env: {}, stderr: { write() {} } }, Buffer, setTimeout, clearTimeout },
  )((name) => dependencies[name] ?? hostRequire(name), module);
  return {
    physical,
    get windows() { return windows; },
    async load(width, height) {
      let settled = false;
      const result = module.exports.dispatch({ method: "load", url: "http://127.0.0.1:3000", width, height });
      void result.then(() => { settled = true; }, () => { settled = true; });
      await turn();
      assert.equal(settled, false, "DOM geometry alone must not complete load");
      finishFence();
      await turn();
      return { result, isSettled: () => settled };
    },
    paint(count, size, change = {}) {
      const texture = {
        releases: 0,
        release() { assert.equal(++this.releases, 1); },
        textureInfo: {
          widgetType: "frame", pixelFormat: "bgra", handle: { ntHandle: Buffer.alloc(8) },
          codedSize: size, visibleRect: { x: 0, y: 0, ...size }, metadata: { frameCount: count },
          ...change,
        },
      };
      contents.emit("paint", { texture });
      return texture;
    },
    dispose() { capture?.dispose(); },
  };
}

test("load drains measured bootstrap and reused prior geometry, then releases settlement before returning", async () => {
  const f = fixture();
  try {
    const firstSize = { width: 64, height: 48 };
    const first = await f.load(firstSize.width, firstSize.height);
    assert.equal(f.paint(0, f.physical).releases, 1);
    await turn();
    assert.equal(first.isSettled(), false);
    const initial = f.paint(1, firstSize);
    await first.result;
    assert.equal(initial.releases, 1);

    // Navigation replaces the source counter; both the prior CDP viewport and
    // the new measured physical surface are trusted, but only for settlement.
    Object.assign(f.physical, { width: 170, height: 115 });
    const nextSize = { width: 160, height: 100 };
    const next = await f.load(nextSize.width, nextSize.height);
    assert.equal(f.paint(0, firstSize).releases, 1);
    assert.equal(f.paint(1, f.physical).releases, 1);
    await turn();
    assert.equal(next.isSettled(), false);
    const current = f.paint(2, nextSize);
    await next.result;
    assert.equal(current.releases, 1);
    assert.equal(f.windows, 1);
  } finally {
    f.dispose();
  }
});

test("load settlement rejects unknown geometry and malformed bootstrap resources", async () => {
  for (const [size, change] of [
    [{ width: 80, height: 60 }, {}],
    [{ width: 70, height: 63 }, { handle: null }],
    [{ width: 70, height: 63 }, { visibleRect: { x: 1, y: 0, width: 70, height: 63 } }],
  ]) {
    const f = fixture();
    try {
      const load = await f.load(64, 48);
      const failed = assert.rejects(load.result, /capture.invalid_native_geometry/);
      const texture = f.paint(0, size, change);
      await failed;
      assert.equal(texture.releases, 1);
    } finally {
      f.dispose();
    }
  }
});
