import { afterEach, expect, it, vi } from "vitest";
import * as files from "node:fs/promises";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudioCodeStore } from "./studio-code-store.js";
import { normalizeStudioConfig } from "./studio-code-config.js";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

it("preserves an external file created while a source edit is being published", async () => {
  const f = await fixture();
  const before = await f.store.read("demo");
  const external = original.replace("Original", "External writer");
  const rename = files.rename;
  vi.spyOn(files, "rename").mockImplementation(async (from, to) => {
    if (from === f.path) {
      await rename(from, to);
      await writeFile(f.path, external, { flag: "wx" });
      return;
    }
    if (to === f.path) await writeFile(f.path, external);
    await rename(from, to);
  });
  await expect(
    f.store.edit("demo", before.revision, [
      { id: "title", field: "text", value: "Studio edit" },
    ]),
  ).rejects.toMatchObject({ code: "studio.code_conflict" });
  expect(await readFile(f.path, "utf8")).toBe(external);
});

const original = `import { Layer } from '@velocast/react';\r\nexport const Demo = () => <Layer id="title">Original</Layer>;\r\n`;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "velocast-code-store-"));
  roots.push(root);
  const path = join(root, "demo.tsx");
  await writeFile(path, original);
  const create = () =>
    new StudioCodeStore(root, { demo: path }, new AbortController().signal);
  return { root, path, create, store: create() };
}

it("retains exact undo and redo bytes after restarting the source store", async () => {
  const f = await fixture();
  const before = await f.store.read("demo");
  const changed = await f.store.edit("demo", before.revision, [
    { id: "title", field: "text", value: "Changed" },
  ]);
  const saved = await readFile(f.path, "utf8");
  const restarted = f.create();
  expect(await restarted.read("demo")).toMatchObject({ canUndo: true });
  const undone = await restarted.history("demo", changed.revision, "undo");
  expect(await readFile(f.path, "utf8")).toBe(original);
  expect(undone.canRedo).toBe(true);
  await f.create().history("demo", undone.revision, "redo");
  expect(await readFile(f.path, "utf8")).toBe(saved);
});

it("gives one source writer ownership across separate store instances", async () => {
  const f = await fixture();
  const before = await f.store.read("demo");
  let captureStarted!: () => void;
  let release!: () => void;
  const captured = new Promise<void>((resolve) => {
    captureStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const rename = files.rename;
  let held = false;
  vi.spyOn(files, "rename").mockImplementation(async (from, to) => {
    if (from === f.path && !held) {
      held = true;
      captureStarted();
      await released;
    }
    await rename(from, to);
  });
  const first = f.store.edit("demo", before.revision, [
    { id: "title", field: "text", value: "First writer" },
  ]);
  await captured;
  try {
    await expect(f.create().recover("demo")).rejects.toMatchObject({
      code: "studio.code_busy",
    });
    await expect(
      f
        .create()
        .edit("demo", before.revision, [
          { id: "title", field: "text", value: "Second writer" },
        ]),
    ).rejects.toMatchObject({ code: "studio.code_busy" });
  } finally {
    release();
    await first.catch(() => {});
  }
  const saved = await f.create().read("demo");
  await f.create().history("demo", saved.revision, "undo");
  expect(await readFile(f.path, "utf8")).toBe(original);
});

it("restores a retained source after publication and immediate restoration both fail", async () => {
  const f = await fixture();
  const before = await f.store.read("demo");
  const failure = Object.assign(new Error("publication interrupted"), {
    code: "EIO",
  });
  const link = files.link;
  vi.spyOn(files, "link").mockImplementation(async (from, to) => {
    if (to === f.path) throw failure;
    await link(from, to);
  });
  await expect(
    f.store.edit("demo", before.revision, [
      { id: "title", field: "text", value: "Unpublished" },
    ]),
  ).rejects.toMatchObject({ code: "studio.code_recovery_required" });
  await expect(readFile(f.path)).rejects.toMatchObject({ code: "ENOENT" });
  vi.restoreAllMocks();
  expect(await f.create().read("demo")).toMatchObject({
    recoveryRequired: true,
  });
  expect(await f.create().recover("demo")).toMatchObject({
    recoveryRequired: false,
  });
  expect(await readFile(f.path, "utf8")).toBe(original);
});

it("keeps observed external changes undoable and allows guarded full-source repair", async () => {
  const f = await fixture();
  const before = await f.store.readSource("demo");
  expect(before.source).toBe(original);
  const replacement = original.replace("Original", "Agent revision");
  const saved = await f.store.replace("demo", before.revision, replacement);
  await writeFile(f.path, "export const broken = <");
  const broken = await f.create().readSource("demo");
  expect(broken).toMatchObject({
    source: "export const broken = <",
    canUndo: true,
    syntaxError: expect.stringContaining("demo.tsx:1"),
  });
  await expect(
    f.store.replace("demo", saved.revision, original),
  ).rejects.toMatchObject({ code: "studio.code_conflict" });
  const restored = await f.create().history("demo", broken.revision, "undo");
  expect(await readFile(f.path, "utf8")).toBe(replacement);
  const redone = await f.create().history("demo", restored.revision, "redo");
  expect(redone).toMatchObject({
    syntaxError: expect.stringContaining("demo.tsx:1"),
    canUndo: true,
  });
  expect(await readFile(f.path, "utf8")).toBe("export const broken = <");
  const repaired = await f.store.replace("demo", redone.revision, replacement);
  await expect(
    f.store.replace("demo", repaired.revision, "export const broken = <"),
  ).rejects.toMatchObject({ code: "studio.code_syntax" });
  expect(await readFile(f.path, "utf8")).toBe(replacement);
});

it("recovers a source captured by an abruptly stopped writer without stealing a live lock", async () => {
  const f = await fixture();
  const worker = join(f.root, "writer.mjs");
  await writeFile(
    worker,
    `
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
const path = ${JSON.stringify(f.path)};
const rename = fs.rename;
fs.rename = async (from, to) => { await rename(from, to); if (from === path) process.exit(17); };
syncBuiltinESMExports();
const {StudioCodeStore} = await import(${JSON.stringify(new URL("./studio-code-store.ts", import.meta.url).href)});
const store = new StudioCodeStore(${JSON.stringify(f.root)}, {demo:path}, new AbortController().signal);
const before = await store.read('demo');
await store.replace('demo', before.revision, ${JSON.stringify(original.replace("Original", "Child edit"))});
process.exit(3);
`,
  );
  const child = spawn(
    process.execPath,
    [
      "--import",
      new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).href,
      worker,
    ],
    { stdio: "pipe", windowsHide: true, timeout: 5000 },
  );
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  expect(code, stderr).toBe(17);
  await expect(readFile(f.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(() =>
    normalizeStudioConfig({ sources: { demo: "demo.tsx" } }, f.root),
  ).not.toThrow();
  expect(await f.create().read("demo")).toMatchObject({
    recoveryRequired: true,
  });
  const recovered = await f.create().recover("demo");
  expect(recovered).toMatchObject({
    recoveryAction: "restored-source",
    recoveryRequired: false,
  });
  expect(await readFile(f.path, "utf8")).toBe(original);
}, 10000);

it("finishes a published edit after history publication fails, without duplicating undo", async () => {
  const f = await fixture();
  const before = await f.store.read("demo");
  const after = original.replace("Original", "Published");
  const rename = files.rename;
  let captured = false;
  vi.spyOn(files, "rename").mockImplementation(async (from, to) => {
    if (captured && to === join(before.recoveryPath!, "history.json"))
      throw Object.assign(new Error("history publication failed"), {
        code: "EIO",
      });
    await rename(from, to);
    if (from === f.path) captured = true;
  });
  await expect(f.store.replace("demo", before.revision, after)).rejects.toThrow(
    "history publication failed",
  );
  expect(await readFile(f.path, "utf8")).toBe(after);
  vi.restoreAllMocks();
  expect(await f.create().read("demo")).toMatchObject({
    recoveryRequired: true,
  });
  const recovered = await f.create().recover("demo");
  expect(recovered).toMatchObject({
    recoveryAction: "completed-edit",
    canUndo: true,
  });
  const undone = await f.create().history("demo", recovered.revision, "undo");
  expect(undone.canUndo).toBe(false);
  expect(await readFile(f.path, "utf8")).toBe(original);
});

it("restores captured source and releases ownership when cancelled before publication", async () => {
  const f = await fixture();
  const abort = new AbortController();
  const store = new StudioCodeStore(f.root, { demo: f.path }, abort.signal);
  const before = await store.read("demo");
  const rename = files.rename;
  vi.spyOn(files, "rename").mockImplementation(async (from, to) => {
    await rename(from, to);
    if (from === f.path) abort.abort();
  });
  await expect(
    store.replace(
      "demo",
      before.revision,
      original.replace("Original", "Cancelled"),
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(await readFile(f.path, "utf8")).toBe(original);
  expect(await f.create().read("demo")).toMatchObject({
    canUndo: false,
    recoveryRequired: false,
  });
});

it("refuses corrupt history and redirected history directories without touching source", async () => {
  const f = await fixture();
  const before = await f.store.read("demo");
  await writeFile(
    join(before.recoveryPath!, "history.json"),
    "{ broken history",
  );
  await expect(
    f.store.replace(
      "demo",
      before.revision,
      original.replace("Original", "Changed"),
    ),
  ).rejects.toMatchObject({ code: "studio.code_history_invalid" });
  expect(await readFile(f.path, "utf8")).toBe(original);
  const redirected = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "velocast-code-outside-"));
  roots.push(outside);
  await symlink(outside, join(redirected.root, ".velocast"), "junction");
  await expect(redirected.store.read("demo")).rejects.toMatchObject({
    code: "studio.code_history_path",
  });
  expect(await files.readdir(outside)).toEqual([]);
});

it("retains the last fifty edits with exact undo and rejects older history", async () => {
  const f = await fixture();
  let state = await f.store.read("demo");
  for (let i = 1; i <= 51; i++)
    state = await f.store.replace(
      "demo",
      state.revision,
      original.replace("Original", `Edit ${i}`),
    );
  const restarted = f.create();
  for (let i = 0; i < 50; i++)
    state = await restarted.history("demo", state.revision, "undo");
  expect(await readFile(f.path, "utf8")).toBe(
    original.replace("Original", "Edit 1"),
  );
  expect(state).toMatchObject({ canUndo: false, canRedo: true });
  await expect(
    restarted.history("demo", state.revision, "undo"),
  ).rejects.toMatchObject({ code: "studio.code_history_empty" });
}, 20000);
