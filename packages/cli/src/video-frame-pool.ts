import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  openVideoFrameSource,
  type DecodedVideoFrame,
  type VideoFrameSource,
  type VideoFrameSourceLimits,
} from "./video-frame-source.js";
import { findVideoFrameOffset } from "./video-pts.js";

export interface VideoFramePoolLimits {
  /** Defaults are hard ceilings: four handles, 256 MiB/source and total. */
  maxSources?: number;
  maxSourceBytes?: number;
  maxTotalBytes?: number;
  fetchTimeoutMs?: number;
  decoder?: VideoFrameSourceLimits;
}
export interface VideoFramePoolOptions {
  env?: NodeJS.ProcessEnv;
  snapshot: { url: string; session: { sourceVersion: string } };
  /** Caller-owned parent; only a unique verified child is removed on close. */
  directory: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  limits?: VideoFramePoolLimits;
  signal?: AbortSignal;
}
export interface VideoFramePoolDependencies {
  fetch?: typeof fetch;
  openSource?: typeof openVideoFrameSource;
}
export interface VideoFramePool {
  frameAt(
    src: string,
    zeroBasedSeconds: number,
    signal?: AbortSignal,
  ): Promise<DecodedVideoFrame>;
  close(): Promise<void>;
}
interface Entry {
  promise: Promise<VideoFrameSource>;
  source?: VideoFrameSource;
  reserved: number;
  path: string;
}

function positive(
  value: number | undefined,
  fallback: number,
  name: string,
  maximum = fallback,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum)
    throw new Error(
      `video.pool_invalid_limit: ${name} must be between 1 and ${maximum}`,
    );
  return result;
}
function aborted(signal: AbortSignal): Error {
  return new Error("video.pool_cancelled: pool work was cancelled", {
    cause: signal.reason,
  });
}
function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw aborted(signal);
}
async function waitFor<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  checkAbort(signal);
  return new Promise((done, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(aborted(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        done(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/**
 * Frozen encoded assets + bounded decoder handles, without a mutable original path.
 * No handle eviction: callers must close the pool in finally after workers join.
 * A cancelled request stops waiting, not an open shared with other workers;
 * closing the pool aborts and joins every fetch and decoder before removing bytes.
 */
export async function createVideoFramePool(
  options: VideoFramePoolOptions,
  dependencies: VideoFramePoolDependencies = {},
): Promise<VideoFramePool> {
  const base = new URL(options.snapshot.url),
    version = options.snapshot.session.sourceVersion;
  if (
    !["http:", "https:"].includes(base.protocol) ||
    !["127.0.0.1", "[::1]"].includes(base.hostname) ||
    base.username ||
    base.password ||
    typeof version !== "string" ||
    !version.trim()
  )
    throw new Error(
      "video.pool_invalid_snapshot: a versioned numeric-loopback snapshot URL is required",
    );
  const limits = options.limits ?? {},
    maxSources = positive(limits.maxSources, 4, "maxSources"),
    maxSourceBytes = positive(
      limits.maxSourceBytes,
      256 * 1024 * 1024,
      "maxSourceBytes",
    ),
    maxTotalBytes = positive(
      limits.maxTotalBytes,
      256 * 1024 * 1024,
      "maxTotalBytes",
    ),
    timeoutMs = positive(
      limits.fetchTimeoutMs,
      30_000,
      "fetchTimeoutMs",
      120_000,
    );
  const owner = new AbortController(),
    lifetime = options.signal
      ? AbortSignal.any([owner.signal, options.signal])
      : owner.signal;
  checkAbort(lifetime);
  const requestedParent = resolve(options.directory);
  await mkdir(requestedParent, { recursive: true });
  const parent = await realpath(requestedParent),
    owned = await mkdtemp(join(parent, ".velocast-video-pool-"));
  const initial = await lstat(owned, { bigint: true }),
    identity = `${initial.dev}:${initial.ino}`;
  const entries = new Map<string, Entry>(),
    requests = new Set<Promise<DecodedVideoFrame>>();
  let reserved = 0,
    nextFile = 0,
    closed = false,
    closePromise: Promise<void> | undefined;

  async function download(url: URL, entry: Entry): Promise<VideoFrameSource> {
    const transfer = new AbortController(),
      signal = AbortSignal.any([lifetime, transfer.signal]);
    const timer = setTimeout(
      () => transfer.abort(new Error("video.pool_fetch_timeout")),
      timeoutMs,
    );
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
      file: Awaited<ReturnType<typeof open>> | undefined,
      source: VideoFrameSource | undefined;
    try {
      checkAbort(signal);
      const response = await (dependencies.fetch ?? fetch)(url, {
        signal,
        redirect: "error",
        headers: { "Accept-Encoding": "identity" },
      });
      if (
        response.status !== 200 ||
        response.redirected ||
        (response.url && new URL(response.url).origin !== base.origin)
      ) {
        await response.body?.cancel();
        throw new Error(
          "video.pool_response: encoded assets require a complete non-redirected 200 response",
        );
      }
      const actualVersion = response.headers.get("X-Velocast-Source-Version"),
        digest = response.headers.get("X-Velocast-Content-SHA256"),
        lengthHeader = response.headers.get("Content-Length"),
        encoding = response.headers.get("Content-Encoding");
      if (
        actualVersion !== version ||
        !digest ||
        !/^([a-f0-9]{64})$/i.test(digest) ||
        !lengthHeader ||
        !/^\d+$/.test(lengthHeader) ||
        (encoding && encoding !== "identity")
      ) {
        await response.body?.cancel();
        throw new Error(
          "video.pool_headers: snapshot version, full-body SHA256 and unencoded Content-Length must match",
        );
      }
      const length = Number(lengthHeader);
      if (
        !Number.isSafeInteger(length) ||
        length < 1 ||
        length > maxSourceBytes ||
        reserved + length > maxTotalBytes
      ) {
        await response.body?.cancel();
        throw new Error(
          "video.pool_encoded_limit: source or aggregate encoded-byte budget exceeded",
        );
      }
      if (!response.body)
        throw new Error("video.pool_response: encoded body is missing");
      entry.reserved = length;
      reserved += length;
      file = await open(entry.path, "wx", 0o600);
      reader = response.body.getReader();
      const hash = createHash("sha256");
      let received = 0;
      while (true) {
        checkAbort(signal);
        const chunk = await reader.read();
        if (chunk.done) break;
        received += chunk.value.byteLength;
        if (received > length)
          throw new Error(
            "video.pool_length_mismatch: response exceeds declared full-body length",
          );
        hash.update(chunk.value);
        let offset = 0;
        while (offset < chunk.value.byteLength) {
          const written = await file.write(
            chunk.value,
            offset,
            chunk.value.byteLength - offset,
          );
          if (!written.bytesWritten)
            throw new Error(
              "video.pool_write_failed: encoded copy did not advance",
            );
          offset += written.bytesWritten;
        }
      }
      if (received !== length)
        throw new Error(
          "video.pool_length_mismatch: response ended before declared full-body length",
        );
      const actual = hash.digest("hex");
      if (actual !== digest.toLowerCase())
        throw new Error(
          "video.pool_hash_mismatch: encoded bytes do not match the frozen asset digest",
        );
      await file.close();
      file = undefined;
      await chmod(entry.path, 0o400);
      checkAbort(signal);
      clearTimeout(timer);
      source = await (dependencies.openSource ?? openVideoFrameSource)({
        path: entry.path,
        sourceHash: actual,
        ffmpegPath: options.ffmpegPath,
        ffprobePath: options.ffprobePath,
        env: options.env,
        limits: {
          ...limits.decoder,
          maxSourceBytes: Math.min(
            maxSourceBytes,
            limits.decoder?.maxSourceBytes ?? maxSourceBytes,
          ),
        },
        signal: lifetime,
      });
      checkAbort(lifetime);
      entry.source = source;
      return source;
    } catch (error) {
      transfer.abort(error);
      await source?.close();
      if (file) await file.close();
      await rm(entry.path, { force: true });
      reserved -= entry.reserved;
      entry.reserved = 0;
      if (entries.get(url.href) === entry) entries.delete(url.href);
      throw error;
    } finally {
      clearTimeout(timer);
      if (reader) {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
  }

  function getEntry(src: string): Entry {
    if (typeof src !== "string" || !src.trim())
      throw new Error(
        "video.pool_invalid_source: src must be a nonempty URL or relative path",
      );
    const url = new URL(src, base);
    url.hash = "";
    if (url.origin !== base.origin || url.username || url.password)
      throw new Error(
        "video.pool_source_origin: source must remain in its pinned snapshot origin",
      );
    const found = entries.get(url.href);
    if (found) return found;
    if (entries.size >= maxSources)
      throw new Error(
        "video.pool_source_limit: source-handle limit reached; no implicit eviction is performed",
      );
    const entry: Entry = {
      promise: undefined as unknown as Promise<VideoFrameSource>,
      reserved: 0,
      path: join(owned, `source-${nextFile++}.media`),
    };
    // Publish the entry before asynchronous headers can resolve: one open per URL.
    entries.set(url.href, entry);
    entry.promise = download(url, entry);
    return entry;
  }

  return {
    frameAt(src, zeroBasedSeconds, signal) {
      if (closed)
        return Promise.reject(
          new Error("video.pool_closed: frame pool is closed"),
        );
      if (!Number.isFinite(zeroBasedSeconds) || zeroBasedSeconds < 0)
        return Promise.reject(
          new Error(
            "video.time_out_of_range: source offset must be finite and nonnegative",
          ),
        );
      const requestSignal = signal
        ? AbortSignal.any([lifetime, signal])
        : lifetime;
      const request = (async () => {
        checkAbort(requestSignal);
        const entry = getEntry(src);
        // A caller may stop waiting without aborting an open shared with peers.
        const source = await waitFor(entry.promise, requestSignal);
        checkAbort(requestSignal);
        const frame = findVideoFrameOffset(source.metadata, zeroBasedSeconds);
        const result = await source.frameAt(frame.seconds, requestSignal);
        checkAbort(requestSignal);
        return result;
      })();
      requests.add(request);
      void request.then(
        () => requests.delete(request),
        () => requests.delete(request),
      );
      return request;
    },
    close() {
      if (!closePromise) {
        closed = true;
        owner.abort();
        closePromise = (async () => {
          const cleanup = await Promise.allSettled(
            [...entries.values()].map(async (entry) => {
              let source: VideoFrameSource;
              try {
                source = await entry.promise;
              } catch {
                return;
              }
              await source.close();
            }),
          );
          await Promise.allSettled([...requests]);
          const failed = cleanup.find((result) => result.status === "rejected");
          if (failed?.status === "rejected") throw failed.reason;
          const stat = await lstat(owned, { bigint: true });
          if (
            !stat.isDirectory() ||
            stat.isSymbolicLink() ||
            `${stat.dev}:${stat.ino}` !== identity ||
            dirname(owned) !== parent ||
            !basename(owned).startsWith(".velocast-video-pool-") ||
            (await realpath(owned)) !== owned
          )
            throw new Error(
              "video.pool_cleanup_scope: owned directory identity changed; refusing recursive cleanup",
            );
          await rm(owned, { recursive: true, force: true });
          entries.clear();
          reserved = 0;
        })();
      }
      return closePromise;
    },
  };
}
