import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(
  new URL("../build/copy-release-manifest.mjs", import.meta.url),
);

for (const packageName of ["cli", "core"]) {
  test(`${packageName} build copies licenses and the appropriate release metadata`, (t) => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "velocast-build-metadata-")),
    );
    t.after(() => {
      assert.equal(realpathSync(root), root);
      rmSync(root, { recursive: true, force: true });
    });
    const script = join(root, "scripts/build/copy-release-manifest.mjs");
    mkdirSync(dirname(script), { recursive: true });
    mkdirSync(join(root, "release"));
    copyFileSync(source, script);
    writeFileSync(join(root, "LICENSE"), "license fixture\n");
    writeFileSync(join(root, "THIRD_PARTY_NOTICES"), "notices fixture\n");
    writeFileSync(
      join(root, "release/velocast-release.json"),
      '{"fixture":true}\n',
    );

    const result = spawnSync(process.execPath, [script, packageName], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const dist = join(root, "packages", packageName, "dist");
    assert.equal(
      readFileSync(join(dist, "LICENSE"), "utf8"),
      "license fixture\n",
    );
    assert.equal(
      readFileSync(join(dist, "THIRD_PARTY_NOTICES"), "utf8"),
      "notices fixture\n",
    );
    if (packageName === "cli") {
      assert.deepEqual(
        JSON.parse(readFileSync(join(dist, "release-manifest.json"))),
        {
          fixture: true,
        },
      );
    } else {
      assert.throws(() => readFileSync(join(dist, "release-manifest.json")), {
        code: "ENOENT",
      });
    }
  });
}
