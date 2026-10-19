import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createElectronRuntimeFixture } from "../test-fixtures/electron-runtime.js";
import { RendererRuntimeAcquisition } from "./renderer-runtime.js";
import type { ResolvedReleaseRuntime } from "./artifact-resolver.js";
function fixture() {
  const { root, manifest: marker, binary } = createElectronRuntimeFixture();
  return {
    root,
    marker,
    runtime: {
      artifactDir: root,
      rendererBinary: binary,
      targetId: "win32-x64",
      source: "download",
    } as ResolvedReleaseRuntime,
  };
}
describe("renderer runtime acquisition", () => {
  it("uses a managed bundle without applying workspace or inherited browser paths", async () => {
    const f = fixture();
    const acquisition = new RendererRuntimeAcquisition({
      platform: "win32",
      arch: "x64",
      env: {
        VELOCAST_ELECTRON_BINARY: "outside",
        VELOCAST_ELECTRON_HOST_SCRIPT: "outside",
        CEF_PATH: "retired",
      },
      resolveRendererBinary: () => undefined,
      artifactResolver: {
        inspect: () => f.runtime,
        setup: async () => f.runtime,
      },
    });
    const runtime = await acquisition.acquire();
    expect(runtime.env.VELOCAST_ELECTRON_BINARY).toBe(
      join(f.root, f.marker.electron),
    );
    expect(runtime.env.VELOCAST_ELECTRON_HOST_SCRIPT).toBe(
      join(f.root, f.marker.hostScript),
    );
    expect(runtime.env.CEF_PATH).toBeUndefined();
    expect(acquisition.inspect()?.binary).toBe(f.runtime.rendererBinary);
  });
  it("rejects a verified artifact without its Electron marker rather than discovering a developer host", async () => {
    const f = fixture();
    rmSync(join(f.root, "electron-runtime.json"));
    const acquisition = new RendererRuntimeAcquisition({
      platform: "win32",
      env: {},
      resolveRendererBinary: () => undefined,
      artifactResolver: {
        inspect: () => f.runtime,
        setup: async () => f.runtime,
      },
    });
    await expect(acquisition.acquire()).rejects.toThrow(
      "missing electron-runtime.json",
    );
  });
  it("never downloads when an explicit renderer cannot be resolved", async () => {
    let setup = false;
    const acquisition = new RendererRuntimeAcquisition({
      env: {},
      resolveRendererBinary: () => undefined,
      artifactResolver: {
        inspect: () => undefined,
        setup: async () => {
          setup = true;
          throw new Error("unexpected");
        },
      },
    });
    await expect(acquisition.acquire("custom-renderer")).rejects.toThrow(
      "renderer.binary_unavailable",
    );
    expect(setup).toBe(false);
  });
  it("inspection does not invoke acquisition side effects of custom runtime adapters", () => {
    let prepared = false;
    const acquisition = new RendererRuntimeAcquisition({
      env: { TEST: "original" },
      runtimeResolver: {
        resolveBinary: () => "renderer",
        resolveProcessEnv: () => {
          prepared = true;
          return {};
        },
      },
    });
    expect(acquisition.inspect()).toMatchObject({
      binary: "renderer",
      env: { TEST: "original" },
    });
    expect(prepared).toBe(false);
  });
});
