import { isObjectRecord } from "./internal/validation.js";

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
  /** RGBA display raster after the explicit container rotation. */
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
  const match = typeof value === "string" ? /^(\d+)\/(\d+)$/.exec(value) : null;
  if (!match) throw new Error("video.invalid_pts: missing rational time base");
  const numerator = positive(Number(match[1]), "time base numerator"),
    denominator = positive(Number(match[2]), "time base denominator");
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

function displayRotation(stream: Record<string, unknown>): number {
  let value: unknown = isObjectRecord(stream.tags)
    ? stream.tags.rotate
    : undefined;
  if (Array.isArray(stream.side_data_list)) {
    const matrix = stream.side_data_list.find(
      (side) =>
        isObjectRecord(side) && side.side_data_type === "Display Matrix",
    );
    if (isObjectRecord(matrix)) {
      value = matrix.rotation;
      const rows =
        typeof matrix.displaymatrix === "string"
          ? [
              ...matrix.displaymatrix.matchAll(
                /:\s*(-?\d+)\s+(-?\d+)\s+(-?\d+)/g,
              ),
            ]
          : [];
      if (rows.length !== 3)
        throw new Error(
          "video.unsupported_format: display matrix could not be verified",
        );
      const a = Number(rows[0]![1]),
        b = Number(rows[0]![2]),
        c = Number(rows[1]![1]),
        d = Number(rows[1]![2]),
        unit = 65_536 ** 2;
      if (
        a * d - b * c !== unit ||
        a * a + b * b !== unit ||
        c * c + d * d !== unit
      )
        throw new Error(
          "video.unsupported_format: mirrored or scaled display matrices are not supported",
        );
    }
  }
  const rotation = value === undefined ? 0 : Number(value);
  if (!Number.isFinite(rotation))
    throw new Error("video.unsupported_format: invalid display rotation");
  const nearest = Math.round(rotation / 90) * 90;
  if (Math.abs(rotation - nearest) > 0.01)
    throw new Error(
      "video.unsupported_format: display rotation must be a multiple of 90 degrees",
    );
  return ((nearest % 360) + 360) % 360;
}

export function parseVideoStreamHeader(
  stream: unknown,
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
  if (!isObjectRecord(stream))
    throw new Error("video.invalid_probe: video stream metadata is missing");
  const maxFrameBytes = positive(
    limits.maxFrameBytes ?? 32 * 1024 * 1024,
    "maxFrameBytes",
  );
  const encodedWidth = positive(stream.width, "width"),
    encodedHeight = positive(stream.height, "height"),
    rotationDegrees = displayRotation(stream),
    swapsDimensions = rotationDegrees === 90 || rotationDegrees === 270,
    width = swapsDimensions ? encodedHeight : encodedWidth,
    height = swapsDimensions ? encodedWidth : encodedHeight,
    frameBytes = width * height * 4;
  if (!Number.isSafeInteger(frameBytes) || frameBytes > maxFrameBytes)
    throw new Error("video.frame_limit: decoded RGBA frame exceeds byte limit");
  const codec = String(stream.codec_name),
    pixelFormat = String(stream.pix_fmt),
    transfer = String(stream.color_transfer ?? "unknown"),
    hdr = ["smpte2084", "arib-std-b67"].includes(transfer),
    inputColor = Object.freeze({
      transfer,
      primaries: String(stream.color_primaries ?? "unknown"),
      matrix: String(stream.color_space ?? "unknown"),
      range: String(stream.color_range ?? "unknown"),
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
  if (
    !["h264", "hevc", "vp8", "vp9", "av1"].includes(codec) ||
    ![
      "yuv420p",
      "yuvj420p",
      "yuv422p",
      "yuvj422p",
      "yuv444p",
      "yuvj444p",
      "nv12",
      "gbrp",
      "rgb24",
      "rgba",
      "bgra",
      "yuv420p10le",
      "yuv422p10le",
      "yuv444p10le",
      "p010le",
      "gbrp10le",
    ].includes(pixelFormat) ||
    (typeof stream.field_order === "string" &&
      !["unknown", "progressive"].includes(stream.field_order)) ||
    (Array.isArray(stream.side_data_list) &&
      stream.side_data_list.some(
        (side) =>
          isObjectRecord(side) &&
          side.side_data_type === "Display Matrix" &&
          (typeof side.rotation !== "number" ||
            typeof side.displaymatrix !== "string"),
      ))
  )
    throw new Error(
      "video.unsupported_format: unsupported codec, pixel format, interlace mode or display transform",
    );
  const base = timeBase(stream.time_base);
  return Object.freeze({
    encodedWidth,
    encodedHeight,
    width,
    height,
    frameBytes,
    codec,
    pixelFormat,
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
  probe: unknown,
  limits: VideoPtsLimits = {},
): VideoPtsIndex {
  if (
    !isObjectRecord(probe) ||
    !Array.isArray(probe.streams) ||
    probe.streams.length !== 1 ||
    !isObjectRecord(probe.streams[0]) ||
    !Array.isArray(probe.frames)
  )
    throw new Error(
      "video.invalid_probe: expected one selected video stream and decoded frame metadata",
    );
  const stream = probe.streams[0],
    maxFrames = positive(limits.maxFrames ?? 250_000, "maxFrames");
  if (probe.frames.length === 0 || probe.frames.length > maxFrames)
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
  } = parseVideoStreamHeader(stream, limits);
  let keyframeIndex = -1;
  const frames: VideoPtsFrame[] = probe.frames.map((frame, index) => {
    if (!isObjectRecord(frame))
      throw new Error("video.invalid_pts: frame metadata must be an object");
    const pts = integer(frame.best_effort_timestamp ?? frame.pts, "frame PTS");
    if (frame.pts !== undefined && integer(frame.pts, "frame pts") !== pts)
      throw new Error(
        "video.invalid_pts: decoded and best-effort PTS disagree",
      );
    if (frame.key_frame === 1) keyframeIndex = index;
    if (keyframeIndex < 0 || frame.interlaced_frame === 1)
      throw new Error(
        "video.invalid_pts: missing initial keyframe or interlaced input",
      );
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
  const last = probe.frames.at(-1) as Record<string, unknown>,
    lastPts = frames.at(-1)!.pts;
  const duration = last.duration ?? last.pkt_duration;
  let endPts: number;
  if (
    typeof duration === "number" &&
    Number.isSafeInteger(duration) &&
    duration > 0
  )
    endPts = lastPts + duration;
  else if (
    typeof stream.duration_ts === "number" &&
    Number.isSafeInteger(stream.duration_ts) &&
    stream.duration_ts > 0
  )
    endPts =
      integer(stream.start_pts ?? frames[0]!.pts, "stream start PTS") +
      stream.duration_ts;
  else
    throw new Error(
      "video.unknown_end: last-frame duration or stream duration is required",
    );
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

/** WebCodecs timestamps are microseconds: floor rather than rounding beyond the selected keyframe. */
export function videoSeekTimestamp(pts: number, base: VideoTimeBase): string {
  integer(pts, "seek PTS");
  positive(base.numerator, "time base numerator");
  positive(base.denominator, "time base denominator");
  const numerator = BigInt(pts) * BigInt(base.numerator) * 1_000_000n,
    denominator = BigInt(base.denominator);
  let micros = numerator / denominator;
  if (numerator % denominator < 0n) micros--;
  const sign = micros < 0n ? "-" : "";
  if (micros < 0n) micros = -micros;
  return `${sign}${micros / 1_000_000n}.${String(micros % 1_000_000n).padStart(6, "0")}`;
}
