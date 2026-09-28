"use strict";
const { mb, outputFile, probe, absolute } = require("./media-io.cjs");
const fs = require("node:fs");
const { mediaSettings, resolveMediaSettings } = require("./media-settings.cjs");
const { registerNativeMedia } = require("./native-media.cjs");
const { NativeVideoClient } = require("./native-video-client.cjs");
const {
  CodecSession,
  encoderConfig,
  frameTiming,
  isUnsupportedWebCodecsError,
} = require("./webcodecs-codec.cjs");

// Native encoders may delay or reorder packets. Awaiting source.add bounds input
// backpressure; only finalization establishes the complete output packet count.
class NativeMediaSession {
  constructor({ outputFd } = {}) {
    this.outputFd = outputFd;
    this.frames = 0;
    this.packets = 0;
    this.busy = false;
  }
  async open(settings) {
    if (this.sink) throw new Error("media.already_open");
    encoderConfig({ ...settings, codec: "av1" });
    const selected = mediaSettings({ ...settings, mediaBackend: "native" });
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
    this.sink = outputFile(
      settings.outputPath,
      selected.container,
      this.outputFd,
    );
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
  async submit(sample, index, timing) {
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
  }
  async encodeBitmap(data, index, format = "BGRA", override) {
    if (this.busy) throw new Error("media.busy");
    this.busy = true;
    let sample;
    try {
      if (!this.sink || this.finished || index !== this.frames)
        throw new Error("media.invalid_sequence");
      const { width, height, fps } = this.settings;
      if (
        !(data instanceof Uint8Array) ||
        data.byteLength !== width * height * 4 ||
        !["BGRA", "RGBA"].includes(format)
      )
        throw new Error("media.invalid_bitmap");
      const timing = override ?? frameTiming(index, fps);
      if (
        !Number.isSafeInteger(timing.timestamp) ||
        timing.timestamp < 0 ||
        !Number.isSafeInteger(timing.duration) ||
        timing.duration <= 0
      )
        throw new Error("media.invalid_timing");
      // The compositor has already provided CPU pixels. Do not upload these
      // bytes into a VideoFrame/Canvas solely to read them back again.
      sample = new mb.VideoSample(data, {
        format,
        codedWidth: width,
        codedHeight: height,
        timestamp: timing.timestamp / 1e6,
        duration: timing.duration / 1e6,
        colorSpace: {
          primaries: "bt709",
          transfer: "iec61966-2-1",
          matrix: "rgb",
          fullRange: true,
        },
      });
      if (process.env.VELOCAST_MEDIA_TRACE) {
        const at = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
        const trace = {
          pid: process.pid,
          index,
          stage: "native-bitmap-input",
          cpuBitmap: process.env.VELOCAST_ELECTRON_CPU_BITMAP === "1",
          rgb:
            format === "BGRA"
              ? [data[at + 2], data[at + 1], data[at]]
              : [data[at], data[at + 1], data[at + 2]],
        };
        fs.appendFileSync(
          absolute(process.env.VELOCAST_MEDIA_TRACE),
          JSON.stringify(trace) + "\n",
          { mode: 0o600 },
        );
      }
      return await this.submit(sample, index, timing);
    } catch (error) {
      await this.cancel();
      throw error;
    } finally {
      sample?.close();
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
    this.settings = settings;
    let selected = await resolveMediaSettings(
      settings,
      globalThis.VideoEncoder,
    );
    const openSelected = () => {
      this.session =
        selected.backend === "native"
          ? process.versions.electron
            ? new NativeVideoClient()
            : new NativeMediaSession()
          : new CodecSession(globalThis.VideoEncoder, globalThis.VideoFrame);
      return this.session.open({
        ...settings,
        codec: selected.logicalCodec,
        mediaBackend: selected.backend,
      });
    };
    let result;
    try {
      result = await openSelected();
    } catch (error) {
      if (
        (settings.mediaBackend ?? "auto") !== "auto" ||
        selected.backend !== "webcodecs" ||
        !isUnsupportedWebCodecsError(error)
      )
        throw error;
      selected = {
        ...mediaSettings({ ...settings, mediaBackend: "native" }),
        backendFallbackReason: `${error.message}; using native video encoding`,
      };
      result = await openSelected();
    }
    return {
      ...result,
      ...selected,
      cpuReadback: selected.backend === "native",
    };
  }
  encode(...args) {
    return this.session.encode(...args);
  }
  encodeBitmap(settings) {
    if (
      settings.width !== this.settings.width ||
      settings.height !== this.settings.height
    )
      throw new Error("media.invalid_bitmap_geometry");
    if (this.session instanceof NativeVideoClient)
      return this.session.encodeBitmap(settings);
    if (this.session instanceof NativeMediaSession)
      return this.session.encodeBitmap(settings.data, settings.index);
    return this.session.encode(
      {
        getVideoFrame: () =>
          new VideoFrame(settings.data, {
            format: "BGRA",
            codedWidth: settings.width,
            codedHeight: settings.height,
            timestamp: 0,
            colorSpace: {
              primaries: "bt709",
              transfer: "iec61966-2-1",
              matrix: "rgb",
              fullRange: true,
            },
          }),
        release() {},
      },
      settings.index,
    );
  }
  finish() {
    return this.session.finish();
  }
}
module.exports = { MediaSession, NativeMediaSession };
