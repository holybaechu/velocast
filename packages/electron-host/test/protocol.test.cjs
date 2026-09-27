"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseCommand,
  loadUrl,
  parseScriptTitle,
  textureMetadata,
} = require("../protocol.cjs");
const { TextureLease } = require("../texture-lease.cjs");

test("script completion only accepts the current request token", () => {
  const old = 'velocast-script-result:script-6:ok:{"frame":6}';
  const current = 'velocast-script-result:script-7:ok:{"frame":7}';
  assert.equal(parseScriptTitle(old, "script-7"), null);
  assert.deepEqual(parseScriptTitle(current, "script-7"), {
    ok: true,
    result: '{"frame":7}',
  });
  assert.deepEqual(
    parseScriptTitle(
      "velocast-script-result:script-7:err:seek failed: late image",
      "script-7",
    ),
    {
      ok: false,
      error: "seek failed: late image",
    },
  );
});

test("shared texture HANDLE is preserved beyond JavaScript number precision", () => {
  const ntHandle = Buffer.alloc(8);
  ntHandle.writeBigUInt64LE(0x123456789abcdef0n);
  const metadata = textureMetadata(
    {
      widgetType: "frame",
      pixelFormat: "bgra",
      codedSize: { width: 1920, height: 1080 },
      visibleRect: { x: 100, y: 50, width: 1200, height: 630 },
      handle: { ntHandle },
    },
    { generation: 17, copy: true },
    "17:1",
  );
  assert.equal(metadata.handle, "0x123456789abcdef0");
  assert.deepEqual(metadata.sourceRect, {
    left: 100,
    top: 50,
    width: 1200,
    height: 630,
  });
  assert.equal(metadata.textureWidth, 1920);
  assert.equal(metadata.width, 1200);
});

test("unsupported or malformed GPU paint fails before native import", () => {
  const texture = {
    widgetType: "frame",
    pixelFormat: "rgba",
    codedSize: { width: 10, height: 10 },
    visibleRect: { x: 0, y: 0, width: 10, height: 10 },
  };
  assert.throws(
    () => textureMetadata(texture, { generation: 1, copy: true }, "1:1"),
    /BGRA/,
  );
  texture.pixelFormat = "bgra";
  texture.visibleRect.width = 11;
  assert.throws(
    () => textureMetadata(texture, { generation: 1, copy: false }, "1:1"),
    /exceeds coded size/,
  );
});

test("NV12 paint reports actual color and crop while rejecting a format mismatch", () => {
  const ntHandle = Buffer.alloc(8);
  ntHandle.writeBigUInt64LE(0x1234n);
  const colorSpace = {
    primaries: "bt709",
    transfer: "bt709",
    matrix: "bt709",
    range: "limited",
  };
  const texture = {
    widgetType: "frame",
    pixelFormat: "nv12",
    codedSize: { width: 192, height: 112 },
    visibleRect: { x: 8, y: 4, width: 160, height: 100 },
    contentRect: { x: 10, y: 6, width: 100, height: 80 },
    colorSpace,
    handle: { ntHandle },
  };
  const metadata = textureMetadata(
    texture,
    { generation: 19, copy: true },
    "19:1",
    "nv12",
  );
  assert.equal(metadata.pixelFormat, "nv12");
  assert.deepEqual(metadata.colorSpace, colorSpace);
  assert.deepEqual(metadata.sourceRect, {
    left: 8,
    top: 4,
    width: 160,
    height: 100,
  });
  assert.deepEqual(metadata.contentRect, {
    left: 10,
    top: 6,
    width: 100,
    height: 80,
  });
  assert.equal(metadata.handle, "0x1234");
  texture.pixelFormat = "bgra";
  assert.throws(
    () =>
      textureMetadata(texture, { generation: 19, copy: true }, "19:1", "nv12"),
    /NV12/,
  );
  texture.pixelFormat = "nv12";
  texture.contentRect.width = 200;
  assert.throws(
    () =>
      textureMetadata(texture, { generation: 19, copy: false }, "19:1", "nv12"),
    /content rectangle exceeds coded size/,
  );
});

test("lease holds only one texture and releases the exact texture once", () => {
  const leases = new TextureLease();
  let releaseCount = 0;
  leases.retain("1:1", {
    release() {
      releaseCount++;
    },
  });
  assert.throws(
    () => leases.retain("1:2", { release() {} }),
    /already retains/,
  );
  assert.throws(() => leases.release("1:2"), /unknown/);
  leases.release("1:1");
  leases.releaseAll();
  assert.equal(releaseCount, 1);
  assert.throws(() => leases.release("1:1"), /unknown/);
});

test("commands reject unsupported operations and unsafe request IDs", () => {
  assert.equal(
    parseCommand('{"id":7,"method":"paint","generation":8,"copy":true}').id,
    7,
  );
  assert.throws(
    () => parseCommand('{"id":9007199254740992,"method":"paint"}'),
    /safe integer/,
  );
  assert.throws(() => parseCommand('{"id":1,"method":"eval"}'), /unsupported/);
  for (const method of [
    "beginNativeEncode",
    "encodeNativeFrame",
    "finishNativeEncode",
    "abortNativeEncode",
  ])
    assert.equal(
      parseCommand(JSON.stringify({ id: 8, method })).method,
      method,
    );
});

test("load accepts the native controller local file entry and web server URLs", () => {
  assert.equal(
    loadUrl("file:///D:/projects/My Scene/index.html"),
    "file:///D:/projects/My%20Scene/index.html",
  );
  assert.equal(
    loadUrl("http://127.0.0.1:3000/scene"),
    "http://127.0.0.1:3000/scene",
  );
  assert.equal(
    loadUrl("https://example.test/scene"),
    "https://example.test/scene",
  );
});

test("load rejects executable, inline, and relative URLs", () => {
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,<script>x</script>",
    "velocast://renderer",
    "./index.html",
    "C:\\scene\\index.html",
  ]) {
    assert.throws(() => loadUrl(value), /HTTP\(S\) or file URL/);
  }
});
