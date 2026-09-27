import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  electronRuntimeEnvironment,
  inspectElectronRuntime,
  resolveDeveloperElectronRuntime,
} from "./electron-runtime.js";
import { resolveRendererProcessEnv } from "./renderer-binary.js";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "velocast-electron-runtime-"));
  directories.push(root);
  const manifest = {
    schema: "velocast-electron-runtime-v1",
    browserHost: "electron",
    platform: "win32",
    arch: "x64",
    renderer: "velocast-renderer.exe",
    electron: "electron/electron.exe",
    hostScript: "electron-host/main.cjs",
    ffmpeg: "ffmpeg.exe",
    ffprobe: "ffprobe.exe",
  };
  for (const path of [
    manifest.renderer,
    manifest.electron,
    manifest.hostScript,
    manifest.ffmpeg,
    manifest.ffprobe,
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), "fixture");
  }
  const save = () =>
    writeFileSync(
      join(root, "electron-runtime.json"),
      JSON.stringify(manifest),
    );
  save();
  return { root, manifest, save, binary: join(root, manifest.renderer) };
}
describe("Electron runtime acquisition", () => {
  it("uses bundled paths without importing a workspace CEF environment", () => {
    const f = fixture();
    mkdirSync(join(f.root, ".velocast"));
    writeFileSync(
      join(f.root, ".velocast/accelerated-env.ps1"),
      "$env:CEF_PATH = 'must-not-be-loaded'",
    );
    const input = {
      Path: "C:\\Windows\\System32",
      CEF_PATH: "old-cef",
      VELOCAST_LINUX_RENDERER_RUNTIME_DIR: "old-linux",
    };
    const env = resolveRendererProcessEnv({
      rendererBinary: f.binary,
      cwd: f.root,
      platform: "win32",
      arch: "x64",
      env: input,
    });
    expect(env.VELOCAST_EXPERIMENTAL_BROWSER).toBe("electron");
    expect(env.VELOCAST_ELECTRON_BINARY).toBe(
      join(f.root, f.manifest.electron),
    );
    expect(env.VELOCAST_ELECTRON_HOST_SCRIPT).toBe(
      join(f.root, f.manifest.hostScript),
    );
    expect(env.Path).toBe(`${f.root};C:\\Windows\\System32`);
    expect(env.CEF_PATH).toBeUndefined();
    expect(env.VELOCAST_LINUX_RENDERER_RUNTIME_DIR).toBeUndefined();
    expect(input.CEF_PATH).toBe("old-cef");
  });
  it("rejects a CEF rollback request for an Electron-only distribution", () => {
    const f = fixture();
    const runtime = inspectElectronRuntime(f.binary, "win32", "x64")!;
    expect(() =>
      electronRuntimeEnvironment(
        runtime,
        { VELOCAST_EXPERIMENTAL_BROWSER: "cef" },
        "win32",
      ),
    ).toThrow("browser.host_not_supported");
  });
  it("rejects wrong-platform and escaping manifests", () => {
    const f = fixture();
    expect(() => inspectElectronRuntime(f.binary, "linux", "x64")).toThrow(
      "runtime.electron_invalid",
    );
    f.manifest.hostScript = "../outside.cjs";
    f.save();
    expect(() => inspectElectronRuntime(f.binary, "win32", "x64")).toThrow(
      "runtime.electron_invalid",
    );
  });
  it("fails closed when a bundled dependency is missing", () => {
    const f = fixture();
    rmSync(join(f.root, f.manifest.ffprobe));
    expect(() => inspectElectronRuntime(f.binary, "win32", "x64")).toThrow(
      "runtime.electron_invalid",
    );
  });
  it("distinguishes a bare developer binary from a marked bundle", () => {
    const f = fixture();
    rmSync(join(f.root, "electron-runtime.json"));
    expect(inspectElectronRuntime(f.binary, "win32", "x64")).toBeUndefined();
  });
});

it("discovers the installed private host runtime without browser environment overrides", () => {
  const f = fixture();
  rmSync(join(f.root, "electron-runtime.json"));
  const host = join(f.root, "packages/electron-host/main.cjs");
  const electronPackage = join(
    f.root,
    "packages/electron-host/node_modules/electron",
  );
  const electron = join(electronPackage, "dist/electron.exe");
  mkdirSync(dirname(host), { recursive: true });
  writeFileSync(host, "host");
  mkdirSync(dirname(electron), { recursive: true });
  writeFileSync(electron, "runtime");
  writeFileSync(join(electronPackage, "package.json"), '{"name":"electron"}');
  writeFileSync(join(electronPackage, "path.txt"), "electron.exe");
  expect(resolveDeveloperElectronRuntime(f.binary, f.root, {})).toMatchObject({
    electron,
    hostScript: host,
  });
  const env = resolveRendererProcessEnv({
    rendererBinary: f.binary,
    cwd: f.root,
    env: {},
    platform: "win32",
  });
  expect(env.VELOCAST_BROWSER).toBe("electron");
  expect(env.VELOCAST_ELECTRON_BINARY).toBe(electron);
});

it("does not install a missing private Electron runtime automatically", () => {
  const f = fixture();
  const host = join(f.root, "empty-host/main.cjs");
  mkdirSync(dirname(host));
  writeFileSync(host, "host");
  expect(() =>
    resolveDeveloperElectronRuntime(f.binary, f.root, {
      VELOCAST_ELECTRON_HOST_SCRIPT: host,
    }),
  ).toThrow("runtime.electron_missing");
});

it("rejects the canonical retired browser selector even when the legacy selector names Electron", () => {
  const f = fixture();
  expect(() =>
    resolveRendererProcessEnv({
      rendererBinary: f.binary,
      platform: "win32",
      arch: "x64",
      env: {
        VELOCAST_BROWSER: "cef",
        VELOCAST_EXPERIMENTAL_BROWSER: "electron",
      },
    }),
  ).toThrow("browser.host_not_supported");
});
