import { expect, it } from "vitest";
import {
  buildVideoPtsIndex,
  findVideoFrame,
  findVideoFrameOffset,
} from "./video-pts.js";

function probe() {
  return {
    codec: "vp8",
    width: 320,
    height: 180,
    codedWidth: 320,
    codedHeight: 180,
    rotation: 0,
    timeBase: { numerator: 1, denominator: 1000 },
    frames: [
      { pts: 0, keyframe: true, duration: 40 },
      { pts: 80, keyframe: false, duration: 40 },
      { pts: 280, keyframe: true, duration: 40 },
      { pts: 320, keyframe: false, duration: 120 },
    ],
  };
}

it("maps VFR half-open source PTS intervals and reuses low-FPS frames", () => {
  const index = buildVideoPtsIndex(probe());
  expect(findVideoFrame(index, 0).pts).toBe(0);
  expect(findVideoFrame(index, 1 / 60).pts).toBe(0);
  expect(findVideoFrame(index, 0.079).pts).toBe(0);
  expect(findVideoFrame(index, 0.08).pts).toBe(80);
  expect(findVideoFrame(index, 0.279).pts).toBe(80);
  expect(findVideoFrame(index, 0.28).pts).toBe(280);
  expect(findVideoFrame(index, 0.43)).toMatchObject({
    pts: 320,
    keyframeIndex: 2,
  });
  expect(() => findVideoFrame(index, 0.44)).toThrow("video.time_out_of_range");
  expect(() => findVideoFrame(index, -0.001)).toThrow(
    "video.time_out_of_range",
  );
});

it("preserves nonzero original timestamps", () => {
  const data = probe();
  for (const frame of data.frames) frame.pts += 2000;
  const index = buildVideoPtsIndex(data);
  expect(index.startSeconds).toBe(2);
  expect(findVideoFrame(index, 2.28).pts).toBe(2280);
  expect(() => findVideoFrame(index, 0)).toThrow("video.time_out_of_range");
});

it("maps zero-based clip time without rounding it before a nonzero-origin PTS boundary", () => {
  const data = probe();
  data.frames = [2300, 2400, 2600, 2700].map((pts, index) => ({
    pts,
    keyframe: index === 0,
    duration: 100,
  }));
  const index = buildVideoPtsIndex(data);
  expect(index.startSeconds + 0.3).toBeLessThan(2.6);
  expect(findVideoFrameOffset(index, 0).pts).toBe(2300);
  expect(findVideoFrameOffset(index, 0.299999).pts).toBe(2400);
  const selected = findVideoFrameOffset(index, 0.3);
  expect(selected.pts).toBe(2600);
  expect(findVideoFrame(index, selected.seconds)).toBe(selected);
  expect(() => findVideoFrameOffset(index, 0.5)).toThrow(
    "video.time_out_of_range",
  );
});

it("rejects unknown/ambiguous PTS, unsupported formats and resource-limit violations", () => {
  const duplicate = probe();
  duplicate.frames[1]!.pts = 0;
  expect(() => buildVideoPtsIndex(duplicate)).toThrow("video.invalid_pts");
  const missingEnd = probe();
  missingEnd.frames.at(-1)!.duration = 0;
  expect(() => buildVideoPtsIndex(missingEnd)).toThrow("video.unknown_end");
  expect(() => buildVideoPtsIndex(probe(), { maxFrames: 2 })).toThrow(
    "video.index_limit",
  );
  expect(() => buildVideoPtsIndex(probe(), { maxFrameBytes: 1024 })).toThrow(
    "video.frame_limit",
  );
  const unsupported = probe();
  unsupported.codec = "unknown";
  expect(() => buildVideoPtsIndex(unsupported)).toThrow(
    "video.unsupported_format",
  );
  const missingKeyframe = probe();
  missingKeyframe.frames[0]!.keyframe = false;
  expect(() => buildVideoPtsIndex(missingKeyframe)).toThrow(
    "video.invalid_pts",
  );
  const unsafe = probe();
  unsafe.frames[0]!.pts = Number.MAX_SAFE_INTEGER + 1;
  expect(() => buildVideoPtsIndex(unsafe)).toThrow("video.invalid_pts");
});

it("rejects distinct integer PTS that collapse to the same source-second value", () => {
  const data = probe();
  data.timeBase.denominator = 3;
  data.frames = [
    { pts: 9007199254740973, keyframe: true, duration: 1 },
    { pts: 9007199254740974, keyframe: false, duration: 3 },
  ];
  expect(() => buildVideoPtsIndex(data)).toThrow("video.invalid_pts");
});

it("uses the displayed raster for RGBA geometry and frame byte limits", () => {
  const data = { ...probe(), codedWidth: 160, width: 320 };
  expect(buildVideoPtsIndex(data)).toMatchObject({
    encodedWidth: 160,
    width: 320,
    frameBytes: 320 * 180 * 4,
    pixelFormat: "rgba",
  });
  expect(() =>
    buildVideoPtsIndex(data, { maxFrameBytes: 160 * 180 * 4 }),
  ).toThrow("video.frame_limit");
});

it("normalizes explicit HDR metadata and rejects an unknown source range", () => {
  const colorSpace = {
    transfer: "pq",
    primaries: "bt2020",
    matrix: "bt2020-ncl",
  };
  expect(
    buildVideoPtsIndex({
      ...probe(),
      colorSpace: { ...colorSpace, fullRange: false },
    }),
  ).toMatchObject({
    normalization: "hdr-to-sdr-bt709",
    inputColor: {
      transfer: "smpte2084",
      primaries: "bt2020",
      matrix: "bt2020nc",
      range: "tv",
    },
  });
  expect(() => buildVideoPtsIndex({ ...probe(), colorSpace })).toThrow(
    "video.unsupported_color",
  );
});
