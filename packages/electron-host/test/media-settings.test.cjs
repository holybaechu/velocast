"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { mediaSettings } = require("../media-settings.cjs");

test("format selection keeps codec, container, pixel format and backend requests binding", () => {
  assert.equal(
    mediaSettings({ outputPath: "render.webm" }).logicalCodec,
    "vp9",
  );
  assert.throws(
    () => mediaSettings({ outputPath: "render.webm", codec: "h264" }),
    /incompatible_video_container/,
  );
  assert.throws(
    () => mediaSettings({ outputPath: "render.webm", audioCodec: "aac" }),
    /incompatible_audio_container/,
  );
  assert.throws(
    () =>
      mediaSettings({
        outputPath: "render.mov",
        codec: "prores",
        pixelFormat: "yuv420p",
      }),
    /unsupported_pixel_format/,
  );
  assert.throws(
    () =>
      mediaSettings({
        outputPath: "render.mov",
        codec: "prores",
        videoProfile: "4444",
      }),
    /unsupported_video_profile/,
  );
  assert.equal(
    mediaSettings({ outputPath: "render.mov", codec: "prores" }).pixelFormat,
    "yuv422p10le",
  );
  const vp9 = { outputPath: "render.webm", codec: "vp9" };
  if (process.platform === "win32" && process.arch === "x64") {
    assert.equal(mediaSettings(vp9).backend, "webcodecs");
    assert.throws(
      () => mediaSettings({ ...vp9, mediaBackend: "native" }),
      /native VP9 is unavailable/,
    );
  } else assert.equal(mediaSettings(vp9).backend, "native");
});
