/** A half-open frame interval [start, end). Signed bounds allow pre-roll; equal bounds are empty. */
export interface FrameRange {
  readonly start: number;
  readonly end: number;
}

function safeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${name} must be a safe integer`);
  }
  return value === 0 ? 0 : value;
}

export function createFrameRange(start: number, end: number): FrameRange {
  safeInteger(start, "start");
  safeInteger(end, "end");
  if (end < start)
    throw new RangeError("end must be greater than or equal to start");
  return { start: start === 0 ? 0 : start, end: end === 0 ? 0 : end };
}

export function containsFrame(range: FrameRange, frame: number): boolean {
  const { start, end } = createFrameRange(range.start, range.end);
  safeInteger(frame, "frame");
  return frame >= start && frame < end;
}

/** `from` is relative to the parent's local frame. Zero duration is an empty sequence. */
export interface SequenceTiming {
  readonly from: number;
  readonly durationFrames: number;
}

export interface SequenceFrame {
  readonly localFrame: number;
  readonly absoluteFrom: number;
  readonly isActive: boolean;
}

/**
 * Resolve an ancestor-to-child sequence chain without playback history.
 * Every ancestor clips visibility; local time itself is never clamped.
 * An empty chain has unbounded visibility. Include the composition as an
 * ancestor ({from: 0, durationFrames}) when composition clipping is desired.
 */
export function resolveSequenceFrame(
  globalFrame: number,
  sequences: readonly SequenceTiming[],
): SequenceFrame {
  safeInteger(globalFrame, "globalFrame");
  if (!Array.isArray(sequences))
    throw new TypeError("sequences must be an array");
  let absoluteFrom = 0;
  let isActive = true;
  for (const sequence of sequences) {
    if (!sequence || typeof sequence !== "object")
      throw new TypeError("sequence must be an object");
    safeInteger(sequence.from, "sequence.from");
    safeInteger(sequence.durationFrames, "sequence.durationFrames");
    if (sequence.durationFrames < 0)
      throw new RangeError("sequence.durationFrames must not be negative");
    absoluteFrom = safeInteger(absoluteFrom + sequence.from, "absoluteFrom");
    const end = safeInteger(
      absoluteFrom + sequence.durationFrames,
      "sequence end",
    );
    isActive = isActive && globalFrame >= absoluteFrom && globalFrame < end;
  }
  return {
    localFrame: safeInteger(globalFrame - absoluteFrom, "localFrame"),
    absoluteFrom,
    isActive,
  };
}

/** `round` means nearest, with exact half ties toward +Infinity (as Math.round). */
export type TimeRounding = "floor" | "ceil" | "round";

function finiteTime(value: number, name: string): number {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(
      `${name} must be finite and within the safe number range`,
    );
  }
  return value;
}

function frameRate(fps: number): void {
  finiteTime(fps, "fps");
  if (fps <= 0) throw new RangeError("fps must be positive");
}

function sampleRateHz(sampleRate: number): void {
  safeInteger(sampleRate, "sampleRate");
  if (sampleRate <= 0) throw new RangeError("sampleRate must be positive");
}

function validateRounding(rounding: TimeRounding): void {
  if (!["floor", "ceil", "round"].includes(rounding)) {
    throw new RangeError("rounding must be floor, ceil or round");
  }
}

function roundNumber(value: number, rounding: TimeRounding): number {
  validateRounding(rounding);
  return safeInteger(Math[rounding](value), "converted value");
}

// Avoid losing integer boundaries to an unsafe intermediate product or a
// floating-point division when both rates are integers (for example 44.1k/60).
function roundRatio(
  numerator: bigint,
  denominator: bigint,
  rounding: TimeRounding,
): number {
  validateRounding(rounding);
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  let result = quotient;
  if (rounding === "floor" && remainder < 0n) result--;
  if (rounding === "ceil" && remainder > 0n) result++;
  if (rounding === "round") {
    if (remainder > 0n && remainder * 2n >= denominator) result++;
    if (remainder < 0n && -remainder * 2n > denominator) result--;
  }
  if (
    result > BigInt(Number.MAX_SAFE_INTEGER) ||
    result < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    throw new RangeError("converted value must be a safe integer");
  }
  return Number(result);
}

/** Convert a signed integer frame to seconds without quantization. */
export function framesToSeconds(frame: number, fps: number): number {
  safeInteger(frame, "frame");
  frameRate(fps);
  const result = finiteTime(frame / fps, "converted seconds");
  return result === 0 ? 0 : result;
}

/**
 * Quantize supplied seconds to frames. Rounding is deliberately mandatory.
 * Fractional seconds/fps use IEEE-754 arithmetic, with no epsilon snapping;
 * use `round` when recovering an already-aligned frame from its seconds value.
 */
export function secondsToFrames(
  seconds: number,
  fps: number,
  rounding: TimeRounding,
): number {
  finiteTime(seconds, "seconds");
  frameRate(fps);
  if (Number.isSafeInteger(seconds) && Number.isSafeInteger(fps)) {
    return roundRatio(BigInt(seconds) * BigInt(fps), 1n, rounding);
  }
  return roundNumber(seconds * fps, rounding);
}

/** Convert a signed integer sample position to seconds without quantization. */
export function samplesToSeconds(samples: number, sampleRate: number): number {
  safeInteger(samples, "samples");
  sampleRateHz(sampleRate);
  const result = finiteTime(samples / sampleRate, "converted seconds");
  return result === 0 ? 0 : result;
}

export function secondsToSamples(
  seconds: number,
  sampleRate: number,
  rounding: TimeRounding,
): number {
  finiteTime(seconds, "seconds");
  sampleRateHz(sampleRate);
  if (Number.isSafeInteger(seconds)) {
    return roundRatio(BigInt(seconds) * BigInt(sampleRate), 1n, rounding);
  }
  return roundNumber(seconds * sampleRate, rounding);
}

/** Map absolute frame boundaries directly; never accumulate rounded frame durations. */
export function framesToSamples(
  frame: number,
  fps: number,
  sampleRate: number,
  rounding: TimeRounding,
): number {
  safeInteger(frame, "frame");
  frameRate(fps);
  sampleRateHz(sampleRate);
  if (Number.isSafeInteger(fps)) {
    return roundRatio(
      BigInt(frame) * BigInt(sampleRate),
      BigInt(fps),
      rounding,
    );
  }
  return roundNumber((frame / fps) * sampleRate, rounding);
}

/** The argument order follows source unit/rate, then destination fps. */
export function samplesToFrames(
  samples: number,
  sampleRate: number,
  fps: number,
  rounding: TimeRounding,
): number {
  safeInteger(samples, "samples");
  sampleRateHz(sampleRate);
  frameRate(fps);
  if (Number.isSafeInteger(fps)) {
    return roundRatio(
      BigInt(samples) * BigInt(fps),
      BigInt(sampleRate),
      rounding,
    );
  }
  return roundNumber((samples / sampleRate) * fps, rounding);
}
