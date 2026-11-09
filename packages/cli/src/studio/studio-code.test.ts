import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStudioServer } from "./studio-server.js";
import { normalizeConfigEntryFromConfigDir } from "../project/render-source.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const finish of cleanup.splice(0).reverse()) await finish();
});

const hash = (source: string) =>
  createHash("sha256").update(source).digest("hex");
async function fixture(source: string, receipt = true) {
  const cwd = await mkdtemp(join(tmpdir(), "velocast-code-"));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "dist"));
  await mkdir(join(cwd, "src"));
  await writeFile(join(cwd, "dist/index.html"), "<main>composition</main>");
  const path = join(cwd, "src/demo.tsx");
  await writeFile(path, source);
  if (receipt)
    await writeFile(
      join(cwd, "dist/_velocast-sources.json"),
      JSON.stringify({ version: 1, revisions: { demo: hash(source) } }),
    );
  const server = await createStudioServer(
    {
      entry: "dist/index.html",
      renderer: { snapshotRoot: "dist" },
      studio: { sources: { demo: "src/demo.tsx" } },
    },
    { pathOptions: { cwd, env: {} } },
  );
  cleanup.push(server.close);
  const get = async () =>
    (await fetch(server.url + "/api/code?compositionId=demo")).json();
  const post = async (value: object, route = "/api/code") =>
    fetch(server.url + route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        compositionId: "demo",
        expectedSourceVersion: server.session().session.sourceVersion,
        ...value,
      }),
    });
  return { cwd, path, server, get, post };
}

it("ties displayed source revisions to the active frozen receipt through staged refresh", async () => {
  const source = `import { Layer } from '@velocast/react'; export const Demo = () => <Layer id="title">Title</Layer>;`;
  const f = await fixture(source);
  const before = f.server.session();
  expect(before.codeRevisions).toEqual({ demo: hash(source) });
  expect(await f.get()).toMatchObject({
    revision: hash(source),
    displayedRevision: hash(source),
  });
  const saved = source + "\n// Comment-only source update\n";
  await writeFile(f.path, saved);
  await writeFile(
    join(f.cwd, "dist/_velocast-sources.json"),
    JSON.stringify({ version: 1, revisions: { demo: hash(saved) } }),
  );
  expect(await f.get()).toMatchObject({
    revision: hash(saved),
    displayedRevision: hash(source),
  });
  expect(
    (
      await (
        await fetch(new URL("/_velocast-sources.json", before.snapshotUrl))
      ).json()
    ).revisions.demo,
  ).toBe(hash(source));
  const prepared = await (
    await fetch(f.server.url + "/api/prepare-refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedSourceVersion: before.session.sourceVersion,
      }),
    })
  ).json();
  expect(prepared.codeRevisions).toEqual({ demo: hash(saved) });
  expect(f.server.session().codeRevisions).toEqual({ demo: hash(source) });
  expect(prepared.session.sourceVersion).not.toBe(before.session.sourceVersion);
  const committed = await fetch(f.server.url + "/api/commit-refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedSourceVersion: before.session.sourceVersion,
      candidateSessionId: prepared.session.sessionId,
    }),
  });
  expect(committed.status).toBe(200);
  expect(await f.get()).toMatchObject({ displayedRevision: hash(saved) });
  await writeFile(
    join(f.cwd, "dist/_velocast-sources.json"),
    JSON.stringify({ version: 1, revisions: { demo: "invalid" } }),
  );
  const invalid = await fetch(f.server.url + "/api/prepare-refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedSourceVersion: f.server.session().session.sourceVersion,
    }),
  });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({
    code: "studio.code_receipt_invalid",
  });
  expect(f.server.session().codeRevisions).toEqual({ demo: hash(saved) });
});

it("keeps source discovery available but blocks edits when the build has no source receipt", async () => {
  const f = await fixture(
    `import { Layer } from '@velocast/react'; export const Demo = () => <Layer id="title">Title</Layer>;`,
    false,
  );
  const source = await f.get();
  expect(source.enabled).toBe(true);
  expect(source.displayedRevision).toBeUndefined();
  const response = await f.post({
    expectedRevision: source.revision,
    edits: [{ id: "title", field: "text", value: "Changed" }],
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    code: "studio.code_build_untracked",
    message: expect.stringContaining("studioSourcePlugin"),
  });
});

it("waits for a build directory being replaced and preserves the displayed snapshot", async () => {
  const f = await fixture("export const value = 1;");
  const before = f.server.session();
  await rename(join(f.cwd, "dist"), join(f.cwd, "building"));
  const refresh = () =>
    fetch(f.server.url + "/api/prepare-refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedSourceVersion: before.session.sourceVersion,
      }),
    });
  const pending = await refresh();
  expect(pending.status).toBe(409);
  expect(await pending.json()).toMatchObject({
    code: "studio.build_in_progress",
  });
  expect(f.server.session().session).toEqual(before.session);
  expect((await fetch(before.snapshotUrl)).status).toBe(200);
  await rename(join(f.cwd, "building"), join(f.cwd, "dist"));
  expect((await refresh()).status).toBe(200);
});

it("discovers imported layer aliases and writes a guarded literal batch without changing custom code", async () => {
  const source = `import { Layer as Box } from '@velocast/react';\r\n// Keep this comment and formatting.\r\nexport function Demo() {\r\n  const animation = Math.sin(2);\r\n  return <Box id="title" x={40} opacity={animation}>Hello</Box>;\r\n}\r\n`;
  const f = await fixture(source);
  const before = await f.get();
  expect(before).toMatchObject({
    enabled: true,
    compositionId: "demo",
    path: f.path,
    canUndo: false,
    elements: [
      {
        id: "title",
        kind: "layer",
        fields: {
          x: { value: 40, editable: true },
          text: { value: "Hello", editable: true },
          opacity: { editable: false, reason: expect.any(String) },
        },
      },
    ],
  });
  const response = await f.post({
    expectedRevision: before.revision,
    edits: [
      { id: "title", field: "text", value: "New <title>" },
      { id: "title", field: "x", value: 64 },
    ],
  });
  expect(response.status).toBe(200);
  expect(await readFile(f.path, "utf8")).toBe(
    source
      .replace("x={40}", "x={64}")
      .replace(">Hello</Box>", '>{"New <title>"}</Box>'),
  );
  expect(await response.json()).toMatchObject({
    canUndo: true,
    elements: [
      { fields: { x: { value: 64 }, text: { value: "New <title>" } } },
    ],
  });
});

it("edits inline styles and absent props while keeping computed, spread, repeated and nested values read-only", async () => {
  const source = `import { Layer, Sequence } from '@velocast/react';
export const Demo = () => <>
  <Layer id="style" style={{ color: '#ffffff', opacity: fade }}>Title</Layer>
  <Layer id="spread" {...props}>Spread</Layer>
  {items.map(item => <Layer id="mapped">Item</Layer>)}
  <Sequence from={30}><Layer id="nested" x={12}>Nested</Layer></Sequence>
  <Sequence from={30}><Layer id="nested-self" /></Sequence>
  <Layer id="same">First</Layer><Layer id="same">Second</Layer>
</>;
`;
  const f = await fixture(source);
  const before = await f.get();
  const byId = (id: string) =>
    before.elements.find((item: { id: string }) => item.id === id);
  expect(byId("style").fields.opacity).toMatchObject({
    editable: false,
    reason: expect.stringContaining("style"),
  });
  for (const id of ["spread", "mapped", "nested", "nested-self", "same"])
    expect(byId(id).fields.x).toMatchObject({
      editable: false,
      reason: expect.any(String),
    });
  const saved = await f.post({
    expectedRevision: before.revision,
    edits: [
      { id: "style", field: "style.color", value: "#2255aa" },
      { id: "style", field: "style.fontSize", value: 42 },
      { id: "style", field: "x", value: -12 },
    ],
  });
  expect(saved.status).toBe(200);
  expect(await readFile(f.path, "utf8")).toContain("opacity: fade");
  expect((await saved.json()).elements[0].fields).toMatchObject({
    "style.color": { value: "#2255aa" },
    "style.fontSize": { value: 42 },
    x: { value: -12 },
  });
  const current = await f.get();
  const rejected = await f.post({
    expectedRevision: current.revision,
    edits: [
      { id: "style", field: "x", value: 100 },
      { id: "mapped", field: "text", value: "Unsafe" },
    ],
  });
  expect(rejected.status).toBe(400);
  expect((await f.get()).revision).toBe(current.revision);
});

it("edits shared media timing and a sole StillImage source without rewriting other media code", async () => {
  const source = `import { Layer as Box, StillImage as Picture, createMediaTimeline as timeline } from '@velocast/react';
const media = timeline(video, [{ id: 'voice', kind: 'audio', src: 'assets/voice.wav', from: 0, durationFrames: 60, gain: 0.5 }, { id: 'clip', kind: 'video', src: computedSource, from: 0, durationFrames: 60 }]);
const unknown = timeline(video, [...clips, { id: 'tail', kind: 'audio', src: 'assets/tail.wav', durationFrames: 60 }]);
export const Demo = () => <Box id="photo"><Picture src="assets/old.png" /></Box>;
`;
  const f = await fixture(source);
  const before = await f.get();
  expect(
    before.elements.find((item: { id: string }) => item.id === "voice"),
  ).toMatchObject({
    kind: "audio",
    fields: {
      from: { value: 0, editable: true },
      gain: { value: 0.5, editable: true },
    },
  });
  expect(
    before.elements.find((item: { id: string }) => item.id === "clip").fields
      .src,
  ).toMatchObject({ editable: false, reason: expect.any(String) });
  const result = await f.post({
    expectedRevision: before.revision,
    edits: [
      { id: "voice", field: "from", value: -3 },
      { id: "voice", field: "trimBeforeFrames", value: 6 },
      { id: "voice", field: "muted", value: true },
      { id: "photo", field: "image.src", value: "assets/new.png" },
    ],
  });
  expect(
    before.elements.find((item: { id: string }) => item.id === "tail").fields
      .src.editable,
  ).toBe(false);
  expect(result.status).toBe(200);
  const saved = await result.json();
  expect(
    saved.elements.find((item: { id: string }) => item.id === "voice").fields,
  ).toMatchObject({
    from: { value: -3 },
    trimBeforeFrames: { value: 6 },
    muted: { value: true },
  });
  expect(
    saved.elements.find((item: { id: string }) => item.id === "photo").fields[
      "image.src"
    ],
  ).toMatchObject({ value: "assets/new.png", editable: true });
  expect(await readFile(f.path, "utf8")).toContain("src: computedSource");
});

it("protects shadowed and duplicate bindings and preserves trailing commas followed by comments", async () => {
  const source = `import { Layer } from '@velocast/react';
import type { Layer as TypeLayer } from '@velocast/react';
function Shadow(Layer) { return <Layer id="shadow" x={1}>Custom</Layer>; }
function Card() { return <Layer id="reused">Card</Layer>; }
function Row() { return <Layer id="callback">Row</Layer>; }
export const Demo = () => <>
  <Layer id="duplicate" x={1} x={2}>Duplicate</Layer>
  <Layer id="styles" style={{ color: 'red', color: 'blue' }}>Duplicate style</Layer>
  <Layer id="safe" style={{ color: 'red', /* preserve this comment */ }}>Safe</Layer>
  <Card/><Card/><TypeLayer id="type-only" />
  {items.map(Row)}
</>;
`;
  const f = await fixture(source);
  const before = await f.get();
  for (const id of ["shadow", "duplicate", "reused", "callback"])
    expect(
      before.elements.find((item: { id: string }) => item.id === id).fields.x
        .editable,
    ).toBe(false);
  expect(
    before.elements.find((item: { id: string }) => item.id === "styles").fields[
      "style.color"
    ].editable,
  ).toBe(false);
  expect(
    before.elements.some((item: { id: string }) => item.id === "type-only"),
  ).toBe(false);
  const response = await f.post({
    expectedRevision: before.revision,
    edits: [{ id: "safe", field: "style.fontSize", value: 24 }],
  });
  expect(response.status).toBe(200);
  expect(await readFile(f.path, "utf8")).toContain(
    "color: 'red', /* preserve this comment */  fontSize: 24 }",
  );
});

it("restores exact source bytes through history, rejects stale writes, and diagnoses external syntax failures", async () => {
  const original = `import { Layer } from '@velocast/react';\r\nexport const Demo = () => <Layer id="title" x={2}>Original</Layer>;\r\n`;
  const f = await fixture(original);
  const before = await f.get();
  const saved = await (
    await f.post({
      expectedRevision: before.revision,
      edits: [{ id: "title", field: "text", value: "Edited" }],
    })
  ).json();
  const undone = await f.post(
    { expectedRevision: saved.revision, action: "undo" },
    "/api/code/history",
  );
  expect(undone.status).toBe(200);
  expect(await readFile(f.path, "utf8")).toBe(original);
  expect(await undone.json()).toMatchObject({ canUndo: false, canRedo: true });
  const redone = await f.post(
    { expectedRevision: (await f.get()).revision, action: "redo" },
    "/api/code/history",
  );
  const prior = await redone.json();
  await writeFile(f.path, original.replace("Original", "External"));
  const conflict = await f.post({
    expectedRevision: prior.revision,
    edits: [{ id: "title", field: "x", value: 50 }],
  });
  expect(conflict.status).toBe(409);
  expect(await f.get()).toMatchObject({
    canUndo: true,
    canRedo: false,
    elements: [{ fields: { text: { value: "External" } } }],
  });
  await writeFile(f.path, "export const broken = <");
  const invalid = await fetch(f.server.url + "/api/code?compositionId=demo");
  expect(invalid.status).toBe(200);
  expect(await invalid.json()).toMatchObject({
    syntaxError: expect.stringContaining("demo.tsx:1"),
    canUndo: true,
    elements: [],
  });
  await writeFile(f.path, original);
  expect(await f.get()).toMatchObject({
    canUndo: true,
    canRedo: false,
    elements: [{ fields: { text: { value: "Original" } } }],
  });
  const staleSource = await f.post({
    expectedSourceVersion: "stale",
    expectedRevision: (await f.get()).revision,
    edits: [{ id: "title", field: "x", value: 50 }],
  });
  expect(staleSource.status).toBe(409);
});

it("limits writable sources to explicit distinct regular files within the config directory", async () => {
  const f = await fixture("export const value = 1;");
  await mkdir(join(f.cwd, "config"));
  expect(() =>
    normalizeConfigEntryFromConfigDir(
      { studio: { sources: { demo: "../src/demo.tsx" } } },
      join(f.cwd, "config"),
    ),
  ).toThrow("inside the config directory");
  expect(() =>
    normalizeConfigEntryFromConfigDir(
      {
        studio: { sources: { first: "src/demo.tsx", second: "src/demo.tsx" } },
      },
      f.cwd,
    ),
  ).toThrow("own editable source file");
  expect(() =>
    normalizeConfigEntryFromConfigDir(
      { studio: { sources: { demo: "src/missing.tsx" } } },
      f.cwd,
    ),
  ).toThrow("missing.tsx");
  const response = await f.post({
    expectedRevision: (await f.get()).revision,
    path: "src/other.tsx",
    edits: [],
  });
  expect(response.status).toBe(400);
});

it("edits bounded layer keyframes through guarded source writes and durable undo", async () => {
  const original = `import {Layer} from '@velocast/react';\n// Human note stays here\nexport const Demo = () => <Layer id="title" x={7} opacity={1}>Title</Layer>;`;
  const f = await fixture(original);
  const track = JSON.stringify({
    keyframes: [
      { frame: 0, value: 0 },
      { frame: 15, value: 1 },
    ],
    easing: "easeOut",
  });
  const response = await f.post({
    expectedRevision: (await f.get()).revision,
    edits: [{ id: "title", field: "animation.opacity", value: track }],
  });
  expect(response.status).toBe(200);
  const animated = await response.json();
  expect(animated.elements[0].fields["animation.opacity"]).toEqual({
    value: track,
    editable: true,
  });
  expect(animated.elements[0].fields.opacity.editable).toBe(false);
  expect(await readFile(f.path, "utf8")).toContain("// Human note stays here");
  const bytes = await readFile(f.path, "utf8");
  const invalid = await f.post({
    expectedRevision: animated.revision,
    edits: [
      {
        id: "title",
        field: "animation.opacity",
        value: JSON.stringify({
          keyframes: [
            { frame: 0, value: 0 },
            { frame: 15, value: 2 },
          ],
        }),
      },
    ],
  });
  expect(invalid.status).toBe(400);
  expect(await readFile(f.path, "utf8")).toBe(bytes);
  const removed = await f.post({
    expectedRevision: animated.revision,
    edits: [{ id: "title", field: "animation.opacity", value: "null" }],
  });
  expect(removed.status).toBe(200);
  const plain = await removed.json();
  expect(plain.elements[0].fields.opacity.editable).toBe(true);
  const undo = await f.post(
    { expectedRevision: plain.revision, action: "undo" },
    "/api/code/history",
  );
  expect(undo.status).toBe(200);
  expect(await readFile(f.path, "utf8")).toBe(bytes);
});

it("preserves computed motion and style overrides when an animation write is refused", async () => {
  const original = `import {Layer} from '@velocast/react'; const track = customMotion();
export const Demo = () => <><Layer id="computed" animation={{opacity: track}}>Custom</Layer>
<Layer id="styled" style={{opacity: 0.5}}>Style-owned</Layer></>;`;
  const f = await fixture(original);
  const source = await f.get();
  for (const id of ["computed", "styled"]) {
    const response = await f.post({
      expectedRevision: source.revision,
      edits: [{ id, field: "animation.opacity", value: "null" }],
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "studio.code_readonly",
    });
    expect(await readFile(f.path, "utf8")).toBe(original);
  }
});

it("rejects a configured directory replaced by a symbolic link after the session starts", async () => {
  const f = await fixture("export const value = 1;");
  const revision = (await f.get()).revision;
  await mkdir(join(f.cwd, "other"));
  await writeFile(
    join(f.cwd, "other/demo.tsx"),
    "export const untouched = true;",
  );
  await rename(join(f.cwd, "src"), join(f.cwd, "original-src"));
  await symlink(join(f.cwd, "other"), join(f.cwd, "src"), "junction");
  const response = await f.post({
    expectedRevision: revision,
    edits: [{ id: "anything", field: "text", value: "Changed" }],
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: "studio.code_path" });
  expect(await readFile(join(f.cwd, "other/demo.tsx"), "utf8")).toBe(
    "export const untouched = true;",
  );
});
