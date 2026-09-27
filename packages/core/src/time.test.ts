import { describe, expect, it } from "vitest";
import {
  containsFrame,
  createFrameRange,
  resolveSequenceFrame,
  framesToSeconds,
  secondsToFrames,
  framesToSamples,
  samplesToFrames,
  secondsToSamples,
  samplesToSeconds,
} from "./index.js";

describe("frame ranges", () => {
  it("includes the start, excludes the end, and represents an empty range", () => {
    const range = createFrameRange(10, 13);
    expect([9, 10, 12, 13].map((frame) => containsFrame(range, frame))).toEqual(
      [false, true, true, false],
    );
    expect(containsFrame(createFrameRange(10, 10), 10)).toBe(false);
  });

  it.each([NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects unsafe frame values: %s",
    (value) => {
      expect(() => createFrameRange(value, 10)).toThrow();
      expect(() => createFrameRange(0, value)).toThrow();
      expect(() => containsFrame(createFrameRange(0, 10), value)).toThrow();
    },
  );

  it("validates supplied bounds rather than accepting a malformed range", () => {
    expect(() => createFrameRange(10, 9)).toThrow(/end/);
    expect(() => containsFrame({ start: 10, end: 9 }, 10)).toThrow(/end/);
    expect(createFrameRange(-0, 0)).toEqual({ start: 0, end: 0 });
  });
});

describe("time unit conversion", () => {
  it("uses explicit signed rounding and exact integer-ratio audio boundaries", () => {
    expect(framesToSeconds(90, 60)).toBe(1.5);
    expect(secondsToFrames(1.51, 60, "floor")).toBe(90);
    expect(secondsToFrames(1.51, 60, "ceil")).toBe(91);
    expect(secondsToFrames(1.51, 60, "round")).toBe(91);
    expect(framesToSamples(1, 60, 44100, "round")).toBe(735);
    expect(framesToSamples(1, 24, 44100, "floor")).toBe(1837);
    expect(framesToSamples(1, 24, 44100, "ceil")).toBe(1838);
    expect(framesToSamples(-1, 24, 44100, "round")).toBe(-1837);
    expect(samplesToFrames(735, 44100, 60, "floor")).toBe(1);
    expect(secondsToSamples(1.5, 48000, "round")).toBe(72000);
    expect(samplesToSeconds(72000, 48000)).toBe(1.5);
    expect(framesToSamples(Number.MAX_SAFE_INTEGER, 60, 60, "round")).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("maps absolute sample boundaries instead of accumulating rounded durations", () => {
    const boundaries = Array.from({ length: 25 }, (_, frame) =>
      framesToSamples(frame, 24, 44100, "round"),
    );
    expect(boundaries[1]).toBe(1838);
    expect(boundaries[2]).toBe(3675);
    expect(boundaries[24]).toBe(44100);
    expect(framesToSamples(24, 24, 44100, "round")).not.toBe(1838 * 24);
  });

  it.each([24, 30, 60, 29.97, 60000 / 1001])(
    "round-trips aligned frames with explicit nearest rounding at %s fps",
    (fps) => {
      for (const frame of [0, 1, 123, 10799, -123]) {
        expect(secondsToFrames(framesToSeconds(frame, fps), fps, "round")).toBe(
          frame,
        );
      }
    },
  );

  it("supports fractional fps and defines negative half ties without negative zero", () => {
    expect(framesToSamples(3000, 60000 / 1001, 48000, "round")).toBe(2402400);
    expect(samplesToFrames(2402400, 48000, 60000 / 1001, "round")).toBe(3000);
    expect(secondsToFrames(-0.25, 2, "floor")).toBe(-1);
    expect(secondsToFrames(-0.25, 2, "ceil")).toBe(0);
    expect(secondsToFrames(-0.25, 2, "round")).toBe(0);
    expect(samplesToFrames(-1, 2, 1, "round")).toBe(0);
    expect(samplesToFrames(-3, 2, 1, "round")).toBe(-1);
    expect(secondsToSamples(-0.5, 1, "round")).toBe(0);
  });

  it.each([0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid rates: %s",
    (rate) => {
      expect(() => framesToSeconds(1, rate)).toThrow();
      expect(() => secondsToFrames(1, rate, "round")).toThrow();
      expect(() => samplesToSeconds(1, rate)).toThrow();
      expect(() => framesToSamples(1, 60, rate, "round")).toThrow();
      expect(() => samplesToFrames(1, rate, 60, "round")).toThrow();
    },
  );

  it("rejects invalid values, quantization policies and unrepresentable results", () => {
    expect(() => secondsToFrames(NaN, 60, "round")).toThrow();
    expect(() => framesToSeconds(0.5, 60)).toThrow();
    expect(() => samplesToSeconds(0.5, 48000)).toThrow();
    expect(() => secondsToSamples(1, 1.5, "round")).toThrow();
    expect(() => secondsToFrames(1, 60, "truncate" as "round")).toThrow(
      /rounding/,
    );
    expect(() =>
      secondsToSamples(1, 48000, undefined as unknown as "round"),
    ).toThrow(/rounding/);
    expect(() =>
      framesToSamples(Number.MAX_SAFE_INTEGER, 1, 2, "round"),
    ).toThrow(/safe integer/);
    expect(() =>
      samplesToFrames(Number.MAX_SAFE_INTEGER, 1, 2, "round"),
    ).toThrow(/safe integer/);
    expect(() => secondsToFrames(Number.MAX_SAFE_INTEGER, 2, "round")).toThrow(
      /safe integer/,
    );
    expect(() => framesToSeconds(1, Number.MIN_VALUE)).toThrow(
      /converted seconds/,
    );
  });
});

describe("nested sequence frames", () => {
  it("evaluates local time without history and clips children to every ancestor", () => {
    const sequence = [
      { from: 10, durationFrames: 8 },
      { from: 3, durationFrames: 10 },
    ];
    expect(
      [12, 13, 17, 18, 13].map((frame) =>
        resolveSequenceFrame(frame, sequence),
      ),
    ).toEqual([
      { localFrame: -1, absoluteFrom: 13, isActive: false },
      { localFrame: 0, absoluteFrom: 13, isActive: true },
      { localFrame: 4, absoluteFrom: 13, isActive: true },
      { localFrame: 5, absoluteFrom: 13, isActive: false },
      { localFrame: 0, absoluteFrom: 13, isActive: true },
    ]);
    expect(resolveSequenceFrame(0, [{ from: -4, durationFrames: 8 }])).toEqual({
      localFrame: 4,
      absoluteFrom: -4,
      isActive: true,
    });
  });

  it("clips a negative-offset child and never mutates a reusable timing chain", () => {
    const chain = Object.freeze([
      Object.freeze({ from: 20, durationFrames: 10 }),
      Object.freeze({ from: -15, durationFrames: 20 }),
    ]);
    expect(
      [19, 20, 24, 25].map(
        (frame) => resolveSequenceFrame(frame, chain).isActive,
      ),
    ).toEqual([false, true, true, false]);
    expect(resolveSequenceFrame(20, chain).localFrame).toBe(15);
    expect(resolveSequenceFrame(3, [])).toEqual({
      localFrame: 3,
      absoluteFrom: 0,
      isActive: true,
    });
    expect(
      resolveSequenceFrame(3, [{ from: 3, durationFrames: 0 }]).isActive,
    ).toBe(false);
  });

  it("rejects invalid or overflowing nested times even for inactive parents", () => {
    expect(() =>
      resolveSequenceFrame(0, [{ from: 0, durationFrames: -1 }]),
    ).toThrow(/durationFrames/);
    expect(() =>
      resolveSequenceFrame(0, [{ from: 0.5, durationFrames: 1 }]),
    ).toThrow(/from/);
    expect(() =>
      resolveSequenceFrame(0, [
        { from: Number.MAX_SAFE_INTEGER, durationFrames: 1 },
      ]),
    ).toThrow(/sequence end/);
    expect(() =>
      resolveSequenceFrame(0, [
        { from: Number.MAX_SAFE_INTEGER, durationFrames: 0 },
        { from: 1, durationFrames: 0 },
      ]),
    ).toThrow(/absoluteFrom/);
    expect(() =>
      resolveSequenceFrame(Number.MAX_SAFE_INTEGER, [
        { from: -1, durationFrames: 0 },
      ]),
    ).toThrow(/localFrame/);
    expect(() =>
      resolveSequenceFrame(0, [
        undefined as unknown as { from: number; durationFrames: number },
      ]),
    ).toThrow(/sequence/);
  });
});
