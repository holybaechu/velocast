import { describe, expect, it } from "vitest";
import {
  nativeRendererPlatforms,
  rendererExecutableNameForPlatform,
  resolveNativeRendererPlatform,
} from "./native-platform.js";

const windowsD3D11FfmpegEncoders = [
  "h264_amf",
  "h264_nvenc",
  "h264_qsv",
  "h264_mf",
  "hevc_amf",
  "hevc_nvenc",
  "hevc_qsv",
  "hevc_mf",
  "av1_amf",
  "av1_nvenc",
  "av1_qsv",
  "av1_mf",
];

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
    ).toEqual([]);
    expect(
      platform?.requiredGpuBackends.map(
        (backend) => backend.packetWriterImplemented,
      ),
    ).toEqual([]);
  });

  it("describes Windows D3D11 FFmpeg hardware encoder probes", () => {
    const platform = resolveNativeRendererPlatform("win32", "x64");

    expect(platform).toMatchObject({
      id: "win32-x64",
      executableName: "velocast-renderer.exe",
    });
    expect(
      platform?.requiredGpuBackends.map((backend) => backend.backend),
    ).toEqual(windowsD3D11FfmpegEncoders);
    expect(
      platform?.requiredGpuBackends.map((backend) => backend.ffmpegEncoder),
    ).toEqual(windowsD3D11FfmpegEncoders);
    expect(
      platform?.requiredGpuBackends.map(
        (backend) => backend.packetWriterImplemented,
      ),
    ).toEqual(windowsD3D11FfmpegEncoders.map(() => true));
    expect(
      platform?.requiredGpuBackends.some(
        (backend) => backend.unavailableReason !== undefined,
      ),
    ).toBe(false);
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
