"use strict";
const path = require("node:path");
const { supportedEncoderConfig } = require("./webcodecs-codec.cjs");
const VIDEO_CODECS = ["h264", "hevc", "av1", "vp8", "vp9"];
const AUDIO_CODECS = [
  "aac",
  "opus",
  "mp3",
  "flac",
  "vorbis",
  "pcm-s16",
  "pcm-s24",
  "pcm-f32",
];
function containerFor(file, requested) {
  const container =
    requested && requested !== "auto"
      ? requested
      : path
          .extname(file || "")
          .slice(1)
          .toLowerCase();
  if (!["mp4", "mov", "webm", "mkv"].includes(container))
    throw new Error("media.invalid_container: use mp4, mov, webm or mkv");
  return container;
}
function mediaSettings(settings) {
  const container = containerFor(settings.outputPath, settings.container);
  const backend = settings.mediaBackend ?? "auto";
  if (!["auto", "webcodecs"].includes(backend))
    throw new Error(
      "media.invalid_backend: native CPU video encoding was removed; use auto or webcodecs",
    );
  const logicalCodec =
    !settings.codec || settings.codec === "auto"
      ? container === "webm"
        ? "vp9"
        : "h264"
      : settings.codec;
  if (!VIDEO_CODECS.includes(logicalCodec))
    throw new Error("media.invalid_video_codec");
  if (container === "webm" && !["vp8", "vp9", "av1"].includes(logicalCodec))
    throw new Error("media.incompatible_video_container");
  const videoProfile = settings.videoProfile ?? "auto";
  if (videoProfile !== "auto")
    throw new Error("media.unsupported_video_profile");
  const pixelFormat = "yuv420p";
  if (
    settings.pixelFormat &&
    settings.pixelFormat !== "auto" &&
    settings.pixelFormat !== pixelFormat &&
    !(settings.pixelFormat === "nv12" && pixelFormat === "yuv420p")
  )
    throw new Error("media.unsupported_pixel_format");
  if (!AUDIO_CODECS.concat("auto").includes(settings.audioCodec ?? "auto"))
    throw new Error("media.invalid_audio_codec");
  if (
    container === "webm" &&
    !["auto", "opus", "vorbis"].includes(settings.audioCodec ?? "auto")
  )
    throw new Error("media.incompatible_audio_container");
  return {
    container,
    backend: "webcodecs",
    logicalCodec,
    pixelFormat,
    videoProfile,
  };
}

async function resolveMediaSettings(
  settings,
  VideoEncoder = globalThis.VideoEncoder,
) {
  const selected = mediaSettings(settings);
  const support = await supportedEncoderConfig(
    { ...settings, codec: selected.logicalCodec },
    VideoEncoder,
  );
  if (!support.config) throw new Error(support.reason);
  return {
    ...selected,
    ...support.config,
    logicalCodec: selected.logicalCodec,
  };
}

module.exports = {
  containerFor,
  mediaSettings,
  resolveMediaSettings,
  VIDEO_CODECS,
  AUDIO_CODECS,
};
