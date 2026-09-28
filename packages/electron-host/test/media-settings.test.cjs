"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  mediaSettings,
  resolveMediaSettings,
} = require("../media-settings.cjs");

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
  assert.equal(mediaSettings(vp9).backend, "webcodecs");
  if (process.platform === "win32" && process.arch === "x64") {
    assert.throws(
      () => mediaSettings({ ...vp9, mediaBackend: "native" }),
      /native VP9 is unavailable/,
    );
  }
});

const video = {
  outputPath: "render.mp4",
  codec: "h264",
  width: 160,
  height: 100,
  fps: 30,
  bitrate: 1_000_000,
};

test("auto prefers WebCodecs and records only capability-based native fallback", async () => {
  const supported = { isConfigSupported: async () => ({ supported: true }) };
  const rejected = { isConfigSupported: async () => ({ supported: false }) };
  const browserSoftware = {
    isConfigSupported: async (config) => ({
      supported: config.hardwareAcceleration === "no-preference",
    }),
  };
  assert.equal(
    (await resolveMediaSettings(video, supported)).backend,
    "webcodecs",
  );
  assert.equal(
    (await resolveMediaSettings(video, browserSoftware)).backend,
    "webcodecs",
  );
  assert.equal(
    (await resolveMediaSettings(video, supported)).backendFallbackReason,
    undefined,
  );
  const fallback = await resolveMediaSettings(video, rejected);
  assert.equal(fallback.backend, "native");
  assert.match(fallback.backendFallbackReason, /webcodecs.unsupported_config/);
  assert.equal((await resolveMediaSettings(video, null)).backend, "native");
  const tooLargeForAvc = await resolveMediaSettings(
    { ...video, width: 4096, height: 4096, fps: 120 },
    supported,
  );
  assert.equal(tooLargeForAvc.backend, "native");
  assert.match(tooLargeForAvc.backendFallbackReason, /AVC level/);
});

test("explicit backends and ProRes never probe or silently switch", async () => {
  const probe = {
    isConfigSupported: () => {
      throw new Error("unexpected browser probe");
    },
  };
  assert.equal(
    (await resolveMediaSettings({ ...video, mediaBackend: "native" }, probe))
      .backend,
    "native",
  );
  assert.equal(
    (await resolveMediaSettings({ ...video, mediaBackend: "webcodecs" }, probe))
      .backend,
    "webcodecs",
  );
  assert.equal(
    (
      await resolveMediaSettings(
        { ...video, codec: "prores", outputPath: "render.mov" },
        probe,
      )
    ).backend,
    "native",
  );
  await assert.rejects(
    resolveMediaSettings(video, probe),
    /unexpected browser probe/,
  );
});

test("Windows x64 VP9 never enters the unsafe native encoder", async () => {
  const settings = { ...video, codec: "vp9", outputPath: "render.webm" };
  const unavailable = { isConfigSupported: async () => ({ supported: false }) };
  if (process.platform === "win32" && process.arch === "x64")
    await assert.rejects(
      resolveMediaSettings(settings, unavailable),
      /native VP9 is unavailable/,
    );
  else
    assert.equal(
      (await resolveMediaSettings(settings, unavailable)).backend,
      "native",
    );
});
