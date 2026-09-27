import { describe, expect, it } from "vitest";
import {
  assertNonEmptyString,
  isNonEmptyString,
  isObjectRecord,
  isPositiveSafeInteger,
  optionalNonEmptyString,
  optionalPositiveSafeInteger,
} from "./validation.js";

describe("core internal validation helpers", () => {
  it("identifies and asserts non-empty strings", () => {
    expect(isNonEmptyString("value")).toBe(true);
    expect(isNonEmptyString("  value  ")).toBe(true);
    expect(isNonEmptyString("")).toBe(false);
    expect(isNonEmptyString("   ")).toBe(false);
    expect(isNonEmptyString(undefined)).toBe(false);

    expect(() => assertNonEmptyString("ok", "expected message")).not.toThrow();
    expect(() => assertNonEmptyString(" ", "expected message")).toThrow(
      "expected message",
    );
  });

  it("identifies object records", () => {
    expect(isObjectRecord({})).toBe(true);
    expect(isObjectRecord({ key: "value" })).toBe(true);
    expect(isObjectRecord([])).toBe(false);
    expect(isObjectRecord(null)).toBe(false);
  });

  it("identifies positive safe integers", () => {
    expect(isPositiveSafeInteger(1)).toBe(true);
    expect(isPositiveSafeInteger(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(isPositiveSafeInteger(0)).toBe(false);
    expect(isPositiveSafeInteger(1.5)).toBe(false);
    expect(isPositiveSafeInteger(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  });

  it("normalizes optional non-empty strings", () => {
    expect(
      optionalNonEmptyString("composition hero", "target", undefined),
    ).toBe(undefined);
    expect(
      optionalNonEmptyString("composition hero", "target", " #hero "),
    ).toBe("#hero");
    expect(() =>
      optionalNonEmptyString("composition hero", "target", " "),
    ).toThrow("composition hero target must be a non-empty string");
  });

  it("normalizes optional positive safe integers", () => {
    expect(
      optionalPositiveSafeInteger(
        "composition hero",
        "maxConcurrency",
        undefined,
      ),
    ).toBe(undefined);
    expect(
      optionalPositiveSafeInteger("composition hero", "maxConcurrency", 2),
    ).toBe(2);
    expect(() =>
      optionalPositiveSafeInteger("composition hero", "maxConcurrency", 0),
    ).toThrow("composition hero maxConcurrency must be a positive integer");
  });
});
