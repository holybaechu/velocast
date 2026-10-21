import { describe, expect, it } from "vitest";
import {
  parseOutputFrame,
  parseOutputRange,
  requireOutputApi,
} from "./output-request.js";

describe("public composition output requests", () => {
  it("uses half-open ranges without exposing internal worker fields", () => {
    expect(parseOutputRange("12", "90")).toEqual({
      startFrame: 12,
      endFrame: 90,
    });
    expect(parseOutputRange(undefined, undefined)).toBeUndefined();
    for (const bounds of [
      [undefined, "90"],
      ["12", undefined],
      ["12", "12"],
      ["90", "12"],
      ["-1", "5"],
      ["0", "4294967296"],
    ] as const)
      expect(() => parseOutputRange(bounds[0], bounds[1])).toThrow();
  });
  it("accepts exact nonnegative u32 frames and rejects rounded or ambiguous input", () => {
    expect(parseOutputFrame(0)).toBe(0);
    expect(parseOutputFrame("90")).toBe(90);
    for (const value of [undefined, "", -1, 1.1, "1e2", NaN, 4294967296])
      expect(() => parseOutputFrame(value)).toThrow("output.invalid_frame");
  });
  it("refuses old or unverified native output APIs instead of silently ignoring fields", () => {
    expect(() => requireOutputApi({ available: true })).toThrow(
      "output.native_incompatible",
    );
    expect(() =>
      requireOutputApi({
        available: false,
        outputApiVersion: 1,
        reason: "not executable",
      }),
    ).toThrow("not executable");
    expect(() =>
      requireOutputApi({ available: true, outputApiVersion: 99 }),
    ).toThrow("output.native_incompatible");
    expect(() =>
      requireOutputApi({ available: true, outputApiVersion: 1 }),
    ).not.toThrow();
  });
});
