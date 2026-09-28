import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  buildVideoPtsIndex,
  findVideoFrame,
  type VideoPtsIndex,
  type VideoPtsLimits,
  type VideoTimeBase,
} from "./video-pts.js";
import {
  acquireMediaProcess,
  maximumLiveMediaProcesses,
  markMediaProcessActive,
  markMediaProcessIdle,
} from "./video-frame-decoder.js";
import {
  runMediaOperation,
  createMediaSession,
  type MediaSession,
  type MediaSessionFactory,
  type MediaProbe,
  type MediaRunner,
} from "./media-runtime.js";
import { mediaWorkspace } from "./media-workspace.js";
export { videoPixelChecksum } from "./video-frame-decoder.js";

export interface VideoFrameSourceLimits extends VideoPtsLimits {
  maxSourceBytes?: number;
  maxIndexBytes?: number;
  maxLogBytes?: number;
  maxCacheBytes?: number;
  maxQueuedRequests?: number;
  /** Compatibility ceiling; the media runtime shares one persistent seekable decoder per source. */
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
  mediaRunner?: MediaRunner;
  mediaSessionFactory?: MediaSessionFactory;
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
  const media = dependencies.mediaRunner ?? runMediaOperation;
  const timeoutMs = limit(limits.processTimeoutMs, 60_000, "processTimeoutMs");
  const releaseProbe = await acquireMediaProcess(lifetime);
  let probe: MediaProbe;
  try {
    probe = await media<MediaProbe>(
      {
        kind: "probe",
        path,
        frames: true,
        maxFrames: limits.maxFrames ?? 250000,
        maxIndexBytes: limits.maxIndexBytes ?? 16 * 1024 * 1024,
        maxFrameBytes: limits.maxFrameBytes ?? 32 * 1024 * 1024,
      },
      { signal: lifetime, timeoutMs, env: options.env },
    );
  } finally {
    releaseProbe();
  }
  if (
    Buffer.byteLength(JSON.stringify(probe)) >
    limit(limits.maxIndexBytes, 16 * 1024 * 1024, "maxIndexBytes")
  )
    throw new Error("video.index_limit: media index exceeds byte budget");
  const video = probe.video;
  if (!video?.frames)
    throw new Error(
      "video.invalid_probe: selected video stream and PTS index required",
    );
  const color = video.colorSpace;
  const transfer =
    color?.transfer === "pq"
      ? "smpte2084"
      : color?.transfer === "hlg"
        ? "arib-std-b67"
        : (color?.transfer ?? "unknown");
  const metadata = buildVideoPtsIndex(
    {
      streams: [
        {
          codec_name: video.codec === "avc" ? "h264" : video.codec,
          width: video.codedWidth,
          height: video.codedHeight,
          pix_fmt: "rgba",
          time_base: `${video.timeBase.numerator}/${video.timeBase.denominator}`,
          tags: { rotate: -video.rotation },
          color_transfer: transfer,
          color_primaries: video.colorSpace?.primaries,
          color_space:
            color?.matrix === "bt2020-ncl" ? "bt2020nc" : color?.matrix,
          color_range: video.colorSpace?.fullRange ? "pc" : "tv",
        },
      ],
      frames: video.frames.map((frame) => ({
        pts: frame.pts,
        key_frame: frame.keyframe ? 1 : 0,
        duration: frame.duration,
      })),
    },
    limits,
  );
  await checkSource();
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
  const sessionId = Symbol("video source");
  const createSession =
    dependencies.mediaSessionFactory ??
    (dependencies.mediaRunner
      ? async () => ({ run: media, close: async () => {} })
      : createMediaSession);
  let session: MediaSession | undefined,
    releaseSession: (() => void) | undefined;
  let sessionClosing = Promise.resolve();
  const stopSession = (): Promise<void> => {
    markMediaProcessActive(sessionId);
    const stopping = session,
      release = releaseSession;
    session = undefined;
    releaseSession = undefined;
    if (stopping)
      sessionClosing = sessionClosing.then(async () => {
        try {
          await stopping.close();
        } finally {
          release?.();
        }
      });
    return sessionClosing;
  };
  const closeOnAbort = () => {
    void stopSession().catch(() => {});
  };
  lifetime.addEventListener("abort", closeOnAbort, { once: true });
  const getSession = async (signal: AbortSignal): Promise<MediaSession> => {
    markMediaProcessActive(sessionId);
    await sessionClosing;
    checkAbort(signal);
    if (!session) {
      const release = await acquireMediaProcess(signal);
      try {
        session = await createSession({
          signal: lifetime,
          timeoutMs,
          env: options.env,
        });
        releaseSession = release;
      } catch (error) {
        release();
        throw error;
      }
    }
    return session;
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
          const decoder = await getSession(requestSignal);
          const workspace = await mediaWorkspace();
          try {
            const outputPath = join(workspace.path, "frame.rgba");
            const result = await decoder.run<{
              timestamp: number;
              width: number;
              height: number;
              normalization?: string;
            }>(
              {
                kind: "frame",
                path,
                timestamp: frame.seconds,
                outputPath,
                format: "rgba",
              },
              { signal: requestSignal, timeoutMs, env: options.env },
            );
            if (
              Math.round(
                (result.timestamp * metadata.timeBase.denominator) /
                  metadata.timeBase.numerator,
              ) !== frame.pts
            )
              throw new Error(
                "video.frame_pts_mismatch: decoded presentation timestamp differs from selected frame",
              );
            if (
              metadata.normalization === "hdr-to-sdr-bt709" &&
              result.normalization !== "hdr-to-sdr-bt709"
            )
              throw new Error(
                "video.unsupported_color: decoder did not verify the requested HDR normalization",
              );
            rgba = await readFile(outputPath);
            if (
              rgba.length !== metadata.frameBytes ||
              result.width !== metadata.width ||
              result.height !== metadata.height
            )
              throw new Error(
                "video.frame_missing: decoder did not return exactly one complete RGBA frame",
              );
          } catch (error) {
            await stopSession();
            if (requestSignal.aborted) throw cancelled(requestSignal);
            throw error;
          } finally {
            await workspace.close();
            if (session)
              markMediaProcessIdle(sessionId, () => {
                void stopSession().catch(() => {});
              });
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
          await stopSession();
          lifetime.removeEventListener("abort", closeOnAbort);
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
      decoderCursors: session ? 1 : 0,
      maxDecoderCursors,
      maxLiveMediaProcesses: maximumLiveMediaProcesses,
      closed,
    }),
  };
}
