import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyElectronRuntimeInventory } from "../verify-electron-runtime-inventory.mjs";

test("native artifact verifies Electron runtime identity and every staged hash", (t) => {
  const root = mkdtempSync(join(tmpdir(), "velocast-electron-inventory-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceCommit = "a".repeat(40);
  const expected = {
    status: "unsigned-local-candidate",
    electronVersion: "44.4.5",
    sourceCommit,
  };
  const renderer = join(root, "velocast-renderer.exe");
  writeFileSync(renderer, "renderer");
  const paths = ["velocast-renderer.exe", "electron-host/media-client.cjs", "electron-host/media-runtime.cjs", "electron-host/node_modules/mediabunny/package.json", "electron-host/node_modules/mediabunny/LICENSE"];
  for (const path of paths.slice(1)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), "fixture");
  }
  const files = paths.map((path) => ({
    path,
    size: readFileSync(join(root, path)).length,
    sha256: createHash("sha256").update(readFileSync(join(root, path))).digest("hex"),
  }));
  const manifest = {
    schema: "velocast-electron-runtime-v1",
    status: expected.status,
    browserHost: "electron",
    platform: "win32",
    arch: "x64",
    electronVersion: expected.electronVersion,
    sourceCommit,
    renderer: "velocast-renderer.exe",
    electron: "electron/electron.exe",
    hostScript: "electron-host/main.cjs",
    mediaClient: "electron-host/media-client.cjs",
    mediaBundle: "electron-host/media-runtime.cjs",
    mediaPackage: "electron-host/node_modules/mediabunny",
    rendererCapabilities: {
      browserHosts: ["electron"],
      defaultBrowserHost: "electron",
      electronHostProtocolVersion: 2,
      videoEncoderBackend: "webcodecs",
      mediaRuntime: "mediabunny",
    },
    files,
  };
  const marker = join(root, "electron-runtime.json");
  const writeMarker = () => writeFileSync(marker, JSON.stringify(manifest));
  writeMarker();
  assert.deepEqual(
    verifyElectronRuntimeInventory(root, files, expected),
    manifest,
  );
  assert.throws(
    () =>
      verifyElectronRuntimeInventory(root, files, {
        ...expected,
        status: "prepared-release-candidate",
      }),
    /identity or provenance differs/,
  );
  manifest.files = [{ ...files[0], sha256: "0".repeat(64) }, ...files.slice(1)];
  writeMarker();
  assert.throws(
    () => verifyElectronRuntimeInventory(root, files, expected),
    /file hashes or paths/,
  );
  manifest.files = files;
  manifest.rendererCapabilities.browserHosts = ["cef", "electron"];
  writeMarker();
  assert.throws(
    () => verifyElectronRuntimeInventory(root, files, expected),
    /Electron-only/,
  );
  manifest.rendererCapabilities.browserHosts = ["electron"];
  manifest.sourceCommit = "b".repeat(40);
  writeMarker();
  assert.throws(
    () => verifyElectronRuntimeInventory(root, files, expected),
    /provenance differs/,
  );
});
