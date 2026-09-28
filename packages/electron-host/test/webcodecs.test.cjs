"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CodecSession,
  encoderConfig,
  frameTiming,
  MAX_PACKET_BYTES,
} = require("../webcodecs-codec.cjs");

const settings = { width: 160, height: 100, fps: 30, bitrate: 1_000_000 };
function fixture(behavior = "ok") {
  const state = {
    framesClosed: 0,
    importsReleased: 0,
    encoded: [],
    closed: false,
  };
  class Frame {
    constructor(_source, timing) {
      Object.assign(this, timing);
    }
    close() {
      state.framesClosed++;
    }
  }
  class Encoder {
    static async isConfigSupported() {
      return { supported: behavior !== "unsupported" };
    }
    constructor(callbacks) {
      this.callbacks = callbacks;
    }
    configure(config) {
      state.config = config;
    }
    encode(frame, options) {
      state.encoded.push({ timestamp: frame.timestamp, ...options });
    }
    async flush() {
      if (behavior === "error") {
        this.callbacks.error(new Error("device lost"));
        return;
      }
      if (behavior === "missing") return;
      const last = state.encoded.at(-1);
      if (!last || state.emitted === state.encoded.length) return;
      const chunk = {
        timestamp: last.timestamp + (behavior === "reordered" ? 1 : 0),
        byteLength: behavior === "oversized" ? MAX_PACKET_BYTES + 1 : 5,
        type: last.keyFrame ? "key" : "delta",
        copyTo: (bytes) => bytes.set([0, 0, 1, 0x65, 1]),
      };
      this.callbacks.output(chunk);
      if (behavior === "duplicate") this.callbacks.output(chunk);
      state.emitted = state.encoded.length;
    }
    close() {
      state.closed = true;
    }
  }
  const imported = () => ({
    getVideoFrame: () => ({
      displayWidth: 160,
      displayHeight: 100,
      close: () => state.framesClosed++,
    }),
    release: () => state.importsReleased++,
  });
  return { state, session: new CodecSession(Encoder, Frame), imported };
}

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

test("sequential encoding drains output and releases both frames and imports", async () => {
  const { session, state, imported } = fixture();
  await session.open(settings);
  for (let index = 0; index < 3; index++) {
    const result = await session.encode(imported(), index);
    assert.equal(result.timestamp, frameTiming(index, 30).timestamp);
    assert.deepEqual([...result.data], [0, 0, 1, 0x65, 1]);
  }
  assert.deepEqual(await session.finish(), { frames: 3 });
  assert.equal(state.framesClosed, 6);
  assert.equal(state.importsReleased, 3);
  assert.equal(state.closed, true);
});

for (const behavior of [
  "missing",
  "duplicate",
  "reordered",
  "oversized",
  "error",
]) {
  test(`encoding fails and releases resources for ${behavior} output`, async () => {
    const { session, state, imported } = fixture(behavior);
    await session.open(settings);
    await assert.rejects(session.encode(imported(), 0));
    assert.equal(state.framesClosed, 2);
    assert.equal(state.importsReleased, 1);
    assert.equal(session.frames, 0);
  });
}

test("unsupported codec configurations fail before submission", async () => {
  await assert.rejects(
    fixture("unsupported").session.open(settings),
    /unsupported_config/,
  );
});

test("out-of-order submissions are rejected and release the transferred import", async () => {
  const { session, state, imported } = fixture();
  await session.open(settings);
  await assert.rejects(session.encode(imported(), 1), /invalid_sequence/);
  assert.equal(state.importsReleased, 1);
  assert.equal(state.encoded.length, 0);
});
