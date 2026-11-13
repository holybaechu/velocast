"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function fixture({ viewportMs = 0 } = {}) {
  const events = [];
  let now = 0,
    host,
    finishSeek,
    finishFence,
    finishCapture,
    budget;
  const texture = {
    textureInfo: { pixelFormat: "bgra" },
    release() {
      events.push("release");
    },
  };
  const capture = {
    capture(width, height, timeoutMs) {
      assert.equal(width, 160);
      assert.equal(height, 100);
      budget = timeoutMs;
      events.push("capture");
      return new Promise((resolve, reject) => {
        finishCapture = (error) => (error ? reject(error) : resolve(texture));
      });
    },
    dispose() {
      events.push("dispose-capture");
      finishCapture?.(new Error("capture.closed"));
    },
  };
  const encoder = {
    frames: 0,
    settings: { startFrame: 240, width: 160, height: 100 },
    async dispose() {
      events.push("dispose-encoder");
    },
    async encode(value, index, frame, token) {
      assert.equal(value, texture);
      events.push("encode");
      texture.release();
      this.frames++;
      return { index, frames: this.frames, frame, token };
    },
  };
  const contents = {
    executeJavaScript(script) {
      if (script === "({width: innerWidth, height: innerHeight})") {
        now += viewportMs;
        events.push("viewport");
        return Promise.resolve({ width: 160, height: 100 });
      }
      events.push("seek");
      return new Promise((resolve, reject) => {
        finishSeek = (error) => {
          if (error) reject(error);
          else {
            host.onTitle(null, "velocast-script-result:seek-241:ok:{}");
            resolve();
          }
        };
      });
    },
    debugger: {
      isAttached: () => true,
      sendCommand(method, parameters) {
        if (method === "Input.dispatchMouseEvent") {
          assert.equal(parameters.type, "mouseWheel");
          assert.equal(parameters.deltaX, 0);
          assert.equal(parameters.deltaY, 0);
          events.push("fence");
          return new Promise((resolve, reject) => {
            finishFence = (error) => (error ? reject(error) : resolve());
          });
        }
        assert.equal(
          method,
          "Emulation.setDeviceMetricsOverride",
          "video must never request a screenshot",
        );
        events.push("override");
        return Promise.resolve();
      },
    },
  };
  const dependencies = {
    "electron/main": {
      app: {
        on() {},
        commandLine: { appendSwitch() {} },
        whenReady: () => new Promise(() => {}),
        exit() {
          events.push("exit");
        },
      },
    },
    "./protocol.cjs": require("../protocol.cjs"),
    "./shared-texture-capture.cjs": {},
    "./profile-directory.cjs": {},
    "node:perf_hooks": { performance: { now: () => now } },
  };
  const module = { exports: {} };
  vm.runInNewContext(
    `(function(require,module){${fs.readFileSync(path.join(__dirname, "../main.cjs"), "utf8")}\nmodule.exports={dispatch,onTitle,cleanup,setup(w,e,c){window=w;webcodecsEncoder=e;textureCapture=c;snapshotViewport={width:160,height:100};}};})`,
    {
      process: { env: {}, stderr: { write() {} } },
      Buffer,
      setTimeout,
      clearTimeout,
    },
  )((name) => dependencies[name] ?? require(name), module);
  host = module.exports;
  host.setup(
    {
      webContents: contents,
      setContentSize() {
        events.push("resize");
      },
      isDestroyed: () => false,
      destroy() {
        events.push("destroy");
      },
    },
    encoder,
    capture,
  );
  return {
    host,
    encoder,
    events,
    budget: () => budget,
    command: {
      method: "webcodecs-frame",
      index: 0,
      frame: 240,
      token: "seek-241",
      script: "seek",
    },
    finishSeek: (error) => finishSeek(error),
    finishFence: (error) => finishFence(error),
    finishCapture: (error) => finishCapture(error),
  };
}
const turn = () => new Promise(setImmediate);

test("capture waits for the exact seek token and compositor fence before requesting a GPU texture", async () => {
  const f = fixture();
  const pending = f.host.dispatch(f.command);
  f.host.onTitle(null, "velocast-script-result:old-token:ok:{}");
  await turn();
  assert.deepEqual(f.events, ["seek"]);
  f.finishSeek();
  await turn();
  assert.deepEqual(f.events, ["seek", "fence"]);
  f.finishFence();
  await turn();
  assert.deepEqual(f.events, ["seek", "fence", "capture"]);
  f.finishCapture();
  const reply = await pending;
  assert.deepEqual(f.events, ["seek", "fence", "capture", "encode", "release"]);
  assert.equal(reply.frame, 240);
  assert.equal(reply.token, "seek-241");
  assert.equal(reply.cpuReadback, false);
  assert.equal(reply.captureBackend, "electron_shared_texture");
  assert.equal(reply.pixelFormat, "bgra");
});

test("failed seeks, compositor fences and captures never submit a frame", async () => {
  for (const stage of ["seek", "fence", "capture"]) {
    const f = fixture();
    const rejected = assert.rejects(
      f.host.dispatch(f.command),
      /fixture failure/,
    );
    f.finishSeek(stage === "seek" ? new Error("fixture failure") : undefined);
    if (stage !== "seek") {
      await turn();
      f.finishFence(
        stage === "fence" ? new Error("fixture failure") : undefined,
      );
    }
    if (stage === "capture") {
      await turn();
      f.finishCapture(new Error("fixture failure"));
    }
    await rejected;
    assert.equal(f.encoder.frames, 0);
    assert.equal(f.events.includes("encode"), false);
  }
});

test("inconsistent frame identities fail before seeking", async () => {
  for (const change of [
    { index: 1 },
    { frame: 0 },
    { frame: 241 },
    { token: "" },
  ]) {
    const f = fixture();
    await assert.rejects(
      f.host.dispatch({ ...f.command, ...change }),
      /invalid_sequence|invalid_frame_identity/,
    );
    assert.deepEqual(f.events, []);
  }
});

test("resize waits for matching GPU geometry and uses the remaining setup budget", async () => {
  const f = fixture({ viewportMs: 700 });
  let ready = false;
  const pending = f.host
    .dispatch({ method: "resize", width: 160, height: 100 })
    .then(() => {
      ready = true;
    });
  await turn();
  assert.equal(ready, false);
  assert.equal(f.budget(), 3800);
  f.finishCapture();
  await pending;
  assert.deepEqual(f.events, [
    "resize",
    "override",
    "viewport",
    "capture",
    "release",
  ]);
  assert.equal(f.encoder.frames, 0);
});

test("an exhausted resize budget cannot request another texture", async () => {
  const f = fixture({ viewportMs: 4500 });
  await assert.rejects(
    f.host.dispatch({ method: "resize", width: 160, height: 100 }),
    /surface resize timed out/,
  );
  assert.equal(f.events.includes("capture"), false);
});

test("cleanup cancels capture before destroying its source window", async () => {
  const f = fixture();
  const rejected = assert.rejects(f.host.dispatch(f.command), /capture.closed/);
  f.finishSeek();
  await turn();
  f.finishFence();
  await turn();
  await f.host.cleanup();
  await rejected;
  assert.deepEqual(f.events, [
    "seek",
    "fence",
    "capture",
    "dispose-capture",
    "dispose-encoder",
    "destroy",
    "exit",
  ]);
});

test("cleanup during a compositor fence cannot start a late capture", async () => {
  const f = fixture();
  const rejected = assert.rejects(
    f.host.dispatch(f.command),
    /Electron host closed/,
  );
  f.finishSeek();
  await turn();
  await f.host.cleanup();
  f.finishFence();
  await rejected;
  assert.equal(f.events.includes("capture"), false);
  assert.equal(f.encoder.frames, 0);
});

test("a compositor fence deadline fails without capturing or encoding", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  const rejected = assert.rejects(
    f.host.dispatch(f.command),
    /compositor visual state timed out/,
  );
  f.finishSeek();
  await turn();
  t.mock.timers.tick(1800);
  await rejected;
  f.finishFence();
  await turn();
  assert.deepEqual(f.events, ["seek", "fence"]);
  assert.equal(f.encoder.frames, 0);
});
