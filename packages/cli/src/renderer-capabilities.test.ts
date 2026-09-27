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
      electronHostProtocolVersion: 1,
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
        electronHostProtocolVersion: 1,
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
          electronHostProtocolVersion: 1,
        },
        "electron",
      ).available,
    ).toBe(true);
  });

  it.each([0, 2, "1", true, null])(
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
});
