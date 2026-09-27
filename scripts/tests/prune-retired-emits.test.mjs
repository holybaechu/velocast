import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  access,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneRetiredEmits } from "../prune-retired-emits.mjs";

async function fixture(t, packageName = "core") {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "velocast-retired-emits-")),
  );
  t.after(async () => {
    assert.equal(await realpath(root), root);
    await rm(root, { recursive: true, force: true });
  });
  const pkg = join(root, "packages", packageName);
  await mkdir(join(pkg, "src"), { recursive: true });
  return { root, pkg, dist: join(pkg, "dist") };
}

for (const [packageName, modules] of [
  ["core", ["registry", "dom-discovery", "composition-definitions"]],
  ["cli", ["job", "remotion-command", "linux-cef-runtime"]],
]) {
  test(`${packageName}: remove exact retired emits while retaining active outputs and assets`, async (t) => {
    const { root, dist } = await fixture(t, packageName);
    await mkdir(dist);
    const retired = modules.flatMap((name) =>
      [".js", ".js.map", ".d.ts", ".d.ts.map"].map((suffix) => name + suffix),
    );
    for (const name of retired) await writeFile(join(dist, name), "stale emit");
    const retained = [
      "index.js",
      "index.d.ts",
      "release-manifest.json",
      "LICENSE",
      "registry.json",
      "job-helper.js",
    ];
    for (const name of retained)
      await writeFile(join(dist, name), "keep " + name);
    assert.equal(
      (await pruneRetiredEmits(packageName, root)).length,
      retired.length,
    );
    for (const name of retired)
      await assert.rejects(access(join(dist, name)), { code: "ENOENT" });
    for (const name of retained)
      assert.equal(await readFile(join(dist, name), "utf8"), "keep " + name);
    assert.deepEqual(await pruneRetiredEmits(packageName, root), []);
  });
}

test("fresh build without dist is a no-op", async (t) => {
  const { root } = await fixture(t);
  assert.deepEqual(await pruneRetiredEmits("core", root), []);
});
test("refuse pruning all candidates when a retired source returns", async (t) => {
  const { root, pkg, dist } = await fixture(t);
  await mkdir(dist);
  await writeFile(
    join(dist, "registry.js"),
    "keep stale until source resolved",
  );
  await writeFile(join(pkg, "src", "dom-discovery.ts"), "export {};");
  await assert.rejects(
    pruneRetiredEmits("core", root),
    /retired_emit.source_present/,
  );
  assert.equal(
    await readFile(join(dist, "registry.js"), "utf8"),
    "keep stale until source resolved",
  );
});
test("reject a directory where a generated file should be, before deleting peers", async (t) => {
  const { root, dist } = await fixture(t);
  await mkdir(dist);
  await writeFile(join(dist, "registry.js"), "keep");
  await mkdir(join(dist, "registry.js.map"));
  await assert.rejects(
    pruneRetiredEmits("core", root),
    /retired_emit.unsafe_file/,
  );
  assert.equal(await readFile(join(dist, "registry.js"), "utf8"), "keep");
});
test("reject a junction/symlink dist escaping the package", async (t) => {
  const { root, dist } = await fixture(t);
  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "registry.js"), "outside untouched");
  await symlink(outside, dist, "junction");
  await assert.rejects(
    pruneRetiredEmits("core", root),
    /retired_emit.unsafe_directory/,
  );
  assert.equal(
    await readFile(join(outside, "registry.js"), "utf8"),
    "outside untouched",
  );
});
test("reject a linked retired file without following it", async (t) => {
  const { root, dist } = await fixture(t);
  await mkdir(dist);
  const outside = join(root, "outside.js");
  await writeFile(outside, "outside untouched");
  try {
    await symlink(outside, join(dist, "registry.js"), "file");
  } catch (error) {
    if (error.code === "EPERM")
      return t.skip("host does not permit file symlinks");
    throw error;
  }
  await assert.rejects(
    pruneRetiredEmits("core", root),
    /retired_emit.unsafe_file/,
  );
  assert.equal(await readFile(outside, "utf8"), "outside untouched");
});
test("reject unknown packages and traversal before filesystem access", async () => {
  for (const name of [
    "../core",
    "core/../../",
    "react",
    "__proto__",
    undefined,
  ]) {
    await assert.rejects(
      pruneRetiredEmits(name),
      /retired_emit.unknown_package/,
    );
  }
});
