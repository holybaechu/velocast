import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const roots = [];
process.on("exit", () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("concurrent setup helper joins two real Node children and seals one result", () => {
  const root = temp("velocast-concurrent-helper-");
  const cache = join(root, "cache");
  const cli = join(root, "cli.mjs");
  const output = join(root, "result.json");
  writeFileSync(
    cli,
    `import{mkdirSync}from"node:fs";mkdirSync(process.env.VELOCAST_CACHE_DIR,{recursive:true});console.log(JSON.stringify({target:"win32-x64",source:"cache",artifactDir:${JSON.stringify(join(cache, "artifact"))},rendererBinary:"renderer",sha256:"${"a".repeat(64)}"}));`,
  );
  run(
    join(repo, "scripts/windows-private-rc-concurrent-setup.mjs"),
    [
      "--npm-cli",
      cli,
      "--pnpm-cli",
      cli,
      "--cache",
      cache,
      "--output",
      output,
    ],
  );
  const result = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(result.status, "PASS");
  assert.deepEqual(result.sources, ["cache", "cache"]);
  assert.deepEqual(result.leftovers, []);
});

test("preview wrapper preserves a child harness JSON result", () => {
  const root = temp("velocast-preview-helper-");
  const harness = join(root, "harness.mjs");
  const project = join(root, "project");
  const runtime = join(root, "runtime");
  const cli = join(root, "cli.mjs");
  const output = join(root, "preview.json");
  mkdirSync(project);
  mkdirSync(runtime);
  writeFileSync(cli, "// installed CLI fixture");
  writeFileSync(harness, 'console.log(JSON.stringify({browser:"test",frame:12}));');
  run(join(repo, "scripts/windows-private-rc-preview.mjs"), [
    "--harness",
    harness,
    "--project",
    project,
    "--cli",
    cli,
    "--runtime",
    runtime,
    "--output",
    output,
  ]);
  const result = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(result.status, "PASS");
  assert.deepEqual(result.result, { browser: "test", frame: 12 });
});

test("offline-empty-cache negative helper accepts only the expected CLI failure", () => {
  const root = temp("velocast-negative-helper-");
  const attempt = join(root, "attempt");
  const cache = join(attempt, "cache");
  mkdirSync(attempt);
  mkdirSync(cache);
  const cli = join(root, "cli.mjs");
  const manifest = join(root, "release.json");
  const artifact = join(root, "artifact.tar.gz");
  const output = join(root, "negative.json");
  writeFileSync(cli, 'console.error("artifact.offline_missing: expected");process.exitCode=1;');
  writeFileSync(manifest, JSON.stringify({ targets: { "win32-x64": { artifact: {} } } }));
  writeFileSync(artifact, "fixture");
  run(
    join(repo, "scripts/windows-private-rc-negative.mjs"),
    [
      "offline-empty-cache",
      "--cli",
      cli,
      "--manifest",
      manifest,
      "--artifact",
      artifact,
      "--output",
      output,
    ],
    {
      VELOCAST_NEGATIVE_ATTEMPT_ROOT: attempt,
      VELOCAST_CACHE_DIR: cache,
    },
  );
  const result = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(result.status, "PASS");
  assert.match(result.stderr, /artifact\.offline_missing/);
});

test("version-mismatch derives an internally consistent manifest before setup", () => {
  const root = temp("velocast-version-helper-");
  const attempt = join(root, "attempt");
  const cache = join(attempt, "cache");
  mkdirSync(attempt);
  mkdirSync(cache);
  const cli = join(root, "cli.mjs");
  const manifest = join(root, "release.json");
  const artifact = join(root, "artifact.tar.gz");
  const output = join(root, "negative.json");
  writeFileSync(
    cli,
    `import{readFileSync}from"node:fs";const value=JSON.parse(readFileSync(process.env.VELOCAST_RELEASE_MANIFEST,"utf8"));const target=value.targets["win32-x64"];if(value.sourceCommit!=="${"0".repeat(40)}"||target.artifact.sourceCommit!==value.sourceCommit){console.error("release.manifest_invalid");process.exitCode=2}else{console.error("artifact.compatibility_mismatch: expected");process.exitCode=1}`,
  );
  writeFileSync(
    manifest,
    JSON.stringify({
      sourceCommit: "a".repeat(40),
      targets: { "win32-x64": { artifact: { sourceCommit: "a".repeat(40) } } },
    }),
  );
  writeFileSync(artifact, "fixture");
  run(
    join(repo, "scripts/windows-private-rc-negative.mjs"),
    [
      "version-mismatch",
      "--cli",
      cli,
      "--manifest",
      manifest,
      "--artifact",
      artifact,
      "--output",
      output,
    ],
    {
      VELOCAST_NEGATIVE_ATTEMPT_ROOT: attempt,
      VELOCAST_CACHE_DIR: cache,
    },
  );
  const result = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(result.status, "PASS");
  assert.match(result.stderr, /artifact\.compatibility_mismatch/);
});

function run(script, args, additions = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, ...additions },
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  assert.equal(
    result.status,
    0,
    `${script} failed\n${result.stdout}\n${result.stderr}`,
  );
}

function temp(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
