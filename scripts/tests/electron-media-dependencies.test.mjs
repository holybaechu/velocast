import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stageMediaDependencies } from "../media-runtime-dependencies.mjs";

test("staged codecs retain their native assets, ESM exports, licenses and shared Mediabunny peer", (t) => {
  const root = mkdtempSync(join(tmpdir(), "velocast-media-dependencies-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = join(root, "host"),
    output = join(root, "runtime");
  mkdirSync(host);
  mkdirSync(output);
  writeFileSync(join(host, "package.json"), "{}");
  const pkg = (name, extra = {}, files = {}) => {
    const directory = join(host, "node_modules", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name, version: "1.0.0", ...extra }),
    );
    for (const [file, contents] of Object.entries({
      LICENSE: name,
      ...files,
    })) {
      const target = join(directory, file);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, contents);
    }
    return directory;
  };
  pkg(
    "mediabunny",
    { main: "index.cjs" },
    { "index.cjs": "module.exports = {};" },
  );
  pkg("@mediabunny/server", {
    dependencies: { native: "1.0.0" },
    peerDependencies: { mediabunny: "1.0.0" },
  });
  pkg(
    "native",
    {
      exports: { import: "./src/index.mjs" },
      optionalDependencies: { "absent-platform": "1.0.0" },
      peerDependencies: { mediabunny: "1.0.0" },
    },
    { "src/index.mjs": "export default {};", "binding.node": "native-bytes" },
  );
  const packages = stageMediaDependencies({ host, output });
  assert.deepEqual(packages.map(({ name }) => name).sort(), [
    "@mediabunny/server",
    "mediabunny",
    "native",
  ]);
  assert.equal(
    readFileSync(join(output, "node_modules/native/binding.node"), "utf8"),
    "native-bytes",
  );
  assert.equal(
    readFileSync(join(output, "node_modules/native/LICENSE"), "utf8"),
    "native",
  );
  assert.equal(
    readFileSync(join(output, "node_modules/native/src/index.mjs"), "utf8"),
    "export default {};",
  );
  assert.equal(
    existsSync(
      join(output, "node_modules/@mediabunny/server/node_modules/mediabunny"),
    ),
    false,
  );
  rmSync(join(host, "node_modules/native"), { recursive: true, force: true });
  assert.throws(
    () => stageMediaDependencies({ host, output: join(root, "missing") }),
    /runtime.package_missing: @mediabunny\/server -> native/,
  );
});
