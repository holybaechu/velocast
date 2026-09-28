import { describe, expect, it } from "vitest";
import {
  defaultRendererAcceleration,
  defaultRendererPixelFormat,
} from "./renderer-defaults.js";

describe("renderer defaults", () => {
  it("keeps auto acceleration as the CLI default", () => {
    expect(defaultRendererAcceleration).toBe("auto");
  });

  it("uses broad 8-bit defaults and a 10-bit ProRes default", () => {
    expect(defaultRendererPixelFormat("required")).toBe("yuv420p");
    expect(defaultRendererPixelFormat("auto")).toBe("yuv420p");
    expect(defaultRendererPixelFormat("off")).toBe("yuv420p");
    expect(defaultRendererPixelFormat("off", "prores")).toBe("yuv422p10le");
  });
});
