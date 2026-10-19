"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test(
  "paint retries allow a slow GPU capture to complete without restarting it",
  { timeout: 3000 },
  async () => {
    let captureTimer, host;
    const state = { starts: 0, stops: 0, invalidates: 0, released: 0 };
    const app = {
      on() {},
      commandLine: { appendSwitch() {} },
      whenReady: () => new Promise(() => {}),
    };
    const contents = {
      stopPainting() {
        state.stops++;
        clearTimeout(captureTimer);
      },
      startPainting() {
        state.starts++;
        // A busy GPU can take longer than the 50ms retry interval. Restarting
        // this asynchronous operation on each null paint would starve it forever.
        captureTimer = setTimeout(
          () =>
            host.onPaint(
              {
                texture: {
                  textureInfo: { visibleRect: { width: 160, height: 100 } },
                  release() {
                    state.released++;
                  },
                },
              },
              {},
            ),
          160,
        );
      },
      invalidate() {
        state.invalidates++;
        host.onPaint({}, {});
      },
    };
    const module = { exports: {} };
    const dependencies = {
      "electron/main": { app },
      "./protocol.cjs": {
        textureMetadata: () => ({ width: 160, height: 100 }),
      },
      "./software-frame.cjs": {},
      "./capture-rate.cjs": {},
      "./profile-directory.cjs": {},
    };
    const source = fs.readFileSync(path.join(__dirname, "../main.cjs"), "utf8");
    const load = vm.runInNewContext(
      `(function(require,module){${source}\nmodule.exports={waitForPaint,onPaint,setWindow(value){window=value;}};})`,
      {
        process: { env: { VELOCAST_ELECTRON_SURFACE_MODE: "webcodecs" } },
        setTimeout,
        clearTimeout,
      },
    );
    load((name) => dependencies[name] ?? require(name), module);
    host = module.exports;
    host.setWindow({
      webContents: contents,
      isDestroyed: () => false,
      getContentSize: () => [160, 100],
    });
    try {
      const result = await host.waitForPaint({ generation: 1, copy: false });
      assert.equal(result.width, 160);
      assert.equal(state.starts, 1);
      assert.equal(state.stops, 1);
      assert.ok(state.invalidates >= 3);
      assert.equal(state.released, 1);
    } finally {
      clearTimeout(captureTimer);
    }
  },
);
