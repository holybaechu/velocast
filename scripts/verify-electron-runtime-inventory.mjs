import { readFileSync } from "node:fs";
import { join } from "node:path";

export function verifyElectronRuntimeInventory(root, files, expected) {
  const runtime = JSON.parse(
    readFileSync(join(root, "electron-runtime.json"), "utf8"),
  );
  const fail = (reason) => {
    throw new Error(`artifact.electron_inventory_invalid: ${reason}`);
  };
  if (
    runtime.schema !== "velocast-electron-runtime-v1" ||
    runtime.status !== expected.status ||
    runtime.browserHost !== "electron" ||
    runtime.platform !== "win32" ||
    runtime.arch !== "x64" ||
    runtime.electronVersion !== expected.electronVersion ||
    runtime.sourceCommit !== expected.sourceCommit
  )
    fail("identity or provenance differs");
  if (
    runtime.renderer !== "velocast-renderer.exe" ||
    runtime.electron !== "electron/electron.exe" ||
    runtime.hostScript !== "electron-host/main.cjs" ||
    runtime.ffmpeg !== "ffmpeg.exe" ||
    runtime.ffprobe !== "ffprobe.exe"
  )
    fail("runtime entrypoints differ");
  if (
    runtime.rendererCapabilities?.defaultBrowserHost !== "electron" ||
    runtime.rendererCapabilities?.electronHostProtocolVersion !== 1 ||
    JSON.stringify(runtime.rendererCapabilities?.browserHosts) !==
      '["electron"]'
  )
    fail("renderer capabilities are not Electron-only");
  if (!Array.isArray(runtime.files)) fail("file inventory is missing");
  const actual = files
    .filter((file) => file.path !== "electron-runtime.json")
    .map(({ path, size, sha256 }) => ({ path, size, sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const declared = runtime.files
    .map(({ path, size, sha256 }) => ({ path, size, sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (JSON.stringify(declared) !== JSON.stringify(actual))
    fail("declared files differ from staged file hashes or paths");
  return runtime;
}
