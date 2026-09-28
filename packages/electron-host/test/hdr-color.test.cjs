"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { hdrToRgba, pqNits, hlgScene } = require("../hdr-color.cjs");
test("PQ and HLG reference transfer points match BT.2100", () => {
  assert.ok(pqNits(0) < 1e-8);
  assert.ok(Math.abs(pqNits(0.5080784215) - 100) < 0.001);
  assert.ok(Math.abs(pqNits(1) - 10000) < 0.001);
  assert.equal(hlgScene(0), 0);
  assert.ok(Math.abs(hlgScene(0.5) - 1 / 12) < 1e-8);
  assert.ok(Math.abs(hlgScene(1) - 1) < 1e-6);
});
for (const transfer of ["pq", "hlg"])
  test(`${transfer} ten-bit planes retain neutral black, midtones and highlights`, () => {
    const values = [64, 509, 723, 940],
      bytes = Buffer.alloc(16 + 8 + 8);
    for (let i = 0; i < 8; i++) bytes.writeUInt16LE(values[i % 4], i * 2);
    for (let i = 16; i < 32; i += 2) bytes.writeUInt16LE(512, i);
    const result = hdrToRgba({
      bytes,
      layouts: [
        { offset: 0, stride: 8 },
        { offset: 16, stride: 4 },
        { offset: 24, stride: 4 },
      ],
      width: 4,
      height: 2,
      format: "I420P10",
      colorSpace: {
        transfer,
        primaries: "bt2020",
        matrix: "bt2020-ncl",
        fullRange: false,
      },
    });
    assert.equal(result[0], 0);
    assert.ok(
      result[4] > 0 && result[4] < result[8] && result[8] <= result[12],
    );
    for (let i = 0; i < 8; i++) {
      assert.ok(Math.abs(result[i * 4] - result[i * 4 + 1]) <= 1);
      assert.ok(Math.abs(result[i * 4] - result[i * 4 + 2]) <= 1);
      assert.equal(result[i * 4 + 3], 255);
    }
  });
