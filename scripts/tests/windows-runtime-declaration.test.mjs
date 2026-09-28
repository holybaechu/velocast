import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { windowsCandidateState } from "../windows-candidate-state.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const declaration = readJson("release/windows-runtime-candidate.json");
const release = readJson("release/velocast-release.json");
const target = release.targets["win32-x64"];

test("Windows candidate declaration matches the current release manifest", () => {
  const expectedState = windowsCandidateState(target);
  assert.equal(declaration.status, expectedState.status);
  assert.equal(declaration.validatedCandidate, undefined);
  assert.equal(declaration.inventory, undefined);
  assert.equal(declaration.provenance, undefined);
  assert.equal(declaration.releaseState.artifact, null);
  assert.deepEqual(declaration.releaseState, expectedState.releaseState);
  assert.equal(declaration.releaseState.publicDistributionApproved, false);
  assert.equal(target.artifact, null);
  assert.equal(
    target.requirements.validationStatus,
    expectedState.releaseState.validationStatus,
  );
  assert.deepEqual(target.runtimeFiles, declaration.runtimeFiles);
  assert.deepEqual(target.nativeFiles, declaration.nativeFiles);
  assert.ok(target.runtimeFiles.length > 80);
  assert.ok(target.nativeFiles.length > 5);
  assert.equal(
    target.runtimeFiles.filter((path) => path.startsWith("electron/locales/"))
      .length > 0,
    true,
  );
  for (const name of [
    "velocast-renderer.exe",
    "electron/electron.exe",
  ])
    assert(target.nativeFiles.includes(name));
  for (const name of ["electron-host/media-client.cjs", "electron-host/media-runtime.cjs", "electron-host/node_modules/mediabunny/package.json"])
    assert(target.runtimeFiles.includes(name));
  assert.ok(!target.runtimeFiles.some((path) => /(^|\/)(ffmpeg|ffprobe)(\.exe)?$|^(avcodec|avformat|avutil|swresample)-\d+\.dll$/i.test(path)));
  assert.equal(
    target.runtimeFiles.some((path) =>
      /(^|\/)(src|include|cmake|debug)(\/|$)|\.(pdb|lib|obj)$/i.test(path),
    ),
    false,
  );
});

test("Windows candidate records Electron and Mediabunny licensing inputs", () => {
  const byComponent = Object.fromEntries(
    declaration.licenses.map((license) => [license.component, license]),
  );
  assert.equal(byComponent.Electron.version, release.electronVersion);
  assert.deepEqual(byComponent.Electron.files, [
    "electron/LICENSE",
    "electron/LICENSES.chromium.html",
  ]);
  assert.deepEqual(byComponent.Mediabunny.files, ["electron-host/node_modules/mediabunny/LICENSE"]);
  assert.equal(declaration.browserHost, "electron");
});

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}
