import { describe, expect, expectTypeOf, it } from "vitest";
import { defineConfig } from "./config.js";

describe("defineConfig", () => {
  it("returns the config object unchanged", () => {
    const config = {
      renderer: {
        acceleration: "required",
        concurrency: "auto",
      },
    } as const;

    expect(defineConfig(config)).toBe(config);
  });

  it("preserves literal config types for callers", () => {
    const config = defineConfig({
      renderer: {
        acceleration: "required",
        concurrency: "auto",
      },
    });

    expectTypeOf(config.renderer.acceleration).toEqualTypeOf<"required">();
    expectTypeOf(config.renderer.concurrency).toEqualTypeOf<"auto">();
  });
});
