import type { MediaRunner } from "./media-runtime.js";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  openVideoFrameSource,
  videoPixelChecksum,
  type VideoFrameSource,
} from "./video-frame-source.js";

const directories: string[] = [],
  sources: VideoFrameSource[] = [];
afterEach(async () => {
  for (const source of sources.splice(0)) await source.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture(mode = "normal") {
  const directory = await mkdtemp(join(tmpdir(), "velocast-video-source-"));
  directories.push(directory);
  const path = join(directory, "source.bin");
  await writeFile(path, "immutable encoded fixture");
  const sourceHash = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
  const frames = [0, 80, 280, 320, 360].map((pts, index) => ({
    pts,
    duration: 40,
    keyframe: index === 0 || index === 2,
  }));
  let active = 0,
    maximum = 0,
    sessions = 0,
    createdSessions = 0,
    maximumSessions = 0;
  let decoded!: () => void;
  const decoding = new Promise<void>((resolve) => (decoded = resolve));
  const mediaRunner: MediaRunner = async <T>(
    operation: { kind: string; [key: string]: unknown },
    options?: { signal?: AbortSignal },
  ): Promise<T> => {
    active++;
    maximum = Math.max(maximum, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (operation.kind === "probe")
        return {
          duration: 0.4,
          video: {
            width: 2,
            height: 2,
            codedWidth: 2,
            codedHeight: 2,
            codec: "vp8",
            rotation: 0,
            colorSpace: mode === "hdr" ? { transfer: "pq" } : undefined,
            timeBase: { numerator: 1, denominator: 1000 },
            frames,
          },
        } as T;
      decoded();
      if (mode === "stall")
        await new Promise<void>((_, reject) => {
          const abort = () => reject(new Error("video.cancelled"));
          if (options?.signal?.aborted) abort();
          else
            options?.signal?.addEventListener("abort", abort, { once: true });
        });
      const timestamp = Number(operation.timestamp);
      await writeFile(
        String(operation.outputPath),
        Buffer.alloc(
          mode === "short" ? 15 : 16,
          Math.round(timestamp * 1000) % 256,
        ),
      );
      return {
        timestamp: mode === "wrong-pts" ? timestamp + 0.001 : timestamp,
        width: mode === "wrong-dimensions" ? 3 : 2,
        height: 2,
      } as T;
    } finally {
      active--;
    }
  };
  const open = async (limits = {}) => {
    const source = await openVideoFrameSource(
      { path, sourceHash, limits },
      {
        mediaRunner,
        mediaSessionFactory: async () => {
          sessions++;
          createdSessions++;
          maximumSessions = Math.max(maximumSessions, sessions);
          let closed = false;
          return {
            run: mediaRunner,
            close: async () => {
              if (!closed) {
                sessions--;
                closed = true;
              }
            },
          };
        },
      },
    );
    sources.push(source);
    return source;
  };
  return {
    path,
    sourceHash,
    open,
    sessions: () => sessions,
    createdSessions: () => createdSessions,
    maximumSessions: () => maximumSessions,
    active: () => active,
    maximum: () => maximum,
    decoding: () => decoding,
  };
}

it("returns exact PTS, uses a four-frame LRU and prevents caller mutation of cached bytes", async () => {
  const f = await fixture(),
    source = await f.open();
  const first = await source.frameAt(0.08);
  expect(first.pts).toBe(80);
  expect(first.rgba[0]).toBe(80);
  first.rgba[0] = 255;
  const again = await source.frameAt(0.1);
  expect(again.cacheHit).toBe(true);
  expect(again.rgba[0]).toBe(80);
  await source.frameAt(0.28);
  await source.frameAt(0.32);
  await source.frameAt(0.36);
  expect(source.stats()).toMatchObject({
    cachedFrames: 4,
    cachedBytes: 64,
    cacheHits: 1,
    decodedFrames: 4,
  });
  await source.frameAt(0);
  const evicted = await source.frameAt(0.08);
  expect(evicted.cacheHit).toBe(false);
  expect(f.maximum()).toBeLessThanOrEqual(8);
  expect(f.createdSessions()).toBe(1);
});

it("honors an explicit cache byte budget below the four-frame default", async () => {
  const f = await fixture(),
    source = await f.open({ maxCacheBytes: 32 });
  await source.frameAt(0);
  await source.frameAt(0.08);
  await source.frameAt(0.28);
  expect(source.stats()).toMatchObject({ cachedFrames: 2, cachedBytes: 32 });
});

it.each(["wrong-pts", "wrong-dimensions", "short"])(
  "rejects %s output instead of caching it",
  async (mode) => {
    const f = await fixture(mode),
      source = await f.open();
    await expect(source.frameAt(0.28)).rejects.toThrow(
      /video.frame_(pts_mismatch|missing)/,
    );
    expect(source.stats().cachedFrames).toBe(0);
    expect(f.active()).toBe(0);
  },
);

it("cancellation kills and joins the active child; closing is idempotent", async () => {
  const f = await fixture("stall"),
    source = await f.open();
  const controller = new AbortController();
  const frame = source.frameAt(0.28, controller.signal);
  const rejection = expect(frame).rejects.toThrow("video.cancelled");
  await f.decoding();
  controller.abort();
  await rejection;
  expect(f.active()).toBe(0);
  await Promise.all([source.close(), source.close()]);
  expect(source.stats()).toMatchObject({ closed: true, cachedFrames: 0 });
  await expect(source.frameAt(0)).rejects.toThrow("video.closed");
});

it("close cancels queued work and a bounded queue refuses excess requests", async () => {
  const f = await fixture("stall"),
    source = await f.open({ maxQueuedRequests: 1 });
  const first = source.frameAt(0.28);
  const rejected = expect(first).rejects.toThrow("video.cancelled");
  await f.decoding();
  await expect(source.frameAt(0)).rejects.toThrow("video.queue_limit");
  await source.close();
  await rejected;
  expect(f.active()).toBe(0);
});

it("detects source edits even on cache hits and enforces index/frame limits", async () => {
  const f = await fixture(),
    source = await f.open();
  await source.frameAt(0);
  await writeFile(f.path, "modified source bytes");
  await expect(source.frameAt(0)).rejects.toThrow("video.source_changed");
  const limited = await fixture();
  await expect(limited.open({ maxFrames: 2 })).rejects.toThrow(
    "video.index_limit",
  );
});

it("matches the documented zero-seeded packed-plane checksum", () => {
  expect(videoPixelChecksum(new Uint8Array([1, 2, 3]))).toBe("000A0006");
});

it("bounds actual tool children across multiple source handles", async () => {
  const f = await fixture(),
    opened = await Promise.all(Array.from({ length: 9 }, () => f.open()));
  await Promise.all(
    opened.map((source, index) =>
      source.frameAt([0.08, 0.28, 0.32][index % 3]!),
    ),
  );
  expect(f.maximum()).toBeGreaterThan(1);
  expect(f.maximum()).toBeLessThanOrEqual(8);
  expect(f.active()).toBeLessThanOrEqual(8);
  expect(f.maximumSessions()).toBeLessThanOrEqual(8);
  expect(f.createdSessions()).toBe(9);
  await Promise.all(opened.map((source) => source.close()));
  expect(f.sessions()).toBe(0);
});

it("rejects HDR without explicit source color metadata", async () => {
  const f = await fixture("hdr");
  await expect(f.open()).rejects.toThrow("video.unsupported_color");
});
