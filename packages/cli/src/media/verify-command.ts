import { stat } from "node:fs/promises";
import { runMediaOperation, type MediaProbe } from "./media-runtime.js";
import {
  resolveCliOutputPath,
  type InvocationPathOptions,
} from "../project/paths.js";

export interface VerifyMediaOptions {
  json?: boolean;
  expectFrames?: number | string;
  expectFps?: number | string;
  expectWidth?: number | string;
  expectHeight?: number | string;
  expectAudio?: boolean;
}

export interface VerifyMediaDependencies {
  pathOptions?: InvocationPathOptions;
  probe?: (path: string) => Promise<MediaProbe>;
  write?: (text: string) => void;
}

function expectation(
  value: number | string | undefined,
  name: string,
  integer = true,
) {
  if (value === undefined) return;
  const number = typeof value === "number" ? value : Number(value);
  if (
    !Number.isFinite(number) ||
    number <= 0 ||
    (integer && !Number.isSafeInteger(number))
  )
    throw new Error(
      `verify.invalid_expectation: ${name} must be a positive ${integer ? "safe integer" : "number"}`,
    );
  return number;
}

/** Bounded demux/timestamp verification. It does not decode pixels or judge sound quality. */
export async function verifyMediaCommand(
  input: string,
  options: VerifyMediaOptions = {},
  dependencies: VerifyMediaDependencies = {},
) {
  const frames = expectation(options.expectFrames, "--expect-frames");
  const fps = expectation(options.expectFps, "--expect-fps", false);
  const width = expectation(options.expectWidth, "--expect-width");
  const height = expectation(options.expectHeight, "--expect-height");
  const path = resolveCliOutputPath(input, dependencies.pathOptions);
  const file = await stat(path);
  if (!file.isFile() || file.size === 0)
    throw new Error("verify.invalid_file: expected a nonempty media file");
  const probe = await (
    dependencies.probe ??
    ((path: string) =>
      runMediaOperation<MediaProbe>({
        kind: "probe",
        path,
        frames: true,
        maxFrames: 2_000_000,
      }))
  )(path);
  const issues: string[] = [];
  const video = probe.video;
  const timestamps = video?.frames;
  if (!Number.isFinite(probe.duration) || probe.duration <= 0)
    issues.push("media duration must be positive and finite");
  if (!video || !timestamps?.length)
    issues.push("media has no indexed video frames");
  if (
    video &&
    (!Number.isSafeInteger(video.width) ||
      video.width <= 0 ||
      !Number.isSafeInteger(video.height) ||
      video.height <= 0)
  )
    issues.push("video dimensions must be positive integers");
  if (frames !== undefined && timestamps?.length !== frames)
    issues.push(
      `frame count: expected ${frames}, found ${timestamps?.length ?? 0}`,
    );
  if (width !== undefined && video?.width !== width)
    issues.push(`width: expected ${width}, found ${video?.width ?? "none"}`);
  if (height !== undefined && video?.height !== height)
    issues.push(`height: expected ${height}, found ${video?.height ?? "none"}`);
  if (options.expectAudio && !probe.audio)
    issues.push("expected an audio track, found none");
  if (
    probe.audio &&
    (!Number.isFinite(probe.audio.duration) ||
      probe.audio.duration <= 0 ||
      !Number.isSafeInteger(probe.audio.sampleRate) ||
      probe.audio.sampleRate <= 0 ||
      !Number.isSafeInteger(probe.audio.channels) ||
      probe.audio.channels <= 0)
  )
    issues.push("audio duration, sample rate and channels must be positive");
  if (video && timestamps?.length) {
    const base = video.timeBase;
    const tick = base.numerator / base.denominator;
    if (
      !Number.isSafeInteger(base.numerator) ||
      base.numerator <= 0 ||
      !Number.isSafeInteger(base.denominator) ||
      base.denominator <= 0
    )
      issues.push("video has an invalid timestamp time base");
    else {
      let previous = -Infinity;
      let timestampIssue = false;
      let cadenceIssue = false;
      for (const [index, frame] of timestamps.entries()) {
        const seconds = frame.pts * tick;
        if (
          !Number.isSafeInteger(frame.pts) ||
          !Number.isSafeInteger(frame.duration) ||
          frame.duration <= 0 ||
          seconds < 0 ||
          seconds <= previous
        )
          timestampIssue = true;
        if (
          fps !== undefined &&
          (Math.abs(seconds - index / fps) > tick + 1e-9 ||
            Math.abs(frame.duration * tick - 1 / fps) > tick + 1e-9)
        )
          cadenceIssue = true;
        previous = seconds;
      }
      if (timestampIssue)
        issues.push("video timestamps must increase with positive durations");
      if (cadenceIssue)
        issues.push(
          `video timestamps or frame durations do not match ${fps}fps starting at zero`,
        );
    }
  }
  const result = {
    apiVersion: 1,
    status: issues.length ? ("failure" as const) : ("success" as const),
    level: "metadata" as const,
    path,
    bytes: file.size,
    container: probe.container,
    durationSeconds: probe.duration,
    video: video
      ? {
          width: video.width,
          height: video.height,
          codec: video.codec,
          frameCount: timestamps?.length ?? 0,
          durationSeconds: video.duration,
        }
      : null,
    audio: probe.audio ?? null,
    issues,
  };
  const write =
    dependencies.write ?? ((text: string) => process.stdout.write(text));
  write(
    options.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : `${result.status === "success" ? "Verified media metadata" : "Media verification failed"}: ${path}\n${video ? `${video.width}x${video.height}, ${timestamps?.length ?? 0} frames, ${probe.duration}s, ${probe.audio ? "with audio" : "silent"}\n` : ""}${issues.map((issue) => `  ${issue}\n`).join("")}`,
  );
  if (issues.length) throw new MediaVerificationError(result);
  return result;
}

export class MediaVerificationError extends Error {
  constructor(readonly result: { issues: string[] }) {
    super(`verify.mismatch: ${result.issues.join("; ")}`);
  }
}
