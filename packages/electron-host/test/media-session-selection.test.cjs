"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const settings = {
  outputPath: "/video.mp4",
  codec: "h264",
  width: 160,
  height: 100,
  fps: 30,
  bitrate: 1000000,
};
function fixture(behavior = "ok") {
  const state = {
    released: 0,
    closed: 0,
    cancelled: 0,
    emitted: 0,
    pending: [],
  };
  let source;
  const packet = (sample) => {
    const packet = {
      timestamp: sample.timestamp,
      duration: sample.duration,
      data: new Uint8Array(5),
      type: "key",
    };
    if (behavior === "wrong-timestamp") packet.timestamp += 1;
    if (behavior === "invalid-duration") packet.duration = NaN;
    if (behavior === "oversized") packet.data = { byteLength: 67108865 };
    source.config.onEncodedPacket(packet);
    state.emitted++;
    if (behavior === "duplicate") source.config.onEncodedPacket(packet);
  };
  class Frame {
    constructor(original, timing) {
      Object.assign(this, original, timing);
    }
    close() {
      state.closed++;
    }
  }
  const mb = {
    VideoSample: class {
      constructor(frame) {
        this.timestamp = frame.timestamp / 1e6;
        this.duration = frame.duration / 1e6;
      }
      close() {
        state.closed++;
      }
    },
    VideoSampleSource: class {
      constructor(config) {
        source = this;
        this.config = config;
      }
      async add(sample) {
        if (behavior === "device-lost") throw new Error("device lost");
        state.pending.push(sample);
        // Buffer output until later submissions: no per-frame flush is available.
        if (state.pending.length > 1) packet(state.pending.shift());
      }
      close() {}
    },
  };
  const dependencies = {
    "./media-io.cjs": {
      mb,
      outputFile: () => ({
        output: {
          addVideoTrack() {},
          async start() {},
          async finalize() {
            if (behavior !== "missing")
              for (const sample of state.pending) packet(sample);
          },
        },
        close() {},
        async cancel() {
          state.cancelled++;
        },
      }),
      probe: async () => ({ video: { frameCount: state.emitted } }),
    },
    "./media-settings.cjs": require("../media-settings.cjs"),
    "./webcodecs-codec.cjs": require("../webcodecs-codec.cjs"),
  };
  const module = { exports: {} };
  vm.runInNewContext(
    `(function(require,module){${fs.readFileSync(path.join(__dirname, "../media-session.cjs"), "utf8")}\n})`,
    {
      VideoFrame: Frame,
      VideoEncoder: {
        isConfigSupported: async () => ({
          supported: behavior !== "unsupported",
        }),
      },
      Uint8Array,
    },
  )((name) => {
    if (!(name in dependencies))
      throw new Error(`unexpected dependency: ${name}`);
    return dependencies[name];
  }, module);
  return {
    session: new module.exports.MediaSession(),
    state,
    imported: () => ({
      getVideoFrame: () => ({
        displayWidth: 160,
        displayHeight: 100,
        close() {
          state.closed++;
        },
      }),
      release() {
        state.released++;
      },
    }),
  };
}
test("Mediabunny buffers packets, drains once and releases all frame wrappers", async () => {
  const { session, state, imported } = fixture();
  await session.open(settings);
  for (let i = 0; i < 6; i++) {
    const result = await session.encode(imported(), i);
    assert.equal(result.frames, i + 1);
    assert.equal(result.encodedFrames, i);
    assert.equal(result.timestamp, Math.round((i * 1e6) / 30));
  }
  assert.equal((await session.finish()).frames, 6);
  assert.equal(state.released, 6);
  assert.equal(state.closed, 18);
  assert.equal(state.cancelled, 0);
});
for (const behavior of [
  "duplicate",
  "wrong-timestamp",
  "invalid-duration",
  "oversized",
  "device-lost",
  "missing",
])
  test(`invalid ${behavior} output cancels and releases GPU imports`, async () => {
    const { session, state, imported } = fixture(behavior);
    await session.open(settings);
    await assert.rejects(async () => {
      await session.encode(imported(), 0);
      await session.encode(imported(), 1);
      await session.finish();
    });
    assert.ok(state.cancelled > 0);
    assert.ok(state.released > 0);
  });
test("sequence errors release the import and unavailable video never opens native", async () => {
  const { session, state, imported } = fixture();
  await session.open(settings);
  await assert.rejects(session.encode(imported(), 1), /invalid_sequence/);
  assert.equal(state.released, 1);
  await assert.rejects(
    fixture("unsupported").session.open(settings),
    /unsupported_config/,
  );
  await assert.rejects(
    fixture().session.open({ ...settings, mediaBackend: "native" }),
    /invalid_backend/,
  );
});
