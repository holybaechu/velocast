import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertComparable,
  assertFrameOracle,
  assertWebCodecsTelemetry,
  assertMediaTiming,
  cancellationMarkerPath,
  compareDecodedPixels,
  firstRenderedFrame,
  median,
  splitRawFrames,
  COLORS,
  FRAME_STATES,
  HEIGHT,
  WIDTH,
} from "../electron-renderer-oracle.mjs";

function frames(
  indices = FRAME_STATES.map((_, index) => index),
  states = FRAME_STATES,
) {
  const bytes = Buffer.alloc(indices.length * WIDTH * HEIGHT * 4);
  for (const [position, frame] of indices.entries()) {
    const color = COLORS[states[frame]];
    for (let y = 0; y < HEIGHT; y++)
      for (let x = 0; x < WIDTH; x++) {
        const at = ((position * HEIGHT + y) * WIDTH + x) * 4;
        const bit =
          y >= 90 && y < 106 && x >= 8 && x < 162
            ? Math.floor((x - 8) / 20)
            : -1;
        const strip = bit >= 0 && (x - 8) % 20 < 14;
        const rgb = strip
          ? (frame >> bit) & 1
            ? [255, 255, 255]
            : [0, 0, 0]
          : color;
        bytes.set([...rgb, 255], at);
      }
  }
  return bytes;
}

test("accepts ordered frames, including static state and reverse transitions", () => {
  assertFrameOracle(frames());
  assertFrameOracle(frames([5, 6, 7]), [5, 6, 7]);
});
test("stream splitting handles partial chunks and high frame identities", async () => {
  async function* chunks() {
    yield Buffer.from([1, 2, 3]);
    yield Buffer.from([4, 5, 6, 7, 8, 9]);
  }
  const output = [];
  for await (const frame of splitRawFrames(chunks(), 3))
    output.push([...frame]);
  assert.deepEqual(output, [
    [1, 2, 3],
    [4, 5, 6],
    [7, 8, 9],
  ]);
  async function* partial() {
    yield Buffer.from([1, 2]);
  }
  await assert.rejects(async () => {
    for await (const frame of splitRawFrames(partial(), 3)) void frame;
  }, /partial decoded frame/);
  const states = Array.from(
    { length: 240 },
    (_, frame) => FRAME_STATES[frame % 24],
  );
  assertFrameOracle(frames([239], states), [239], { states });
  assert.throws(
    () => assertFrameOracle(frames([215], states), [239], { states }),
    /identity bit/,
  );
});
test("rejects duplicate paint within a static stretch", () => {
  const bytes = frames();
  const stride = WIDTH * HEIGHT * 4;
  bytes.copy(bytes, 5 * stride, 4 * stride, 5 * stride);
  assert.throws(() => assertFrameOracle(bytes), /frame 5: identity bit/);
});
test("rejects a reversed or missing frame and truncated output", () => {
  const indices = FRAME_STATES.map((_, index) => index);
  [indices[1], indices[2]] = [indices[2], indices[1]];
  assert.throws(() => assertFrameOracle(frames(indices)), /frame 1:/);
  assert.throws(
    () => assertFrameOracle(frames().subarray(0, -1)),
    /decoded byte count/,
  );
});
test("checks WebCodecs route and mismatched comparison settings", () => {
  const telemetry = {
    capture_backend: "electron_shared_texture",
    conversion_backend: "chromium_webcodecs",
    encoder_backend: "electron_webcodecs_h264",
    cpu_readback_frames: 0,
    fallback_used: false,
    dropped_frames: 0,
    stale_frames: 0,
    frames_expected: 24,
    frames_rendered: 24,
    frames_encoded: 24,
    total_wall_ms: 100,
    selected_codec: "h264",
    target_bitrate_bps: 12000000,
  };
  assertWebCodecsTelemetry(telemetry, "electron", 24);
  assert.throws(
    () =>
      assertWebCodecsTelemetry(
        { ...telemetry, capture_backend: "native_gpu" },
        "electron",
        24,
      ),
    /capture_backend/,
  );
  assert.throws(
    () =>
      assertWebCodecsTelemetry(
        { ...telemetry, dropped_frames: 1 },
        "electron",
        24,
      ),
    /drop/,
  );
  const summary = {
    sourceVersion: "abc",
    codec_name: "h264",
    pix_fmt: "yuv420p",
    color_range: "tv",
    color_space: "bt709",
    width: WIDTH,
    height: HEIGHT,
    sample_rate: "48000",
    channels: 2,
    telemetry,
  };
  assertComparable(summary, summary);
  assert.throws(
    () => assertComparable(summary, { ...summary, sourceVersion: "different" }),
    /sourceVersion differs/,
  );
  assert.throws(
    () => assertComparable(summary, { ...summary, color_space: "bt470bg" }),
    /color_space differs/,
  );
  assert.throws(
    () =>
      assertComparable(summary, {
        ...summary,
        telemetry: { ...telemetry, encoder_backend: "electron_webcodecs_av1" },
      }),
    /encoder_backend differs/,
  );
  const withAudio = { ...summary, audioSignal: { samples: 96000, rms: 400 } };
  assert.throws(
    () =>
      assertComparable(withAudio, {
        ...withAudio,
        audioSignal: { samples: 96000, rms: 50 },
      }),
    /audio RMS differs/,
  );
});
test("accepts Linux bitmap fallback only with matching readback and fallback facts", () => {
  const linux = {
    mode: "reference_web_codecs",
    webcodecs: { hardware_acceleration: "no-preference" },
    capture_backend: "electron_bitmap",
    conversion_backend: "chromium_webcodecs",
    encoder_backend: "electron_webcodecs_h264",
    cpu_readback_frames: 24,
    fallback_used: true,
    fallback_reason:
      "Shared texture capture unavailable; using bitmap capture with WebCodecs",
    dropped_frames: 0,
    stale_frames: 0,
    frames_expected: 24,
    frames_rendered: 24,
    frames_encoded: 24,
    total_wall_ms: 2993,
  };
  assertWebCodecsTelemetry(linux, "electron", 24);
  assert.throws(
    () =>
      assertWebCodecsTelemetry(
        { ...linux, cpu_readback_frames: 23 },
        "electron",
        24,
      ),
    /readback/,
  );
  assert.throws(
    () =>
      assertWebCodecsTelemetry(
        { ...linux, fallback_used: false },
        "electron",
        24,
      ),
    /fallback/,
  );
  assert.throws(
    () =>
      assertWebCodecsTelemetry(
        { ...linux, fallback_reason: null },
        "electron",
        24,
      ),
    /fallback/,
  );
  assert.throws(
    () =>
      assertWebCodecsTelemetry(
        { ...linux, webcodecs: { hardware_acceleration: "verified-hardware" } },
        "electron",
        24,
      ),
    /hardware preference/,
  );
  const shared = {
    ...linux,
    capture_backend: "electron_shared_texture",
    cpu_readback_frames: 0,
    fallback_used: false,
    fallback_reason: null,
  };
  assertWebCodecsTelemetry(shared, "electron", 24);
  assert.throws(
    () =>
      assertWebCodecsTelemetry(
        { ...shared, cpu_readback_frames: 1 },
        "electron",
        24,
      ),
    /readback/,
  );
  assert.throws(
    () =>
      assertWebCodecsTelemetry(
        { ...shared, fallback_used: true },
        "electron",
        24,
      ),
    /fallback/,
  );
});
test("decoded comparison measures codec noise and rejects wrong frame colors", () => {
  const first = frames([0]);
  const noisy = Buffer.from(first);
  for (let offset = 0; offset < noisy.length; offset += 4)
    noisy[offset] = Math.min(255, noisy[offset] + 2);
  const stats = compareDecodedPixels(first, noisy);
  assert.ok(stats.mae > 0 && stats.mae < 1);
  assert.throws(
    () => compareDecodedPixels(first, frames([1])),
    /decoded pixel mismatch/,
  );
  assert.throws(
    () => compareDecodedPixels(first, first.subarray(0, -4)),
    /buffers differ in length/,
  );
});
test("checks full and ranged media against their own duration, samples and rebased PTS", () => {
  const media = (
    duration,
    videoStart = "0.000000",
    audioStart = "0.000000",
  ) => ({
    streams: [
      { codec_type: "video", start_time: videoStart },
      { codec_type: "audio", start_time: audioStart },
    ],
    format: { duration: String(duration) },
  });
  assertMediaTiming(media(2), 96000, 24);
  assertMediaTiming(media(7 / 12), 28000, 7);
  assertMediaTiming(media(4), 192000, 240, 60);
  assertMediaTiming(media(1), 48000, 60, 60);
  assert.throws(() => assertMediaTiming(media(2), 28000, 7), /media duration/);
  assert.throws(
    () => assertMediaTiming(media(7 / 12), 96000, 7),
    /decoded audio samples/,
  );
  assert.throws(
    () => assertMediaTiming(media(7 / 12, "0.416667"), 28000, 7),
    /video PTS was not rebased/,
  );
  assert.throws(
    () => assertMediaTiming(media(7 / 12, "0", "0.416667"), 28000, 7),
    /audio PTS was not rebased/,
  );
});
test("cancellation waits for a complete frame event and uses the native PID marker", () => {
  const partial = '{"event":"frame_rendered","frame":';
  assert.equal(
    firstRenderedFrame(`{"event":"renderer_started"}\n${partial}`),
    null,
  );
  assert.equal(
    firstRenderedFrame(
      `{"event":"renderer_started"}\n{"event":"frame_rendered","frame":3}\n${partial}`,
    ),
    3,
  );
  assert.equal(
    cancellationMarkerPath("C:\\renders\\events.jsonl", 421),
    "C:\\renders\\events.jsonl.421.cancel",
  );
  assert.throws(
    () => cancellationMarkerPath("events.jsonl", 0),
    /invalid native process id/,
  );
});
test("paired median averages even runs", () => {
  assert.equal(median([100, 300]), 200);
  assert.equal(median([300, 100, 200]), 200);
  assert.throws(() => median([]), /finite values/);
});
