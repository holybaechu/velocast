import { describe, expect, it } from "vitest";
import {
  defaultRendererAcceleration,
  defaultRendererPixelFormat,
} from "./renderer-defaults.js";

describe("renderer defaults", () => {
  it("keeps auto acceleration as the CLI default", () => {
    expect(defaultRendererAcceleration).toBe("auto");
  });

  it("keeps hardware and software pixel format defaults centralized", () => {
    expect(defaultRendererPixelFormat("required")).toBe("nv12");
    expect(defaultRendererPixelFormat("auto")).toBe("nv12");
    expect(defaultRendererPixelFormat("off")).toBe("yuv444p");
  });
});
