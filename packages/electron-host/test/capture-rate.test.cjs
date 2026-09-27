"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveCaptureFrameRate } = require("../capture-rate.cjs");

test("uses the measured offline default when the override is absent", () => {
  for (const value of [undefined, "", "  "])
    assert.equal(resolveCaptureFrameRate(value), 1000);
});

test("accepts positive capture rates above the old 240 fps setting", () => {
  for (const fps of [1, 240, 1000, 10000, 1000000])
    assert.equal(resolveCaptureFrameRate(` ${fps} `), fps);
});

test("rejects unlimited sentinels and values that produce a zero interval", () => {
  for (const value of [
    "0",
    "-1",
    "Infinity",
    "unlimited",
    "1.5",
    "1e3",
    "NaN",
    "1000001",
  ])
    assert.throws(() => resolveCaptureFrameRate(value), /must be an integer/);
});
