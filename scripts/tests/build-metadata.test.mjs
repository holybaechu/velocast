import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));

for (const packageName of ["cli", "core", "remotion-compat"]) {
  test(`${packageName} build removes stale outputs and recreates code and release metadata`, (t) => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "velocast-build-metadata-")),
    );
    t.after(() => {
      assert.equal(realpathSync(root), root);
      assert.ok(!root.startsWith(resolve(repository)));
      rmSync(root, { recursive: true, force: true });
    });
    const script = join(root, "scripts/build/copy-release-manifest.mjs");
    mkdirSync(dirname(script), { recursive: true });
    mkdirSync(join(root, "release"));
    copyFileSync(
      join(repository, "scripts/build/copy-release-manifest.mjs"),
      script,
    );
    copyFileSync(
      join(repository, "tsconfig.base.json"),
      join(root, "tsconfig.base.json"),
    );
    const pkg = join(root, "packages", packageName);
    mkdirSync(join(pkg, "src"), { recursive: true });
    for (const file of ["package.json", "tsconfig.json", "tsconfig.build.json"])
      copyFileSync(
        join(repository, "packages", packageName, file),
        join(pkg, file),
      );
    symlinkSync(
      join(repository, "packages", packageName, "node_modules"),
      join(pkg, "node_modules"),
      "junction",
    );
    const source = "export const value = 42;\n";
    writeFileSync(join(pkg, "src/index.ts"), source);
    const dist = join(pkg, "dist");
    mkdirSync(join(dist, "removed"), { recursive: true });
    writeFileSync(join(dist, "removed/module.js"), "obsolete output");
    writeFileSync(join(dist, "removed/module.d.ts"), "obsolete declaration");
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "keep");
    symlinkSync(outside, join(dist, "linked"), "junction");
    writeFileSync(join(root, "LICENSE"), "license fixture\n");
    writeFileSync(join(root, "THIRD_PARTY_NOTICES"), "notices fixture\n");
    writeFileSync(
      join(root, "release/velocast-release.json"),
      '{"fixture":true}\n',
    );

    const { scripts } = JSON.parse(
      readFileSync(join(pkg, "package.json"), "utf8"),
    );
    const result = spawnSync(scripts.build, {
      cwd: pkg,
      shell: true,
      env: {
        ...process.env,
        PATH: [
          dirname(process.execPath),
          join(pkg, "node_modules/.bin"),
          process.env.PATH,
        ].join(delimiter),
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(dist, "removed")), false);
    assert.equal(existsSync(join(dist, "linked")), false);
    assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "keep");
    assert.equal(readFileSync(join(pkg, "src/index.ts"), "utf8"), source);
    assert.match(readFileSync(join(dist, "index.js"), "utf8"), /value = 42/);
    assert.match(readFileSync(join(dist, "index.d.ts"), "utf8"), /value = 42/);
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
