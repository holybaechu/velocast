import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { requirementsSha256, sha256File } from "../release/hashes.mjs";
import { validatedRequirementsSha256 } from "../../packages/cli/dist/runtime/release-manifest.js";

test("release file hashes cover empty files and multiple read buffers", (t) => {
  const root = mkdtempSync(join(tmpdir(), "velocast-release-hashes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "artifact");
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.alloc(2 * 1024 * 1024 + 17, 123),
  ]) {
    writeFileSync(path, bytes);
    assert.equal(
      sha256File(path),
      createHash("sha256").update(bytes).digest("hex"),
    );
  }
});

test("release tooling and the shipped CLI agree on host requirements fingerprints", () => {
  const requirements = {
    validationStatus: "validated",
    minimumOsVersion: "test-os",
    gpuRequired: true,
    captureBackends: ["webcodecs"],
    conversionBackends: ["webcodecs"],
    encoderBackends: ["webcodecs"],
    softwareFallbackRequired: false,
    softwareFallbackImplemented: false,
  };
  for (const value of [
    requirements,
    { ...requirements, minimumGlibcVersion: "2.31" },
  ]) {
    assert.equal(requirementsSha256(value), validatedRequirementsSha256(value));
    assert.equal(
      requirementsSha256({ unrelated: true, ...value }),
      requirementsSha256(value),
    );
  }
});
