import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeHostForDoctor } from "./doctor-host.js";
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
  electronHostProtocolVersion: 3,
  supportedMediaBackends: ["webcodecs", "native"],
  videoEncoderBackend: "webcodecs",
  mediaRuntime: "mediabunny",
  hardwareAccelerationGuarantee: false,
};
describe("Electron host doctor", () => {
  it("reports WebCodecs availability without claiming hardware guarantees", () => {
    const f = fixture();
    const report = probeHostForDoctor({
      cwd: f.dir,
      env: f.env,
      platform: "win32",
      arch: "x64",
      spawnRendererCapabilities: () => ({
        status: 0,
        stdout: JSON.stringify(caps),
        stderr: "",
      }),
    });
    expect(report.browserRuntime?.available).toBe(true);
    expect(
      report.requiredGpuBackends?.find((item) => item.backend === "webcodecs")
        ?.available,
    ).toBe(false);
    expect(report.webCodecsAvailable).toBe(true);
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
        spawnRendererCapabilities: () => ({
          status: 0,
          stdout: JSON.stringify(caps),
          stderr: "",
        }),
      });
      expect(report.requiredGpuBackends).toEqual([
        expect.objectContaining({ backend: "webcodecs", available: false }),
      ]);
      expect(report.browserRuntime).toMatchObject({
        available: true,
        gpuCaptureSupported: false,
      });
      expect(report.webCodecsAvailable).toBe(true);
    },
  );
  it("rejects legacy native binaries even when Electron files exist", () => {
    const f = fixture();
    const report = probeHostForDoctor({
      cwd: f.dir,
      env: f.env,
      platform: "linux",
      arch: "x64",
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
    expect(report.webCodecsAvailable).toBe(false);
  });
  it("reports a missing browser dependency without claiming fallback readiness", () => {
    const f = fixture();
    rmSync(f.env.VELOCAST_ELECTRON_BINARY);
    const report = probeHostForDoctor({
      cwd: f.dir,
      env: f.env,
      platform: "win32",
    });
    expect(report.browserRuntime?.reason).toContain("runtime.electron_missing");
    expect(report.webCodecsAvailable).toBe(false);
  });
});
