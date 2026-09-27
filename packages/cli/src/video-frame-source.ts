import {
  spawn as spawnProcess,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildVideoPtsIndex,
  parseVideoStreamHeader,
  findVideoFrame,
  videoSeekTimestamp,
  type VideoPtsIndex,
  type VideoPtsLimits,
  type VideoTimeBase,
} from "./video-pts.js";
import {
  acquireMediaProcess,
  createSequentialVideoDecoder,
  maximumLiveMediaProcesses,
  videoNormalizationFilters,
  type SequentialDecoder,
} from "./video-frame-decoder.js";

export { videoPixelChecksum } from "./video-frame-decoder.js";

export interface VideoFrameSourceLimits extends VideoPtsLimits {
  maxSourceBytes?: number;
  maxIndexBytes?: number;
  maxLogBytes?: number;
  maxCacheBytes?: number;
  maxQueuedRequests?: number;
  /** Warm sequential cursors retained per source; defaults to and is capped at four. */
  maxDecoderCursors?: number;
  /** Index distance to preceding keyframe; actual decode work is timeout-bounded. */
  maxKeyframeDistanceFrames?: number;
  processTimeoutMs?: number;
}
export interface VideoFrameSourceOptions {
  env?: NodeJS.ProcessEnv;
  /** Caller-owned immutable snapshot copy, never a live development asset. */
  path: string;
  sourceHash: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  limits?: VideoFrameSourceLimits;
  signal?: AbortSignal;
}
export interface VideoToolEvent {
  command: readonly string[];
  exitStatus: number | null;
  stdoutBytes: number;
  stderr: string;
  elapsedMs: number;
  terminated: boolean;
}
export interface VideoFrameSourceDependencies {
  spawn?: (
    binary: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
  onCommand?: (event: VideoToolEvent) => void;
}
export interface DecodedVideoFrame {
  readonly pts: number;
  readonly timeBase: VideoTimeBase;
  readonly width: number;
  readonly height: number;
  /** Caller-owned copy; mutating it cannot corrupt the source cache. */
  readonly rgba: Uint8Array;
  readonly keyframePts: number;
  readonly cacheHit: boolean;
  readonly elapsedMs: number;
}
export interface VideoFrameSource {
  readonly metadata: VideoPtsIndex;
  frameAt(
    sourceSeconds: number,
    signal?: AbortSignal,
  ): Promise<DecodedVideoFrame>;
  close(): Promise<void>;
  stats(): {
    cachedFrames: number;
    cachedBytes: number;
    cacheHits: number;
    decodedFrames: number;
    pendingRequests: number;
    decoderCursors: number;
    maxDecoderCursors: number;
    maxLiveMediaProcesses: number;
    closed: boolean;
  };
}

function cancelled(signal: AbortSignal): Error {
  return new Error("video.cancelled: video frame work was cancelled", {
    cause: signal.reason,
  });
}
function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw cancelled(signal);
}
function limit(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1)
    throw new Error(
      `video.invalid_limit: ${name} must be a positive safe integer`,
    );
  return result;
}
function boundedLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const result = limit(value, fallback, name);
  if (result > maximum)
    throw new Error(`video.invalid_limit: ${name} must be at most ${maximum}`);
  return result;
}

async function fingerprint(path: string): Promise<string> {
  const stat = await lstat(path, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error(
      "video.invalid_source: media must be an immutable regular file, not a symlink",
    );
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

interface CaptureOptions {
  env?: NodeJS.ProcessEnv;
  signal: AbortSignal;
  stdoutLimit: number;
  stderrLimit: number;
  timeoutMs: number;
  exactBytes?: number;
}
async function capture(
  binary: string,
  args: string[],
  options: CaptureOptions,
  dependencies: VideoFrameSourceDependencies,
): Promise<{ stdout: Buffer; stderr: string; elapsedMs: number }> {
  const release = await acquireMediaProcess(options.signal);
  const started = performance.now();
  let child: ChildProcess | undefined;
  try {
    checkAbort(options.signal);
    child = (dependencies.spawn ?? spawnProcess)(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(options.env ? { env: options.env } : {}),
    });
    if (!child.stdout || !child.stderr)
      throw new Error("video.process_failed: tool pipes unavailable");
    const fixed =
      options.exactBytes === undefined
        ? undefined
        : Buffer.alloc(options.exactBytes);
    const chunks: Buffer[] = [];
    let bytes = 0,
      logBytes = 0,
      stderr = "",
      failure: Error | undefined,
      terminated = false;
    const stop = (error: Error) => {
      if (!failure) failure = error;
      terminated = true;
      child!.kill("SIGKILL");
    };
    const abort = () => stop(cancelled(options.signal));
    options.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () =>
        stop(
          new Error(
            "video.process_timeout: media tool exceeded its time budget",
          ),
        ),
      options.timeoutMs,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      if (bytes + chunk.length > options.stdoutLimit) {
        stop(
          new Error("video.output_limit: tool output exceeded its byte budget"),
        );
        return;
      }
      if (fixed) chunk.copy(fixed, bytes);
      else chunks.push(chunk);
      bytes += chunk.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (failure) return;
      if (logBytes + chunk.length > options.stderrLimit) {
        stop(
          new Error(
            "video.log_limit: tool diagnostics exceeded their byte budget",
          ),
        );
        return;
      }
      stderr += chunk.toString("utf8");
      logBytes += chunk.length;
    });
    let exitStatus: number | null = null;
    try {
      exitStatus = await new Promise<number | null>((done) => {
        child!.once("error", (error) => {
          failure = error;
        });
        child!.once("close", (code) => done(code));
      });
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
    }
    const elapsedMs = performance.now() - started;
    dependencies.onCommand?.({
      command: [binary, ...args],
      exitStatus,
      stdoutBytes: bytes,
      stderr,
      elapsedMs,
      terminated,
    });
    if (failure) throw failure;
    checkAbort(options.signal);
    if (exitStatus !== 0)
      throw new Error(
        `video.process_failed: tool exited ${exitStatus}: ${stderr.trim()}`,
      );
    if (fixed && bytes !== fixed.length)
      throw new Error(
        "video.frame_missing: decoder did not return exactly one complete RGBA frame",
      );
    return { stdout: fixed ?? Buffer.concat(chunks, bytes), stderr, elapsedMs };
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const joined = new Promise<void>((resolve) =>
        child!.once("close", () => resolve()),
      );
      child.kill("SIGKILL");
      await joined;
    }
    release();
  }
}

export async function openVideoFrameSource(
  options: VideoFrameSourceOptions,
  dependencies: VideoFrameSourceDependencies = {},
): Promise<VideoFrameSource> {
  if (!/^[a-f0-9]{64}$/i.test(options.sourceHash))
    throw new Error("video.invalid_source: sourceHash must be SHA-256 hex");
  const path = resolve(options.path),
    limits = options.limits ?? {},
    owner = new AbortController();
  const lifetime = options.signal
    ? AbortSignal.any([options.signal, owner.signal])
    : owner.signal;
  checkAbort(lifetime);
  const original = await fingerprint(path),
    stat = await lstat(path);
  if (
    stat.size >
    limit(limits.maxSourceBytes, 512 * 1024 * 1024, "maxSourceBytes")
  )
    throw new Error("video.source_limit: encoded source exceeds byte budget");
  const digest = createHash("sha256"),
    stream = createReadStream(path, {
      highWaterMark: 1024 * 1024,
      signal: lifetime,
    });
  for await (const bytes of stream) digest.update(bytes);
  if (digest.digest("hex") !== options.sourceHash.toLowerCase())
    throw new Error(
      "video.source_mismatch: encoded media hash does not match the immutable input identity",
    );
  const checkSource = async () => {
    checkAbort(lifetime);
    if ((await fingerprint(path)) !== original)
      throw new Error(
        "video.source_changed: immutable media was modified during its lifetime",
      );
  };
  await checkSource();
  const processOptions = {
    env: options.env,
    signal: lifetime,
    stdoutLimit: limit(limits.maxIndexBytes, 16 * 1024 * 1024, "maxIndexBytes"),
    stderrLimit: limit(limits.maxLogBytes, 1024 * 1024, "maxLogBytes"),
    timeoutMs: limit(limits.processTimeoutMs, 60_000, "processTimeoutMs"),
  };
  const allocationLimit = String(
    limit(limits.maxFrameBytes, 32 * 1024 * 1024, "maxFrameBytes") * 2,
  );
  const header = await capture(
    options.ffprobePath ?? "ffprobe",
    [
      "-v",
      "error",
      "-max_alloc",
      allocationLimit,
      "-protocol_whitelist",
      "file,pipe",
      "-format_whitelist",
      "mov,matroska,webm",
      "-threads",
      "1",
      "-select_streams",
      "v:0",
      "-show_streams",
      "-show_entries",
      "stream=codec_name,width,height,pix_fmt,time_base,start_pts,duration_ts,color_transfer,color_primaries,color_space,color_range,field_order:stream_tags=rotate:stream_side_data=side_data_type,rotation,displaymatrix",
      "-of",
      "json",
      path,
    ],
    {
      ...processOptions,
      stdoutLimit: Math.min(processOptions.stdoutLimit, 64 * 1024),
    },
    dependencies,
  );
  const headerValue = JSON.parse(header.stdout.toString("utf8"));
  if (!Array.isArray(headerValue.streams) || headerValue.streams.length !== 1)
    throw new Error(
      "video.invalid_probe: exactly one selected video stream is required",
    );
  parseVideoStreamHeader(headerValue.streams[0], limits);
  await checkSource();
  const probe = await capture(
    options.ffprobePath ?? "ffprobe",
    [
      "-v",
      "error",
      "-max_alloc",
      allocationLimit,
      "-protocol_whitelist",
      "file,pipe",
      "-format_whitelist",
      "mov,matroska,webm",
      "-threads",
      "1",
      "-select_streams",
      "v:0",
      "-show_frames",
      "-show_streams",
      "-show_entries",
      "stream=codec_name,width,height,pix_fmt,time_base,start_pts,duration_ts,color_transfer,color_primaries,color_space,color_range,field_order:stream_tags=rotate:stream_side_data=side_data_type,rotation,displaymatrix:frame=pts,best_effort_timestamp,key_frame,duration,pkt_duration,interlaced_frame",
      "-of",
      "json",
      path,
    ],
    processOptions,
    dependencies,
  );
  await checkSource();
  const metadata = buildVideoPtsIndex(
    JSON.parse(probe.stdout.toString("utf8")),
    limits,
  );
  const cacheBudget = limit(
    limits.maxCacheBytes,
    metadata.frameBytes * 4,
    "maxCacheBytes",
  );
  if (cacheBudget < metadata.frameBytes)
    throw new Error(
      "video.cache_limit: cache byte budget cannot hold one decoded frame",
    );
  const capacity = Math.min(4, Math.floor(cacheBudget / metadata.frameBytes)),
    cache = new Map<number, Buffer>();
  const maxQueue = limit(limits.maxQueuedRequests, 16, "maxQueuedRequests"),
    maxDecodeFrames = limit(
      limits.maxKeyframeDistanceFrames,
      600,
      "maxKeyframeDistanceFrames",
    );
  const maxDecoderCursors = boundedLimit(
    limits.maxDecoderCursors,
    4,
    4,
    "maxDecoderCursors",
  );
  interface Cursor {
    decoder: SequentialDecoder;
    nextIndex?: number;
  }
  const cursors: Cursor[] = [];
  const createCursor = (): Cursor => ({
    decoder: createSequentialVideoDecoder({
      binary: options.ffmpegPath ?? "ffmpeg",
      env: options.env,
      metadata,
      maxDecodeFrames,
      maxLogBytes: processOptions.stderrLimit,
      timeoutMs: processOptions.timeoutMs,
      signal: lifetime,
      spawn: dependencies.spawn,
      onCommand: dependencies.onCommand,
      args(startFrameIndex, outputFrameIndex) {
        const keyframe = metadata.frames[startFrameIndex]!,
          outputFrame = metadata.frames[outputFrameIndex]!,
          base = metadata.timeBase,
          filter = [
            `settb=expr=${base.numerator}/${base.denominator}`,
            `select=gte(pts\\,${outputFrame.pts})`,
            ...videoNormalizationFilters(metadata),
          ].join(",");
        const args = [
          "-hide_banner",
          "-nostdin",
          "-nostats",
          "-loglevel",
          "info",
          "-max_alloc",
          allocationLimit,
          "-copyts",
          "-protocol_whitelist",
          "file,pipe",
          "-format_whitelist",
          "mov,matroska,webm",
          "-threads",
          "1",
          "-noautorotate",
        ];
        if (startFrameIndex > 0)
          args.push(
            "-seek_timestamp",
            "1",
            "-noaccurate_seek",
            "-ss",
            videoSeekTimestamp(keyframe.pts, base),
          );
        args.push(
          "-i",
          path,
          "-map",
          "0:v:0",
          "-an",
          "-sn",
          "-dn",
          "-vf",
          filter,
          "-fps_mode",
          "passthrough",
          "-filter_threads",
          "1",
          "-threads",
          "1",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgba",
          "pipe:1",
        );
        return args;
      },
    }),
  });
  const cursorFor = (frameIndex: number): Cursor => {
    const sequential = cursors
      .filter(
        (cursor) =>
          cursor.nextIndex !== undefined &&
          frameIndex >= cursor.nextIndex &&
          frameIndex - cursor.nextIndex <= 8,
      )
      .sort(
        (left, right) =>
          frameIndex - left.nextIndex! - (frameIndex - right.nextIndex!),
      )[0];
    if (sequential) return sequential;
    const reset = cursors.find((cursor) => cursor.nextIndex === undefined);
    if (reset) return reset;
    if (cursors.length < maxDecoderCursors) {
      const cursor = createCursor();
      cursors.push(cursor);
      return cursor;
    }
    return cursors.reduce((nearest, cursor) =>
      Math.abs(frameIndex - cursor.nextIndex!) <
      Math.abs(frameIndex - nearest.nextIndex!)
        ? cursor
        : nearest,
    );
  };
  let tail = Promise.resolve(),
    closed = false,
    pending = 0,
    hits = 0,
    decoded = 0,
    closePromise: Promise<void> | undefined;
  return {
    metadata,
    frameAt(sourceSeconds, signal) {
      if (closed)
        return Promise.reject(
          new Error("video.closed: frame source is closed"),
        );
      if (pending >= maxQueue)
        return Promise.reject(
          new Error("video.queue_limit: too many pending frame requests"),
        );
      pending++;
      const requestSignal = signal
        ? AbortSignal.any([lifetime, signal])
        : lifetime;
      const request = tail.then(async () => {
        checkAbort(requestSignal);
        await checkSource();
        const frame = findVideoFrame(metadata, sourceSeconds),
          keyframe = metadata.frames[frame.keyframeIndex]!;
        const started = performance.now();
        let rgba = cache.get(frame.index),
          cacheHit = true;
        if (rgba) {
          cache.delete(frame.index);
          cache.set(frame.index, rgba);
          hits++;
        } else {
          cacheHit = false;
          if (frame.index - frame.keyframeIndex > maxDecodeFrames)
            throw new Error(
              "video.seek_limit: selected frame is too far from an indexed keyframe",
            );
          const cursor = cursorFor(frame.index);
          try {
            rgba = await cursor.decoder.decode(frame.index, requestSignal);
            cursor.nextIndex = frame.index + 1;
          } catch (error) {
            cursor.nextIndex = undefined;
            throw error;
          }
          await checkSource();
          checkAbort(requestSignal);
          decoded++;
          cache.set(frame.index, rgba);
          while (cache.size > capacity)
            cache.delete(cache.keys().next().value!);
        }
        checkAbort(requestSignal);
        return {
          pts: frame.pts,
          timeBase: metadata.timeBase,
          width: metadata.width,
          height: metadata.height,
          rgba: Buffer.from(rgba),
          keyframePts: keyframe.pts,
          cacheHit,
          elapsedMs: performance.now() - started,
        };
      });
      tail = request.then(
        () => undefined,
        () => undefined,
      );
      return request.finally(() => {
        pending--;
      });
    },
    close() {
      if (!closePromise) {
        closed = true;
        owner.abort();
        cache.clear();
        closePromise = tail.then(async () => {
          await Promise.all(cursors.map((cursor) => cursor.decoder.close()));
          cache.clear();
        });
      }
      return closePromise;
    },
    stats: () => ({
      cachedFrames: cache.size,
      cachedBytes: cache.size * metadata.frameBytes,
      cacheHits: hits,
      decodedFrames: decoded,
      pendingRequests: pending,
      decoderCursors: cursors.length,
      maxDecoderCursors,
      maxLiveMediaProcesses: maximumLiveMediaProcesses,
      closed,
    }),
  };
}
