import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { windowsCandidateState } from "../windows-candidate-state.mjs";

const blocked = {
  artifact: null,
  requirements: { validationStatus: "blocked" },
};

test("an inventoried candidate remains blocked without acceptance evidence", () => {
  assert.deepEqual(windowsCandidateState(blocked), {
    status: "prepared-not-supported",
    releaseState: {
      artifact: null,
      validationStatus: "blocked",
      publicDistributionApproved: false,
    },
  });
});

test("private acceptance preserves exact evidence without advertising distribution", () => {
  const validatedCandidate = {
    sha256: "a".repeat(64),
    consumerEvidenceSha256: "b".repeat(64),
    hostRequirementsSha256: "c".repeat(64),
  };
  assert.deepEqual(
    windowsCandidateState({
      ...blocked,
      requirements: { validationStatus: "validated" },
      validatedCandidate,
    }),
    {
      status: "validated-unpublished",
      validatedCandidate,
      releaseState: {
        artifact: null,
        validationStatus: "validated",
        distributionStatus: "unpublished",
        publicDistributionApproved: false,
      },
    },
  );
});

test("declaration synchronization cannot promote or erase incomplete acceptance", () => {
  assert.throws(
    () => windowsCandidateState({ ...blocked, artifact: {} }),
    /public_distribution/,
  );
  assert.throws(
    () => windowsCandidateState({ ...blocked, validatedCandidate: {} }),
    /validation_state/,
  );
  assert.throws(
    () =>
      windowsCandidateState({
        ...blocked,
        requirements: { validationStatus: "validated" },
      }),
    /validation_state/,
  );
  assert.throws(
    () =>
      windowsCandidateState({
        ...blocked,
        requirements: { validationStatus: "validated" },
        validatedCandidate: {},
      }),
    /evidence_missing/,
  );
});

test("sync and verifier preserve an accepted private manifest on a disposable fixture", () => {
  const source = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const root = mkdtempSync(join(tmpdir(), "velocast-declaration-state-test-"));
  for (const path of [
    "scripts/sync-windows-runtime-declarations.mjs",
    "scripts/verify-release-manifest.mjs",
    "scripts/windows-candidate-state.mjs",
    "release/velocast-release.json",
    "release/windows-runtime-candidate.json",
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(source, path), join(root, path));
  }
  const path = join(root, "release/velocast-release.json");
  const release = JSON.parse(readFileSync(path, "utf8"));
  const target = release.targets["win32-x64"];
  target.requirements.validationStatus = "validated";
  target.requirements.minimumOsVersion = "10.0.26200";
  release.sourceCommit = "a".repeat(40);
  const requirements = Object.fromEntries(
    [
      "validationStatus",
      "minimumOsVersion",
      "minimumGlibcVersion",
      "gpuRequired",
      "captureBackends",
      "conversionBackends",
      "encoderBackends",
      "softwareFallbackRequired",
      "softwareFallbackImplemented",
    ].map((key) => [key, target.requirements[key]]),
  );
  target.validatedCandidate = {
    name: "test-native.tar.gz",
    format: "tar.gz",
    size: 123,
    sha256: "b".repeat(64),
    sourceCommit: release.sourceCommit,
    packageVersion: release.packageVersion,
    nativeRendererVersion: release.nativeRendererVersion,
    protocolVersion: release.protocolVersion,
    renderer: "velocast-renderer.exe",
    root: "test-native",
    signed: false,
    consumerEvidenceSha256: "c".repeat(64),
    hostRequirementsSha256: createHash("sha256")
      .update(JSON.stringify(requirements))
      .digest("hex"),
  };
  target.artifact = null;
  target.blocker = "Private fixture validated; distribution is not advertised.";
  writeFileSync(path, JSON.stringify(release));
  function run(script, ...args) {
    return spawnSync(
      process.execPath,
      [join(root, "scripts", script), ...args],
      { encoding: "utf8" },
    );
  }
  const inventoryPath = join(
    root,
    "release/test-windows-runtime-inventory.json",
  );
  const inventory = {
    schema: "velocast-electron-runtime-v1",
    status: "unsigned-local-candidate",
    browserHost: "electron",
    platform: "win32",
    arch: "x64",
    electronVersion: release.electronVersion,
    sourceCommit: release.sourceCommit,
    files: target.runtimeFiles
      .filter((path) => path !== "electron-runtime.json")
      .map((path) => ({ path })),
  };
  inventory.electronVersion = "0.0.0";
  writeFileSync(inventoryPath, JSON.stringify(inventory));
  const stale = run(
    "sync-windows-runtime-declarations.mjs",
    "--inventory",
    "release/test-windows-runtime-inventory.json",
    "--write",
  );
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /inventory_runtime_mismatch/);
  inventory.electronVersion = release.electronVersion;
  writeFileSync(inventoryPath, JSON.stringify(inventory));
  for (const [script, ...args] of [
    [
      "sync-windows-runtime-declarations.mjs",
      "--inventory",
      "release/test-windows-runtime-inventory.json",
      "--write",
    ],
    ["sync-windows-runtime-declarations.mjs"],
    ["verify-release-manifest.mjs"],
  ]) {
    const result = run(script, ...args);
    assert.equal(result.status, 0, result.stderr);
  }
  const declaration = JSON.parse(
    readFileSync(join(root, "release/windows-runtime-candidate.json"), "utf8"),
  );
  assert.equal(declaration.status, "validated-unpublished");
  assert.deepEqual(declaration.validatedCandidate, target.validatedCandidate);
  assert.equal(declaration.releaseState.artifact, null);
  assert.equal(declaration.releaseState.publicDistributionApproved, false);
  assert.equal(declaration.provenance.electronVersion, release.electronVersion);
  assert.equal(
    declaration.inventory.path,
    "release/test-windows-runtime-inventory.json",
  );
  inventory.files.push({ path: "unexpected.dll" });
  writeFileSync(inventoryPath, JSON.stringify(inventory));
  const modified = run("verify-release-manifest.mjs");
  assert.notEqual(modified.status, 0);
  assert.match(modified.stderr, /inventory hash differs/);
  inventory.files.pop();
  writeFileSync(inventoryPath, JSON.stringify(inventory));
  release.sourceCommit = "d".repeat(40);
  writeFileSync(path, JSON.stringify(release));
  const invalid = run("verify-release-manifest.mjs");
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /candidate source commit differs from manifest/);
});
