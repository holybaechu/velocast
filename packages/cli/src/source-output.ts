import {
  runMediaOperation,
  type MediaProbe,
  type MediaRunner,
} from "./media-runtime.js";
import { lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { RendererAudioCodec, RendererContainer } from "@velocast/core";
import type { CompositionManifest } from "./generated/renderer-contracts.js";

export interface SourceOutputOptions {
  /** Final supported-container path. Existing bytes are replaced only after validation. */
  output: string;
  /** Explicit final format; otherwise inferred from the output path extension. */
  container?: RendererContainer;
  /** Selected mux audio codec, forwarded when separate audio is added. */
  audioCodec?: RendererAudioCodec;
  /** Expected full composition, covering source frames [0, durationFrames). */
  composition?: CompositionManifest;
  /** Render the requested container to the owned staging path; it may already contain audio. */
  renderVideo: (videoPath: string, signal: AbortSignal) => Promise<void>;
  /** Render finished audio after video evaluation, or return null to retain existing audio or silence. */
  renderAudio: (
    audioPath: string,
    signal: AbortSignal,
  ) => Promise<string | null>;
  signal?: AbortSignal;
  mediaRunner?: MediaRunner;
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
  const container = options.container ?? extname(output).slice(1).toLowerCase();
  const extension = `.${container}`;
  if (![".mp4", ".mov", ".webm", ".mkv"].includes(extension))
    throw new Error("Source output must use .mp4, .mov, .webm, or .mkv");
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();

  await mkdir(dirname(output), { recursive: true });
  const stage = await mkdtemp(
    join(dirname(output), `.${basename(output)}.velocast-`),
  );
  const video = join(stage, `video${extension}`);
  const audio = join(stage, "audio.wav");
  const muxed = join(stage, `muxed${extension}`);
  try {
    signal.throwIfAborted();
    await options.renderVideo(video, signal);
    signal.throwIfAborted();
    await assertRegularFile(video, "Video renderer");
    const videoProbe = await probe(video, media, signal);
    const sourceHasAudio = videoProbe.audio !== undefined;
    assertStreams(
      videoProbe,
      { video: true, audio: sourceHasAudio },
      "Video renderer",
    );
    assertContainer(videoProbe, container, "Video renderer");
    if (options.composition)
      assertComposition(videoProbe, options.composition, "Video renderer");

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
          ...(options.composition ? { fps: options.composition.fps } : {}),
          ...(options.audioCodec ? { audioCodec: options.audioCodec } : {}),
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
    assertContainer(finalProbe, container, "Final media");
    assertVideoCopy(videoProbe, finalProbe);
    if (options.composition)
      assertComposition(finalProbe, options.composition, "Final media");
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
): Promise<MediaProbe> {
  return media<MediaProbe>({ kind: "probe", path, frames: true }, { signal });
}

function assertStreams(
  result: MediaProbe,
  expected: { video: boolean; audio: boolean },
  producer: string,
): void {
  const videoCount = result.videoTrackCount ?? Number(!!result.video);
  const audioCount = result.audioTrackCount ?? Number(!!result.audio);
  const duration = result.duration;
  if (
    videoCount !== Number(expected.video) ||
    audioCount !== Number(expected.audio) ||
    !Number.isFinite(duration) ||
    duration <= 0
  ) {
    throw new Error(`${producer} produced invalid media streams or duration`);
  }
}

function assertComposition(
  result: MediaProbe,
  composition: CompositionManifest,
  producer: string,
): void {
  const video = result.video;
  if (
    !video ||
    video.width !== composition.width ||
    video.height !== composition.height
  )
    throw new Error(`${producer} dimensions differ from the composition`);
  if (video.frames?.length !== composition.durationFrames)
    throw new Error(`${producer} frame count differs from the composition`);
  const tick = video.timeBase.numerator / video.timeBase.denominator;
  if (!Number.isFinite(tick) || tick <= 0)
    throw new Error(`${producer} returned an invalid video time base`);
  // Container timestamps round to ticks, after WebCodecs rounds to microseconds.
  // Do not tolerate an entire frame when the time base equals the frame rate.
  const tolerance = tick / 2 + 1e-6;
  if (
    video.frames.some(
      (frame, index) =>
        !Number.isFinite(frame.pts) ||
        Math.abs(frame.pts * tick - index / composition.fps) > tolerance,
    )
  )
    throw new Error(`${producer} frame timing differs from the composition`);
  const duration = video.duration ?? result.duration;
  if (
    !Number.isFinite(duration) ||
    Math.abs(duration - composition.durationFrames / composition.fps) >
      tolerance
  )
    throw new Error(`${producer} duration differs from the composition`);
}

function assertContainer(
  result: MediaProbe,
  container: string,
  producer: string,
): void {
  if (result.container !== container)
    throw new Error(
      `${producer} container differs from requested ${container}: ${result.container ?? "unknown"}`,
    );
}

function assertVideoCopy(source: MediaProbe, final: MediaProbe): void {
  const original = source.video;
  const published = final.video;
  if (!original || !published) {
    throw new Error("Final media is missing the rendered video stream");
  }
  for (const field of ["width", "height"] as const) {
    if (original[field] !== published[field]) {
      throw new Error(
        `Final media video ${field} differs from the rendered video`,
      );
    }
  }
  const originalFrames = original.frames;
  const publishedFrames = published.frames;
  if (
    !originalFrames?.length ||
    originalFrames.length !== publishedFrames?.length
  ) {
    throw new Error("Final media frame count differs from the rendered video");
  }
  const originalTick =
    original.timeBase.numerator / original.timeBase.denominator;
  const publishedTick =
    published.timeBase.numerator / published.timeBase.denominator;
  if (
    !Number.isFinite(originalTick) ||
    originalTick <= 0 ||
    !Number.isFinite(publishedTick) ||
    publishedTick <= 0
  )
    throw new Error("Final media returned an invalid video time base");
  // Remuxing may round the original PTS to the final container's time base.
  // Do not permit a whole frame when one tick equals the frame interval.
  const tolerance = publishedTick / 2 + 2e-6;
  for (let index = 0; index < originalFrames.length; index++) {
    const before = originalFrames[index]!.pts * originalTick;
    const after = publishedFrames[index]!.pts * publishedTick;
    if (
      !Number.isFinite(before) ||
      !Number.isFinite(after) ||
      Math.abs(after - before) > tolerance
    )
      throw new Error(
        "Final media frame timing differs from the rendered video",
      );
  }
  const originalDuration = original.duration ?? source.duration;
  const publishedDuration = published.duration ?? final.duration;
  if (
    !Number.isFinite(originalDuration) ||
    !Number.isFinite(publishedDuration) ||
    Math.abs(publishedDuration - originalDuration) > tolerance
  )
    throw new Error(
      "Final media video duration differs from the rendered video",
    );
  // Encoded audio packet padding can extend the container beyond the video.
  if (Math.abs(final.duration - source.duration) > tolerance + 0.05) {
    throw new Error("Final media duration differs from the rendered video");
  }
}
