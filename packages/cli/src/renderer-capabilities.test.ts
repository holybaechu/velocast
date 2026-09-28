import { describe, expect, it } from "vitest";
import { probeRendererCapabilities } from "./renderer-capabilities.js";

function probe(capabilities: unknown, host?: string) {
  return probeRendererCapabilities(
    "renderer.exe",
    host ? { VELOCAST_EXPERIMENTAL_BROWSER: host } : {},
    () => ({
      status: 0,
      stdout: JSON.stringify(capabilities),
      stderr: "",
    }),
  );
}

describe("Electron-only capability negotiation", () => {
  it("uses the native default and rejects a CEF request on Electron-only builds", () => {
    const caps = {
      outputApiVersion: 1,
      browserHosts: ["electron"],
      defaultBrowserHost: "electron",
      electronHostProtocolVersion: 3,
      videoEncoderBackend: "webcodecs",
      supportedMediaBackends: ["webcodecs", "native"],
      mediaRuntime: "mediabunny",
      hardwareAccelerationGuarantee: false,
    };
    expect(probe(caps)).toMatchObject({
      available: true,
      browserHosts: ["electron"],
      defaultBrowserHost: "electron",
    });
    expect(probe(caps, "cef")).toMatchObject({ available: false });
    expect(
      probe({ ...caps, electronHostProtocolVersion: undefined }).available,
    ).toBe(false);
  });
  it("rejects a legacy renderer without Electron-only capabilities", () => {
    expect(probe({ outputApiVersion: 1 }).available).toBe(false);
    expect(
      probe({
        browserHosts: ["cef", "electron"],
        defaultBrowserHost: "cef",
        electronHostProtocolVersion: 3,
        videoEncoderBackend: "webcodecs",
        supportedMediaBackends: ["webcodecs", "native"],
        mediaRuntime: "mediabunny",
        hardwareAccelerationGuarantee: false,
      }).available,
    ).toBe(false);
  });

  it("rejects an old renderer instead of silently running CEF for Electron", () => {
    const result = probe({ outputApiVersion: 1 }, "electron");
    expect(result.available).toBe(false);
    expect(result.reason).toContain("renderer.electron_unsupported");
  });

  it("accepts the matching Electron host protocol", () => {
    expect(
      probe(
        {
          outputApiVersion: 1,
          browserHosts: ["electron"],
          defaultBrowserHost: "electron",
          electronHostProtocolVersion: 3,
          videoEncoderBackend: "webcodecs",
          supportedMediaBackends: ["webcodecs", "native"],
          mediaRuntime: "mediabunny",
          hardwareAccelerationGuarantee: false,
        },
        "electron",
      ).available,
    ).toBe(true);
  });

  it.each([0, 1, 2, "3", true, null])(
    "rejects unsupported host protocol %s",
    (version) => {
      expect(
        probe(
          { outputApiVersion: 1, electronHostProtocolVersion: version },
          "electron",
        ).available,
      ).toBe(false);
    },
  );

  it("requires both negotiated media backends while retaining the legacy encoder field", () => {
    const caps = {
      outputApiVersion: 1,
      browserHosts: ["electron"],
      defaultBrowserHost: "electron",
      electronHostProtocolVersion: 3,
      videoEncoderBackend: "webcodecs",
      supportedMediaBackends: ["webcodecs"],
      mediaRuntime: "mediabunny",
      hardwareAccelerationGuarantee: false,
    };
    expect(probe(caps).available).toBe(false);
    expect(
      probe({ ...caps, supportedMediaBackends: ["webcodecs", "native"] })
        .available,
    ).toBe(true);
  });
});
