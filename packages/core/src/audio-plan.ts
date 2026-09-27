import { createFrameRange, framesToSamples } from "./time.js";
import type { TimeRounding } from "./time.js";

/**
 * Positions count sample frames (one sample per channel) at AudioPlan.sampleRate.
 * sourceStartSample is measured AFTER decoding/resampling, with decoder priming
 * removed. It is not an encoded packet index and never includes the old
 * Remotion reference's observed 2,048-sample output delay.
 */
export interface AudioEnvelopePoint {
  readonly sample: number;
  readonly gain: number;
}

export interface AudioClip {
  readonly source: string;
  readonly startSample: number;
  readonly sourceStartSample: number;
  readonly durationSamples: number;
  readonly gain: number;
  /** Linear gain multiplier at clip-local sample positions; endpoints extend constantly. */
  readonly volumeEnvelope?: readonly AudioEnvelopePoint[];
}

export interface AudioPlan {
  readonly sampleRate: number;
  readonly durationSamples: number;
  readonly clips: readonly AudioClip[];
}

function integer(value: number, name: string, nonnegative = false): number {
  if (!Number.isSafeInteger(value) || (nonnegative && value < 0)) {
    throw new RangeError(
      `${name} must be a ${nonnegative ? "nonnegative " : ""}safe integer`,
    );
  }
  return value === 0 ? 0 : value;
}

/** Validate and snapshot a plan. No file access, implicit gain normalization or clipping. */
export function validateAudioPlan(plan: AudioPlan): AudioPlan {
  if (!plan || typeof plan !== "object" || Array.isArray(plan))
    throw new TypeError("audio plan must be an object");
  integer(plan.sampleRate, "sampleRate", true);
  if (plan.sampleRate === 0)
    throw new RangeError("sampleRate must be positive");
  const durationSamples = integer(
    plan.durationSamples,
    "durationSamples",
    true,
  );
  if (!Array.isArray(plan.clips)) throw new TypeError("clips must be an array");
  const clips = plan.clips.map((clip): AudioClip => {
    if (!clip || typeof clip !== "object" || Array.isArray(clip))
      throw new TypeError("clip must be an object");
    if (
      typeof clip.source !== "string" ||
      !clip.source.trim() ||
      /[\0\r\n]/.test(clip.source)
    )
      throw new TypeError(
        "clip source must be a nonempty path without NUL/newlines",
      );
    const startSample = integer(clip.startSample, "startSample");
    const sourceStartSample = integer(
      clip.sourceStartSample,
      "sourceStartSample",
      true,
    );
    const clipDuration = integer(
      clip.durationSamples,
      "clip durationSamples",
      true,
    );
    integer(startSample + clipDuration, "clip output end");
    integer(sourceStartSample + clipDuration, "clip source end", true);
    if (!Number.isFinite(clip.gain) || clip.gain < 0)
      throw new RangeError("clip gain must be finite and nonnegative");
    let volumeEnvelope: readonly AudioEnvelopePoint[] | undefined;
    if (clip.volumeEnvelope !== undefined) {
      if (
        !Array.isArray(clip.volumeEnvelope) ||
        clip.volumeEnvelope.length === 0 ||
        clip.volumeEnvelope.length > 10000
      )
        throw new RangeError("volumeEnvelope must contain 1 to 10000 points");
      let previous = -1;
      volumeEnvelope = Object.freeze(
        clip.volumeEnvelope.map((point: AudioEnvelopePoint) => {
          if (!point || typeof point !== "object")
            throw new TypeError("envelope point must be an object");
          const sample = integer(point.sample, "envelope sample", true);
          if (sample <= previous || sample > clipDuration)
            throw new RangeError(
              "envelope samples must increase within the clip duration",
            );
          if (!Number.isFinite(point.gain) || point.gain < 0)
            throw new RangeError(
              "envelope gain must be finite and nonnegative",
            );
          previous = sample;
          return Object.freeze({ sample, gain: point.gain });
        }),
      );
    }
    return Object.freeze({
      ...(volumeEnvelope ? { volumeEnvelope } : {}),
      source: clip.source,
      startSample,
      sourceStartSample,
      durationSamples: clipDuration,
      gain: clip.gain === 0 ? 0 : clip.gain,
    });
  });
  return Object.freeze({
    sampleRate: plan.sampleRate,
    durationSamples,
    clips: Object.freeze(clips),
  });
}

/**
 * Slice [startSample,endSample), rebase output to zero, and advance source trims
 * by the same amount. Negative clip starts are preroll; negative source starts
 * are invalid. Muted/empty/outside clips are removed. Missing source tail samples
 * are silence when rendered, never stretched to fill the requested duration.
 */
export function sliceAudioPlan(
  plan: AudioPlan,
  startSample: number,
  endSample: number,
): AudioPlan {
  const snapshot = validateAudioPlan(plan);
  integer(startSample, "slice startSample", true);
  integer(endSample, "slice endSample", true);
  if (endSample < startSample || endSample > snapshot.durationSamples)
    throw new RangeError(
      "audio slice must be within the plan and start <= end",
    );
  const clips: AudioClip[] = [];
  for (const clip of snapshot.clips) {
    const start = Math.max(startSample, clip.startSample);
    const end = Math.min(endSample, clip.startSample + clip.durationSamples);
    if (start >= end || clip.gain === 0) continue;
    clips.push({
      source: clip.source,
      startSample: start - startSample,
      sourceStartSample: clip.sourceStartSample + (start - clip.startSample),
      durationSamples: end - start,
      gain: clip.gain,
      ...(clip.volumeEnvelope
        ? {
            volumeEnvelope: sliceAudioEnvelope(
              clip.volumeEnvelope,
              start - clip.startSample,
              end - clip.startSample,
            ),
          }
        : {}),
    });
  }
  return validateAudioPlan({
    sampleRate: snapshot.sampleRate,
    durationSamples: endSample - startSample,
    clips,
  });
}

/** Clip a plan to its own half-open output duration, retaining input clip order. */
export function normalizeAudioPlan(plan: AudioPlan): AudioPlan {
  const snapshot = validateAudioPlan(plan);
  return sliceAudioPlan(snapshot, 0, snapshot.durationSamples);
}

/** Frame slicing uses independently rounded absolute boundaries, never rounded durations. */
export function sliceAudioPlanByFrames(
  plan: AudioPlan,
  startFrame: number,
  endFrame: number,
  fps: number,
  rounding: TimeRounding,
): AudioPlan {
  createFrameRange(startFrame, endFrame);
  return sliceAudioPlan(
    plan,
    framesToSamples(startFrame, fps, plan.sampleRate, rounding),
    framesToSamples(endFrame, fps, plan.sampleRate, rounding),
  );
}

/** Evaluate a validated envelope at any clip-local sample position. */
export function evaluateAudioEnvelope(
  points: readonly AudioEnvelopePoint[] | undefined,
  sample: number,
): number {
  if (!points?.length) return 1;
  const first = points[0]!;
  if (sample <= first.sample) return first.gain;
  let low = 1,
    high = points.length - 1;
  if (sample >= points[high]!.sample) return points[high]!.gain;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (sample > points[middle]!.sample) low = middle + 1;
    else high = middle;
  }
  const left = points[low - 1]!,
    right = points[low]!;
  return (
    left.gain +
    (right.gain - left.gain) *
      ((sample - left.sample) / (right.sample - left.sample))
  );
}

export function sliceAudioEnvelope(
  points: readonly AudioEnvelopePoint[],
  start: number,
  end: number,
): readonly AudioEnvelopePoint[] {
  return [
    { sample: 0, gain: evaluateAudioEnvelope(points, start) },
    ...points
      .filter((p) => p.sample > start && p.sample < end)
      .map((p) => ({ sample: p.sample - start, gain: p.gain })),
    ...(end > start
      ? [{ sample: end - start, gain: evaluateAudioEnvelope(points, end) }]
      : []),
  ];
}

/** Fade boundaries are sample-accurate. Nonoverlapping fades may include a unity plateau. */
export function fadeAudioEnvelope(
  durationSamples: number,
  fadeInSamples = 0,
  fadeOutSamples = 0,
): readonly AudioEnvelopePoint[] {
  integer(durationSamples, "durationSamples", true);
  integer(fadeInSamples, "fadeInSamples", true);
  integer(fadeOutSamples, "fadeOutSamples", true);
  if (fadeInSamples + fadeOutSamples > durationSamples)
    throw new RangeError("fades must fit within durationSamples");
  const points = new Map<number, number>();
  points.set(0, fadeInSamples > 0 ? 0 : 1);
  if (fadeInSamples > 0) points.set(fadeInSamples, 1);
  if (fadeOutSamples > 0) {
    points.set(durationSamples - fadeOutSamples, 1);
    points.set(durationSamples, 0);
  }
  return Object.freeze(
    [...points].map(([sample, gain]) => Object.freeze({ sample, gain })),
  );
}
