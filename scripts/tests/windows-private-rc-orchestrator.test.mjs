import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  environmentFor,
  runCommandForTest,
  runWindowsPrivateRc,
  validateManifest,
} from "../windows-private-rc-orchestrator.mjs";

const roots = [];
process.on("exit", () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("executes once, records immutable evidence, and resumes completed steps", async () => {
  const fixture = createFixture();
  const calls = [];
  const run = async (input) => {
    calls.push(input.id);
    const step = fixture.manifest.steps.find((candidate) => candidate.id === input.id);
    for (const output of step.outputs) writeFileSync(output, `output:${input.id}`);
    return { exitCode: 0, stdout: `stdout:${input.id}\n`, stderr: "" };
  };
  const state = await runWindowsPrivateRc(
    fixture.manifest,
    { stateDir: fixture.state, execute: true, hostEnv: fixture.hostEnv },
    { run, now: clock() },
  );
  assert.equal(state.status, "complete");
  assert.equal(calls.length, fixture.manifest.steps.length);
  for (const step of fixture.manifest.steps) {
    const record = state.steps[step.id];
    assert.equal(record.status, "complete");
    assert.equal(record.attempts.length, 1);
    assert.equal(record.outputs.length, step.outputs.length);
    assert.match(record.attempts[0].request.sha256, /^[a-f0-9]{64}$/);
    assert.match(record.attempts[0].stdout.sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(existsSync(join(fixture.state, "state.final.json")), true);
  assert.match(
    readFileSync(join(fixture.state, "state.final.sha256"), "utf8"),
    /^[a-f0-9]{64}  state\.final\.json\n$/,
  );
  const resumed = await runWindowsPrivateRc(
    fixture.manifest,
    { stateDir: fixture.state, execute: true, hostEnv: fixture.hostEnv },
    { run: async () => { throw new Error("completed step reran"); }, now: clock() },
  );
  assert.equal(resumed.status, "complete");
  assert.equal(calls.length, fixture.manifest.steps.length);
});

test("fails fast, preserves the failed attempt, and does not run later commands", async () => {
  const fixture = createFixture();
  const calls = [];
  await assert.rejects(
    runWindowsPrivateRc(
      fixture.manifest,
      { stateDir: fixture.state, execute: true, hostEnv: fixture.hostEnv },
      {
        run: async (input) => {
          calls.push(input.id);
          const step = fixture.manifest.steps.find((candidate) => candidate.id === input.id);
          if (calls.length === 2)
            return { exitCode: 19, stdout: "partial", stderr: "literal failure" };
          for (const output of step.outputs) writeFileSync(output, input.id);
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
        now: clock(),
      },
    ),
    /private_rc\.command_failed/,
  );
  assert.equal(calls.length, 2);
  const state = JSON.parse(readFileSync(join(fixture.state, "state.json")));
  assert.equal(state.status, "failed");
  assert.equal(state.steps[calls[1]].attempts[0].exitCode, 19);
  assert.equal(
    readFileSync(state.steps[calls[1]].attempts[0].stderr.path, "utf8"),
    "literal failure",
  );
});

test("records output verification failure and resumes with a new immutable attempt", async () => {
  const fixture = createFixture();
  await assert.rejects(
    runWindowsPrivateRc(
      fixture.manifest,
      { stateDir: fixture.state, execute: true, hostEnv: fixture.hostEnv },
      {
        run: async () => ({ exitCode: 0, stdout: "exit zero", stderr: "" }),
        now: clock(),
      },
    ),
    /output_verification_failed/,
  );
  let state = JSON.parse(readFileSync(join(fixture.state, "state.json")));
  const first = state.steps["npm-install"];
  assert.equal(first.status, "failed");
  assert.equal(first.attempts[0].status, "output-verification-failed");
  const firstStdout = readFileSync(first.attempts[0].stdout.path, "utf8");
  // Simulate interruption after the ledger and evidence files were reserved.
  first.status = "running";
  first.attempts[0].status = "running";
  state.status = "running";
  writeFileSync(join(fixture.state, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  const completed = await runWindowsPrivateRc(
    fixture.manifest,
    { stateDir: fixture.state, execute: true, hostEnv: fixture.hostEnv },
    {
      run: async (input) => {
        const step = fixture.manifest.steps.find((candidate) => candidate.id === input.id);
        for (const output of step.outputs) writeFileSync(output, `recovered:${input.id}`);
        return { exitCode: 0, stdout: `recovered:${input.id}`, stderr: "" };
      },
      now: clock(),
    },
  );
  assert.equal(completed.status, "complete");
  assert.equal(completed.steps["npm-install"].attempts.length, 2);
  assert.equal(completed.steps["npm-install"].attempts[0].status, "interrupted");
  assert.equal(completed.steps["npm-install"].attempts[1].status, "complete");
  assert.equal(readFileSync(first.attempts[0].stdout.path, "utf8"), firstStdout);
});

test("uses a distinct disposable negative root and cache for each retry", async () => {
  const fixture = createFixture();
  let failed = false;
  await assert.rejects(
    runWindowsPrivateRc(
      fixture.manifest,
      { stateDir: fixture.state, execute: true, hostEnv: fixture.hostEnv },
      {
        run: async (input) => {
          const step = fixture.manifest.steps.find((candidate) => candidate.id === input.id);
          if (input.id === "corrupt-archive" && !failed) {
            failed = true;
            return { exitCode: 9, stdout: "", stderr: "expected negative harness failure" };
          }
          for (const output of step.outputs) writeFileSync(output, input.id);
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
        now: clock(),
      },
    ),
    /command_failed: corrupt-archive/,
  );
  const completed = await runWindowsPrivateRc(
    fixture.manifest,
    { stateDir: fixture.state, execute: true, hostEnv: fixture.hostEnv },
    {
      run: async (input) => {
        const step = fixture.manifest.steps.find((candidate) => candidate.id === input.id);
        for (const output of step.outputs) writeFileSync(output, `retry:${input.id}`);
        return { exitCode: 0, stdout: "retry", stderr: "" };
      },
      now: clock(),
    },
  );
  const attempts = completed.steps["corrupt-archive"].attempts;
  assert.equal(attempts.length, 2);
  assert.notEqual(attempts[0].negativeRoot, attempts[1].negativeRoot);
  assert.match(attempts[0].negativeRoot, /attempt-1$/);
  assert.match(attempts[1].negativeRoot, /attempt-2$/);
});

test("minimal environments exclude developer runtime overrides", () => {
  const fixture = createFixture();
  const step = fixture.manifest.steps[2];
  const env = environmentFor(fixture.manifest, step, {
    ...fixture.hostEnv,
    VELOCAST_RENDERER_BINARY: "developer-renderer",
    CARGO_TARGET_DIR: "developer-target",
    CEF_PATH: "developer-cef",
    VCPKG_ROOT: "developer-vcpkg",
    LIBCLANG_PATH: "developer-llvm",
  });
  assert.equal(env.PATH, fixture.manifest.environment.minimalPath);
  assert.equal(env.VELOCAST_RELEASE_MANIFEST, fixture.manifest.environment.releaseManifest);
  for (const name of [
    "VELOCAST_RENDERER_BINARY",
    "CARGO_TARGET_DIR",
    "CEF_PATH",
    "VCPKG_ROOT",
    "LIBCLANG_PATH",
  ])
    assert.equal(env[name], undefined);
});

test("rejects publication, missing video roles, and escaping negative roots", () => {
  const fixture = createFixture();
  const publication = structuredClone(fixture.manifest);
  publication.publication.upload = true;
  assert.throws(() => validateManifest(publication, true), /publication_forbidden/);
  const video = structuredClone(fixture.manifest);
  video.steps = video.steps.filter((step) => step.videoRole !== "clip-caption-music");
  assert.throws(() => validateManifest(video, true), /video_missing/);
  const escape = structuredClone(fixture.manifest);
  escape.steps.find((step) => step.negative).negative.disposableRoot = "../escape";
  assert.throws(() => validateManifest(escape, true), /negative_scope_invalid/);
  const protectedPath = structuredClone(fixture.manifest);
  protectedPath.steps[0].env = { Path: "C:\\developer" };
  assert.throws(
    () => validateManifest(protectedPath, true),
    /environment_override_forbidden: Path/,
  );
  const protectedCache = structuredClone(fixture.manifest);
  protectedCache.steps[0].env = { velocast_cache_dir: "C:\\developer-cache" };
  assert.throws(
    () => validateManifest(protectedCache, true),
    /environment_override_forbidden: velocast_cache_dir/,
  );
  const lowercaseToolchain = structuredClone(fixture.manifest);
  lowercaseToolchain.steps[0].env = { vcpkg_root: "C:\\developer-vcpkg" };
  assert.throws(
    () => validateManifest(lowercaseToolchain, true),
    /environment_override_forbidden: vcpkg_root/,
  );
  const unsafeId = structuredClone(fixture.manifest);
  unsafeId.steps[0].id = "../escape";
  assert.throws(() => validateManifest(unsafeId, true), /step_id_invalid/);
});

test("bounds and joins a real Node child process tree", async () => {
  const root = mkdtempSync(join(tmpdir(), "velocast-private-rc-timeout-"));
  roots.push(root);
  const script = join(root, "parent.mjs");
  const grandchildPid = join(root, "grandchild.pid");
  writeFileSync(
    script,
    `import{spawn}from"node:child_process";import{writeFileSync}from"node:fs";const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});writeFileSync(${JSON.stringify(grandchildPid)},String(child.pid));setInterval(()=>{},1000);`,
  );
  const result = await runCommandForTest({
    argv: [process.execPath, script],
    cwd: root,
    env: process.env,
    timeoutMs: 1_000,
  });
  assert.equal(result.exitCode, 124);
  assert.equal(result.timedOut, true);
  const pid = Number(readFileSync(grandchildPid, "utf8"));
  await expectProcessExit(pid);
});

test(
  "executes Windows package-manager cmd shims without a shell spawn error",
  { skip: process.platform !== "win32" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "velocast-private-rc-cmd-"));
    roots.push(root);
    const command = join(root, "package manager.cmd");
    writeFileSync(command, "@echo off\r\necho shim:%~1\r\n");
    const result = await runCommandForTest({
      argv: [command, "value with spaces"],
      cwd: root,
      env: process.env,
      timeoutMs: 10_000,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), "shim:value with spaces");
    assert.equal(result.stderr, "");
  },
);

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "velocast-private-rc-test-"));
  roots.push(root);
  const state = join(root, "state");
  const output = join(root, "outputs");
  mkdirSync(output);
  const kinds = [
    { id: "npm-install", kind: "install", scope: "npm" },
    { id: "pnpm-install", kind: "install", scope: "pnpm" },
    { id: "lyrics", kind: "render", scope: "npm", videoRole: "original-lyrics" },
    { id: "media", kind: "render", scope: "pnpm", videoRole: "clip-caption-music" },
    ...[
      "corrupt-archive",
      "corrupt-cache",
      "version-mismatch",
      "cancel-render",
      "offline-empty-cache",
    ].map((name) => ({
      id: name,
      kind: "negative",
      scope: "shared",
      negative: { case: name, disposableRoot: name, cacheRoot: "cache" },
    })),
  ];
  const manifest = {
    schema: "velocast-windows-private-rc-run-v1",
    status: "ready-private-rc",
    target: "win32-x64",
    consumerRoot: root,
    publication: { upload: false, publicRelease: false, supportedManifestFlip: false },
    environment: {
      installPath: "C:\\tools\\node;C:\\tools\\npm;C:\\Windows\\System32",
      minimalPath: "C:\\tools\\node;C:\\Windows\\System32;C:\\Windows",
      releaseManifest: join(root, "private-release.json"),
      cacheRoot: join(root, "cache"),
    },
    steps: kinds.map((value, index) => ({
      ...value,
      environment: value.kind === "install" ? "install" : "minimal",
      argv: ["C:\\tools\\node.exe", `step-${value.id}.mjs`],
      cwd: root,
      outputs: [join(output, `${String(index).padStart(2, "0")}-${value.id}.out`)],
    })),
  };
  return {
    root,
    state,
    manifest,
    hostEnv: {
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      TEMP: join(root, "temp"),
      USERPROFILE: join(root, "profile"),
    },
  };
}

async function expectProcessExit(pid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`process ${pid} is still running`);
}

function clock() {
  let value = 0;
  return () => new Date(value++ * 1000).toISOString();
}
