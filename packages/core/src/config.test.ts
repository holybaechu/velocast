import { describe, expect, expectTypeOf, it } from "vitest";
import { defineConfig } from "./config.js";

describe("defineConfig", () => {
  it("returns the config object unchanged", () => {
    const config = {
      renderer: {
        acceleration: "required",
        concurrency: "auto",
        container: "mov",
        audioCodec: "pcm-s24",
        mediaBackend: "native",
        videoProfile: "prores_ks",
      },
    } as const;

    expect(defineConfig(config)).toBe(config);
  });

  it("preserves literal config types for callers", () => {
    const config = defineConfig({
      renderer: {
        acceleration: "required",
        concurrency: "auto",
        container: "mov",
        audioCodec: "pcm-s24",
        mediaBackend: "native",
        videoProfile: "prores_ks",
      },
    });

    expectTypeOf(config.renderer.acceleration).toEqualTypeOf<"required">();
    expectTypeOf(config.renderer.concurrency).toEqualTypeOf<"auto">();
    expectTypeOf(config.renderer.container).toEqualTypeOf<"mov">();
    expectTypeOf(config.renderer.audioCodec).toEqualTypeOf<"pcm-s24">();
    expectTypeOf(config.renderer.mediaBackend).toEqualTypeOf<"native">();
    expectTypeOf(config.renderer.videoProfile).toEqualTypeOf<"prores_ks">();
  });
});
