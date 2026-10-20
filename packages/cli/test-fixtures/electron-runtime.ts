import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { onTestFinished } from "vitest";

export function createElectronRuntimeFixture() {
  const root = mkdtempSync(join(tmpdir(), "velocast-electron-runtime-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const manifest = {
    schema: "velocast-electron-runtime-v1",
    browserHost: "electron",
    platform: "win32",
    arch: "x64",
    renderer: "velocast-renderer.exe",
    electron: "electron/electron.exe",
    hostScript: "electron-host/main.cjs",
    mediaClient: "media-client.cjs",
    mediaBundle: "media-runtime.cjs",
  };
  for (const path of [
    manifest.renderer,
    manifest.electron,
    manifest.hostScript,
    manifest.mediaClient,
    manifest.mediaBundle,
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
