"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { NativeEncodeSession } = require("../native-encode.cjs");
const { TextureLease } = require("../texture-lease.cjs");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture(encodeFrame = async () => '{"submittedFrames":1}') {
  const leases = new TextureLease();
  const calls = [];
  const addonPath = path.resolve("native-encoder.node");
  class NativeEncoder {
    constructor(configJson) {
      calls.push(["constructor", JSON.parse(configJson)]);
    }
    async ready() {
      calls.push(["ready"]);
      return '{"backend":"electron-native-nv12"}';
    }
    async encodeFrame(frameJson) {
      const frame = JSON.parse(frameJson);
      calls.push(["encode", frame]);
      return encodeFrame(frame);
    }
    async finish() {
      calls.push(["finish"]);
      return '{"encodedPackets":1}';
    }
    async abort() {
      calls.push(["abort"]);
    }
  }
  const session = new NativeEncodeSession({
    leases,
    addonPath,
    captureFormat: "nv12",
    loadAddon(loadedPath) {
      assert.equal(loadedPath, addonPath);
      return { NativeEncoder };
    },
  });
  return { leases, session, calls };
}

function retain(leases, onRelease) {
  leases.retain(
    "7:3",
    { release: onRelease },
    {
      textureId: "7:3",
      generation: 7,
      width: 160,
      height: 100,
      textureWidth: 192,
      textureHeight: 112,
      sourceRect: { left: 8, top: 4, width: 160, height: 100 },
      pixelFormat: "nv12",
      handle: "0x123456789abcdef0",
      colorSpace: {
        primaries: "bt709",
        transfer: "bt709",
        matrix: "bt709",
        range: "limited",
      },
    },
  );
}

test("native encode hands retained same-process handle to addon and releases after copy", async () => {
  const copy = deferred();
  const { leases, session, calls } = fixture(() => copy.promise);
  let releases = 0;
  assert.deepEqual(
    await session.begin({
      output: "movie.mp4",
      width: 160,
      height: 100,
      fps: 30,
      codec: "h264",
    }),
    { report: { backend: "electron-native-nv12" } },
  );
  retain(leases, () => releases++);
  const encoding = session.encode({
    textureId: "7:3",
    generation: 7,
    frame: 9,
    pts: 4,
  });
  await Promise.resolve();
  const idle = leases.waitForIdle();
  leases.releaseAll(); // EOF/close cannot release a source while the GPU copy uses it.
  assert.throws(() => leases.release("7:3"), /still in use/);
  assert.equal(releases, 0);
  assert.equal(calls[2][1].handle, "0x123456789abcdef0");
  assert.equal(calls[2][1].frame, 9);
  assert.equal(calls[2][1].pts, 4);
  assert.equal(calls[2][1].pixelFormat, "nv12");
  assert.equal(calls[2][1].generation, undefined);
  copy.resolve('{"submittedFrames":1}');
  assert.deepEqual(await encoding, { stats: { submittedFrames: 1 } });
  await idle;
  assert.equal(releases, 1);
  assert.deepEqual(await session.finish(), { report: { encodedPackets: 1 } });
  assert.equal(session.active, false);
});

test("failed copy releases exactly once and rejects stale generation before addon import", async () => {
  const { leases, session, calls } = fixture(async () => {
    throw new Error("GPU copy failed");
  });
  await session.begin({ output: "movie.mp4" });
  let releases = 0;
  retain(leases, () => releases++);
  await assert.rejects(
    session.encode({ textureId: "7:3", generation: 8, frame: 9, pts: 4 }),
    /generation/,
  );
  assert.equal(releases, 1);
  assert.equal(
    calls.some(([method]) => method === "encode"),
    false,
  );
  retain(leases, () => releases++);
  await assert.rejects(
    session.encode({ textureId: "7:3", generation: 7, frame: 9, pts: 4 }),
    /GPU copy failed/,
  );
  leases.releaseAll();
  assert.equal(releases, 2);
  await session.abort();
});

test("native encoding requires explicit mode, absolute addon and valid frame fields", async () => {
  const leases = new TextureLease();
  const base = { leases, captureFormat: "nv12", addonPath: "relative.node" };
  await assert.rejects(
    new NativeEncodeSession(base).begin({}),
    /absolute path/,
  );
  await assert.rejects(
    new NativeEncodeSession({ ...base, captureFormat: "bgra" }).begin({}),
    /NV12/,
  );
  const { session, calls } = fixture();
  await session.begin({});
  await assert.rejects(
    session.encode({ textureId: "7:3", generation: 7, frame: -1, pts: 0 }),
    /frame/,
  );
  await assert.rejects(
    session.encode({ textureId: "7:3", generation: 7, frame: 0, pts: 1.5 }),
    /pts/,
  );
  assert.equal(
    calls.some(([method]) => method === "encode"),
    false,
  );
  await session.abort();
});

test("shutdown waiters settle even when native texture release throws", async () => {
  const leases = new TextureLease();
  leases.retain("release-error", {
    release() {
      throw new Error("release failed");
    },
  });
  let completeCopy;
  const copied = new Promise((resolve) => {
    completeCopy = resolve;
  });
  const consumed = leases.consume("release-error", () => copied);
  const idle = leases.waitForIdle();
  completeCopy();
  await assert.rejects(consumed, /release failed/);
  await idle;
  assert.equal(leases.occupied, false);
});
