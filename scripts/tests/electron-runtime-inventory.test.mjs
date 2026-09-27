import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const files = [
    {
      path: "velocast-renderer.exe",
      size: 8,
      sha256: createHash("sha256").update(readFileSync(renderer)).digest("hex"),
    },
  ];
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
    ffmpeg: "ffmpeg.exe",
    ffprobe: "ffprobe.exe",
    rendererCapabilities: {
      browserHosts: ["electron"],
      defaultBrowserHost: "electron",
      electronHostProtocolVersion: 1,
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
  manifest.files = [{ ...files[0], sha256: "0".repeat(64) }];
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
