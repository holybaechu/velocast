import { describe, expect, it } from "vitest";
import {
  assertNonEmptyString,
  isNonEmptyString,
  isObjectRecord,
  isPositiveSafeInteger,
  uniquePaths,
} from "./validation.js";

describe("CLI internal validation helpers", () => {
  it("identifies non-empty strings", () => {
    expect(isNonEmptyString("value")).toBe(true);
    expect(isNonEmptyString("  value  ")).toBe(true);
    expect(isNonEmptyString("")).toBe(false);
    expect(isNonEmptyString("   ")).toBe(false);
    expect(isNonEmptyString(undefined)).toBe(false);
  });

  it("throws stable errors for empty strings", () => {
    expect(() => assertNonEmptyString("ok", "expected message")).not.toThrow();
    expect(() => assertNonEmptyString(" ", "expected message")).toThrow(
      "expected message",
    );
    expect(() => assertNonEmptyString(12, "expected message")).toThrow(
      "expected message",
    );
  });

  it("identifies plain object records", () => {
    expect(isObjectRecord({})).toBe(true);
    expect(isObjectRecord({ key: "value" })).toBe(true);
    expect(isObjectRecord([])).toBe(false);
    expect(isObjectRecord(null)).toBe(false);
    expect(isObjectRecord("object")).toBe(false);
  });

  it("deduplicates paths without reordering first occurrences", () => {
    expect(uniquePaths(["/a", "/b", "/a", "/c", "/b"])).toEqual([
      "/a",
      "/b",
      "/c",
    ]);
  });

  it("identifies positive safe integers", () => {
    expect(isPositiveSafeInteger(1)).toBe(true);
    expect(isPositiveSafeInteger(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(isPositiveSafeInteger(0)).toBe(false);
    expect(isPositiveSafeInteger(1.5)).toBe(false);
    expect(isPositiveSafeInteger(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(isPositiveSafeInteger("1")).toBe(false);
  });
});
