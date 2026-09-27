import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { create } from "tar";

const audit = fileURLToPath(
  new URL("../audit-package-tarballs.mjs", import.meta.url),
);
test("package audit rejects source trees from the published React package", async () => {
  const temporary = await mkdtemp(
    join(tmpdir(), "velocast-package-audit-test-"),
  );
  const resolved = await realpath(temporary);
  try {
    const root = join(temporary, "package");
    async function put(name, body) {
      await mkdir(dirname(join(root, name)), { recursive: true });
      await writeFile(join(root, name), body);
    }
    await put(
      "package.json",
      JSON.stringify({
        name: "@velocast/react",
        version: "0.1.0",
        license: "MIT",
        exports: "./dist/index.js",
      }),
    );
    await put("dist/index.js", "export {};\n");
    await put("LICENSE", "MIT\n");
    await put("THIRD_PARTY_NOTICES.md", "fixture\n");
    const tarball = join(temporary, "react.tgz");
    async function run() {
      await create({ cwd: temporary, file: tarball, gzip: true }, ["package"]);
      return spawnSync(process.execPath, [audit, tarball], {
        encoding: "utf8",
        windowsHide: true,
      });
    }
    const accepted = await run();
    assert.equal(accepted.status, 0, accepted.stderr);
    await put("templates/basic/src/Composition.tsx", "not a distributable\n");
    const rejected = await run();
    assert.notEqual(rejected.status, 0);
    assert.match(
      rejected.stderr,
      /contains build junk: templates\/basic\/src\/Composition\.tsx/,
    );
  } finally {
    assert.equal(await realpath(temporary), resolved);
    await rm(resolved, { recursive: true, force: true });
  }
});
