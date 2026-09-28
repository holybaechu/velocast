"use strict";
const { mb, outputFile, probe } = require("./media-io.cjs");
const { mediaSettings } = require("./media-settings.cjs");
const { registerNativeMedia } = require("./native-media.cjs");
const {
  CodecSession,
  encoderConfig,
  frameTiming,
} = require("./webcodecs-codec.cjs");

// Native encoders may delay or reorder packets. Awaiting source.add bounds input
// backpressure; only finalization establishes the complete output packet count.
class NativeMediaSession {
  constructor() {
    this.frames = 0;
    this.packets = 0;
    this.busy = false;
  }
  async open(settings) {
    if (this.sink) throw new Error("media.already_open");
    encoderConfig({ ...settings, codec: "av1" });
    const selected = mediaSettings(settings);
    registerNativeMedia();
    this.settings = settings;
    this.config = {
      ...selected,
      width: settings.width,
      height: settings.height,
      framerate: settings.fps,
      bitrate: settings.bitrate,
      hardwareAcceleration: "prefer-software",
      cpuReadback: true,
    };
    const codec =
      selected.logicalCodec === "h264" ? "avc" : selected.logicalCodec;
    const options = {
      codec,
      bitrate: settings.bitrate,
      hardwareAcceleration: "prefer-software",
      latencyMode: "realtime",
      alpha: "discard",
      ...(codec === "prores"
        ? { fullCodecString: selected.videoProfile === "hq" ? "apch" : "apcn" }
        : {}),
    };
    if (
      !(await mb.canEncodeVideo(codec, {
        ...options,
        width: settings.width,
        height: settings.height,
      }))
    )
      throw new Error(`media.encoder_unavailable: ${codec}`);
    this.sink = outputFile(settings.outputPath, selected.container);
    this.source = new mb.VideoSampleSource({
      ...options,
      onEncodedPacket: (packet, metadata) => {
        this.packets++;
        this.bytes = (this.bytes ?? 0) + packet.data.byteLength;
        if (metadata?.decoderConfig?.colorSpace)
          this.colorSpace = metadata.decoderConfig.colorSpace;
      },
    });
    this.sink.output.addVideoTrack(this.source, {
      ...(settings.timestamps ? {} : { frameRate: settings.fps }),
      rotation: settings.rotation ?? 0,
    });
    try {
      await this.sink.output.start();
    } catch (error) {
      await this.cancel();
      throw error;
    }
    return this.config;
  }
  async encode(imported, index, override) {
    let frame, sample;
    if (this.busy) {
      imported.release();
      throw new Error("media.busy");
    }
    this.busy = true;
    try {
      if (!this.sink || this.finished || index !== this.frames)
        throw new Error("media.invalid_sequence");
      const timing = override ?? frameTiming(index, this.settings.fps);
      if (
        !Number.isSafeInteger(timing.timestamp) ||
        timing.timestamp < 0 ||
        !Number.isSafeInteger(timing.duration) ||
        timing.duration <= 0
      )
        throw new Error("media.invalid_timing");
      frame = imported.getVideoFrame();
      if (
        frame.displayWidth !== this.settings.width ||
        frame.displayHeight !== this.settings.height
      )
        throw new Error("media.invalid_geometry");
      // Canvas readback provides a consistent SDR RGBA source even when the
      // imported VideoFrame is a GPU texture whose native pixel layout is opaque.
      this.canvas ??= new OffscreenCanvas(
        this.settings.width,
        this.settings.height,
      );
      const context = this.canvas.getContext("2d", {
        willReadFrequently: true,
      });
      context.drawImage(frame, 0, 0);
      const data = context.getImageData(
        0,
        0,
        this.settings.width,
        this.settings.height,
      ).data;
      sample = new mb.VideoSample(data, {
        format: "RGBA",
        codedWidth: this.settings.width,
        codedHeight: this.settings.height,
        timestamp: timing.timestamp / 1e6,
        duration: timing.duration / 1e6,
        colorSpace: {
          primaries: "bt709",
          transfer: "iec61966-2-1",
          matrix: "rgb",
          fullRange: true,
        },
      });
      const before = this.bytes ?? 0;
      await this.source.add(sample);
      this.frames++;
      return {
        index,
        ...timing,
        frames: this.frames,
        encodedFrames: this.packets,
        bytes: (this.bytes ?? 0) - before,
        colorSpace: this.colorSpace,
      };
    } catch (error) {
      await this.cancel();
      throw error;
    } finally {
      sample?.close();
      frame?.close();
      imported.release();
      this.busy = false;
    }
  }
  async finish() {
    if (!this.sink || this.finished || this.busy || !this.frames)
      throw new Error("media.invalid_finish");
    try {
      this.source.close();
      await this.sink.output.finalize();
      this.sink.close();
      const metadata = await probe({ path: this.settings.outputPath });
      if (metadata.video?.frameCount !== this.frames)
        throw new Error("media.frame_count_mismatch");
      this.finished = true;
      return {
        ...metadata,
        frames: this.frames,
        colorSpace: this.colorSpace,
        backend: "native",
        pixelFormat: this.config.pixelFormat,
      };
    } catch (error) {
      await this.cancel();
      throw error;
    }
  }
  async cancel() {
    if (this.sink && !this.finished) await this.sink.cancel();
  }
}

class MediaSession {
  async open(settings) {
    const selected = mediaSettings(settings);
    this.session =
      selected.backend === "native"
        ? new NativeMediaSession()
        : new CodecSession(VideoEncoder, VideoFrame);
    const result = await this.session.open({
      ...settings,
      codec: selected.logicalCodec,
    });
    return {
      ...result,
      ...selected,
      cpuReadback: selected.backend === "native",
    };
  }
  encode(...args) {
    return this.session.encode(...args);
  }
  finish() {
    return this.session.finish();
  }
}
module.exports = { MediaSession, NativeMediaSession };
