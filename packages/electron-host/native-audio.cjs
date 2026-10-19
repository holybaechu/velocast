"use strict";
const { createRequire } = require("node:module");
const mb = require("mediabunny");
const av = createRequire(require.resolve("@mediabunny/server"))("node-av");
const ids = {
  aac: av.AV_CODEC_ID_AAC,
  opus: av.AV_CODEC_ID_OPUS,
  mp3: av.AV_CODEC_ID_MP3,
  vorbis: av.AV_CODEC_ID_VORBIS,
  flac: av.AV_CODEC_ID_FLAC,
};
const check = (code) =>
  av.FFmpegError.throwIfError(code, "Native audio conversion");

// Electron disallows external ArrayBuffers: Frame.data returns copies. Use
// native frame-to-frame conversion instead of writing those copied planes.
class NativeAudioEncoder extends mb.CustomAudioEncoder {
  static supports(codec, config) {
    if (!(codec in ids) || ![1, 2].includes(config.numberOfChannels))
      return false;
    if (codec === "aac")
      return [
        7350, 8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000,
        64000, 88200, 96000,
      ].includes(config.sampleRate);
    if (codec === "mp3")
      return [
        8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000,
      ].includes(config.sampleRate);
    if (codec === "opus") return config.sampleRate === 48000;
    return true;
  }
  async init() {
    const encoder = av.Codec.findEncoder(ids[this.codec]);
    if (!encoder)
      throw new Error(`media.audio_encoder_unavailable: ${this.codec}`);
    this.context = new av.CodecContext();
    this.context.allocContext3(encoder);
    this.context.sampleRate = this.config.sampleRate;
    this.layout =
      this.config.numberOfChannels === 1
        ? av.AV_CHANNEL_LAYOUT_MONO
        : av.AV_CHANNEL_LAYOUT_STEREO;
    this.context.channelLayout = this.layout;
    this.context.codecType = av.AVMEDIA_TYPE_AUDIO;
    this.context.sampleFormat = encoder.sampleFormats?.includes(
      av.AV_SAMPLE_FMT_FLTP,
    )
      ? av.AV_SAMPLE_FMT_FLTP
      : (encoder.sampleFormats?.[0] ?? av.AV_SAMPLE_FMT_FLTP);
    this.context.timeBase = new av.Rational(1, this.config.sampleRate);
    this.context.bitRate = BigInt(this.config.bitrate ?? 192000);
    check(await this.context.open2());
    this.frameSize = this.context.frameSize || 1024;
    this.buffer = new Float32Array(
      this.frameSize * this.config.numberOfChannels,
    );
    this.used = 0;
    this.frames = 0;
    this.origin = null;
    this.packet = new av.Packet();
    this.packet.alloc();
    this.resampler = new av.SoftwareResampleContext();
    check(
      this.resampler.allocSetOpts2(
        this.layout,
        this.context.sampleFormat,
        this.config.sampleRate,
        this.layout,
        av.AV_SAMPLE_FMT_FLT,
        this.config.sampleRate,
      ),
    );
    check(this.resampler.init());
  }
  async encode(sample) {
    this.origin ??= sample.timestamp;
    if (
      sample.sampleRate !== this.config.sampleRate ||
      sample.numberOfChannels !== this.config.numberOfChannels
    )
      throw new Error("media.audio_format_changed");
    for (let offset = 0; offset < sample.numberOfFrames;) {
      const count = Math.min(
        this.frameSize - this.used,
        sample.numberOfFrames - offset,
      );
      sample.copyTo(
        this.buffer.subarray(this.used * this.config.numberOfChannels),
        {
          format: "f32",
          planeIndex: 0,
          frameOffset: offset,
          frameCount: count,
        },
      );
      this.used += count;
      offset += count;
      if (this.used === this.frameSize) await this.submit();
    }
  }
  async submit() {
    let input, output;
    try {
      const count = this.codec === "flac" ? this.used : this.frameSize;
      input = av.Frame.fromAudioBuffer(
        Buffer.from(
          this.buffer.buffer,
          0,
          count * this.config.numberOfChannels * 4,
        ),
        {
          nbSamples: count,
          format: av.AV_SAMPLE_FMT_FLT,
          sampleRate: this.config.sampleRate,
          channelLayout: this.layout,
          timeBase: { num: 1, den: this.config.sampleRate },
        },
      );
      output = new av.Frame();
      output.alloc();
      output.channelLayout = this.layout;
      output.sampleRate = this.config.sampleRate;
      output.format = this.context.sampleFormat;
      check(this.resampler.convertFrame(output, input));
      output.pts = BigInt(
        Math.round(this.origin * this.config.sampleRate) + this.frames,
      );
      output.timeBase = new av.Rational(1, this.config.sampleRate);
      await this.send(output);
      this.frames += count;
      this.used = 0;
      this.buffer.fill(0);
    } finally {
      input?.free();
      output?.free();
    }
  }
  async send(frame) {
    check(await this.context.sendFrame(frame));
    for (;;) {
      const status = await this.context.receivePacket(this.packet);
      if ([av.AVERROR_EAGAIN, av.AVERROR_EOF].includes(status)) break;
      check(status);
      const data = this.packet.data;
      // FLAC can flush an empty packet carrying only updated STREAMINFO side
      // data. It is not an audio frame and must not be sent to the muxer.
      if (!data?.byteLength) {
        this.packet.unref();
        continue;
      }
      let metadata;
      if (!this.emitted) {
        this.timestampOffset =
          this.codec === "opus"
            ? Math.max(
                0,
                this.origin - Number(this.packet.pts) / this.config.sampleRate,
              )
            : 0;
        let description = this.context.extraData
          ? new Uint8Array(this.context.extraData)
          : undefined;
        if (this.codec === "flac" && description)
          description = new Uint8Array([
            102,
            76,
            97,
            67,
            128,
            0,
            0,
            description.length,
            ...description,
          ]);
        metadata = {
          decoderConfig: {
            codec: this.config.codec,
            sampleRate: this.config.sampleRate,
            numberOfChannels: this.config.numberOfChannels,
            description,
          },
        };
      }
      this.emitted = true;
      // Preserve negative priming PTS; muxers write the edit/pre-skip metadata.
      this.onPacket(
        new mb.EncodedPacket(
          new Uint8Array(data),
          "key",
          Number(this.packet.pts) / this.config.sampleRate +
            this.timestampOffset,
          Number(this.packet.duration) / this.config.sampleRate,
        ),
        metadata,
      );
      this.packet.unref();
    }
  }
  async flush() {
    if (this.used) await this.submit();
    await this.send(null);
  }
  close() {
    this.packet?.free();
    this.context?.freeContext();
    this.resampler?.free();
  }
}
module.exports = { NativeAudioEncoder };
