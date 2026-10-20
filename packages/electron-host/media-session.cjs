"use strict";
const { mb, outputFile, probe } = require("./media-io.cjs");
const { resolveMediaSettings } = require("./media-settings.cjs");
const { frameTiming, MAX_PACKET_BYTES } = require("./webcodecs-codec.cjs");

// Keep video encoders isolated from native media codec registrations.
// Each input owns an immutable frame until the encoder retains its reference.
class MediaSession {
  constructor() {
    this.frames = 0;
    this.packets = 0;
    this.bytes = 0;
    this.outstanding = new Map();
    this.busy = false;
  }
  async open(settings) {
    if (this.settings) throw new Error("webcodecs.already_open");
    this.config = await resolveMediaSettings(settings, globalThis.VideoEncoder);
    this.settings = settings;
    const codec =
      this.config.logicalCodec === "h264" ? "avc" : this.config.logicalCodec;
    this.source = new mb.VideoSampleSource({
      codec,
      fullCodecString: this.config.codec,
      bitrate: settings.bitrate,
      hardwareAcceleration: this.config.hardwareAcceleration,
      latencyMode: "quality",
      alpha: "discard",
      onEncodedPacket: (packet, metadata) => {
        // WebCodecs output callbacks are asynchronous. Throwing here would be
        // reported to the window instead of rejecting add/finalize.
        try {
          if (!this.error) this.packet(packet, metadata);
        } catch (error) {
          this.error ??= error;
        }
      },
    });
    this.sink = outputFile(settings.outputPath, this.config.container);
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
  packet(packet, metadata) {
    const timestamp = Math.round(packet.timestamp * 1e6);
    const expected = this.outstanding.get(timestamp);
    if (
      !expected ||
      !Number.isSafeInteger(timestamp) ||
      !Number.isFinite(packet.duration) ||
      packet.duration <= 0 ||
      Math.abs(packet.duration * 1e6 - expected.duration) > 1 ||
      packet.data.byteLength < 1 ||
      packet.data.byteLength > MAX_PACKET_BYTES ||
      (expected.keyFrame && packet.type !== "key")
    )
      throw new Error(
        "webcodecs.invalid_packet: missing, duplicate or unexpected frame",
      );
    this.outstanding.delete(timestamp);
    this.packets++;
    this.bytes += packet.data.byteLength;
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
      )
        throw new Error("webcodecs.color_changed");
      this.colorSpace = value;
    }
  }
  async encode(imported, index, override) {
    let original, frame, sample;
    if (this.busy) {
      imported.release();
      throw new Error("webcodecs.busy");
    }
    this.busy = true;
    try {
      if (this.error) throw this.error;
      if (!this.sink || this.finished || index !== this.frames)
        throw new Error("webcodecs.invalid_sequence");
      const timing = override ?? frameTiming(index, this.settings.fps);
      if (
        !Number.isSafeInteger(timing.timestamp) ||
        timing.timestamp < 0 ||
        !Number.isSafeInteger(timing.duration) ||
        timing.duration <= 0 ||
        this.outstanding.has(timing.timestamp)
      )
        throw new Error("webcodecs.invalid_timing");
      // Bound validation metadata even if a broken encoder never emits output.
      if (this.outstanding.size >= 128)
        throw new Error("webcodecs.encoder_stalled");
      original = imported.getVideoFrame();
      if (
        original.displayWidth !== this.settings.width ||
        original.displayHeight !== this.settings.height
      )
        throw new Error("webcodecs.invalid_geometry");
      frame = new VideoFrame(original, timing);
      sample = new mb.VideoSample(frame);
      const keyFrame = index % (this.settings.fps * 2) === 0;
      this.outstanding.set(timing.timestamp, { ...timing, keyFrame });
      await this.source.add(sample, { keyFrame });
      if (this.error) throw this.error;
      this.frames++;
      return {
        index,
        pixelFormat: original.format,
        ...timing,
        frames: this.frames,
        encodedFrames: this.packets,
        bytes: this.bytes,
        colorSpace: this.colorSpace,
      };
    } catch (error) {
      await this.cancel();
      throw error;
    } finally {
      sample?.close();
      frame?.close();
      original?.close();
      imported.release();
      this.busy = false;
    }
  }
  async finish() {
    if (!this.sink || this.finished || this.busy || !this.frames)
      throw new Error("webcodecs.invalid_finish");
    try {
      this.source.close();
      // Mediabunny drains the encoder and muxer here, never once per frame.
      await this.sink.output.finalize();
      if (this.error) throw this.error;
      if (this.packets !== this.frames || this.outstanding.size)
        throw new Error("webcodecs.frame_count_mismatch");
      this.sink.close();
      const metadata = await probe({ path: this.settings.outputPath });
      if (metadata.video?.frameCount !== this.frames)
        throw new Error("webcodecs.frame_count_mismatch");
      this.finished = true;
      return {
        ...metadata,
        frames: this.frames,
        encodedFrames: this.packets,
        colorSpace: this.colorSpace,
        backend: "webcodecs",
        pixelFormat: this.config.pixelFormat,
      };
    } catch (error) {
      await this.cancel();
      throw error;
    }
  }
  async cancel() {
    if (this.sink && !this.finished) await this.sink.cancel();
    this.outstanding.clear();
  }
}
module.exports = { MediaSession };
