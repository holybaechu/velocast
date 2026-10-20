"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const protocol = require("../protocol.cjs");

function fixture() {
  const events = [];
  let host, finishSeek, finishSnapshot;
  const png = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png);
  png.writeUInt32BE(160, 16);
  png.writeUInt32BE(100, 20);
  const encoder = {
    frames: 0,
    settings: { startFrame: 240, width: 160, height: 100 },
    async encode(bytes, index, frame, token) {
      events.push("encode");
      assert.equal(bytes.equals(png), true);
      this.frames++;
      return { index, frames: this.frames, frame, token };
    },
  };
  const contents = {
    executeJavaScript() {
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
      sendCommand(method) {
        assert.equal(method, "Page.captureScreenshot");
        events.push("snapshot");
        return new Promise((resolve, reject) => {
          finishSnapshot = (error) =>
            error ? reject(error) : resolve({ data: png.toString("base64") });
        });
      },
    },
  };
  const dependencies = {
    "electron/main": {
      app: {
        on() {},
        commandLine: { appendSwitch() {} },
        whenReady: () => new Promise(() => {}),
      },
    },
    "./protocol.cjs": protocol,
    "./software-frame.cjs": {},
    "./profile-directory.cjs": {},
  };
  const module = { exports: {} };
  vm.runInNewContext(
    `(function(require,module){${fs.readFileSync(path.join(__dirname, "../main.cjs"), "utf8")}\nmodule.exports={dispatch,onTitle,setup(w,e){window=w;webcodecsEncoder=e;snapshotViewport={width:160,height:100};}};})`,
    { process: { env: {} }, Buffer, setTimeout, clearTimeout },
  )((name) => dependencies[name] ?? require(name), module);
  host = module.exports;
  host.setup({ webContents: contents, isDestroyed: () => false }, encoder);
  return {
    host,
    encoder,
    events,
    command: {
      method: "webcodecs-frame",
      index: 0,
      frame: 240,
      token: "seek-241",
      script: "seek",
    },
    finishSeek: (error) => finishSeek(error),
    finishSnapshot: (error) => finishSnapshot(error),
  };
}
const turn = () => new Promise(setImmediate);

test("capture waits for this seek and its immutable snapshot before encoding", async () => {
  const f = fixture();
  const result = f.host.dispatch(f.command);
  f.host.onTitle(null, "velocast-script-result:old-token:ok:{}");
  await turn();
  assert.deepEqual(f.events, ["seek"]);
  f.finishSeek();
  await turn();
  assert.deepEqual(f.events, ["seek", "snapshot"]);
  assert.equal(f.encoder.frames, 0);
  f.finishSnapshot();
  const reply = await result;
  assert.deepEqual(f.events, ["seek", "snapshot", "encode"]);
  assert.equal(reply.frame, 240);
  assert.equal(reply.token, "seek-241");
  assert.equal(reply.cpuReadback, true);
});

test("failed seeks and failed snapshots never submit a frame", async () => {
  for (const stage of ["seek", "snapshot"]) {
    const f = fixture();
    const rejected = assert.rejects(
      f.host.dispatch(f.command),
      /fixture failure/,
    );
    f.finishSeek(stage === "seek" ? new Error("fixture failure") : undefined);
    if (stage === "snapshot") {
      await turn();
      f.finishSnapshot(new Error("fixture failure"));
    }
    await rejected;
    assert.equal(f.encoder.frames, 0);
    assert.equal(f.events.includes("encode"), false);
  }
});

test("out-of-order or inconsistent frame identities fail before seeking", async () => {
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
