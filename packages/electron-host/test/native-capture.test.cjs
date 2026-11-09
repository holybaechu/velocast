"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { NativeCapture } = require("../native-capture.cjs");

const turn = () => new Promise(setImmediate);
function fixture() {
  const contents = new EventEmitter();
  let finishFence;
  contents.executeJavaScript = () =>
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
  assert.equal(f.contents.started, undefined);
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
      /shared_texture_unavailable|invalid_native_geometry/,
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
    assert.equal(f.contents.started, undefined);
    f.capture.dispose();
  }
  const f = fixture();
  await assert.rejects(f.capture.capture(0, 100), /invalid_native_geometry/);
  f.capture.dispose();
  await assert.rejects(f.capture.capture(160, 100), /closed/);
});
