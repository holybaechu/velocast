import { describe, expect, it } from "vitest";
import type { CompositionDefinition } from "./types.js";
import { validateComposition } from "./validation.js";

describe("validateComposition", () => {
  it("accepts a valid composition", () => {
    expect(
      validateComposition("hero", {
        width: 1200,
        height: 630,
        fps: 30,
        durationFrames: 90,
        target: "#hero",
      }),
    ).toEqual({
      id: "hero",
      width: 1200,
      height: 630,
      fps: 30,
      durationFrames: 90,
      target: "#hero",
    });
  });

  it("trims target and url values", () => {
    expect(
      validateComposition("hero", {
        width: 1200,
        height: 630,
        fps: 30,
        durationFrames: 90,
        target: "  #hero  ",
        url: "  https://example.com/hero  ",
      }),
    ).toEqual({
      id: "hero",
      width: 1200,
      height: 630,
      fps: 30,
      durationFrames: 90,
      target: "#hero",
      url: "https://example.com/hero",
    });
  });

  it("rejects invalid dimensions", () => {
    expect(() =>
      validateComposition("hero", {
        width: 0,
        height: 630,
        fps: 30,
        durationFrames: 90,
        target: "#hero",
      }),
    ).toThrow("composition hero width must be a positive integer");
  });

  it("rejects unsafe integer dimensions", () => {
    expect(() =>
      validateComposition("hero", {
        width: Number.MAX_SAFE_INTEGER + 1,
        height: 630,
        fps: 30,
        durationFrames: 90,
        target: "#hero",
      }),
    ).toThrow("composition hero width must be a positive integer");
  });

  it("rejects blank ids", () => {
    expect(() =>
      validateComposition("   ", {
        width: 1200,
        height: 630,
        fps: 30,
        durationFrames: 90,
        target: "#hero",
      }),
    ).toThrow("composition id must not be empty");
  });

  it("rejects non-string ids with a clear error", () => {
    expect(() =>
      validateComposition(12 as unknown as string, {
        width: 1200,
        height: 630,
        fps: 30,
        durationFrames: 90,
        target: "#hero",
      }),
    ).toThrow("composition id must be a string");
  });

  it("rejects non-object definitions with a clear error", () => {
    expect(() =>
      validateComposition(
        "hero",
        undefined as unknown as CompositionDefinition,
      ),
    ).toThrow("composition hero definition must be an object");

    expect(() =>
      validateComposition("hero", [] as unknown as CompositionDefinition),
    ).toThrow("composition hero definition must be an object");
  });

  it("rejects compositions without target or url", () => {
    expect(() =>
      validateComposition("hero", {
        width: 1200,
        height: 630,
        fps: 30,
        durationFrames: 90,
      }),
    ).toThrow("composition hero must define target or url");
  });

  it("rejects whitespace target values", () => {
    expect(() =>
      validateComposition("hero", {
        width: 1200,
        height: 630,
        fps: 30,
        durationFrames: 90,
        target: "   ",
      }),
    ).toThrow("composition hero target must be a non-empty string");
  });

  it("rejects whitespace url values", () => {
    expect(() =>
      validateComposition("hero", {
        width: 1200,
        height: 630,
        fps: 30,
        durationFrames: 90,
        url: "   ",
      }),
    ).toThrow("composition hero url must be a non-empty string");
  });

  it("rejects non-string target values", () => {
    expect(() =>
      validateComposition("hero", {
        width: 1200,
        height: 630,
        fps: 30,
        durationFrames: 90,
        target: 12,
      } as unknown as CompositionDefinition),
    ).toThrow("composition hero target must be a non-empty string");
  });

  it("rejects non-string url values", () => {
    expect(() =>
      validateComposition("hero", {
        width: 1200,
        height: 630,
        fps: 30,
        durationFrames: 90,
        url: 12,
      } as unknown as CompositionDefinition),
    ).toThrow("composition hero url must be a non-empty string");
  });

  it("rejects invalid height", () => {
    expect(() =>
      validateComposition("hero", {
        width: 1200,
        height: 0,
        fps: 30,
        durationFrames: 90,
        target: "#hero",
      }),
    ).toThrow("composition hero height must be a positive integer");
  });

  it("rejects invalid fps", () => {
    expect(() =>
      validateComposition("hero", {
        width: 1200,
        height: 630,
        fps: 0,
        durationFrames: 90,
        target: "#hero",
      }),
    ).toThrow("composition hero fps must be a positive integer");
  });

  it("rejects invalid durationFrames", () => {
    expect(() =>
      validateComposition("hero", {
        width: 1200,
        height: 630,
        fps: 30,
        durationFrames: 0,
        target: "#hero",
      }),
    ).toThrow("composition hero durationFrames must be a positive integer");
  });

  it("accepts optional maxConcurrency", () => {
    expect(
      validateComposition("hero", {
        width: 1200,
        height: 630,
        fps: 30,
        durationFrames: 90,
        target: "#hero",
        maxConcurrency: 4,
      }),
    ).toEqual({
      id: "hero",
      width: 1200,
      height: 630,
      fps: 30,
      durationFrames: 90,
      target: "#hero",
      maxConcurrency: 4,
    });
  });

  it("rejects invalid maxConcurrency", () => {
    expect(() =>
      validateComposition("hero", {
        width: 1200,
        height: 630,
        fps: 30,
        durationFrames: 90,
        target: "#hero",
        maxConcurrency: 0,
      }),
    ).toThrow("composition hero maxConcurrency must be a positive integer");
  });

  it("rejects unsafe maxConcurrency values", () => {
    expect(() =>
      validateComposition("hero", {
        width: 1200,
        height: 630,
        fps: 30,
        durationFrames: 90,
        target: "#hero",
        maxConcurrency: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow("composition hero maxConcurrency must be a positive integer");
  });
});
