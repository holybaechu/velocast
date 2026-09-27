import { describe, expect, it } from "vitest";
import {
  buildDoctorReport,
  DOCTOR_REQUIRED_GPU_DIAGNOSTIC_CODES,
  type DoctorProbeInput,
} from "./doctor.js";
const input = (
  overrides: Partial<DoctorProbeInput> = {},
): DoctorProbeInput => ({
  platform: "win32",
  arch: "x64",
  rendererBinary: "renderer.exe",
  browserRuntime: {
    host: "electron",
    available: true,
    gpuCaptureSupported: true,
  },
  ffmpegPresent: true,
  softwareFallbackAvailable: true,
  requiredGpuBackends: [
    { backend: "h264_mf", available: true, packetWriterAvailable: true },
  ],
  ...overrides,
});
describe("Electron doctor report", () => {
  it("reports a supported Windows encoder and software fallback", () => {
    expect(buildDoctorReport(input())).toMatchObject({
      requiredGpu: { available: true, backend: "h264_mf" },
      softwareFallback: { available: true },
    });
  });
  it.each(["linux", "darwin"] as const)(
    "keeps %s GPU unavailable while allowing software",
    (platform) => {
      const report = buildDoctorReport(
        input({
          platform,
          browserRuntime: {
            host: "electron",
            available: true,
            gpuCaptureSupported: false,
          },
          requiredGpuBackends: [],
        }),
      );
      expect(report.requiredGpu.available).toBe(false);
      expect(report.requiredGpu.reason).toContain("Windows");
      expect(report.softwareFallback.available).toBe(true);
    },
  );
  it("missing browser files block both capture routes before encoder checks", () => {
    const report = buildDoctorReport(
      input({
        browserRuntime: {
          host: "electron",
          available: false,
          gpuCaptureSupported: true,
          reason: "missing Electron",
        },
      }),
    );
    expect(report.requiredGpu.diagnostics).toEqual([
      {
        kind: "runtime",
        code: "runtime.electron_invalid",
        reason: "missing Electron",
      },
    ]);
    expect(report.softwareFallback.available).toBe(false);
  });
  it("missing native renderer cannot advertise software readiness", () => {
    const report = buildDoctorReport(input({ rendererBinary: undefined }));
    expect(report.requiredGpu.diagnostics?.[0]?.code).toBe(
      "renderer.binary_unavailable",
    );
    expect(report.softwareFallback.available).toBe(false);
  });
  it("retains each Windows backend diagnostic and packet writer requirement", () => {
    const report = buildDoctorReport(
      input({
        requiredGpuBackends: [
          {
            backend: "h264_mf",
            available: false,
            unavailableCode: "encoder.codec_unavailable",
            reason: "encoder missing",
          },
          {
            backend: "h264_nvenc",
            available: false,
            reason: "hardware missing",
          },
        ],
      }),
    );
    expect(report.requiredGpu.diagnostics).toHaveLength(2);
    expect(report.requiredGpu.diagnostics?.[0]?.code).toBe(
      "encoder.codec_unavailable",
    );
    expect(
      buildDoctorReport(
        input({
          requiredGpuBackends: [
            {
              backend: "h264_mf",
              available: true,
              packetWriterAvailable: false,
            },
          ],
        }),
      ).requiredGpu.available,
    ).toBe(false);
  });
  it("does not publish retired runtime diagnostic codes", () => {
    expect(DOCTOR_REQUIRED_GPU_DIAGNOSTIC_CODES).not.toContain(
      "runtime.cef_missing",
    );
  });
});
