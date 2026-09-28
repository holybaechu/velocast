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
    !["auto", "h264", "hevc", "av1"].includes(codec) ||
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
      : codec === "av1"
        ? {}
        : { avc: { format: "avc" } }),
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

// One submitted frame and one bounded packet at a time. Per-frame flush is
// deliberately conservative; it also exposes dropped or
// reordered output before acknowledging the capture to the native scheduler.
class CodecSession {
  constructor(VideoEncoder, VideoFrame) {
    this.VideoEncoder = VideoEncoder;
    this.VideoFrame = VideoFrame;
    this.encoder = null;
    this.pending = null;
    this.error = null;
    this.frames = 0;
  }

  async open(settings) {
    if (this.encoder) throw new Error("webcodecs.already_open");
    let config;
    for (const codec of !settings.codec || settings.codec === "auto"
      ? ["h264", "hevc", "av1"]
      : [settings.codec]) {
      let candidate;
      try {
        candidate = encoderConfig({ ...settings, codec });
      } catch (error) {
        if (settings.codec && settings.codec !== "auto") throw error;
        continue;
      }
      if ((await this.VideoEncoder.isConfigSupported(candidate)).supported) {
        config = candidate;
        this.codec = codec;
        break;
      }
      if (candidate.hardwareAcceleration === "prefer-hardware") {
        const fallback = {
          ...candidate,
          hardwareAcceleration: "no-preference",
        };
        if ((await this.VideoEncoder.isConfigSupported(fallback)).supported) {
          config = fallback;
          this.codec = codec;
          break;
        }
      }
    }
    if (!config)
      throw new Error(
        `webcodecs.unsupported_config: ${settings.codec || "auto"}`,
      );
    this.fps = settings.fps;
    this.width = settings.width;
    this.height = settings.height;
    this.encoder = new this.VideoEncoder({
      output: (chunk, metadata) => {
        try {
          if (metadata?.decoderConfig?.colorSpace) {
            const color = metadata.decoderConfig.colorSpace;
            const value = {
              primaries: color.primaries,
              transfer: color.transfer,
              matrix: color.matrix,
              fullRange: color.fullRange,
            };
            if (
              this.colorSpace &&
              JSON.stringify(value) !== JSON.stringify(this.colorSpace)
            ) {
              throw new Error("webcodecs.color_changed");
            }
            this.colorSpace = value;
          }
          const pending = this.pending;
          if (
            !pending ||
            pending.packet ||
            chunk.timestamp !== pending.timestamp ||
            chunk.byteLength < 1 ||
            chunk.byteLength > MAX_PACKET_BYTES ||
            (pending.keyFrame && chunk.type !== "key")
          ) {
            throw new Error(
              "webcodecs.invalid_packet: dropped, reordered, duplicate or oversized output",
            );
          }
          pending.packet = new Uint8Array(chunk.byteLength);
          chunk.copyTo(pending.packet);
          pending.type = chunk.type;
          pending.metadata = metadata;
        } catch (error) {
          this.error = error;
        }
      },
      error: (error) => {
        this.error = error;
      },
    });
    this.encoder.configure(config);
    return { ...config, logicalCodec: this.codec };
  }

  async encode(imported, index, timingOverride) {
    if (this.pending) {
      imported.release();
      throw new Error("webcodecs.busy");
    }
    let original, frame;
    try {
      if (this.error) throw this.error;
      if (!this.encoder || this.pending || index !== this.frames) {
        throw new Error("webcodecs.invalid_sequence");
      }
      original = imported.getVideoFrame();
      if (
        original.displayWidth !== this.width ||
        original.displayHeight !== this.height
      ) {
        throw new Error(
          "webcodecs.invalid_geometry: imported frame dimensions changed",
        );
      }
      const timing = timingOverride ?? frameTiming(index, this.fps);
      if (
        !Number.isSafeInteger(timing.timestamp) ||
        timing.timestamp < 0 ||
        !Number.isSafeInteger(timing.duration) ||
        timing.duration <= 0
      )
        throw new Error("webcodecs.invalid_timing");
      frame = new this.VideoFrame(original, timing);
      const keyFrame = index % (this.fps * 2) === 0;
      this.pending = { ...timing, keyFrame, packet: null };
      this.encoder.encode(frame, { keyFrame });
      frame.close();
      frame = null;
      original.close();
      original = null;
      await this.encoder.flush();
      if (this.error) throw this.error;
      if (!this.pending.packet) throw new Error("webcodecs.missing_packet");
      const result = {
        index,
        ...timing,
        data: this.pending.packet,
        type: this.pending.type,
        metadata: this.pending.metadata,
        colorSpace: this.colorSpace,
      };
      this.frames++;
      return result;
    } catch (error) {
      this.error ??= error;
      throw error;
    } finally {
      frame?.close();
      original?.close();
      imported.release();
      this.pending = null;
    }
  }

  async finish() {
    if (!this.encoder || this.pending)
      throw new Error("webcodecs.invalid_finish");
    await this.encoder.flush();
    if (this.error) throw this.error;
    this.encoder.close();
    this.encoder = null;
    return { frames: this.frames };
  }
}

module.exports = { CodecSession, encoderConfig, frameTiming, MAX_PACKET_BYTES };
