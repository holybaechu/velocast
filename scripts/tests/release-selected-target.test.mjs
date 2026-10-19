import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validReleasePackageSet } from "../release/release-package-set.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const script = join(root, "scripts/release/assemble-release-manifest.mjs");

test("selected Windows assembly does not require five unrelated target artifacts", (t) => {
  const { temp, run } = fixture(t);
  writeFileSync(
    join(temp, "win32-x64.tar.gz.json"),
    JSON.stringify({
      target: "win32-x64",
      name: "win32-x64.tar.gz",
      format: "tar.gz",
      size: 123,
      sha256: "a".repeat(64),
      sourceCommit: "b".repeat(40),
      renderer: "velocast-renderer.exe",
      root: "velocast-win32-x64",
      unsigned: true,
    }),
  );
  const result = run(["--target", "win32-x64"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release\.signature_missing: win32-x64/);
  assert.doesNotMatch(result.stderr, /ENOENT.*darwin|linux-arm64/);
});

test("invalid selected targets fail before reading evidence", (t) => {
  const { run } = fixture(t, "velocast-selected-release-invalid-");
  const result = run(["--target", "windows-any"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release\.target_invalid/);
});

test("omitting target keeps all-target assembly behavior", (t) => {
  const { run } = fixture(t, "velocast-selected-release-default-");
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /darwin-arm64\.tar\.gz\.json/);
});

test("package identity follows the manifest version without a major-zero prefix", () => {
  expectPackageSet("1.4.2");
  expectPackageSet("2.0.0-rc.1");
});

function fixture(t, prefix = "velocast-selected-release-") {
  const temp = mkdtempSync(join(tmpdir(), prefix));
  const owned = realpathSync(temp);
  t.after(() => {
    assert.equal(realpathSync(temp), owned);
    assert.equal(dirname(owned), realpathSync(tmpdir()));
    rmSync(owned, { recursive: true, force: true });
  });
  return {
    temp,
    run: (args = []) =>
      spawnSync(
        process.execPath,
        [
          script,
          ...args,
          "--evidence-dir",
          temp,
          "--output",
          join(temp, "release.json"),
          "--base-url",
          "https://artifacts.invalid/",
        ],
        {
          cwd: root,
          encoding: "utf8",
          windowsHide: true,
        },
      ),
  };
}

function expectPackageSet(version) {
  const packages = [
    `velocast-${version}.tgz`,
    `velocast-core-${version}.tgz`,
    `velocast-gsap-${version}.tgz`,
    `velocast-react-${version}.tgz`,
    `velocast-remotion-${version}.tgz`,
    `velocast-remotion-source-${version}.tgz`,
    `velocast-preview-${version}.tgz`,
  ];
  assert.equal(validReleasePackageSet(packages, version), true);
  assert.equal(
    validReleasePackageSet(
      packages.map((name) => name.replace(version, "0.1.0")),
      version,
    ),
    false,
  );
}
