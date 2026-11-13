"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { SharedTextureCapture } = require("../shared-texture-capture.cjs");
function fixture() {
  const contents = new EventEmitter();
  let starts = 0,
    stops = 0;
  contents.isDestroyed = () => false;
  contents.startPainting = () => {
    starts++;
  };
  contents.stopPainting = () => {
    stops++;
  };
  const capture = new SharedTextureCapture(contents);
  function paint({ width = 160, height = 100, widgetType = "frame" } = {}) {
    let releases = 0;
    const texture = {
      textureInfo: {
        widgetType,
        codedSize: { width, height },
        visibleRect: { x: 0, y: 0, width, height },
      },
      release() {
        releases++;
      },
    };
    contents.emit("paint", { texture });
    return { texture, releases: () => releases };
  }
  return { contents, capture, paint, starts: () => starts, stops: () => stops };
}

test("fresh captures accept identical and black frames without relying on damage or bitmap copies", async () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) {
    const pending = f.capture.capture(160, 100);
    const source = f.paint();
    assert.equal(await pending, source.texture);
    assert.equal(source.releases(), 0);
    source.texture.release();
    assert.equal(source.releases(), 1);
  }
  assert.equal(f.starts(), 3);
  assert.equal(f.stops(), 4);
});

test("popups, old resize geometry, unsolicited and late textures are released", async () => {
  const f = fixture();
  assert.equal(f.paint().releases(), 1);
  const pending = f.capture.capture(160, 100);
  assert.equal(f.paint({ widgetType: "popup" }).releases(), 1);
  assert.equal(f.paint({ width: 192 }).releases(), 1);
  const source = f.paint();
  assert.equal(await pending, source.texture);
  source.texture.release();
  assert.equal(f.paint().releases(), 1);
});

test("missing GPU textures fail without a bitmap fallback", async () => {
  const f = fixture();
  const failed = assert.rejects(
    f.capture.capture(160, 100),
    /shared_texture_unavailable/,
  );
  f.contents.emit("paint", {});
  await failed;
  assert.equal(f.capture.pending, null);
});

test("timeout stops painting and releases later deliveries", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  const failed = assert.rejects(
    f.capture.capture(160, 100),
    /shared texture capture timed out/,
  );
  t.mock.timers.tick(1800);
  await failed;
  assert.equal(f.paint().releases(), 1);
  assert.equal(f.capture.pending, null);
});

test("cancellation rejects an owned capture and releases late deliveries", async () => {
  const f = fixture();
  const failed = assert.rejects(f.capture.capture(160, 100), /capture.closed/);
  assert.throws(() => f.capture.capture(160, 100), /capture.busy/);
  f.capture.dispose();
  await failed;
  assert.equal(f.paint().releases(), 1);
  assert.throws(() => f.capture.capture(160, 100), /capture.closed/);
});

test("resize timeout reports rejected texture geometry without copying pixels", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  const failed = assert.rejects(f.capture.capture(3840, 2160), (error) => {
    assert.match(error.message, /expected 3840x2160; 2 textures received/);
    assert.match(error.message, /"codedSize":\{"width":4096,"height":2160\}/);
    assert.match(
      error.message,
      /"visibleRect":\{"x":0,"y":0,"width":4096,"height":2160\}/,
    );
    return true;
  });
  assert.equal(f.paint({ widgetType: "popup" }).releases(), 1);
  assert.equal(f.paint({ width: 4096, height: 2160 }).releases(), 1);
  t.mock.timers.tick(1800);
  await failed;
});
