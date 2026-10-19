"use strict";

const MAX_PACKET_BYTES = 64 * 1024 * 1024;

function encoderConfig({
  width,
  height,
  fps,
  bitrate,
  codec = "auto",
  hardwareAcceleration = "prefer-hardware",
}) {
  if (
    ![width, height, fps, bitrate].every(Number.isSafeInteger) ||
    width < 2 ||
    height < 2 ||
    width % 2 ||
    height % 2 ||
    width > 4096 ||
    height > 4096 ||
    fps < 1 ||
    fps > 120 ||
    bitrate < 1 ||
    bitrate > 1_000_000_000
  ) {
    throw new Error(
      "webcodecs.invalid_config: even dimensions up to 4096, 1–120 fps and a bounded bitrate are required",
    );
  }
  const widthBlocks = Math.ceil(width / 16),
    heightBlocks = Math.ceil(height / 16);
  const blocks = widthBlocks * heightBlocks;
  // AVC level limits from ITU-T H.264 Annex A.
  const level = [
    ["1f", 3600, 108000, 14_000_000],
    ["20", 5120, 216000, 20_000_000],
    ["28", 8192, 245760, 20_000_000],
    ["29", 8192, 245760, 50_000_000],
    ["2a", 8704, 522240, 50_000_000],
    ["32", 22080, 589824, 135_000_000],
    ["33", 36864, 983040, 240_000_000],
    ["34", 36864, 2073600, 240_000_000],
  ].find(
    ([, size, rate, maxBitrate]) =>
      blocks <= size &&
      blocks * fps <= rate &&
      widthBlocks ** 2 <= 8 * size &&
      heightBlocks ** 2 <= 8 * size &&
      bitrate <= maxBitrate,
  );
  if (!level && codec === "h264")
    throw new Error(
      "webcodecs.unsupported_config: geometry, frame rate or bitrate exceeds AVC level 5.2",
    );
  if (
    !["auto", "h264", "hevc", "av1", "vp8", "vp9"].includes(codec) ||
    !["prefer-hardware", "prefer-software", "no-preference"].includes(
      hardwareAcceleration,
    )
  )
    throw new Error("webcodecs.invalid_codec");
  return {
    codec:
      codec === "hevc"
        ? "hvc1.1.6.L153.B0"
        : codec === "av1"
          ? "av01.0.13M.08"
          : codec === "vp8"
            ? "vp8"
            : codec === "vp9"
              ? "vp09.00.41.08"
              : `avc1.4200${level?.[0] ?? "34"}`,
    width,
    height,
    framerate: fps,
    bitrate,
    bitrateMode: "variable",
    latencyMode: "quality",
    hardwareAcceleration,
    ...(codec === "hevc"
      ? { hevc: { format: "hevc" } }
      : ["av1", "vp8", "vp9"].includes(codec)
        ? {}
        : { avc: { format: "avc" } }),
  };
}

function isUnsupportedWebCodecsError(error) {
  return (
    error?.name === "NotSupportedError" ||
    error?.message?.startsWith("webcodecs.unsupported_config:")
  );
}

async function supportedEncoderConfig(settings, VideoEncoder) {
  if (typeof VideoEncoder?.isConfigSupported !== "function")
    return { reason: "webcodecs.unavailable: VideoEncoder is unavailable" };
  let reason;
  for (const codec of !settings.codec || settings.codec === "auto"
    ? ["h264", "hevc", "av1"]
    : [settings.codec]) {
    let candidate;
    try {
      candidate = encoderConfig({ ...settings, codec });
    } catch (error) {
      if (!isUnsupportedWebCodecsError(error)) throw error;
      reason = error.message;
      continue;
    }
    for (const config of [
      candidate,
      ...(candidate.hardwareAcceleration === "prefer-hardware"
        ? [{ ...candidate, hardwareAcceleration: "no-preference" }]
        : []),
    ]) {
      let supported;
      try {
        supported = (await VideoEncoder.isConfigSupported(config)).supported;
      } catch (error) {
        if (!isUnsupportedWebCodecsError(error)) throw error;
        reason = `webcodecs.unsupported_config: ${codec}`;
        continue;
      }
      if (supported) return { config, logicalCodec: codec };
    }
    reason ??= `webcodecs.unsupported_config: ${codec}`;
  }
  return {
    reason:
      reason ?? `webcodecs.unsupported_config: ${settings.codec || "auto"}`,
  };
}

function frameTiming(index, fps) {
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index > 0xffffffff ||
    !Number.isSafeInteger(fps) ||
    fps < 1 ||
    fps > 120
  ) {
    throw new Error("webcodecs.invalid_frame: invalid index or frame rate");
  }
  const timestamp = Math.round((index * 1_000_000) / fps);
  return {
    timestamp,
    duration: Math.round(((index + 1) * 1_000_000) / fps) - timestamp,
  };
}

module.exports = {
  encoderConfig,
  supportedEncoderConfig,
  isUnsupportedWebCodecsError,
  frameTiming,
  MAX_PACKET_BYTES,
};
