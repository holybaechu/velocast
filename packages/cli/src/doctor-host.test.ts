import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseFfmpegEncoderSupport,
  probeHostForDoctor,
} from "./doctor-host.js";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "velocast-doctor-"));
  dirs.push(dir);
  mkdirSync(join(dir, "host"));
  const binary = join(dir, "renderer.exe");
  const electron = join(dir, "electron.exe");
  const host = join(dir, "host/main.cjs");
  for (const path of [binary, electron, host]) writeFileSync(path, "fixture");
  return {
    dir,
    binary,
    env: {
      VELOCAST_RENDERER_BINARY: binary,
      VELOCAST_ELECTRON_BINARY: electron,
      VELOCAST_ELECTRON_HOST_SCRIPT: host,
    },
  };
}
const caps = {
  outputApiVersion: 1,
  browserHosts: ["electron"],
  defaultBrowserHost: "electron",
  electronHostProtocolVersion: 1,
  d3d11FfmpegEncoder: { compiled: true, encoders: { h264_mf: true } },
};
describe("Electron host doctor", () => {
  it("uses linked native Windows encoders rather than unrelated PATH encoder availability", () => {
    const f = fixture();
    const report = probeHostForDoctor({
      cwd: f.dir,
      env: f.env,
      platform: "win32",
      arch: "x64",
      ffmpegEncoders: { ffmpegPresent: false },
      spawnRendererCapabilities: () => ({
        status: 0,
        stdout: JSON.stringify(caps),
        stderr: "",
      }),
    });
    expect(report.browserRuntime?.available).toBe(true);
    expect(
      report.requiredGpuBackends?.find((item) => item.backend === "h264_mf")
        ?.available,
    ).toBe(true);
    expect(report.softwareFallbackAvailable).toBe(false);
  });
  it.each(["linux", "darwin"] as const)(
    "reports %s software without probing retired GPU devices",
    (platform) => {
      const f = fixture();
      const report = probeHostForDoctor({
        cwd: f.dir,
        env: f.env,
        platform,
        arch: "x64",
        ffmpegEncoders: { ffmpegPresent: true },
        spawnRendererCapabilities: () => ({
          status: 0,
          stdout: JSON.stringify(caps),
          stderr: "",
        }),
      });
      expect(report.requiredGpuBackends).toEqual([]);
      expect(report.browserRuntime).toMatchObject({
        available: true,
        gpuCaptureSupported: false,
      });
      expect(report.softwareFallbackAvailable).toBe(true);
    },
  );
  it("rejects legacy native binaries even when Electron files exist", () => {
    const f = fixture();
    const report = probeHostForDoctor({
      cwd: f.dir,
      env: f.env,
      platform: "linux",
      arch: "x64",
      ffmpegEncoders: { ffmpegPresent: true },
      spawnRendererCapabilities: () => ({
        status: 0,
        stdout: '{"outputApiVersion":1}',
        stderr: "",
      }),
    });
    expect(report.browserRuntime?.available).toBe(false);
    expect(report.browserRuntime?.reason).toContain(
      "renderer.electron_unsupported",
    );
    expect(report.softwareFallbackAvailable).toBe(false);
  });
  it("reports a missing browser dependency without claiming fallback readiness", () => {
    const f = fixture();
    rmSync(f.env.VELOCAST_ELECTRON_BINARY);
    const report = probeHostForDoctor({
      cwd: f.dir,
      env: f.env,
      platform: "win32",
      ffmpegEncoders: { ffmpegPresent: true },
    });
    expect(report.browserRuntime?.reason).toContain("runtime.electron_missing");
    expect(report.softwareFallbackAvailable).toBe(false);
  });
  it("parses exact FFmpeg encoder rows rather than description substrings", () => {
    expect(
      parseFfmpegEncoderSupport(
        " V..... libx264 H264 encoder\n V..... png PNG\n description h264_mf",
        ["libx264", "png", "h264_mf"],
      ),
    ).toEqual({
      ffmpegPresent: true,
      encoders: { libx264: true, png: true, h264_mf: false },
    });
  });
});
