"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  encoderConfig,
  frameTiming,
  MAX_PACKET_BYTES,
} = require("../webcodecs-codec.cjs");

const settings = { width: 160, height: 100, fps: 30, bitrate: 1_000_000 };
test("configuration uses baseline AVCC, quality mode and a hardware preference", () => {
  const config = encoderConfig(settings);
  assert.equal(config.codec, "avc1.42001f");
  assert.equal(config.avc.format, "avc");
  assert.equal(config.latencyMode, "quality");
  assert.equal(config.hardwareAcceleration, "prefer-hardware");
  assert.equal(
    encoderConfig({ ...settings, bitrate: 64_000_000 }).codec,
    "avc1.420032",
  );
  assert.throws(
    () => encoderConfig({ ...settings, codec: "h264", bitrate: 241_000_000 }),
    /unsupported_config/,
  );
  for (const invalid of [
    { width: 161 },
    { fps: 0 },
    { bitrate: Infinity },
    { height: 8192 },
  ]) {
    assert.throws(
      () => encoderConfig({ ...settings, ...invalid }),
      /webcodecs/,
    );
  }
});

test("timestamps derive from frame indices without accumulated rounding", () => {
  assert.deepEqual(frameTiming(0, 30), { timestamp: 0, duration: 33333 });
  assert.deepEqual(frameTiming(1, 30), { timestamp: 33333, duration: 33334 });
  assert.equal(frameTiming(108000, 30).timestamp, 3_600_000_000);
});
