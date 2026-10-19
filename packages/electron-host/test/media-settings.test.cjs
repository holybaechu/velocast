"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  mediaSettings,
  resolveMediaSettings,
} = require("../media-settings.cjs");
const settings = {
  outputPath: "video.mp4",
  width: 160,
  height: 100,
  fps: 30,
  bitrate: 1000000,
};
test("only browser video codecs and compatible containers are accepted", () => {
  assert.equal(mediaSettings({ outputPath: "video.webm" }).logicalCodec, "vp9");
  for (const change of [
    { codec: "prores" },
    { mediaBackend: "native" },
    { pixelFormat: "yuv422p10le" },
    { videoProfile: "hq" },
    { container: "webm", codec: "h264" },
  ])
    assert.throws(() => mediaSettings({ ...settings, ...change }), /media\./);
});
test("auto and explicit WebCodecs fail instead of switching to CPU video", async () => {
  for (const mediaBackend of ["auto", "webcodecs"])
    for (const VideoEncoder of [
      null,
      { isConfigSupported: async () => ({ supported: false }) },
    ])
      await assert.rejects(
        resolveMediaSettings({ ...settings, mediaBackend }, VideoEncoder),
        /webcodecs\.(unavailable|unsupported_config)/,
      );
  const result = await resolveMediaSettings(settings, {
    isConfigSupported: async () => ({ supported: true }),
  });
  assert.equal(result.backend, "webcodecs");
  assert.equal(result.backendFallbackReason, undefined);
});
