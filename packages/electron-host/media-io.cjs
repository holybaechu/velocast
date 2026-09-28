"use strict";
const fs = require("node:fs");
const path = require("node:path");
const mb = require("mediabunny");
const { containerFor } = require("./media-settings.cjs");
function outputFormat(container) {
  const Format = {
    mp4: mb.Mp4OutputFormat,
    mov: mb.MovOutputFormat,
    webm: mb.WebMOutputFormat,
    mkv: mb.MkvOutputFormat,
  }[container];
  if (!Format) throw new Error("media.invalid_container");
  return new Format(
    ["mp4", "mov"].includes(container) ? { fastStart: false } : {},
  );
}

function absolute(file) {
  if (typeof file !== "string" || !path.isAbsolute(file))
    throw new Error("media.absolute_path_required");
  return file;
}
function inputFile(file) {
  const fd = fs.openSync(absolute(file), "r");
  const size = fs.fstatSync(fd).size;
  let closed = false;
  return new mb.Input({
    formats: mb.ALL_FORMATS,
    source: new mb.CustomSource({
      getSize: () => size,
      read(start, end) {
        const bytes = Buffer.alloc(end - start);
        let read = 0;
        while (read < bytes.length) {
          const count = fs.readSync(
            fd,
            bytes,
            read,
            bytes.length - read,
            start + read,
          );
          if (!count) throw new Error("media.truncated_input");
          read += count;
        }
        return bytes;
      },
      dispose() {
        if (!closed) {
          closed = true;
          fs.closeSync(fd);
        }
      },
      maxCacheSize: 8 * 1024 * 1024,
    }),
  });
}
function outputFile(file, container) {
  const format = outputFormat(containerFor(file, container));
  const fd = fs.openSync(absolute(file), "wx", 0o600);
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      fs.closeSync(fd);
    }
  };
  const output = new mb.Output({
    format,
    target: new mb.StreamTarget(
      new WritableStream({
        write({ data, position }) {
          let written = 0;
          while (written < data.byteLength)
            written += fs.writeSync(
              fd,
              data,
              written,
              data.byteLength - written,
              position + written,
            );
        },
        close,
        abort: close,
      }),
      { chunked: true, chunkSize: 1024 * 1024 },
    ),
  });
  return {
    output,
    close,
    async cancel() {
      try {
        if (output.state !== "finalized") await output.cancel();
      } finally {
        close();
        fs.rmSync(file, { force: true });
      }
    },
  };
}
async function probe({
  path: file,
  frames = false,
  maxFrames = 2_000_000,
  maxIndexBytes = 128 * 1024 * 1024,
  maxFrameBytes = 256 * 1024 * 1024,
}) {
  if (
    ![maxFrames, maxIndexBytes, maxFrameBytes].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  )
    throw new Error("media.invalid_probe_budget");
  const input = inputFile(file);
  try {
    const result = {
      path: file,
      bytes: fs.statSync(file).size,
      duration: await input.computeDuration(undefined, { metadataOnly: false }),
    };
    const format = await input.getFormat();
    result.container =
      format === mb.QTFF
        ? "mov"
        : format === mb.WEBM
          ? "webm"
          : format === mb.MATROSKA
            ? "mkv"
            : format === mb.MP4
              ? "mp4"
              : format.name;
    result.videoTrackCount = (await input.getVideoTracks()).length;
    result.audioTrackCount = (await input.getAudioTracks()).length;
    const video = await input.getPrimaryVideoTrack();
    if (video) {
      const resolution = await video.getTimeResolution();
      const timeResolution =
        Number.isSafeInteger(resolution) && resolution > 0
          ? resolution
          : 1000000;
      result.video = {
        width: await video.getDisplayWidth(),
        height: await video.getDisplayHeight(),
        codedWidth: await video.getCodedWidth(),
        codedHeight: await video.getCodedHeight(),
        rotation: await video.getRotation(),
        codec: await video.getCodec(),
        colorSpace: await video.getColorSpace(),
        timeBase: { numerator: 1, denominator: timeResolution },
        duration: await video.computeDuration(),
      };
      if (result.video.width * result.video.height * 4 > maxFrameBytes)
        throw new Error("media.frame_byte_limit");
      {
        result.video.frameCount = 0;
        result.video.firstTimestamp = null;
        result.video.lastTimestamp = null;
        let indexBytes = 2;
        if (frames) result.video.frames = [];
        for await (const packet of new mb.EncodedPacketSink(video).packets(
          undefined,
          undefined,
          { metadataOnly: true },
        )) {
          result.video.frameCount++;
          result.video.firstTimestamp = Math.min(
            result.video.firstTimestamp ?? Infinity,
            packet.timestamp,
          );
          result.video.lastTimestamp = Math.max(
            result.video.lastTimestamp ?? -Infinity,
            packet.timestamp,
          );
          if (frames) {
            const indexed = {
              pts: Math.round(packet.timestamp * timeResolution),
              duration: Math.round(packet.duration * timeResolution),
              keyframe: packet.type === "key",
            };
            indexBytes +=
              Buffer.byteLength(JSON.stringify(indexed), "utf8") + 1;
            if (
              result.video.frames.length >= maxFrames ||
              indexBytes > maxIndexBytes
            )
              throw new Error("media.frame_index_limit");
            result.video.frames.push(indexed);
          }
        }
        result.video.frames?.sort((a, b) => a.pts - b.pts);
      }
    }
    const audio = await input.getPrimaryAudioTrack();
    if (audio)
      result.audio = {
        codec: await audio.getCodec(),
        sampleRate: await audio.getSampleRate(),
        channels: await audio.getNumberOfChannels(),
        duration: await audioDuration(audio),
      };
    if (result.audio)
      result.duration = Math.max(result.duration, result.audio.duration);
    return result;
  } finally {
    input.dispose();
  }
}
// Matroska SimpleBlocks can omit the final audio packet's duration. Read the
// final decoded sample rather than truncating audio at that packet's start.
async function audioDuration(track) {
  const duration = await track.computeDuration({ metadataOnly: false });
  const last = await new mb.EncodedPacketSink(track).getPacket(Infinity);
  if (!last || last.duration > 0 || !(await track.canDecode())) return duration;
  // Some native audio decoders require earlier packets to establish their
  // block size. Stream the track with bounded sample ownership instead of
  // seeking into an isolated final FLAC/AAC packet.
  let end = duration;
  for await (const sample of new mb.AudioSampleSink(track).samples()) {
    try {
      end = Math.max(
        end,
        sample.timestamp + sample.numberOfFrames / sample.sampleRate,
      );
    } finally {
      sample.close();
    }
  }
  return end;
}
module.exports = {
  mb,
  absolute,
  inputFile,
  outputFile,
  outputFormat,
  probe,
  audioDuration,
};
