import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createVideoFramePool,
  type VideoFramePool,
} from "./video-frame-pool.js";
import { buildVideoPtsIndex } from "./video-pts.js";
import type {
  VideoFrameSource,
  VideoFrameSourceOptions,
} from "./video-frame-source.js";

const directories: string[] = [],
  servers: Server[] = [],
  pools: VideoFramePool[] = [];
afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});
const version = "snapshot-v1",
  bytes = Buffer.from("frozen-media"),
  sha = createHash("sha256").update(bytes).digest("hex");
async function fixture(headers: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "velocast-video-pool-test-"));
  directories.push(directory);
  await writeFile(join(directory, "keep.txt"), "caller data");
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(200, {
      "X-Velocast-Source-Version": version,
      "X-Velocast-Content-SHA256": sha,
      "Content-Length": String(bytes.length),
      ...headers,
    });
    response.end(bytes);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no server");
  return {
    directory,
    snapshot: {
      url: `http://127.0.0.1:${address.port}/index.html`,
      session: { sourceVersion: version },
    },
    requests: () => requests,
  };
}
function backend() {
  const paths: string[] = [],
    optionsSeen: VideoFrameSourceOptions[] = [],
    times: number[] = [];
  let closes = 0;
  const metadata = buildVideoPtsIndex({
    streams: [
      {
        width: 2,
        height: 1,
        codec_name: "vp8",
        pix_fmt: "yuv420p",
        time_base: "1/1000",
      },
    ],
    frames: [2300, 2600, 2900].map((pts, index) => ({
      pts,
      best_effort_timestamp: pts,
      duration: 300,
      key_frame: index === 0 ? 1 : 0,
    })),
  });
  const open = async (
    options: VideoFrameSourceOptions,
  ): Promise<VideoFrameSource> => {
    optionsSeen.push(options);
    paths.push(options.path);
    expect(await readFile(options.path)).toEqual(bytes);
    expect(options.sourceHash).toBe(sha);
    return {
      metadata,
      frameAt: async (seconds, signal) => {
        signal?.throwIfAborted();
        times.push(seconds);
        return {
          pts: Math.round(seconds * 1000),
          timeBase: metadata.timeBase,
          width: 2,
          height: 1,
          rgba: new Uint8Array(8),
          keyframePts: 2300,
          cacheHit: false,
          elapsedMs: 0,
        };
      },
      close: async () => {
        closes++;
      },
      stats: () => ({
        cachedFrames: 0,
        cachedBytes: 0,
        cacheHits: 0,
        decodedFrames: 0,
        pendingRequests: 0,
        decoderCursors: 0,
        maxDecoderCursors: 4,
        maxLiveMediaProcesses: 8,
        closed: false,
      }),
    };
  };
  return { open, paths, optionsSeen, times, closes: () => closes };
}

it("deduplicates concurrent opens, validates immutable bytes and maps relative integer PTS", async () => {
  const f = await fixture(),
    b = backend();
  const pool = await createVideoFramePool(f, { openSource: b.open });
  pools.push(pool);
  await Promise.all([
    pool.frameAt("clip.webm", 0.3),
    pool.frameAt("clip.webm", 0),
  ]);
  expect(f.requests()).toBe(1);
  expect(b.paths).toHaveLength(1);
  expect(b.times).toEqual([2.6, 2.3]);
  const owned = dirname(b.paths[0]!);
  expect(owned).not.toBe(f.directory);
  await pool.close();
  expect(b.closes()).toBe(1);
  await expect(access(owned)).rejects.toThrow();
  expect(await readFile(join(f.directory, "keep.txt"), "utf8")).toBe(
    "caller data",
  );
});

it.each([
  [{ "X-Velocast-Source-Version": "other-version" }, "video.pool_headers"],
  [{ "X-Velocast-Content-SHA256": "0".repeat(64) }, "video.pool_hash_mismatch"],
  [{ "Content-Length": String(257 * 1024 * 1024) }, "video.pool_encoded_limit"],
] as const)(
  "rejects invalid snapshot headers or bytes before opening a decoder",
  async (headers, message) => {
    const f = await fixture(headers),
      b = backend(),
      pool = await createVideoFramePool(f, { openSource: b.open });
    pools.push(pool);
    await expect(pool.frameAt("clip.webm", 0)).rejects.toThrow(message);
    expect(b.paths).toEqual([]);
    await pool.close();
    expect(await readdir(f.directory)).toEqual(["keep.txt"]);
  },
);

it("aligns the default per-source decoder budget with the 256 MiB snapshot aggregate", async () => {
  const f = await fixture(),
    b = backend(),
    pool = await createVideoFramePool(f, { openSource: b.open });
  pools.push(pool);
  await pool.frameAt("clip.mp4", 0);
  expect(b.optionsSeen[0]?.limits?.maxSourceBytes).toBe(256 * 1024 * 1024);
});

it("rejects off-origin sources and nonnumeric/nonversioned snapshot origins", async () => {
  const f = await fixture(),
    b = backend(),
    pool = await createVideoFramePool(f, { openSource: b.open });
  pools.push(pool);
  await expect(
    pool.frameAt("https://example.invalid/video.mp4", 0),
  ).rejects.toThrow("video.pool_source_origin");
  await expect(pool.frameAt("file:///tmp/video.mp4", 0)).rejects.toThrow(
    "video.pool_source_origin",
  );
  expect(f.requests()).toBe(0);
  await expect(
    createVideoFramePool({
      ...f,
      snapshot: { ...f.snapshot, url: "http://localhost:1234/index.html" },
    }),
  ).rejects.toThrow("video.pool_invalid_snapshot");
  await expect(
    createVideoFramePool({
      ...f,
      snapshot: { ...f.snapshot, session: { sourceVersion: "" } },
    }),
  ).rejects.toThrow("video.pool_invalid_snapshot");
});

it("bounds source handles and aggregate encoded bytes without implicit eviction", async () => {
  const f = await fixture(),
    b = backend();
  const pool = await createVideoFramePool(
    { ...f, limits: { maxSources: 2 } },
    { openSource: b.open },
  );
  pools.push(pool);
  await pool.frameAt("one.webm", 0);
  await pool.frameAt("two.webm", 0);
  await expect(pool.frameAt("three.webm", 0)).rejects.toThrow(
    "video.pool_source_limit",
  );
  expect(b.paths).toHaveLength(2);
  const other = await fixture(),
    otherBackend = backend(),
    limited = await createVideoFramePool(
      { ...other, limits: { maxTotalBytes: bytes.length } },
      { openSource: otherBackend.open },
    );
  pools.push(limited);
  await limited.frameAt("one.webm", 0);
  await expect(limited.frameAt("two.webm", 0)).rejects.toThrow(
    "video.pool_encoded_limit",
  );
  expect(otherBackend.paths).toHaveLength(1);
});

it("one cancelled waiter does not abort an open shared with another frame", async () => {
  const f = await fixture(),
    b = backend();
  let resolveOpen!: () => void, started!: () => void;
  const startedPromise = new Promise<void>((resolve) => (started = resolve));
  const pool = await createVideoFramePool(f, {
    openSource: async (options) => {
      const source = await b.open(options);
      started();
      return new Promise<VideoFrameSource>(
        (resolve) => (resolveOpen = () => resolve(source)),
      );
    },
  });
  pools.push(pool);
  const controller = new AbortController(),
    first = pool.frameAt("clip.webm", 0, controller.signal),
    second = pool.frameAt("clip.webm", 0.3);
  const rejection = expect(first).rejects.toThrow("video.pool_cancelled");
  await startedPromise;
  controller.abort();
  await rejection;
  resolveOpen();
  expect((await second).pts).toBe(2600);
  expect(f.requests()).toBe(1);
});

it("close initiates decoder shutdown, joins late work, and never returns its cancelled frame", async () => {
  const f = await fixture(),
    b = backend();
  let started!: () => void, finish!: () => void;
  const began = new Promise<void>((resolve) => (started = resolve));
  const pool = await createVideoFramePool(f, {
    openSource: async (options) => {
      const source = await b.open(options);
      return {
        ...source,
        frameAt: async (seconds) => {
          started();
          await new Promise<void>((resolve) => (finish = resolve));
          return source.frameAt(seconds);
        },
        close: async () => {
          finish?.();
          await source.close();
        },
      };
    },
  });
  pools.push(pool);
  const request = pool.frameAt("clip.webm", 0),
    rejected = expect(request).rejects.toThrow("video.pool_cancelled");
  await began;
  await pool.close();
  await rejected;
  expect(b.closes()).toBe(1);
  expect(await readdir(f.directory)).toEqual(["keep.txt"]);
  await expect(pool.frameAt("clip.webm", 0)).rejects.toThrow(
    "video.pool_closed",
  );
});

it("close aborts an unfinished streamed fetch and removes only its owned child", async () => {
  const f = await fixture(),
    b = backend();
  let signal: AbortSignal | undefined, started!: () => void;
  const began = new Promise<void>((resolve) => (started = resolve));
  const fetcher: typeof fetch = async (_url, options) => {
    signal = options?.signal as AbortSignal;
    started();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          signal!.addEventListener(
            "abort",
            () => controller.error(new Error("fetch cancelled")),
            { once: true },
          );
        },
      }),
      {
        headers: {
          "X-Velocast-Source-Version": version,
          "X-Velocast-Content-SHA256": sha,
          "Content-Length": String(bytes.length),
        },
      },
    );
  };
  const pool = await createVideoFramePool(f, {
    fetch: fetcher,
    openSource: b.open,
  });
  pools.push(pool);
  const request = pool.frameAt("clip.webm", 0),
    rejection = expect(request).rejects.toThrow(/cancel/);
  await began;
  await pool.close();
  await rejection;
  expect(signal?.aborted).toBe(true);
  expect(b.paths).toEqual([]);
  expect(await readdir(f.directory)).toEqual(["keep.txt"]);
});

it.each([
  ["Content-Length", undefined, "video.pool_headers"],
  ["X-Velocast-Content-SHA256", undefined, "video.pool_headers"],
  ["Content-Encoding", "gzip", "video.pool_headers"],
  ["Content-Length", String(bytes.length + 1), "video.pool_length_mismatch"],
  ["Content-Length", String(bytes.length - 1), "video.pool_length_mismatch"],
] as const)(
  "rejects missing headers and incomplete or oversized bodies",
  async (name, value, message) => {
    const f = await fixture(),
      b = backend();
    const headers = new Headers({
      "X-Velocast-Source-Version": version,
      "X-Velocast-Content-SHA256": sha,
      "Content-Length": String(bytes.length),
    });
    if (value === undefined) headers.delete(name);
    else headers.set(name, value);
    const pool = await createVideoFramePool(f, {
      fetch: async () => new Response(bytes, { headers }),
      openSource: b.open,
    });
    pools.push(pool);
    await expect(pool.frameAt("clip.webm", 0)).rejects.toThrow(message);
    expect(b.paths).toEqual([]);
    await pool.close();
    expect(await readdir(f.directory)).toEqual(["keep.txt"]);
  },
);

it("never follows redirects to a different endpoint", async () => {
  const f = await fixture(),
    b = backend();
  const server = servers.at(-1)!;
  server.removeAllListeners("request");
  server.on("request", (_request, response) => {
    response.writeHead(302, { Location: "https://example.invalid/clip.webm" });
    response.end();
  });
  const pool = await createVideoFramePool(f, { openSource: b.open });
  pools.push(pool);
  await expect(pool.frameAt("clip.webm", 0)).rejects.toThrow();
  expect(b.paths).toEqual([]);
  await pool.close();
  expect(await readdir(f.directory)).toEqual(["keep.txt"]);
});
