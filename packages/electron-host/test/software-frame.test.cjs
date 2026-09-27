"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SoftwareFrameLease, byteLength, MAX_FRAME_BYTES } = require("../software-frame.cjs");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "velocast-software-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { lease: new SoftwareFrameLease(directory), file: path.join(directory, "frame.bgra") };
}
function image(width, height, pixels) {
  return { getSize: () => ({ width, height }), toBitmap: () => pixels };
}

test("software lease preserves packed BGRA including transparent pixels outside JSON", (t) => {
  const { lease, file } = fixture(t);
  const pixels = Buffer.from([3, 2, 1, 255, 0, 0, 0, 0]);
  const metadata = lease.capture(image(2, 1, pixels), { generation: 7, copy: true });
  assert.deepEqual(fs.readFileSync(file), pixels);
  assert.deepEqual(metadata, { generation: 7, width: 2, height: 1, pixelFormat: "bgra", byteLength: 8, softwareFrameId: "7:1" });
  assert.equal(lease.occupied, true);
  assert.throws(() => lease.capture(image(2, 1, pixels), { generation: 8, copy: true }), /already retained/);
  assert.throws(() => lease.release("old"), /Unknown/);
  assert.equal(fs.existsSync(file), true);
  lease.release(metadata.softwareFrameId);
  assert.equal(fs.existsSync(file), false);
  assert.equal(lease.occupied, false);
  assert.throws(() => lease.release(metadata.softwareFrameId), /Unknown/);
});

test("observation and invalid geometry never read bitmap bytes or create a file", (t) => {
  const { lease, file } = fixture(t);
  const source = { getSize: () => ({ width: 2, height: 2 }), toBitmap: () => { throw new Error("unexpected readback"); } };
  assert.equal(lease.capture(source, { generation: 1, copy: false }).byteLength, 16);
  assert.equal(fs.existsSync(file), false);
  for (const [width, height] of [[0, 1], [-1, 2], [1.5, 2], [16385, 1], [16384, 16384]]) {
    assert.throws(() => byteLength(width, height), /bounded BGRA/);
  }
  assert.equal(byteLength(8192, 8192), MAX_FRAME_BYTES);
  assert.throws(() => lease.capture(image(2, 2, Buffer.alloc(4)), { generation: 1, copy: true }), /byte length/);
  assert.equal(fs.existsSync(file), false);
});

test("release permits static repeated frames and resized frames with fresh lease IDs", (t) => {
  const { lease, file } = fixture(t);
  const pixels = Buffer.from([10, 20, 30, 255]);
  const first = lease.capture(image(1, 1, pixels), { generation: 3, copy: true });
  lease.release(first.softwareFrameId);
  const second = lease.capture(image(1, 1, pixels), { generation: 4, copy: true });
  assert.deepEqual(fs.readFileSync(file), pixels);
  assert.notEqual(first.softwareFrameId, second.softwareFrameId);
  lease.release(second.softwareFrameId);
  const resized = lease.capture(image(2, 1, Buffer.alloc(8)), { generation: 5, copy: true });
  assert.equal(resized.byteLength, 8);
  lease.releaseAll();
  lease.releaseAll();
  assert.equal(fs.existsSync(file), false);
});

test("software transfer refuses to overwrite an existing lease file", (t) => {
  const { lease, file } = fixture(t);
  fs.writeFileSync(file, "existing");
  assert.throws(() => lease.capture(image(1, 1, Buffer.alloc(4)), { generation: 1, copy: true }), /EEXIST/);
  assert.equal(fs.readFileSync(file, "utf8"), "existing");
  assert.equal(lease.occupied, false);
});
