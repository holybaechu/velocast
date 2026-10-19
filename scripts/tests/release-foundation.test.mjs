import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
test("release assembly rejects unsigned, incomplete, and missing package evidence", () => {
  const temp = mkdtempSync(join(tmpdir(), "velocast-release-test-"));
  const target = "darwin-arm64";
  try {
    writeEvidence({ unsigned: true });
    assert.match(runAssembly(), /release\.signature_missing: darwin-arm64/);

    writeEvidence({ unsigned: false });
    writeFileSync(
      join(temp, `${target}-package-audit.json`),
      JSON.stringify({ status: "PASS", packages: [] }),
    );
    assert.match(runAssembly(), /release\.package_audit_missing: darwin-arm64/);

    writeFileSync(
      join(temp, `${target}-package-audit.json`),
      JSON.stringify({
        status: "PASS",
        packages: [
          "velocast-0.1.0.tgz",
          "velocast-core-0.1.0.tgz",
          "velocast-gsap-0.1.0.tgz",
          "velocast-react-0.1.0.tgz",
          "velocast-remotion-0.1.0.tgz",
          "velocast-remotion-source-0.1.0.tgz",
          "velocast-preview-0.1.0.tgz",
        ],
      }),
    );
    assert.match(
      runAssembly(),
      /release\.package_artifact_missing: darwin-arm64/,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }

  function writeEvidence(overrides) {
    writeFileSync(
      join(temp, `${target}.tar.gz.json`),
      JSON.stringify({
        target,
        name: `${target}.tar.gz`,
        format: "tar.gz",
        size: 123,
        sha256: "a".repeat(64),
        sourceCommit: "b".repeat(40),
        renderer: "Velocast Renderer.app/Contents/MacOS/velocast-renderer",
        root: "velocast-darwin-arm64",
        unsigned: true,
        ...overrides,
      }),
    );
  }

  function runAssembly() {
    const result = spawnSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "release", "assemble-release-manifest.mjs"),
        "--evidence-dir",
        temp,
        "--output",
        join(temp, "release.json"),
        "--base-url",
        "https://artifacts.invalid/",
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.notEqual(
      result.status,
      0,
      "assembly unexpectedly accepted incomplete evidence",
    );
    return `${result.stdout}\n${result.stderr}`;
  }
});
