"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  encoderConfig,
  supportedEncoderConfig,
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

test("hardware is selected without probing software when supported", async () => {
  const requests = [];
  const result = await supportedEncoderConfig(
    { ...settings, codec: "h264" },
    {
      isConfigSupported: async (config) => {
        requests.push(config.hardwareAcceleration);
        return { supported: true };
      },
    },
  );
  assert.deepEqual(requests, ["prefer-hardware"]);
  assert.equal(result.config.hardwareAcceleration, "prefer-hardware");
});

for (const unsupported of ["false", "NotSupportedError"])
  test(`unsupported hardware (${unsupported}) falls back to software with the same codec`, async () => {
    const requests = [];
    const result = await supportedEncoderConfig(
      { ...settings, codec: "h264" },
      {
        isConfigSupported: async (config) => {
          requests.push(config);
          if (config.hardwareAcceleration === "prefer-hardware") {
            if (unsupported === "NotSupportedError")
              throw Object.assign(new Error("Hardware unavailable"), {
                name: "NotSupportedError",
              });
            return { supported: false };
          }
          return { supported: true };
        },
      },
    );
    assert.deepEqual(
      requests.map((config) => config.hardwareAcceleration),
      ["prefer-hardware", "prefer-software"],
    );
    assert.deepEqual(requests[1], {
      ...requests[0],
      hardwareAcceleration: "prefer-software",
    });
    assert.equal(result.logicalCodec, "h264");
    assert.equal(result.config.hardwareAcceleration, "prefer-software");
  });

for (const hardwareAcceleration of ["prefer-software", "no-preference"])
  test(`explicit ${hardwareAcceleration} probes only that preference`, async () => {
    const requests = [];
    const result = await supportedEncoderConfig(
      { ...settings, codec: "h264", hardwareAcceleration },
      {
        isConfigSupported: async (config) => {
          requests.push(config.hardwareAcceleration);
          return { supported: true };
        },
      },
    );
    assert.deepEqual(requests, [hardwareAcceleration]);
    assert.equal(result.config.hardwareAcceleration, hardwareAcceleration);
  });

test("unsupported hardware and software fail without changing an explicit codec", async () => {
  const requests = [];
  const result = await supportedEncoderConfig(
    { ...settings, codec: "h264" },
    {
      isConfigSupported: async (config) => {
        requests.push(config);
        return { supported: false };
      },
    },
  );
  assert.equal(result.config, undefined);
  assert.equal(result.reason, "webcodecs.unsupported_config: h264");
  assert.equal(requests.length, 2);
  assert.ok(requests.every((config) => config.codec === "avc1.42001f"));
});

test("unrelated capability errors are propagated without a software retry", async () => {
  const requests = [];
  const failure = new Error("encoder service disconnected");
  await assert.rejects(
    supportedEncoderConfig(
      { ...settings, codec: "h264" },
      {
        isConfigSupported: async (config) => {
          requests.push(config.hardwareAcceleration);
          throw failure;
        },
      },
    ),
    (error) => error === failure,
  );
  assert.deepEqual(requests, ["prefer-hardware"]);
});

test("unavailable explicit software encoding fails without trying hardware", async () => {
  const requests = [];
  const result = await supportedEncoderConfig(
    { ...settings, codec: "h264", hardwareAcceleration: "prefer-software" },
    {
      isConfigSupported: async (config) => {
        requests.push(config.hardwareAcceleration);
        return { supported: false };
      },
    },
  );
  assert.equal(result.config, undefined);
  assert.deepEqual(requests, ["prefer-software"]);
});
