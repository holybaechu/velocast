import { describe, expect, it } from "vitest";
import {
  nativeRendererPlatforms,
  rendererExecutableNameForPlatform,
  resolveNativeRendererPlatform,
} from "./native-platform.js";

describe("native renderer platform descriptors", () => {
  it("describes the packaged Linux x64 renderer in one place", () => {
    const platform = resolveNativeRendererPlatform("linux", "x64");

    expect(platform).toMatchObject({
      id: "linux-x64",
      executableName: "velocast-renderer",
      packageName: "@velocast/renderer-linux-x64",
      workspacePackageDir: "renderer-linux-x64",
      libraryPathEnv: "LD_LIBRARY_PATH",
    });
    expect(
      platform?.requiredGpuBackends.map((backend) => backend.backend),
    ).toEqual(["webcodecs"]);
    expect(
      platform?.requiredGpuBackends.map(
        (backend) => backend.packetWriterImplemented,
      ),
    ).toEqual([true]);
  });

  it("describes WebCodecs without claiming a hardware guarantee", () => {
    const platform = resolveNativeRendererPlatform("win32", "x64");
    expect(platform?.requiredGpuBackends).toEqual([
      expect.objectContaining({
        backend: "webcodecs",
        packetWriterImplemented: true,
      }),
    ]);
  });

  it("keeps native platform ids unique", () => {
    const ids = nativeRendererPlatforms.map((platform) => platform.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("falls back to conventional renderer executable names", () => {
    expect(rendererExecutableNameForPlatform("linux", "arm64")).toBe(
      "velocast-renderer",
    );
    expect(rendererExecutableNameForPlatform("win32", "arm64")).toBe(
      "velocast-renderer.exe",
    );
  });
});
