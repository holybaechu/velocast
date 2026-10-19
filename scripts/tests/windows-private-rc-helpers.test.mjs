import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
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
    join(repo, "scripts/release/windows-private-rc-concurrent-setup.mjs"),
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
  run(join(repo, "scripts/release/windows-private-rc-preview.mjs"), [
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
    join(repo, "scripts/release/windows-private-rc-negative.mjs"),
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
    join(repo, "scripts/release/windows-private-rc-negative.mjs"),
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

test("finalizer certifies software preference only from a completed off request and matching report", () => {
  const root = temp("velocast-finalize-software-");
  const evidence = join(root, "evidence"),
    runtime = join(root, "runtime");
  mkdirSync(evidence);
  mkdirSync(join(runtime, "electron-host"), { recursive: true });
  writeFileSync(
    join(runtime, "electron-host/media-client.cjs"),
    `
    exports.runMediaOperation = async ({kind, path}) => {
      if (kind === 'frame-hashes') return {frameCount:240, hashes:Array.from({length:240},(_,i)=>String(i))};
      const original = path.includes('original-lyrics');
      return {video:{codec:'avc',frameCount:original?240:12,duration:original?4:1.2},audio:{codec:'aac',sampleRate:48000,channels:2,duration:original?4:1.2}};
    };
  `,
  );
  const template = JSON.parse(
    readFileSync(join(repo, "release/windows-private-rc-run.template.json")),
  );
  const state = {
    steps: Object.fromEntries(
      template.steps.map(({ id }) => [id, { status: "complete" }]),
    ),
  };
  for (const [step, file, startFrame, endFrame] of [
    ["npm-original-lyrics", "npm-original-lyrics", 820, 1060],
    ["pnpm-clip-caption-music", "pnpm-clip-caption-music", 0, 12],
    ["npm-original-lyrics-repeat", "npm-original-lyrics-repeat", 820, 1060],
    ["software-preference", "pnpm-software-preference", 0, 12],
  ]) {
    writeFileSync(join(evidence, `${file}.mp4`), "fixture video");
    const stdout = join(evidence, `${step}.stdout.json`);
    writeFileSync(
      stdout,
      JSON.stringify({
        status: "success",
        request: { range: { startFrame, endFrame } },
      }),
    );
    state.steps[step].attempts = [{ stdout: { path: stdout } }];
  }
  for (const name of [
    "preview-browser",
    "negative-corrupt-archive",
    "negative-corrupt-cache",
    "negative-version-mismatch",
    "negative-cancel-render",
    "negative-offline-empty-cache",
    "concurrent-setup",
  ])
    writeFileSync(join(evidence, `${name}.json`), '{"status":"PASS"}');
  const requestPath = join(evidence, "software-request.json");
  state.steps["software-preference"].attempts[0].request = {
    path: requestPath,
  };
  const request = {
    argv: [
      process.execPath,
      "cli.js",
      "render",
      "scene",
      "--acceleration",
      "off",
    ],
  };
  const report = {
    webcodecs: {
      hardware_acceleration: "prefer-software",
      hardware_encoder_verified: false,
    },
    capture_backend: "electron_shared_texture",
    conversion_backend: "chromium_webcodecs",
    encoder_backend: "electron_webcodecs_h264",
    cpu_readback_frames: 0,
    frames_expected: 12,
    frames_rendered: 12,
    frames_encoded: 12,
  };
  const statePath = join(root, "state.json"),
    host = join(root, "host.json");
  writeFileSync(host, '{"validationStatus":"validated"}');
  const cases = [
    [
      "missing step",
      (value) => {
        delete value.state.steps["software-preference"];
      },
      /step is incomplete: software-preference/,
    ],
    [
      "wrong request",
      (value) => {
        value.request.argv[5] = "auto";
      },
      /software preference request/,
    ],
    [
      "overridden request",
      (value) => {
        value.request.argv.push("--acceleration=auto");
      },
      /software preference request/,
    ],
    [
      "wrong preference",
      (value) => {
        value.report.webcodecs.hardware_acceleration = "prefer-hardware";
      },
      /software preference report/,
    ],
    [
      "hardware claim",
      (value) => {
        value.report.webcodecs.hardware_encoder_verified = true;
      },
      /software preference report/,
    ],
    [
      "incomplete report",
      (value) => {
        value.report.frames_encoded = 11;
      },
      /software preference report/,
    ],
    ["matching evidence", () => {}, null],
  ];
  for (const [name, mutate, expected] of cases) {
    const value = structuredClone({ state, request, report });
    mutate(value);
    writeFileSync(statePath, JSON.stringify(value.state));
    writeFileSync(requestPath, JSON.stringify(value.request));
    writeFileSync(
      join(evidence, "pnpm-software-preference.report.json"),
      JSON.stringify(value.report),
    );
    const output = join(root, `${name}.json`);
    const result = spawnSync(
      process.execPath,
      [
        join(repo, "scripts/release/windows-private-rc-finalize.mjs"),
        "--root",
        root,
        "--state",
        statePath,
        "--runtime",
        runtime,
        "--host-requirements",
        host,
        "--output",
        output,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    if (expected) {
      assert.notEqual(result.status, 0, name);
      assert.match(result.stderr, expected, name);
      assert.equal(existsSync(output), false, name);
    } else {
      assert.equal(result.status, 0, result.stderr);
      const accepted = JSON.parse(readFileSync(output));
      assert.equal(accepted.scenarios.softwarePreference, true);
      assert.ok(
        accepted.videos.some(
          (video) =>
            video.role === "software-preference" && video.video.frames === 12,
        ),
      );
      assert.ok(
        accepted.notRunInThisGate.includes("hardware-encoder-selection-proof"),
      );
    }
  }
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
