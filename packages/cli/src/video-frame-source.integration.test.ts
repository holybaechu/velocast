import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  openVideoFrameSource,
  type VideoFrameSource,
} from "./video-frame-source.js";
import { writeTestVideo } from "./media-test-fixtures.js";
let directory: string;
const sources: VideoFrameSource[] = [];
async function open(name: string, limits = {}): Promise<VideoFrameSource> {
  const path = join(directory, name),
    sourceHash = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  const source = await openVideoFrameSource({ path, sourceHash, limits });
  sources.push(source);
  return source;
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "velocast-webcodecs-video-"));
  await writeTestVideo(join(directory, "cfr.mp4"), directory, {
    frames: 12,
    fps: 10,
  });
  await writeTestVideo(join(directory, "vfr.mp4"), directory, {
    frames: 6,
    fps: 10,
    timestamps: [0, 0.08, 0.28, 0.32, 0.6, 0.7],
  });
  await writeTestVideo(join(directory, "fractional.mp4"), directory, {
    frames: 8,
    fps: 6,
  });
  await writeTestVideo(join(directory, "rotated.mp4"), directory, {
    width: 80,
    height: 64,
    frames: 2,
    fps: 10,
    rotation: 90,
  });
}, 120_000);
afterAll(async () => {
  await Promise.allSettled(sources.splice(0).map((source) => source.close()));
  await rm(directory, { recursive: true, force: true });
});
it("preserves exact indexed timestamps across forward and reverse decoding and isolates cached bytes", async () => {
  const source = await open("cfr.mp4");
  const hashes = new Map<number, string>();
  for (const index of [0, 1, 2, 9, 10, 9, 3, 9]) {
    const frame = await source.frameAt(source.metadata.frames[index]!.seconds);
    const hash = createHash("sha256").update(frame.rgba).digest("hex");
    expect(frame.pts).toBe(source.metadata.frames[index]!.pts);
    expect(hash).toBe(hashes.get(index) ?? hash);
    hashes.set(index, hash);
  }
  const mutable = await source.frameAt(source.metadata.frames[9]!.seconds);
  mutable.rgba[0] = 0;
  expect(
    createHash("sha256")
      .update((await source.frameAt(source.metadata.frames[9]!.seconds)).rgba)
      .digest("hex"),
  ).toBe(hashes.get(9));
  expect(source.stats().cachedFrames).toBeLessThanOrEqual(4);
}, 120_000);
it("selects original variable-rate presentation intervals", async () => {
  const source = await open("vfr.mp4");
  expect(
    source.metadata.frames.map((frame) => Math.round(frame.seconds * 1000000)),
  ).toEqual([0, 80000, 280000, 320000, 600000, 700000]);
  expect((await source.frameAt(0.2)).pts).toBe(source.metadata.frames[1]!.pts);
  expect((await source.frameAt(0.6)).pts).toBe(source.metadata.frames[4]!.pts);
  expect((await source.frameAt(0.28)).pts).toBe(source.metadata.frames[2]!.pts);
  expect((await source.frameAt(0.6)).cacheHit).toBe(true);
}, 120_000);
it("applies container rotation to the decoded display raster", async () => {
  const source = await open("rotated.mp4");
  expect(source.metadata).toMatchObject({
    encodedWidth: 80,
    encodedHeight: 64,
    width: 64,
    height: 80,
    rotationDegrees: 270,
  });
  const frame = await source.frameAt(0);
  expect(frame.rgba.length).toBe(64 * 80 * 4);
  expect(frame.width).toBe(64);
  expect(frame.height).toBe(80);
}, 120_000);
it("bounds the request queue and joins an aborted real decode", async () => {
  const source = await open("cfr.mp4", { maxQueuedRequests: 1 });
  const controller = new AbortController();
  const pending = source.frameAt(0.9, controller.signal);
  const rejection = expect(pending).rejects.toThrow();
  await expect(source.frameAt(0)).rejects.toThrow("video.queue_limit");
  controller.abort();
  await rejection;
  expect((await source.frameAt(0)).pts).toBe(0);
}, 120_000);

it("retains rational source PTS at fractional frame boundaries", async () => {
  const source = await open("fractional.mp4");
  for (const [index, frame] of source.metadata.frames.entries()) {
    expect((await source.frameAt(index / 6)).pts).toBe(frame.pts);
    if (index > 0)
      expect((await source.frameAt(index / 6 - 0.000002)).pts).toBe(
        source.metadata.frames[index - 1]!.pts,
      );
  }
}, 120_000);
