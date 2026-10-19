import { isObjectRecord } from "./internal/validation.js";
import type { MediaProbe } from "./media-runtime.js";

export interface VideoTimeBase {
  readonly numerator: number;
  readonly denominator: number;
}
export interface VideoPtsFrame {
  readonly index: number;
  readonly pts: number;
  readonly seconds: number;
  readonly keyframeIndex: number;
}
export interface VideoPtsIndex {
  /** Encoded raster before the container display transform. */
  readonly encodedWidth: number;
  readonly encodedHeight: number;
  /** RGBA display raster after aspect-ratio adjustment and container rotation. */
  readonly width: number;
  readonly height: number;
  readonly codec: string;
  readonly pixelFormat: string;
  /** Counter-clockwise display rotation reported by the container, normalized to 0/90/180/270. */
  readonly rotationDegrees: number;
  readonly inputColor: {
    readonly transfer: string;
    readonly primaries: string;
    readonly matrix: string;
    readonly range: string;
  };
  readonly outputColorSpace: "rgba-source-derived" | "sdr-bt709-rgba";
  readonly normalization: "none" | "hdr-to-sdr-bt709";
  readonly timeBase: VideoTimeBase;
  readonly frameBytes: number;
  readonly frames: readonly VideoPtsFrame[];
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly startPts: number;
  readonly endPts: number;
}
export interface VideoPtsLimits {
  maxFrames?: number;
  maxFrameBytes?: number;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error(`video.invalid_pts: ${label} must be a safe integer`);
  return value;
}
function positive(value: unknown, label: string): number {
  const number = integer(value, label);
  if (number <= 0)
    throw new Error(`video.invalid_pts: ${label} must be positive`);
  return number;
}
function timeBase(value: unknown): VideoTimeBase {
  if (!isObjectRecord(value))
    throw new Error("video.invalid_pts: missing rational time base");
  const numerator = positive(value.numerator, "time base numerator"),
    denominator = positive(value.denominator, "time base denominator");
  let a = numerator,
    b = denominator;
  while (b) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return Object.freeze({
    numerator: numerator / a,
    denominator: denominator / a,
  });
}

function ptsSeconds(pts: number, base: VideoTimeBase): number {
  const product = pts * base.numerator;
  if (!Number.isSafeInteger(product))
    throw new Error(
      "video.invalid_pts: scaled PTS exceeds exact integer range",
    );
  return product / base.denominator;
}

function displayRotation(clockwise: number): number {
  const rotation = -clockwise;
  if (!Number.isFinite(rotation))
    throw new Error("video.unsupported_format: invalid display rotation");
  const nearest = Math.round(rotation / 90) * 90;
  if (Math.abs(rotation - nearest) > 0.01)
    throw new Error(
      "video.unsupported_format: display rotation must be a multiple of 90 degrees",
    );
  return ((nearest % 360) + 360) % 360;
}

function parseVideoHeader(
  video: NonNullable<MediaProbe["video"]>,
  limits: VideoPtsLimits = {},
): Pick<
  VideoPtsIndex,
  | "encodedWidth"
  | "encodedHeight"
  | "width"
  | "height"
  | "frameBytes"
  | "codec"
  | "pixelFormat"
  | "rotationDegrees"
  | "inputColor"
  | "outputColorSpace"
  | "normalization"
  | "timeBase"
> {
  const maxFrameBytes = positive(
    limits.maxFrameBytes ?? 32 * 1024 * 1024,
    "maxFrameBytes",
  );
  const encodedWidth = positive(video.codedWidth, "coded width"),
    encodedHeight = positive(video.codedHeight, "coded height"),
    rotationDegrees = displayRotation(video.rotation),
    width = positive(video.width, "display width"),
    height = positive(video.height, "display height"),
    frameBytes = width * height * 4;
  if (!Number.isSafeInteger(frameBytes) || frameBytes > maxFrameBytes)
    throw new Error("video.frame_limit: decoded RGBA frame exceeds byte limit");
  const codec = video.codec === "avc" ? "h264" : video.codec,
    color = video.colorSpace,
    transfer =
      color?.transfer === "pq"
        ? "smpte2084"
        : color?.transfer === "hlg"
          ? "arib-std-b67"
          : (color?.transfer ?? "unknown"),
    hdr = ["smpte2084", "arib-std-b67"].includes(transfer),
    inputColor = Object.freeze({
      transfer,
      primaries: color?.primaries ?? "unknown",
      matrix:
        color?.matrix === "bt2020-ncl"
          ? "bt2020nc"
          : (color?.matrix ?? "unknown"),
      range:
        color?.fullRange === true
          ? "pc"
          : color?.fullRange === false
            ? "tv"
            : "unknown",
    });
  if (
    hdr &&
    (inputColor.primaries !== "bt2020" ||
      inputColor.matrix !== "bt2020nc" ||
      !["tv", "limited"].includes(inputColor.range))
  )
    throw new Error(
      "video.unsupported_color: HDR input requires explicit BT.2020 non-constant-luminance limited-range metadata",
    );
  if (!["h264", "hevc", "vp8", "vp9", "av1"].includes(codec))
    throw new Error("video.unsupported_format: unsupported video codec");
  const base = timeBase(video.timeBase);
  return Object.freeze({
    encodedWidth,
    encodedHeight,
    width,
    height,
    frameBytes,
    codec,
    pixelFormat: "rgba",
    rotationDegrees,
    inputColor,
    outputColorSpace: hdr
      ? ("sdr-bt709-rgba" as const)
      : ("rgba-source-derived" as const),
    normalization: hdr ? ("hdr-to-sdr-bt709" as const) : ("none" as const),
    timeBase: base,
  });
}

/** Original presentation timestamps, not decoded ordinals or a guessed constant FPS. */
export function buildVideoPtsIndex(
  video: NonNullable<MediaProbe["video"]>,
  limits: VideoPtsLimits = {},
): VideoPtsIndex {
  if (!isObjectRecord(video) || !Array.isArray(video.frames))
    throw new Error(
      "video.invalid_probe: expected one selected video stream and decoded frame metadata",
    );
  const maxFrames = positive(limits.maxFrames ?? 250_000, "maxFrames");
  if (video.frames.length === 0 || video.frames.length > maxFrames)
    throw new Error("video.index_limit: empty or oversized decoded PTS index");
  const {
    encodedWidth,
    encodedHeight,
    width,
    height,
    frameBytes,
    codec,
    pixelFormat,
    rotationDegrees,
    inputColor,
    outputColorSpace,
    normalization,
    timeBase: base,
  } = parseVideoHeader(video, limits);
  let keyframeIndex = -1;
  const frames: VideoPtsFrame[] = video.frames.map((frame, index) => {
    if (!isObjectRecord(frame))
      throw new Error("video.invalid_pts: frame metadata must be an object");
    const pts = integer(frame.pts, "frame PTS");
    if (frame.keyframe === true) keyframeIndex = index;
    if (keyframeIndex < 0)
      throw new Error("video.invalid_pts: missing initial keyframe");
    return Object.freeze({
      index,
      pts,
      seconds: ptsSeconds(pts, base),
      keyframeIndex,
    });
  });
  for (let index = 1; index < frames.length; index++)
    if (
      frames[index]!.pts <= frames[index - 1]!.pts ||
      frames[index]!.seconds <= frames[index - 1]!.seconds
    )
      throw new Error(
        "video.invalid_pts: timestamps must be strictly increasing",
      );
  const last = video.frames.at(-1)!,
    lastPts = frames.at(-1)!.pts;
  if (!Number.isSafeInteger(last.duration) || last.duration <= 0)
    throw new Error("video.unknown_end: last-frame duration is required");
  const endPts = lastPts + last.duration;
  if (!Number.isSafeInteger(endPts) || endPts <= lastPts)
    throw new Error("video.unknown_end: invalid final PTS boundary");
  if (ptsSeconds(endPts, base) <= frames.at(-1)!.seconds)
    throw new Error(
      "video.unknown_end: final interval collapses in source seconds",
    );
  return Object.freeze({
    encodedWidth,
    encodedHeight,
    width,
    height,
    codec,
    pixelFormat,
    rotationDegrees,
    inputColor,
    outputColorSpace,
    normalization,
    timeBase: base,
    frameBytes,
    frames: Object.freeze(frames),
    startSeconds: frames[0]!.seconds,
    endSeconds: ptsSeconds(endPts, base),
    startPts: frames[0]!.pts,
    endPts,
  });
}

/** Half-open original source-time lookup, with no epsilon or playback-history state. */
export function findVideoFrame(
  index: VideoPtsIndex,
  seconds: number,
): VideoPtsFrame {
  if (
    !Number.isFinite(seconds) ||
    seconds < index.startSeconds ||
    seconds >= index.endSeconds
  )
    throw new RangeError(
      "video.time_out_of_range: requested source time is outside indexed presentation intervals",
    );
  let low = 0,
    high = index.frames.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (index.frames[middle]!.seconds <= seconds) low = middle + 1;
    else high = middle;
  }
  return index.frames[Math.max(0, low - 1)]!;
}

/**
 * Authoring time begins at the first presented frame. Compare relative integer
 * PTS before conversion instead of adding two rounded second values (2.3 + 0.3).
 * Pass the returned original `seconds` to frameAt(); no second origin addition.
 */
export function findVideoFrameOffset(
  index: VideoPtsIndex,
  seconds: number,
): VideoPtsFrame {
  const duration = ptsSeconds(index.endPts - index.startPts, index.timeBase);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds >= duration)
    throw new RangeError(
      "video.time_out_of_range: requested offset is outside the source duration",
    );
  let low = 0,
    high = index.frames.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const offset = ptsSeconds(
      index.frames[middle]!.pts - index.startPts,
      index.timeBase,
    );
    if (offset <= seconds) low = middle + 1;
    else high = middle;
  }
  return index.frames[Math.max(0, low - 1)]!;
}
