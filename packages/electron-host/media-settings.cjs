"use strict";
const path = require("node:path");
const VIDEO_CODECS = ["h264", "hevc", "av1", "vp8", "vp9", "prores"];
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
  if (!["auto", "native", "webcodecs"].includes(backend))
    throw new Error("media.invalid_backend");
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
  const videoProfile =
    settings.videoProfile ?? (logicalCodec === "prores" ? "standard" : "auto");
  if (
    logicalCodec === "prores"
      ? !["standard", "hq", "auto"].includes(videoProfile)
      : videoProfile !== "auto"
  )
    throw new Error("media.unsupported_video_profile");
  const pixelFormat = logicalCodec === "prores" ? "yuv422p10le" : "yuv420p";
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
  // The pinned Windows x64 NodeAV libvpx build terminates on VP9 submission
  // (STATUS_ILLEGAL_INSTRUCTION), including in standalone Node. Avoid invoking
  // it until a replacement binding passes the native acceptance gate.
  const blockedNativeVp9 =
    process.platform === "win32" &&
    process.arch === "x64" &&
    logicalCodec === "vp9";
  if (blockedNativeVp9 && backend === "native")
    throw new Error(
      "media.encoder_unavailable: native VP9 is unavailable in the pinned Windows x64 binding; use auto or webcodecs",
    );
  return {
    container,
    backend:
      backend === "auto"
        ? blockedNativeVp9
          ? "webcodecs"
          : "native"
        : backend,
    logicalCodec,
    pixelFormat,
    videoProfile:
      logicalCodec === "prores" && videoProfile === "auto"
        ? "standard"
        : videoProfile,
  };
}
module.exports = { containerFor, mediaSettings, VIDEO_CODECS, AUDIO_CODECS };
