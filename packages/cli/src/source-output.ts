import {
  runMediaOperation,
  type MediaProbe,
  type MediaRunner,
} from "./media-runtime.js";
import { lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

export interface SourceOutputOptions {
  /** Final MP4 path. Existing bytes are replaced only after the new file passes validation. */
  output: string;
  /** Render an MP4 to the owned staging path; it may already contain audio. */
  renderVideo: (videoPath: string, signal: AbortSignal) => Promise<void>;
  /** Render finished audio after video evaluation, or return null to retain existing audio or silence. */
  renderAudio: (
    audioPath: string,
    signal: AbortSignal,
  ) => Promise<string | null>;
  signal?: AbortSignal;
  mediaRunner?: MediaRunner;
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  nb_frames?: string;
  start_time?: string;
  duration?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
}

interface ProbeResult {
  videoTrackCount?: number;
  audioTrackCount?: number;
  streams?: ProbeStream[];
  format?: { duration?: string };
}

/**
 * Publish a source-owned video and optional finished audio as one transaction.
 * The callbacks write into a uniquely owned sibling directory, and the final
 * path is touched only by the last rename after media validation succeeds.
 */
export async function renderSourceOutput(
  options: SourceOutputOptions,
): Promise<string> {
  const media = options.mediaRunner ?? runMediaOperation;
  const output = resolve(options.output);
  if (extname(output).toLowerCase() !== ".mp4") {
    throw new Error("Source output must be an MP4 path");
  }
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();

  await mkdir(dirname(output), { recursive: true });
  const stage = await mkdtemp(
    join(dirname(output), `.${basename(output)}.velocast-`),
  );
  const video = join(stage, "video.mp4");
  const audio = join(stage, "audio.wav");
  const muxed = join(stage, "muxed.mp4");
  try {
    signal.throwIfAborted();
    await options.renderVideo(video, signal);
    signal.throwIfAborted();
    await assertRegularFile(video, "Video renderer");
    const videoProbe = await probe(video, media, signal);
    const sourceHasAudio =
      videoProbe.streams?.some((stream) => stream.codec_type === "audio") ??
      false;
    assertStreams(
      videoProbe,
      { video: true, audio: sourceHasAudio },
      "Video renderer",
    );

    const audioSource = await options.renderAudio(audio, signal);
    signal.throwIfAborted();
    let candidate = video;
    if (audioSource !== null) {
      if (sourceHasAudio) {
        throw new Error(
          "Cannot add source audio to a video that already has audio",
        );
      }
      await assertRegularFile(audioSource, "Audio renderer");
      const audioProbe = await probe(audioSource, media, signal);
      assertStreams(
        audioProbe,
        { video: false, audio: true },
        "Audio renderer",
      );
      await media(
        {
          kind: "mux-audio",
          videoPath: video,
          audioPath: audioSource,
          outputPath: muxed,
        },
        { signal },
      );
      candidate = muxed;
    }

    await assertRegularFile(candidate, "Final media");
    const finalProbe = await probe(candidate, media, signal);
    assertStreams(
      finalProbe,
      { video: true, audio: sourceHasAudio || audioSource !== null },
      "Final media",
    );
    assertVideoCopy(videoProbe, finalProbe);
    signal.throwIfAborted();
    await rename(candidate, output);
    return output;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function assertRegularFile(
  path: string,
  producer: string,
): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile() || info.size === 0) {
    throw new Error(
      `${producer} did not produce a nonempty regular file: ${path}`,
    );
  }
}

async function probe(
  path: string,
  media: MediaRunner,
  signal: AbortSignal,
): Promise<ProbeResult> {
  const result = await media<MediaProbe>(
    { kind: "probe", path, frames: true },
    { signal },
  );
  return {
    videoTrackCount: result.videoTrackCount,
    audioTrackCount: result.audioTrackCount,
    format: { duration: String(result.duration) },
    streams: [
      ...(result.video
        ? [
            {
              codec_type: "video",
              codec_name: result.video.codec,
              width: result.video.width,
              height: result.video.height,
              nb_frames: result.video.frames
                ? String(result.video.frames.length)
                : undefined,
              duration: String(result.video.duration ?? result.duration),
              start_time: result.video.frames?.length
                ? String(
                    (result.video.frames[0]!.pts *
                      result.video.timeBase.numerator) /
                      result.video.timeBase.denominator,
                  )
                : undefined,
            },
          ]
        : []),
      ...(result.audio
        ? [{ codec_type: "audio", duration: String(result.audio.duration) }]
        : []),
    ],
  };
}

function assertStreams(
  result: ProbeResult,
  expected: { video: boolean; audio: boolean },
  producer: string,
): void {
  const types = result.streams?.map((stream) => stream.codec_type) ?? [];
  const videoCount =
    result.videoTrackCount ?? types.filter((type) => type === "video").length;
  const audioCount =
    result.audioTrackCount ?? types.filter((type) => type === "audio").length;
  const duration = mediaDuration(result);
  if (
    videoCount !== Number(expected.video) ||
    audioCount !== Number(expected.audio) ||
    !Number.isFinite(duration) ||
    duration <= 0
  ) {
    throw new Error(`${producer} produced invalid media streams or duration`);
  }
}

function mediaDuration(result: ProbeResult): number {
  return Number(result.format?.duration);
}

function assertVideoCopy(source: ProbeResult, final: ProbeResult): void {
  const original = source.streams?.find(
    (stream) => stream.codec_type === "video",
  );
  const published = final.streams?.find(
    (stream) => stream.codec_type === "video",
  );
  if (!original || !published) {
    throw new Error("Final media is missing the rendered video stream");
  }
  for (const field of ["width", "height"] as const) {
    if (original[field] !== undefined && original[field] !== published[field]) {
      throw new Error(
        `Final media video ${field} differs from the rendered video`,
      );
    }
  }
  const originalFrames = positiveNumber(original.nb_frames);
  if (
    originalFrames !== null &&
    originalFrames !== positiveNumber(published.nb_frames)
  ) {
    throw new Error("Final media frame count differs from the rendered video");
  }

  const frameDuration = frameDurationSeconds(original);
  const tolerance = Math.max(
    frameDuration === null ? 0 : frameDuration * 2,
    0.05,
  );
  for (const field of ["start_time", "duration"] as const) {
    const before = finiteNumber(original[field]);
    if (before === null) continue;
    const after = finiteNumber(published[field]);
    if (after === null || Math.abs(after - before) > tolerance) {
      throw new Error(
        `Final media video ${field} differs from the rendered video`,
      );
    }
  }
  if (
    Math.abs(mediaDuration(final) - mediaDuration(source)) >
    tolerance + 0.05
  ) {
    throw new Error("Final media duration differs from the rendered video");
  }
}

function finiteNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveNumber(value: string | undefined): number | null {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function frameDurationSeconds(stream: ProbeStream): number | null {
  for (const rate of [stream.avg_frame_rate, stream.r_frame_rate]) {
    if (!rate) continue;
    const [numerator, denominator = "1"] = rate.split("/");
    const framesPerSecond = Number(numerator) / Number(denominator);
    if (Number.isFinite(framesPerSecond) && framesPerSecond > 0) {
      return 1 / framesPerSecond;
    }
  }
  const duration = positiveNumber(stream.duration);
  const frames = positiveNumber(stream.nb_frames);
  return duration !== null && frames !== null ? duration / frames : null;
}
