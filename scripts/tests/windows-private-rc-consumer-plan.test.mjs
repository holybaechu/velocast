import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const plan = JSON.parse(
  readFileSync(join(root, "release/windows-private-rc-consumer-plan.json")),
);

test("private RC plan isolates runtime resolution and cannot publish", () => {
  assert.equal(plan.status, "prepared-not-executed");
  assert.equal(plan.publication.upload, false);
  assert.equal(plan.publication.publicRelease, false);
  assert.equal(plan.publication.supportedManifestFlip, false);
  for (const name of [
    "VELOCAST_RENDERER_BINARY",
    "VELOCAST_ARTIFACT_DIR",
    "CARGO_TARGET_DIR",
    "CEF_PATH",
    "FFMPEG_PATH",
    "VCPKG_ROOT",
    "LIBCLANG_PATH",
  ])
    assert.ok(plan.minimalEnvironment.mustBeAbsent.includes(name), name);
  assert.match(plan.minimalEnvironment.set.PATH, /NODE_EXE/);
  assert.doesNotMatch(plan.minimalEnvironment.set.PATH, /vcpkg|cargo|ffmpeg/i);
});

test("private RC plan covers release and preview acceptance boundaries", () => {
  const commands = new Set(plan.commands.map((command) => command.id));
  for (const id of [
    "fresh-setup",
    "cached-setup",
    "offline-setup",
    "concurrent-setup",
    "frame-output",
    "full-240-frame-output",
    "deterministic-repeat",
    "software-fallback",
    "preview-session",
  ])
    assert.ok(commands.has(id), id);
  const negatives = new Set(
    plan.negativeScenarios.map((scenario) => scenario.id),
  );
  for (const id of [
    "corrupt-archive",
    "corrupt-cache",
    "version-mismatch",
    "cancel-render",
    "offline-empty-cache",
  ])
    assert.ok(negatives.has(id), id);
  assert.equal(plan.acceptance.frames, 240);
  assert.deepEqual(plan.acceptance.originalLyricsSourceRange, {
    start: 820,
    end: 1060,
    reason:
      "Representative four-second range includes known lyric transitions near frames 847 and 887 while preserving the 13,488-frame source identity.",
  });
  assert.deepEqual(plan.acceptance.packageManagers, ["npm", "pnpm"]);
});

test("runnable template binds repository helpers and leaves only final inputs pending", () => {
  const run = JSON.parse(
    readFileSync(join(root, "release/windows-private-rc-run.template.json")),
  );
  const serialized = JSON.stringify(run);
  for (const helper of [
    "windows-private-rc-concurrent-setup.mjs",
    "windows-private-rc-preview.mjs",
    "windows-private-rc-negative.mjs",
    "windows-private-rc-finalize.mjs",
  ])
    assert.match(serialized, new RegExp(helper.replaceAll(".", "\\.")));
  for (const obsolete of [
    "<CONCURRENT_SETUP_HARNESS>",
    "<PREVIEW_BROWSER_HARNESS>",
    "<NEGATIVE_HARNESS>",
    "<FINAL_VERIFY_HARNESS>",
  ])
    assert.doesNotMatch(serialized, new RegExp(obsolete.replace(/[<>]/g, "\\$&")));
  for (const pending of [
    "<FINAL_RUNTIME_DIR>",
    "<FINAL_ARTIFACT_ARCHIVE>",
    "<FINAL_HOST_REQUIREMENTS>",
  ])
    assert.match(serialized, new RegExp(pending.replace(/[<>]/g, "\\$&")));
  const lyrics = run.steps.find((step) => step.id === "npm-original-lyrics");
  const start = lyrics.argv.indexOf("--start-frame");
  const end = lyrics.argv.indexOf("--end-frame");
  assert.equal(lyrics.argv[start + 1], "820");
  assert.equal(lyrics.argv[end + 1], "1060");
});
