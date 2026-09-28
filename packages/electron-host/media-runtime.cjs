"use strict";
// Runs exclusively in the trusted utility preload, never in authored pages.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const {
  mb,
  absolute,
  inputFile,
  outputFile,
  probe,
} = require("./media-io.cjs");
const { CodecSession } = require("./webcodecs-codec.cjs");
const { toneMapFrame } = require("./hdr-color.cjs");
const { StreamingAudioResampler } = require("./audio-resampler.cjs");
const { selectAudioEncoder } = require("./audio-codec.cjs");
const BLOCK = 4096;
function scratch(prefix) {
  return fs.mkdtempSync(
    path.join(
      process.env.VELOCAST_MEDIA_SCRATCH ??
        process.env.VELOCAST_ELECTRON_FRAME_DIRECTORY ??
        os.tmpdir(),
      prefix,
    ),
  );
}

function wavHeader(samples, rate, channels) {
  const size = samples * channels * 4;
  if (size > 0xffffffff - 36) throw new Error("media.wave_size_limit");
  const b = Buffer.alloc(44);
  b.write("RIFF");
  b.writeUInt32LE(size + 36, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(3, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * channels * 4, 28);
  b.writeUInt16LE(channels * 4, 32);
  b.writeUInt16LE(32, 34);
  b.write("data", 36);
  b.writeUInt32LE(size, 40);
  return b;
}
function audioOptions(op) {
  if (
    !Number.isSafeInteger(op.sampleRate) ||
    op.sampleRate < 4000 ||
    op.sampleRate > 192000 ||
    ![1, 2].includes(op.channels)
  )
    throw new Error("media.invalid_audio_format");
  if (
    op.duration !== undefined &&
    (!Number.isFinite(op.duration) || op.duration < 0)
  )
    throw new Error("media.invalid_duration");
}
async function decodeAudio(op) {
  audioOptions(op);
  const input = inputFile(op.path);
  let fd;
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error("media.no_audio_track");
    const sourceChannels = await track.getNumberOfChannels();
    if (sourceChannels > 2)
      throw new Error(
        "media.unsupported_channel_layout: only mono/stereo sources are supported",
      );
    // Negative packet timestamps represent decoder preroll before presentation
    // time zero (for example an MP4 edit list). Decode them, but never rebase
    // that padding into the authored timeline.
    const encodedFirst = await track.getFirstTimestamp();
    const first = Math.max(0, encodedFirst);
    const duration = Math.min(
      Math.max(0, (await track.computeDuration()) - first),
      op.duration ?? Infinity,
    );
    const count = Math.max(0, Math.round(duration * op.sampleRate));
    if (!Number.isSafeInteger(count) || count > 0xffffffff / (4 * op.channels))
      throw new Error("media.audio_size_limit");
    fd = fs.openSync(absolute(op.outputPath), "wx", 0o600);
    const header = op.format === "f32" ? 0 : 44;
    if (header) fs.writeSync(fd, wavHeader(count, op.sampleRate, op.channels));
    fs.ftruncateSync(fd, header + count * op.channels * 4);
    // Decode and resample with bounded history and anti-alias filtering. Packet
    // boundaries do not reset the filter or change the requested output timing.
    const resampler = new StreamingAudioResampler({
      sourceRate: await track.getSampleRate(),
      targetRate: op.sampleRate,
      sourceChannels,
      targetChannels: op.channels,
      totalFrames: count,
      sourceOrigin: first,
      onData(startFrame, data) {
        fs.writeSync(
          fd,
          Buffer.from(data.buffer, data.byteOffset, data.byteLength),
          0,
          data.byteLength,
          header + startFrame * op.channels * 4,
        );
      },
    });
    for await (const sample of new mb.AudioSampleSink(track).samples(
      encodedFirst,
      first + duration + resampler.lookaheadSeconds,
    )) {
      let current;
      try {
        if (sample.numberOfChannels !== sourceChannels)
          throw new Error("media.audio_channels_changed");
        const data = new Float32Array(sample.numberOfFrames * sourceChannels);
        sample.copyTo(data, { format: "f32", planeIndex: 0 });
        current = {
          data,
          rate: sample.sampleRate,
          frames: sample.numberOfFrames,
          timestamp: sample.timestamp,
        };
      } finally {
        sample.close();
      }
      resampler.push(current);
      if (resampler.done) break;
    }
    resampler.finish();
    fs.closeSync(fd);
    fd = undefined;
    return {
      path: op.outputPath,
      sampleRate: op.sampleRate,
      channels: op.channels,
      samples: count,
    };
  } catch (error) {
    if (fd !== undefined) {
      fs.closeSync(fd);
      fs.rmSync(op.outputPath, { force: true });
    }
    throw error;
  } finally {
    input.dispose();
  }
}
function envelope(points, sample) {
  if (!points?.length) return 1;
  if (sample <= points[0].sample) return points[0].gain;
  for (let i = 1; i < points.length; i++) {
    if (sample <= points[i].sample) {
      const a = points[i - 1],
        b = points[i];
      return (
        a.gain +
        (b.gain - a.gain) * ((sample - a.sample) / (b.sample - a.sample))
      );
    }
  }
  return points.at(-1).gain;
}
async function mixAudio(op) {
  const plan = op.plan,
    channels = op.channels ?? 2;
  audioOptions({ sampleRate: plan?.sampleRate, channels });
  if (
    !Number.isSafeInteger(plan.durationSamples) ||
    plan.durationSamples < 0 ||
    !Array.isArray(plan.clips)
  )
    throw new Error("media.invalid_audio_plan");
  const directory = scratch("velocast-media-mix-");
  const sources = new Map();
  let fd;
  try {
    for (const clip of plan.clips) {
      if (
        ![clip.startSample, clip.sourceStartSample, clip.durationSamples].every(
          Number.isSafeInteger,
        ) ||
        clip.sourceStartSample < 0 ||
        clip.durationSamples < 0 ||
        !Number.isFinite(clip.gain) ||
        clip.gain < 0
      )
        throw new Error("media.invalid_audio_clip");
      let last = -1;
      for (const point of clip.volumeEnvelope ?? []) {
        if (
          !Number.isSafeInteger(point.sample) ||
          point.sample <= last ||
          point.sample < 0 ||
          !Number.isFinite(point.gain) ||
          point.gain < 0
        )
          throw new Error("media.invalid_envelope");
        last = point.sample;
      }
      if (!sources.has(clip.source)) sources.set(clip.source, { maximum: 0 });
      const source = sources.get(clip.source);
      source.maximum = Math.max(
        source.maximum,
        clip.sourceStartSample + clip.durationSamples,
      );
    }
    for (const [source, state] of sources) {
      const file = path.join(
        directory,
        `${[...sources.keys()].indexOf(source)}.f32`,
      );
      await decodeAudio({
        path: op.sources?.[source] ?? source,
        outputPath: file,
        sampleRate: plan.sampleRate,
        channels,
        duration: state.maximum / plan.sampleRate,
        format: "f32",
      });
      state.fd = fs.openSync(file, "r");
      state.samples = fs.statSync(file).size / (channels * 4);
    }
    fd = fs.openSync(absolute(op.outputPath), "wx", 0o600);
    const hash = createHash("sha256");
    if (op.format !== "f32")
      fs.writeSync(
        fd,
        wavHeader(plan.durationSamples, plan.sampleRate, channels),
      );
    for (let start = 0; start < plan.durationSamples; start += BLOCK) {
      const n = Math.min(BLOCK, plan.durationSamples - start),
        mixed = new Float32Array(n * channels);
      for (const clip of plan.clips) {
        const source = sources.get(clip.source);
        const from = Math.max(start, clip.startSample, 0);
        const to = Math.min(
          start + n,
          clip.startSample + clip.durationSamples,
          clip.startSample + source.samples - clip.sourceStartSample,
        );
        if (to <= from) continue;
        const data = Buffer.alloc((to - from) * channels * 4);
        fs.readSync(
          source.fd,
          data,
          0,
          data.length,
          (clip.sourceStartSample + from - clip.startSample) * channels * 4,
        );
        for (let i = from; i < to; i++) {
          const gain =
            clip.gain * envelope(clip.volumeEnvelope, i - clip.startSample);
          for (let ch = 0; ch < channels; ch++) {
            const index = (i - start) * channels + ch;
            const scaled = Math.fround(
              data.readFloatLE(((i - from) * channels + ch) * 4) * gain,
            );
            mixed[index] = Math.fround(mixed[index] + scaled);
            if (!Number.isFinite(mixed[index]))
              throw new Error("media.nonfinite_mix");
          }
        }
      }
      const bytes = Buffer.from(mixed.buffer);
      hash.update(bytes);
      fs.writeSync(fd, bytes);
    }
    fs.closeSync(fd);
    fd = undefined;
    return {
      path: op.outputPath,
      sampleRate: plan.sampleRate,
      channels,
      samples: plan.durationSamples,
      pcmSha256: hash.digest("hex"),
    };
  } catch (error) {
    if (fd !== undefined) {
      fs.closeSync(fd);
      fs.rmSync(op.outputPath, { force: true });
    }
    throw error;
  } finally {
    for (const source of sources.values())
      if (source.fd !== undefined) fs.closeSync(source.fd);
    // This absolute directory is created above under the OS temp directory and owned by this call.
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
const videoInputs = new Map();
async function videoInput(file) {
  let entry = videoInputs.get(file);
  if (entry) {
    videoInputs.delete(file);
    videoInputs.set(file, entry);
    return entry;
  }
  if (videoInputs.size >= 4) {
    const [key, oldest] = videoInputs.entries().next().value;
    await oldest.iterator?.return();
    oldest.input.dispose();
    videoInputs.delete(key);
  }
  const input = inputFile(file);
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("media.no_video_track");
    if (
      (await track.getDisplayWidth()) * (await track.getDisplayHeight()) * 4 >
      256 * 1024 * 1024
    )
      throw new Error("media.frame_byte_limit");
    entry = {
      input,
      track,
      sink: new mb.CanvasSink(track, { poolSize: 2 }),
      iterator: null,
      current: null,
      next: null,
      exhausted: false,
    };
    videoInputs.set(file, entry);
    return entry;
  } catch (error) {
    input.dispose();
    throw error;
  }
}
async function selectedCanvas(entry, timestamp) {
  const target = Math.round(timestamp * 1e6);
  if (
    !entry.iterator ||
    target < Math.round((entry.current?.timestamp ?? Infinity) * 1e6)
  ) {
    await entry.iterator?.return();
    entry.iterator = entry.sink.canvases(timestamp - 0.0000005);
    entry.current = null;
    entry.next = null;
    entry.exhausted = false;
  }
  while (!entry.exhausted) {
    if (!entry.next) {
      const item = await entry.iterator.next();
      if (item.done) {
        entry.exhausted = true;
        break;
      }
      entry.next = item.value;
    }
    if (Math.round(entry.next.timestamp * 1e6) > target) break;
    entry.current = entry.next;
    entry.next = null;
  }
  return entry.current;
}
async function frame(op) {
  if (!Number.isFinite(op.timestamp))
    throw new Error("media.invalid_timestamp");
  const entry = await videoInput(op.path),
    track = entry.track;
  {
    if (
      (await track.getDisplayWidth()) * (await track.getDisplayHeight()) * 4 >
      (op.maxFrameBytes ?? 256 * 1024 * 1024)
    )
      throw new Error("media.frame_byte_limit");
    const hdr = await track.hasHighDynamicRange();
    let wrapped;
    if (hdr) {
      let pixels, timestamp;
      const failures = [];
      for (const hardwareAcceleration of ["no-preference", "prefer-software"]) {
        let sample, decoded;
        try {
          sample = await new mb.VideoSampleSink(track, {
            hardwareAcceleration,
          }).getSample(op.timestamp + 0.0000005);
          if (!sample) throw new Error("media.frame_unavailable");
          decoded = sample.toVideoFrame();
          pixels = await toneMapFrame(decoded);
          timestamp = sample.timestamp;
          break;
        } catch (error) {
          failures.push(`${hardwareAcceleration}: ${error.message}`);
        } finally {
          decoded?.close();
          sample?.close();
        }
      }
      if (!pixels)
        throw new Error(
          `media.hdr_tonemap_unavailable: high-bit-depth decode failed (${failures.join("; ")})`,
        );
      {
        const raw = new OffscreenCanvas(pixels.width, pixels.height);
        raw
          .getContext("2d")
          .putImageData(
            new ImageData(pixels.data, pixels.width, pixels.height),
            0,
            0,
          );
        const rotation = await track.getRotation(),
          flip = await track.getFlip();
        const canvas = new OffscreenCanvas(
            await track.getDisplayWidth(),
            await track.getDisplayHeight(),
          ),
          context = canvas.getContext("2d");
        context.translate(canvas.width / 2, canvas.height / 2);
        if (flip) context.scale(-1, 1);
        context.rotate((rotation * Math.PI) / 180);
        const width = rotation % 180 ? canvas.height : canvas.width,
          height = rotation % 180 ? canvas.width : canvas.height;
        context.drawImage(raw, -width / 2, -height / 2, width, height);
        wrapped = { canvas, timestamp };
      }
    } else wrapped = await selectedCanvas(entry, op.timestamp);
    if (!wrapped) throw new Error("media.frame_unavailable");
    const canvas = wrapped.canvas;
    let bytes;
    if (op.format === "rgba")
      bytes = canvas
        .getContext("2d")
        .getImageData(0, 0, canvas.width, canvas.height).data;
    else {
      const blob = canvas.convertToBlob
        ? await canvas.convertToBlob({ type: "image/png" })
        : await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      bytes = new Uint8Array(await blob.arrayBuffer());
    }
    fs.writeFileSync(absolute(op.outputPath), bytes, {
      flag: "wx",
      mode: 0o600,
    });
    return {
      path: op.outputPath,
      width: canvas.width,
      height: canvas.height,
      timestamp: wrapped.timestamp,
      normalization: hdr ? "hdr-to-sdr-bt709" : "none",
    };
  }
}
function configKey(config) {
  return JSON.stringify({
    codec: config.codec,
    width: config.codedWidth,
    height: config.codedHeight,
    color: config.colorSpace,
    description: config.description
      ? Array.from(
          new Uint8Array(
            config.description.buffer ?? config.description,
            config.description.byteOffset ?? 0,
            config.description.byteLength,
          ),
        )
      : null,
  });
}

async function audioEncoding(track, requested) {
  return selectAudioEncoder(
    requested ?? "auto",
    {
      sampleRate: await track.getSampleRate(),
      numberOfChannels: await track.getNumberOfChannels(),
    },
    mb.canEncodeAudio,
  );
}

async function encodeAudioTrack(track, source, selection) {
  const first = Math.max(0, await track.getFirstTimestamp());
  // Chromium's AudioToolbox AAC encoder emits 2112 leading PCM samples but
  // timestamps the first packet at the submitted input timestamp. Verified by
  // the pinned macOS encode/decode impulse test (Windows AAC has no such shift).
  // Public AudioSample timestamps carry this offset into encoded packets;
  // Mediabunny writes the corresponding standard MP4 edit list. Keep decoder
  // preroll; do not delete compressed packets or widen duration tolerances.
  // https://chromium.googlesource.com/chromium/src/+/refs/tags/130.0.6723.62/media/audio/audio_encoders_unittest.cc
  const primingSamples =
    selection.codec === "aac" && process.platform === "darwin" ? 2112 : 0;
  selection.appliedEncoderPrimingSamples = primingSamples;
  const primingSeconds = primingSamples / selection.sampleRate;
  if (selection.sourceSampleRate === selection.sampleRate) {
    for await (const sample of new mb.AudioSampleSink(track).samples()) {
      let trimmed;
      try {
        const trimFrames = Math.max(
          0,
          Math.round((first - sample.timestamp) * sample.sampleRate),
        );
        if (trimFrames >= sample.numberOfFrames) continue;
        const presented = trimFrames
          ? (trimmed = sample.trim(trimFrames))
          : sample;
        presented.setTimestamp(presented.timestamp - first - primingSeconds);
        await source.add(presented);
      } finally {
        trimmed?.close();
        sample.close();
      }
    }
    return;
  }
  const pending = [];
  const resampler = new StreamingAudioResampler({
    sourceRate: selection.sourceSampleRate,
    targetRate: selection.sampleRate,
    sourceChannels: selection.numberOfChannels,
    targetChannels: selection.numberOfChannels,
    totalFrames: Math.round(
      Math.max(0, (await track.computeDuration()) - first) *
        selection.sampleRate,
    ),
    sourceOrigin: first,
    onData(startFrame, data) {
      pending.push(
        new mb.AudioSample({
          data: new Float32Array(data),
          format: "f32",
          numberOfChannels: selection.numberOfChannels,
          sampleRate: selection.sampleRate,
          timestamp: (startFrame - primingSamples) / selection.sampleRate,
        }),
      );
    },
  });
  const drain = async () => {
    while (pending.length) {
      const sample = pending.shift();
      try {
        await source.add(sample);
      } finally {
        sample.close();
      }
    }
  };
  try {
    for await (const sample of new mb.AudioSampleSink(track).samples()) {
      try {
        if (sample.numberOfChannels !== selection.numberOfChannels)
          throw new Error("media.audio_channels_changed");
        // Drain after each small input block so an upsampled packet cannot
        // accumulate an unbounded collection of output AudioSamples.
        for (let offset = 0; offset < sample.numberOfFrames; offset += BLOCK) {
          const frames = Math.min(BLOCK, sample.numberOfFrames - offset);
          const data = new Float32Array(frames * sample.numberOfChannels);
          sample.copyTo(data, {
            format: "f32",
            planeIndex: 0,
            frameOffset: offset,
            frameCount: frames,
          });
          resampler.push({
            data,
            frames,
            rate: sample.sampleRate,
            timestamp: sample.timestamp + offset / sample.sampleRate,
          });
          await drain();
        }
      } finally {
        sample.close();
      }
    }
    resampler.finish();
    await drain();
  } finally {
    for (const sample of pending) sample.close();
  }
}

function audioSelectionMetadata(metadata, selection, copied = false) {
  Object.assign(metadata.audio, {
    requestedCodec: selection.requestedCodec,
    fallbackUsed: selection.fallbackUsed,
    sourceSampleRate: selection.sourceSampleRate,
    appliedEncoderPrimingSamples: selection.appliedEncoderPrimingSamples ?? 0,
    copied,
  });
  return metadata;
}
async function mux(op) {
  const inputs = [],
    sink = outputFile(op.outputPath);
  let audioInput;
  try {
    const paths = op.paths ?? [op.videoPath];
    if (!Array.isArray(paths) || !paths.length)
      throw new Error("media.no_segments");
    let videoSource,
      audioSource,
      expected,
      offset = 0;
    for (const file of paths) inputs.push(inputFile(file));
    const tracks = [];
    for (const input of inputs) {
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error("media.no_video_track");
      const config = await track.getDecoderConfig();
      if (!config || (expected && configKey(config) !== expected))
        throw new Error("media.incompatible_segments");
      expected = configKey(config);
      tracks.push({ track, config });
    }
    videoSource = new mb.EncodedVideoPacketSource(
      await tracks[0].track.getCodec(),
    );
    sink.output.addVideoTrack(videoSource, {
      rotation: await tracks[0].track.getRotation(),
    });
    let audioTrack,
      selection,
      copyAudio = false;
    if (op.audioPath) {
      audioInput = inputFile(op.audioPath);
      audioTrack = await audioInput.getPrimaryAudioTrack();
      if (!audioTrack) throw new Error("media.no_audio_track");
      const requested = op.audioCodec ?? "auto";
      if (!["auto", "aac", "opus"].includes(requested))
        throw new Error("media.invalid_audio_codec: use auto, aac or opus");
      const inputCodec = await audioTrack.getCodec();
      copyAudio =
        ["aac", "opus"].includes(inputCodec) &&
        (requested === "auto" || requested === inputCodec);
      selection = copyAudio
        ? {
            codec: inputCodec,
            requestedCodec: requested,
            fallbackUsed: false,
            sourceSampleRate: await audioTrack.getSampleRate(),
          }
        : await audioEncoding(audioTrack, requested);
      audioSource = copyAudio
        ? new mb.EncodedAudioPacketSource(inputCodec)
        : new mb.AudioSampleSource({
            codec: selection.codec,
            bitrate: selection.bitrate,
          });
      sink.output.addAudioTrack(audioSource);
    }
    await sink.output.start();
    const addVideo = async () => {
      for (const { track, config } of tracks) {
        const first = await track.getFirstTimestamp();
        let end = 0,
          count = 0;
        for await (const packet of new mb.EncodedPacketSink(track).packets()) {
          if (!count && packet.type !== "key")
            throw new Error("media.segment_must_start_with_keyframe");
          const time = packet.timestamp - first;
          await videoSource.add(
            packet.clone({ timestamp: offset + time }),
            count++ ? undefined : { decoderConfig: config },
          );
          end = Math.max(end, time + packet.duration);
        }
        if (!count || end <= 0) throw new Error("media.empty_segment");
        offset += end;
      }
      videoSource.close();
    };
    const addAudio = async () => {
      if (!audioTrack) return;
      const first = Math.max(0, await audioTrack.getFirstTimestamp());
      if (copyAudio) {
        let count = 0;
        const decoderConfig = await audioTrack.getDecoderConfig();
        for await (const packet of new mb.EncodedPacketSink(
          audioTrack,
        ).packets())
          await audioSource.add(
            packet.clone({ timestamp: packet.timestamp - first }),
            count++ ? undefined : { decoderConfig },
          );
        audioSource.close();
        return;
      }
      await encodeAudioTrack(audioTrack, audioSource, selection);
      audioSource.close();
    };
    await Promise.all([addVideo(), addAudio()]);
    await sink.output.finalize();
    sink.close();
    const metadata = await probe({ path: op.outputPath });
    return selection
      ? audioSelectionMetadata(metadata, selection, copyAudio)
      : metadata;
  } catch (error) {
    await sink.cancel();
    throw error;
  } finally {
    for (const input of inputs) input.dispose();
    audioInput?.dispose();
  }
}
async function encodeFrames(op) {
  if (!Array.isArray(op.framePaths) || !op.framePaths.length)
    throw new Error("media.no_frames");
  const sink = outputFile(op.outputPath),
    codec = new CodecSession(VideoEncoder, VideoFrame);
  try {
    const config = await codec.open(op);
    const source = new mb.EncodedVideoPacketSource(
      config.logicalCodec === "h264" ? "avc" : config.logicalCodec,
    );
    sink.output.addVideoTrack(source, {
      ...(op.timestamps ? {} : { frameRate: op.fps }),
      rotation: op.rotation ?? 0,
    });
    await sink.output.start();
    for (let index = 0; index < op.framePaths.length; index++) {
      const bitmap = await createImageBitmap(
        new Blob([fs.readFileSync(absolute(op.framePaths[index]))]),
      );
      let result;
      const timing = op.timestamps
        ? {
            timestamp: Math.round(op.timestamps[index] * 1e6),
            duration: Math.round(
              ((op.timestamps[index + 1] ?? op.timestamps[index] + 1 / op.fps) -
                op.timestamps[index]) *
                1e6,
            ),
          }
        : undefined;
      try {
        result = await codec.encode(
          {
            getVideoFrame: () => new VideoFrame(bitmap, { timestamp: 0 }),
            release() {},
          },
          index,
          timing,
        );
      } finally {
        bitmap.close();
      }
      await source.add(
        new mb.EncodedPacket(
          result.data,
          result.type,
          result.timestamp / 1e6,
          result.duration / 1e6,
        ),
        result.metadata,
      );
    }
    await codec.finish();
    source.close();
    await sink.output.finalize();
    sink.close();
    return await probe({ path: op.outputPath });
  } catch (error) {
    if (codec.encoder && codec.encoder.state !== "closed")
      codec.encoder.close();
    await sink.cancel();
    throw error;
  }
}
async function runMediaOperation(op) {
  if (!op || typeof op.kind !== "string")
    throw new Error("media.invalid_operation");
  if (op.kind === "probe") return probe(op);
  if (op.kind === "frame") return frame(op);
  if (op.kind === "frame-hashes") {
    const input = inputFile(op.path);
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error("media.no_video_track");
      const hashes = [];
      for await (const { canvas } of new mb.CanvasSink(track, {
        poolSize: 1,
      }).canvases()) {
        if (hashes.length >= (op.maxFrames ?? 250000))
          throw new Error("media.frame_index_limit");
        const pixels = canvas
          .getContext("2d")
          .getImageData(0, 0, canvas.width, canvas.height).data;
        hashes.push(createHash("sha256").update(pixels).digest("hex"));
      }
      return { hashes, frameCount: hashes.length };
    } finally {
      input.dispose();
    }
  }
  if (op.kind === "image-rgba") {
    const bitmap = await createImageBitmap(
      new Blob([fs.readFileSync(absolute(op.path))]),
    );
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
        context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      fs.writeFileSync(
        absolute(op.outputPath),
        context.getImageData(0, 0, bitmap.width, bitmap.height).data,
        { flag: "wx", mode: 0o600 },
      );
      return {
        path: op.outputPath,
        width: bitmap.width,
        height: bitmap.height,
      };
    } finally {
      bitmap.close();
    }
  }
  if (op.kind === "decode-audio") return decodeAudio(op);
  if (op.kind === "encode-audio") {
    const input = inputFile(op.path),
      sink = outputFile(op.outputPath);
    try {
      const track = await input.getPrimaryAudioTrack();
      if (!track) throw new Error("media.no_audio_track");
      const selection = await audioEncoding(track, op.audioCodec ?? op.codec);
      const source = new mb.AudioSampleSource({
        codec: selection.codec,
        bitrate: selection.bitrate,
      });
      sink.output.addAudioTrack(source);
      await sink.output.start();
      await encodeAudioTrack(track, source, selection);
      source.close();
      await sink.output.finalize();
      sink.close();
      return audioSelectionMetadata(
        await probe({ path: op.outputPath }),
        selection,
      );
    } catch (error) {
      await sink.cancel();
      throw error;
    } finally {
      input.dispose();
    }
  }
  if (op.kind === "mix-audio") return mixAudio(op);
  if (op.kind === "mux-audio" || op.kind === "concat") return mux(op);
  if (
    op.kind === "mux-audio-plan" ||
    (op.kind === "encode-frames" && op.audioPath)
  ) {
    const directory = scratch("velocast-media-mux-");
    try {
      if (op.kind === "mux-audio-plan") {
        const audioPath = path.join(directory, "audio.wav");
        const mixed = await mixAudio({
          ...op.audio,
          plan: op.audio.plan,
          outputPath: audioPath,
          channels: 2,
        });
        const result = await mux({
          ...op,
          audioPath,
          audioCodec: op.audioCodec ?? op.audio.audioCodec ?? op.audio.codec,
        });
        result.audio.pcmSha256 = mixed.pcmSha256;
        return result;
      }
      const videoPath = path.join(directory, "video.mp4");
      await encodeFrames({
        ...op,
        outputPath: videoPath,
        audioPath: undefined,
      });
      return await mux({ ...op, videoPath });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
  if (op.kind === "encode-frames") return encodeFrames(op);
  throw new Error(`media.unknown_operation: ${op.kind}`);
}
module.exports = { runMediaOperation, envelope, wavHeader };
