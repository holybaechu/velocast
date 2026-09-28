"use strict";
const { createRequire } = require("node:module");
const mb = require("mediabunny");
const server = require("@mediabunny/server");
const av = createRequire(require.resolve("@mediabunny/server"))("node-av");
const check = (status) =>
  av.FFmpegError.throwIfError(status, "ProRes decoding");

// The server extension delegates ProRes to an ESM-only extension, whose codec
// registry differs from this CommonJS host. Use its public AVFrame resource
// interface with FFmpeg's intra-frame ProRes decoder instead.
class NativeProresDecoder extends mb.CustomVideoDecoder {
  static supports(codec) {
    return codec === "prores";
  }
  async init() {
    const codec = av.Codec.findDecoder(av.AV_CODEC_ID_PRORES);
    if (!codec) throw new Error("media.decoder_unavailable: prores");
    this.context = new av.CodecContext();
    this.context.allocContext3(codec);
    this.context.codecType = av.AVMEDIA_TYPE_VIDEO;
    this.context.width = this.config.codedWidth ?? 0;
    this.context.height = this.config.codedHeight ?? 0;
    this.context.timeBase = new av.Rational(1, 1000000);
    this.context.threadCount = 1;
    check(await this.context.open2());
    this.packet = new av.Packet();
    this.packet.alloc();
    this.frame = new av.Frame();
    this.frame.alloc();
    this.timings = new Map();
  }
  async decode(packet) {
    this.timings.set(packet.microsecondTimestamp, {
      timestamp: packet.timestamp,
      duration: packet.duration,
    });
    if (this.timings.size > 32) throw new Error("media.decoder_queue_full");
    this.packet.data = Buffer.from(packet.data);
    this.packet.pts = BigInt(packet.microsecondTimestamp);
    this.packet.dts = this.packet.pts;
    this.packet.duration = BigInt(packet.microsecondDuration);
    this.packet.timeBase = { num: 1, den: 1000000 };
    this.packet.isKeyframe = true;
    try {
      check(await this.context.sendPacket(this.packet));
    } finally {
      this.packet.unref();
    }
    await this.drain();
  }
  async drain() {
    for (;;) {
      const status = await this.context.receiveFrame(this.frame);
      if (status === av.AVERROR_EAGAIN || status === av.AVERROR_EOF) break;
      check(status);
      const key = Number(this.frame.pts),
        timing = this.timings.get(key);
      if (!timing) throw new Error("media.decoder_timestamp_mismatch");
      this.timings.delete(key);
      if (!(
        this.frame.sampleAspectRatio.num > 0 &&
        this.frame.sampleAspectRatio.den > 0
      )) {
        this.frame.sampleAspectRatio = new av.Rational(
          (this.config.displayAspectWidth ?? this.frame.width) *
            this.frame.height,
          (this.config.displayAspectHeight ?? this.frame.height) *
            this.frame.width,
        );
      }
      const copy = this.frame.clone();
      if (!copy) throw new Error("media.decoder_frame_allocation");
      this.frame.unref();
      const resource = new server.AvFrameVideoSampleResource(copy);
      let sample;
      try {
        sample = new mb.VideoSample(resource, timing);
      } catch (error) {
        resource.close();
        throw error;
      }
      this.onSample(sample);
    }
  }
  async flush() {
    check(await this.context.sendPacket(null));
    await this.drain();
    this.context.flushBuffers();
    this.timings.clear();
  }
  close() {
    this.packet?.free();
    this.frame?.free();
    this.context?.freeContext();
  }
}
module.exports = { NativeProresDecoder };
