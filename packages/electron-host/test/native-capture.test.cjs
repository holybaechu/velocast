"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { NativeCapture } = require("../native-capture.cjs");

test("release failure is terminal and late paints after cancellation are returned once", async () => {
  const f = fixture();
  const result = assert.rejects(
    f.capture.capture(160, 100),
    /native_release_failed/,
  );
  let releases = 0;
  f.contents.emit("paint", {
    texture: {
      release() {
        releases++;
        throw new Error("device lost");
      },
    },
  });
  await result;
  assert.equal(releases, 1);
  await assert.rejects(f.capture.capture(160, 100), /native_release_failed/);
  f.capture.dispose();
  const late = texture(5);
  f.contents.emit("paint", { texture: late });
  assert.equal(late.releases, 1);
});

test("navigation resets a replaced native source counter without accepting stale frames within a capture", async () => {
  const f = fixture();
  const before = texture(50);
  f.contents.emit("paint", { texture: before });
  f.capture.resetSource();
  const result = f.capture.capture(160, 100);
  assert.throws(() => f.capture.resetSource(), /busy/);
  f.fence();
  await turn();
  const after = texture(1);
  f.contents.emit("paint", { texture: after });
  assert.equal(await result, after);
  after.release();
  f.capture.dispose();
});

const turn = () => new Promise(setImmediate);
function fixture() {
  const contents = new EventEmitter();
  let finishFence;
  contents.executeJavaScriptInIsolatedWorld = () =>
    new Promise((resolve) => {
      finishFence = resolve;
    });
  contents.startPainting = () => {
    contents.started = (contents.started ?? 0) + 1;
  };
  contents.stopPainting = () => {};
  const capture = new NativeCapture(contents, 50);
  return { contents, capture, fence: () => finishFence() };
}
function texture(count = 1, change = {}) {
  return {
    releases: 0,
    release() {
      this.releases++;
      assert.equal(this.releases, 1);
    },
    textureInfo: {
      widgetType: "frame",
      pixelFormat: "bgra",
      handle: { ntHandle: Buffer.alloc(8) },
      codedSize: { width: 160, height: 100 },
      visibleRect: { x: 0, y: 0, width: 160, height: 100 },
      metadata: { frameCount: count },
      ...change,
    },
  };
}

test("native capture drains old paints, fences readiness and transfers exactly one fresh texture", async () => {
  const f = fixture();
  const old = texture(2);
  const result = f.capture.capture(160, 100);
  f.contents.emit("paint", { texture: old });
  assert.equal(old.releases, 1);
  assert.equal(f.contents.started, 1);
  await assert.rejects(f.capture.capture(160, 100), /busy/);
  f.fence();
  await turn();
  const stale = texture(2),
    next = texture(3),
    extra = texture(4);
  f.contents.emit("paint", { texture: stale });
  f.contents.emit("paint", { texture: next });
  f.contents.emit("paint", { texture: extra });
  assert.equal(await result, next);
  assert.equal(stale.releases, 1);
  assert.equal(next.releases, 0);
  assert.equal(extra.releases, 1);
  next.release();
  f.capture.dispose();
});

test("missing native texture, malformed geometry and handles fail without CPU fallback", async () => {
  for (const change of [
    null,
    { codedSize: { width: 80, height: 50 } },
    { visibleRect: { x: 1, y: 0, width: 160, height: 100 } },
    { handle: null },
    { pixelFormat: "invalid" },
    { metadata: {} },
  ]) {
    const f = fixture();
    const result = assert.rejects(
      f.capture.capture(160, 100),
      (error) => {
        assert.match(error.message, /shared_texture_unavailable|invalid_native_geometry/);
        if (change !== null) {
          const details = JSON.parse(error.message.split(": ").slice(1).join(": "));
          assert.deepEqual(details.expected, { width: 160, height: 100 });
          assert.equal(details.hasHandle, change.handle !== null);
          assert.equal(error.message.includes("ntHandle"), false);
        }
        return true;
      },
    );
    f.fence();
    await turn();
    const value = change === null ? null : texture(1, change);
    f.contents.emit("paint", { texture: value });
    await result;
    if (value) assert.equal(value.releases, 1);
    f.capture.dispose();
  }
});

test("cancellation and timeout include the readiness fence and never restart a cancelled capture", async () => {
  for (const cancel of [true, false]) {
    const f = fixture();
    const result = assert.rejects(
      f.capture.capture(160, 100),
      cancel ? /closed/ : /timeout/,
    );
    if (cancel) f.capture.dispose();
    await result;
    f.fence();
    await turn();
    assert.equal(f.contents.started, 1);
    f.capture.dispose();
  }
  const f = fixture();
  await assert.rejects(f.capture.capture(0, 100), /invalid_native_geometry/);
  f.capture.dispose();
  await assert.rejects(f.capture.capture(160, 100), /closed/);
});
