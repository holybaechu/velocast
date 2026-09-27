import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  openVideoFrameSource,
  type VideoFrameSource,
  type VideoToolEvent,
} from "./video-frame-source.js";

let directory: string;
const sources: VideoFrameSource[] = [];

async function command(args: string[], capture = false): Promise<Buffer> {
  const child = spawn("ffmpeg", args, {
    stdio: ["ignore", capture ? "pipe" : "ignore", "pipe"],
    windowsHide: true,
  });
  const stdout: Buffer[] = [];
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on(
    "data",
    (chunk: Buffer) => (stderr += chunk.toString("utf8")),
  );
  const code = await new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("close", done);
  });
  if (code !== 0) throw new Error(`ffmpeg exited ${code}: ${stderr}`);
  return Buffer.concat(stdout);
}

async function open(
  name: string,
  limits = {},
  events: VideoToolEvent[] = [],
): Promise<VideoFrameSource> {
  const path = join(directory, name),
    bytes = await readFile(path),
    source = await openVideoFrameSource(
      {
        path,
        sourceHash: createHash("sha256").update(bytes).digest("hex"),
        limits,
      },
      { onCommand: (event) => events.push(event) },
    );
  sources.push(source);
  return source;
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "velocast-real-video-"));
  await command([
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x360:rate=30:duration=6",
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "30",
    "-keyint_min",
    "30",
    "-sc_threshold",
    "0",
    "-threads",
    "1",
    join(directory, "cfr.mp4"),
  ]);
  await command([
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=30:duration=2",
    "-vf",
    "select=if(lt(n\\,20)\\,not(mod(n\\,2))\\,not(mod(n\\,5)))",
    "-fps_mode",
    "vfr",
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "30",
    join(directory, "vfr.mp4"),
  ]);
  await command([
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=120x80:rate=5:duration=1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    join(directory, "landscape.mp4"),
  ]);
  await command([
    "-y",
    "-v",
    "error",
    "-display_rotation:v:0",
    "90",
    "-i",
    join(directory, "landscape.mp4"),
    "-c",
    "copy",
    join(directory, "rotated.mp4"),
  ]);
  await command([
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x90:rate=5:duration=1",
    "-c:v",
    "libx265",
    "-pix_fmt",
    "yuv420p10le",
    "-x265-params",
    "log-level=error:pools=1:frame-threads=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:range=limited",
    "-color_primaries",
    "bt2020",
    "-color_trc",
    "smpte2084",
    "-colorspace",
    "bt2020nc",
    "-color_range",
    "tv",
    join(directory, "hdr-hevc.mp4"),
  ]);
}, 60_000);

afterAll(async () => {
  await Promise.allSettled(sources.splice(0).map((source) => source.close()));
  await rm(directory, { recursive: true, force: true });
});

it("keeps sequential decoders warm and preserves exact PTS through seeks and reverse", async () => {
  const events: VideoToolEvent[] = [],
    source = await open("cfr.mp4", {}, events),
    sequence = [0, 1, 2, 3, 45, 46, 45, 12, 13, 45],
    hashes = new Map<number, string>();
  for (const index of sequence) {
    const indexed = source.metadata.frames[index]!,
      frame = await source.frameAt(indexed.seconds),
      digest = createHash("sha256").update(frame.rgba).digest("hex");
    expect(frame.pts).toBe(indexed.pts);
    expect(digest).toBe(hashes.get(index) ?? digest);
    hashes.set(index, digest);
  }
  const mutable = await source.frameAt(source.metadata.frames[45]!.seconds);
  mutable.rgba[0] = (mutable.rgba[0] ?? 0) ^ 0xff;
  const unmodified = await source.frameAt(source.metadata.frames[45]!.seconds);
  expect(createHash("sha256").update(unmodified.rgba).digest("hex")).toBe(
    hashes.get(45),
  );
  expect(source.stats()).toMatchObject({
    maxDecoderCursors: 4,
    maxLiveMediaProcesses: 8,
  });
  expect(source.stats().decoderCursors).toBeGreaterThanOrEqual(2);
  expect(source.stats().decoderCursors).toBeLessThanOrEqual(4);
  await source.close();
  const decoders = events.filter((event) => event.command.includes("rawvideo"));
  expect(decoders.length).toBeLessThan(sequence.length / 2);
  expect(
    decoders.some(
      (event) =>
        event.command.includes("-seek_timestamp") &&
        event.command.includes("-noaccurate_seek"),
    ),
  ).toBe(true);
});

it("uses original VFR intervals for forward, repeat and reverse requests", async () => {
  const source = await open("vfr.mp4");
  expect(
    new Set(
      source.metadata.frames
        .slice(1)
        .map((frame, index) => frame.pts - source.metadata.frames[index]!.pts),
    ).size,
  ).toBeGreaterThan(1);
  const later = source.metadata.frames.at(-3)!,
    earlier = source.metadata.frames[2]!,
    repeated = await source.frameAt(later.seconds);
  expect((await source.frameAt(earlier.seconds)).pts).toBe(earlier.pts);
  expect((await source.frameAt(later.seconds)).pts).toBe(repeated.pts);
  const next = source.metadata.frames[3]!;
  expect((await source.frameAt((earlier.seconds + next.seconds) / 2)).pts).toBe(
    earlier.pts,
  );
});

it("reuses four repeated 30-to-60 fps worker lanes without restarting decoders", async () => {
  const events: VideoToolEvent[] = [],
    source = await open("cfr.mp4", { maxQueuedRequests: 64 }, events),
    starts = [0, 15, 30, 45],
    sequence = Array.from({ length: 3 }, (_, offset) => {
      const frames = starts.map((start) => start + offset);
      return [...frames, ...frames];
    }).flat(),
    values = await Promise.all(
      sequence.map((index) =>
        source.frameAt(source.metadata.frames[index]!.seconds),
      ),
    );
  for (let request = 0; request < sequence.length; request++)
    expect(values[request]!.pts).toBe(
      source.metadata.frames[sequence[request]!]!.pts,
    );
  expect(source.stats()).toMatchObject({
    cacheHits: sequence.length / 2,
    cachedFrames: 4,
    decoderCursors: 4,
  });
  await source.close();
  expect(
    events.filter((event) => event.command.includes("rawvideo")),
  ).toHaveLength(4);
});

it("cancels and joins an active real decoder while keeping queue work bounded", async () => {
  const source = await open("cfr.mp4", { maxQueuedRequests: 1 }),
    controller = new AbortController(),
    work = source.frameAt(
      source.metadata.frames.at(-2)!.seconds,
      controller.signal,
    );
  await expect(source.frameAt(0)).rejects.toThrow("video.queue_limit");
  setTimeout(() => controller.abort("integration cancellation"), 1);
  await expect(work).rejects.toThrow("video.cancelled");
  expect((await source.frameAt(0)).pts).toBe(source.metadata.frames[0]!.pts);
});

it("applies phone rotation explicitly and matches FFmpeg display orientation", async () => {
  const source = await open("rotated.mp4"),
    frame = await source.frameAt(source.metadata.startSeconds),
    reference = await command(
      [
        "-v",
        "error",
        "-i",
        join(directory, "rotated.mp4"),
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgba",
        "pipe:1",
      ],
      true,
    );
  expect(source.metadata).toMatchObject({
    encodedWidth: 120,
    encodedHeight: 80,
    width: 80,
    height: 120,
    rotationDegrees: 90,
  });
  expect(frame.rgba).toEqual(reference);
});

it("normalizes 10-bit HDR HEVC to deterministic SDR and exposes color metadata", async () => {
  const source = await open("hdr-hevc.mp4"),
    first = await source.frameAt(source.metadata.startSeconds),
    again = await source.frameAt(source.metadata.startSeconds);
  expect(source.metadata).toMatchObject({
    codec: "hevc",
    pixelFormat: "yuv420p10le",
    inputColor: {
      transfer: "smpte2084",
      primaries: "bt2020",
      matrix: "bt2020nc",
      range: "tv",
    },
    normalization: "hdr-to-sdr-bt709",
    outputColorSpace: "sdr-bt709-rgba",
  });
  expect(first.rgba).toEqual(again.rgba);
  expect(new Set(first.rgba).size).toBeGreaterThan(32);
});
