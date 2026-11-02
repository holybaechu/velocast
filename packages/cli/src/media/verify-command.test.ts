import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyMediaCommand } from "./verify-command.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "velocast-verify-test-"));
  directories.push(directory);
  const path = join(directory, "video.mp4");
  await writeFile(path, "media fixture");
  return path;
}
const media = {
  duration: 0.1,
  container: "mp4",
  video: {
    width: 640,
    height: 360,
    codedWidth: 640,
    codedHeight: 360,
    rotation: 0,
    codec: "avc",
    timeBase: { numerator: 1, denominator: 30000 },
    frames: [
      { pts: 0, duration: 1000, keyframe: true },
      { pts: 1000, duration: 1000, keyframe: false },
      { pts: 2000, duration: 1000, keyframe: false },
    ],
  },
  audio: { codec: "aac", sampleRate: 48000, channels: 2, duration: 0.1 },
};

it("checks actual media dimensions, frame timestamps and audio against explicit expectations", async () => {
  const path = await fixture();
  const probe = vi.fn(async () => media);
  const write = vi.fn();
  const result = await verifyMediaCommand(
    path,
    {
      json: true,
      expectFrames: 3,
      expectFps: 30,
      expectWidth: 640,
      expectHeight: 360,
      expectAudio: true,
    },
    { probe, write },
  );
  expect(result).toMatchObject({
    status: "success",
    level: "metadata",
    path,
    video: { width: 640, height: 360, frameCount: 3 },
    audio: { sampleRate: 48000 },
  });
  expect(JSON.parse(write.mock.calls[0]![0])).toMatchObject({
    status: "success",
  });
  expect(probe).toHaveBeenCalledWith(path);
});

it("reports expected-vs-actual mismatches as structured failure and rejects the command", async () => {
  const path = await fixture();
  const write = vi.fn();
  await expect(
    verifyMediaCommand(
      path,
      { json: true, expectFrames: 4, expectAudio: true },
      {
        probe: async () => ({ ...media, audio: undefined }),
        write,
      },
    ),
  ).rejects.toThrow("verify.mismatch");
  expect(JSON.parse(write.mock.calls[0]![0])).toMatchObject({
    status: "failure",
    issues: [
      expect.stringContaining("expected 4"),
      expect.stringContaining("audio"),
    ],
  });
});

it("rejects a repeated frame timestamp even when the frame count matches", async () => {
  const path = await fixture();
  await expect(
    verifyMediaCommand(
      path,
      { expectFrames: 3, expectFps: 30 },
      {
        probe: async () => ({
          ...media,
          video: {
            ...media.video,
            frames: [
              media.video.frames[0]!,
              media.video.frames[0]!,
              media.video.frames[2]!,
            ],
          },
        }),
        write: () => {},
      },
    ),
  ).rejects.toThrow("verify.mismatch");
});

it("rejects invalid expectations before opening the media runtime", async () => {
  const probe = vi.fn(async () => media);
  await expect(
    verifyMediaCommand("missing.mp4", { expectFrames: "2.5" }, { probe }),
  ).rejects.toThrow("verify.invalid_expectation");
  expect(probe).not.toHaveBeenCalled();
});
