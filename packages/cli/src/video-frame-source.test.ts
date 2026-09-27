import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  openVideoFrameSource,
  videoPixelChecksum,
  type VideoFrameSource,
  type VideoToolEvent,
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
  const path = join(directory, "source.bin"),
    script = join(directory, "tool.cjs");
  await writeFile(path, "immutable encoded fixture");
  const sourceHash = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
  const probe = {
    streams: [
      {
        codec_name: "vp8",
        width: 2,
        height: 2,
        pix_fmt: "yuv420p",
        time_base: "1/1000",
      },
    ],
    frames: [0, 80, 280, 320, 360].map((pts, index) => ({
      pts,
      best_effort_timestamp: pts,
      key_frame: index === 0 || index === 2 ? 1 : 0,
      duration: 40,
    })),
  };
  await writeFile(
    script,
    `const item=JSON.parse(process.argv[2]);
if(item.stall){setInterval(()=>{},1000);}else setTimeout(()=>{if(item.probe)process.stdout.write(JSON.stringify(item.probe));else{process.stderr.write(item.stderr);for(const frame of item.frames)process.stdout.write(Buffer.alloc(frame.bytes,frame.value));}},10);`,
  );
  const events: VideoToolEvent[] = [],
    commands: string[][] = [];
  let active = 0,
    maximum = 0;
  let decoded!: () => void;
  let decoding = new Promise<void>((resolve) => (decoded = resolve));
  const launch = (
    binary: string,
    args: readonly string[],
    options: SpawnOptions,
  ): ChildProcess => {
    commands.push([binary, ...args]);
    let item: unknown;
    if (binary === "probe") item = { probe };
    else {
      const seekIndex = args.indexOf("-ss"),
        filter = args[args.indexOf("-vf") + 1]!,
        selectedPts = Number(
          /select=gte\(pts\\,(-?\d+)\)/.exec(filter)?.[1] ?? 0,
        ),
        startPts = Math.max(
          selectedPts,
          seekIndex < 0 ? 0 : Math.round(Number(args[seekIndex + 1]) * 1000),
        ),
        frames = probe.frames.filter((frame) => frame.pts >= startPts),
        stderr = frames
          .map((frame, index) => {
            const bytes = Buffer.alloc(16, frame.pts % 256),
              checksum = videoPixelChecksum(bytes);
            return `[showinfo@velocast_pts @ fixture] n: ${index} pts: ${mode === "wrong-pts" ? frame.pts + 1 : frame.pts} pts_time: 0 fmt:rgba s:2x2 checksum:${mode === "wrong-pixels" ? "00000000" : checksum}`;
          })
          .join("\n");
      item = {
        frames: frames.map((frame) => ({
          bytes: mode === "short" ? 15 : 16,
          value: frame.pts % 256,
        })),
        stall: mode === "stall",
        stderr: `[showinfo@velocast_pts @ fixture] config in time_base: 1/1000, frame_rate: 25/1\n${stderr}\n`,
      };
      decoded();
    }
    const child = spawn(
      process.execPath,
      [script, JSON.stringify(item)],
      options,
    );
    active++;
    maximum = Math.max(maximum, active);
    child.once("close", () => active--);
    return child;
  };
  const open = async (limits = {}) => {
    const source = await openVideoFrameSource(
      { path, sourceHash, ffmpegPath: "decoder", ffprobePath: "probe", limits },
      { spawn: launch, onCommand: (event) => events.push(event) },
    );
    sources.push(source);
    return source;
  };
  return {
    path,
    sourceHash,
    open,
    events,
    commands,
    active: () => active,
    maximum: () => maximum,
    decoding: () => decoding,
    resetDecoding: () => {
      decoding = new Promise((resolve) => (decoded = resolve));
    },
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
  const decoder = f.commands.find((command) => command.includes("rawvideo"));
  expect(decoder).toBeDefined();
  expect(decoder).toContain("-copyts");
  expect(decoder).toContain("-format_whitelist");
  expect(decoder).toContain("mov,matroska,webm");
  expect(f.maximum()).toBeLessThanOrEqual(4);
});

it("honors an explicit cache byte budget below the four-frame default", async () => {
  const f = await fixture(),
    source = await f.open({ maxCacheBytes: 32 });
  await source.frameAt(0);
  await source.frameAt(0.08);
  await source.frameAt(0.28);
  expect(source.stats()).toMatchObject({ cachedFrames: 2, cachedBytes: 32 });
});

it.each(["wrong-pts", "wrong-pixels", "short"])(
  "rejects %s output instead of caching it",
  async (mode) => {
    const f = await fixture(mode),
      source = await f.open();
    await expect(source.frameAt(0.28)).rejects.toThrow("video.pts_mismatch");
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
});
