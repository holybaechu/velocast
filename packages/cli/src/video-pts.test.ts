import { expect, it } from "vitest";
import {
  buildVideoPtsIndex,
  findVideoFrame,
  findVideoFrameOffset,
  videoSeekTimestamp,
} from "./video-pts.js";

function probe() {
  return {
    streams: [
      {
        codec_name: "vp8",
        width: 320,
        height: 180,
        pix_fmt: "yuv420p",
        time_base: "1/1000",
        start_pts: 0,
      },
    ],
    frames: [
      { best_effort_timestamp: 0, key_frame: 1, duration: 40 },
      { best_effort_timestamp: 80, key_frame: 0, duration: 40 },
      { best_effort_timestamp: 280, key_frame: 1, duration: 40 },
      { best_effort_timestamp: 320, key_frame: 0, duration: 120 },
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

it("preserves nonzero original timestamps and floors seek arguments to microseconds", () => {
  const data = probe();
  data.streams[0]!.start_pts = 2000;
  for (const frame of data.frames) frame.best_effort_timestamp += 2000;
  const index = buildVideoPtsIndex(data);
  expect(index.startSeconds).toBe(2);
  expect(findVideoFrame(index, 2.28).pts).toBe(2280);
  expect(() => findVideoFrame(index, 0)).toThrow("video.time_out_of_range");
  expect(videoSeekTimestamp(1, { numerator: 1, denominator: 3 })).toBe(
    "0.333333",
  );
  expect(videoSeekTimestamp(-1, { numerator: 1, denominator: 3 })).toBe(
    "-0.333334",
  );
});

it("maps zero-based clip time without rounding it before a nonzero-origin PTS boundary", () => {
  const data = probe();
  data.streams[0]!.start_pts = 2300;
  data.frames = [2300, 2400, 2600, 2700].map((pts, index) => ({
    best_effort_timestamp: pts,
    key_frame: index === 0 ? 1 : 0,
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
  duplicate.frames[1]!.best_effort_timestamp = 0;
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
  const tenBit = probe();
  tenBit.streams[0]!.codec_name = "hevc";
  tenBit.streams[0]!.pix_fmt = "yuv420p10le";
  expect(buildVideoPtsIndex(tenBit)).toMatchObject({
    codec: "hevc",
    pixelFormat: "yuv420p10le",
    normalization: "none",
  });
  const ambiguousHdr = probe();
  ambiguousHdr.streams[0]!.pix_fmt = "yuv420p10le";
  Object.assign(ambiguousHdr.streams[0]!, {
    color_transfer: "smpte2084",
  });
  expect(() => buildVideoPtsIndex(ambiguousHdr)).toThrow(
    "video.unsupported_color",
  );
  const mirrored = probe();
  Object.assign(mirrored.streams[0]!, {
    side_data_list: [
      {
        side_data_type: "Display Matrix",
        rotation: 0,
        displaymatrix:
          "\n00000000:       -65536           0           0\n00000001:            0       65536           0\n00000002:            0           0  1073741824\n",
      },
    ],
  });
  expect(() => buildVideoPtsIndex(mirrored)).toThrow(
    "mirrored or scaled display matrices",
  );
  const unsafe = probe();
  unsafe.frames[0]!.best_effort_timestamp = Number.MAX_SAFE_INTEGER + 1;
  expect(() => buildVideoPtsIndex(unsafe)).toThrow("video.invalid_pts");
});

it("rejects distinct integer PTS that collapse to the same source-second value", () => {
  const data = probe();
  data.streams[0]!.time_base = "1/3";
  data.frames = [
    { best_effort_timestamp: 9007199254740973, key_frame: 1, duration: 1 },
    { best_effort_timestamp: 9007199254740974, key_frame: 0, duration: 3 },
  ];
  expect(() => buildVideoPtsIndex(data)).toThrow("video.invalid_pts");
});
