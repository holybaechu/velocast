import { describe, expect, it } from "vitest";
import { interpolate } from "./index.js";

describe("interpolate", () => {
  it("evaluates piecewise keyframes and explicit extrapolation without history", () => {
    expect(
      [0, 5, 10, 15, 20, 15, 0].map((value) =>
        interpolate(value, [0, 10, 20], [0, 100, 50]),
      ),
    ).toEqual([0, 50, 100, 75, 50, 75, 0]);
    expect(interpolate(-1, [0, 10], [0, 100])).toBe(-10);
    expect(
      interpolate(11, [0, 10], [0, 100], { extrapolateRight: "clamp" }),
    ).toBe(100);
    expect(
      interpolate(-1, [0, 10], [0, 100], { extrapolateLeft: "identity" }),
    ).toBe(-1);
  });

  it("uses descending outputs, exact interior boundaries, and constant segments", () => {
    expect(interpolate(5, [0, 10], [100, 0])).toBe(50);
    expect(
      interpolate(10, [0, 10, 20], [0, 100, 200], { easing: () => 0 }),
    ).toBe(0);
    expect(
      interpolate(15, [0, 10, 20], [0, 100, 200], { easing: () => 0 }),
    ).toBe(100);
    expect(interpolate(-100, [0, 10], [5, 5])).toBe(5);
    expect(
      interpolate(-100, [0, 10], [5, 5], { extrapolateLeft: "identity" }),
    ).toBe(-100);
    expect(
      interpolate(11, [0, 10], [0, 100], { extrapolateRight: "identity" }),
    ).toBe(11);
    expect(
      interpolate(-1, [0, 10], [10, 20], { extrapolateLeft: "clamp" }),
    ).toBe(10);
  });

  it.each([NaN, Infinity, -Infinity])(
    "rejects non-finite values anywhere: %s",
    (value) => {
      expect(() => interpolate(value, [0, 10], [0, 1])).toThrow();
      expect(() => interpolate(5, [0, value], [0, 1])).toThrow();
      expect(() => interpolate(5, [0, 10], [0, value])).toThrow();
      expect(() =>
        interpolate(5, [0, 10], [0, 1], { easing: () => value }),
      ).toThrow(/easing result/);
    },
  );

  it("rejects ambiguous keyframes, unsupported modes and numeric overflow", () => {
    expect(() => interpolate(0, [], [])).toThrow(/at least two/);
    expect(() => interpolate(0, [0, 1], [0])).toThrow(/same length/);
    expect(() => interpolate(0, [0, 0], [0, 1])).toThrow(/strictly increasing/);
    expect(() => interpolate(0, [1, 0], [0, 1])).toThrow(/strictly increasing/);
    const sparse = Array<number>(3);
    sparse[0] = 0;
    sparse[2] = 2;
    expect(() => interpolate(0, sparse, [0, 1, 2])).toThrow(/finite/);
    expect(() =>
      interpolate(0, [0, 1], [0, 1], { extrapolateLeft: "wrap" as "clamp" }),
    ).toThrow(/extrapolation/);
    expect(() =>
      interpolate(0, [0, 1], [0, 1], {
        easing: 3 as unknown as (x: number) => number,
      }),
    ).toThrow(/easing/);
    expect(() => interpolate(0, [-1e308, 1e308], [0, 1])).toThrow(/span/);
    expect(() => interpolate(0.5, [0, 1], [-1e308, 1e308])).toThrow(/span/);
  });
});
