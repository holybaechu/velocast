import { afterEach, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStudioServer,
  type StudioServerDependencies,
} from "./studio-server.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

async function fixture(
  inputProps: unknown = { title: "First" },
  dependencies: StudioServerDependencies = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), "velocast-project-server-"));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "dist"));
  await writeFile(join(cwd, "dist/index.html"), "<main>project</main>");
  await writeFile(join(cwd, "project.json"), JSON.stringify(inputProps));
  const server = await createStudioServer(
    {
      entry: "dist/index.html",
      inputPropsFile: "project.json",
      renderer: { snapshotRoot: "dist" },
    },
    { pathOptions: { cwd, env: {} } },
    dependencies,
  );
  cleanup.push(server.close);
  const get = async (path: string) => (await fetch(server.url + path)).json();
  const post = (path: string, value: unknown) =>
    fetch(server.url + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    });
  const request = async () => ({
    expectedSourceVersion: server.session().session.sourceVersion,
    expectedRevision: (await get("/api/inputs")).revision,
  });
  return { cwd, server, get, post, request };
}

const project = () => ({
  format: "velocast-project",
  version: 1,
  name: "Demo",
  assets: [],
  compositions: [
    {
      id: "demo",
      name: "Demo",
      width: 640,
      height: 360,
      fps: 30,
      durationFrames: 300,
      background: "#ffffff",
      scenes: [
        {
          id: "intro",
          name: "Intro",
          from: 0,
          durationFrames: 300,
          background: "#ffffff",
        },
      ],
      layers: [],
    },
  ],
});

it("shares persisted undo and redo across clients and invalidates history after a direct source edit", async () => {
  const f = await fixture();
  expect(await f.get("/api/inputs")).toMatchObject({
    enabled: true,
    inputProps: { title: "First" },
  });
  expect(
    (
      await f.post("/api/inputs", {
        ...(await f.request()),
        inputProps: { title: "Second" },
      })
    ).status,
  ).toBe(200);
  expect(await f.get("/api/history")).toEqual({
    canUndo: true,
    canRedo: false,
  });
  const undone = await f.post("/api/history", {
    ...(await f.request()),
    action: "undo",
  });
  expect(undone.status).toBe(200);
  expect(await undone.json()).toMatchObject({ inputProps: { title: "First" } });
  expect(await f.get("/api/history")).toEqual({
    canUndo: false,
    canRedo: true,
  });
  const redone = await f.post("/api/history", {
    ...(await f.request()),
    action: "redo",
  });
  expect(await redone.json()).toMatchObject({
    inputProps: { title: "Second" },
  });
  await writeFile(
    join(f.cwd, "project.json"),
    JSON.stringify({ title: "External" }),
  );
  expect(await f.get("/api/history")).toEqual({
    canUndo: false,
    canRedo: false,
  });
  expect(
    (await f.post("/api/history", { ...(await f.request()), action: "undo" }))
      .status,
  ).toBe(409);
  expect(await f.get("/api/inputs")).toMatchObject({
    inputProps: { title: "External" },
  });
});

it("validates project saves before publication and accepts useful project-sized inputs", async () => {
  const f = await fixture(project());
  const invalid = project();
  invalid.compositions[0]!.scenes[0]!.durationFrames = 301;
  const failed = await f.post("/api/inputs", {
    ...(await f.request()),
    inputProps: invalid,
  });
  expect(failed.status).toBe(400);
  expect(await failed.json()).toMatchObject({
    code: "studio.invalid_project",
    message: expect.stringContaining("scenes"),
  });
  expect((await f.get("/api/inputs")).inputProps).toEqual(project());
  expect(await f.get("/api/history")).toEqual({
    canUndo: false,
    canRedo: false,
  });
  const large = { ...project(), name: "Project ".repeat(1200) };
  expect(
    (await f.post("/api/inputs", { ...(await f.request()), inputProps: large }))
      .status,
  ).toBe(200);
});

it("imports local images without native tools, retains them through undo, and rejects unsupported paths", async () => {
  const f = await fixture(project());
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6xKcAAAAASUVORK5CYII=",
    "base64",
  );
  const query = new URLSearchParams({
    ...(await f.request()),
    name: "Product screen.png",
  });
  const response = await fetch(`${f.server.url}/api/assets?${query}`, {
    method: "POST",
    body: png,
  });
  expect(response.status).toBe(200);
  const saved = await response.json();
  expect(saved.inputProps.assets).toEqual([
    expect.objectContaining({
      id: expect.any(String),
      kind: "image",
      name: "Product screen.png",
      src: expect.stringMatching(/^assets\/[a-zA-Z0-9._-]+\.png$/),
    }),
  ]);
  const asset = saved.inputProps.assets[0];
  expect(await readFile(join(f.cwd, "public", asset.src))).toEqual(png);
  await f.post("/api/history", { ...(await f.request()), action: "undo" });
  expect((await f.get("/api/inputs")).inputProps.assets).toEqual([]);
  expect(await readFile(join(f.cwd, "public", asset.src))).toEqual(png);
  const rejected = await fetch(
    `${f.server.url}/api/assets?${new URLSearchParams({ ...(await f.request()), name: "../escape.exe" })}`,
    { method: "POST", body: png },
  );
  expect(rejected.status).toBe(400);
  expect(await readdir(join(f.cwd, "public/assets"))).toEqual([
    asset.src.slice(7),
  ]);
});

it.each([false, true])(
  "persists probed video audio presence (hasAudio=%s)",
  async (hasAudio) => {
    const f = await fixture(project(), {
      probeAsset: async () => ({
        duration: 2,
        video: {
          width: 320,
          height: 180,
          codedWidth: 320,
          codedHeight: 180,
          rotation: 0,
          codec: "h264",
          timeBase: { numerator: 1, denominator: 30 },
        },
        ...(hasAudio
          ? { audio: { sampleRate: 48000, channels: 2, duration: 2 } }
          : {}),
      }),
    });
    const query = new URLSearchParams({
      ...(await f.request()),
      name: "clip.mp4",
    });
    const response = await fetch(`${f.server.url}/api/assets?${query}`, {
      method: "POST",
      body: Buffer.from("video"),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).inputProps.assets).toEqual([
      expect.objectContaining({
        kind: "video",
        hasAudio,
        durationSeconds: 2,
        width: 320,
        height: 180,
      }),
    ]);
    expect((await f.get("/api/inputs")).inputProps.assets[0].hasAudio).toBe(
      hasAudio,
    );
  },
);

it("rolls back only its imported media when another writer changes the project during probing", async () => {
  let projectPath = "";
  const external = { ...project(), name: "Changed elsewhere" };
  const f = await fixture(project(), {
    probeAsset: async () => {
      await writeFile(projectPath, JSON.stringify(external));
      return {
        duration: 2,
        audio: { sampleRate: 48000, channels: 2, duration: 2 },
      };
    },
  });
  projectPath = join(f.cwd, "project.json");
  await mkdir(join(f.cwd, "public/assets"), { recursive: true });
  await writeFile(join(f.cwd, "public/assets/kept.png"), "existing asset");
  const query = new URLSearchParams({
    ...(await f.request()),
    name: "narration.wav",
  });
  const response = await fetch(`${f.server.url}/api/assets?${query}`, {
    method: "POST",
    body: Buffer.from("audio"),
  });
  expect(response.status).toBe(409);
  expect(await readdir(join(f.cwd, "public/assets"))).toEqual(["kept.png"]);
  expect(await readFile(join(f.cwd, "public/assets/kept.png"), "utf8")).toBe(
    "existing asset",
  );
  expect((await f.get("/api/inputs")).inputProps).toEqual(external);
  expect(await f.get("/api/history")).toEqual({
    canUndo: false,
    canRedo: false,
  });
});

it("keeps source identity and saved inputs stable while importing media, then exposes probe metadata", async () => {
  let started!: () => void;
  let release!: () => void;
  const probing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(project(), {
    probeAsset: async () => {
      started();
      await held;
      return {
        duration: 2,
        audio: { sampleRate: 48000, channels: 2, duration: 2 },
      };
    },
  });
  cleanup.push(async () => release());
  const guard = await f.request();
  const query = new URLSearchParams({ ...guard, name: "voice.wav" });
  const upload = fetch(`${f.server.url}/api/assets?${query}`, {
    method: "POST",
    body: Buffer.from("audio"),
  });
  await probing;
  expect(
    (
      await f.post("/api/prepare-refresh", {
        expectedSourceVersion: guard.expectedSourceVersion,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await f.post("/api/inputs", {
        ...guard,
        inputProps: { ...project(), name: "Concurrent" },
      })
    ).status,
  ).toBe(409);
  expect(f.server.session().session.sourceVersion).toBe(
    guard.expectedSourceVersion,
  );
  release();
  const imported = await upload;
  expect(imported.status).toBe(200);
  expect((await imported.json()).inputProps.assets).toEqual([
    expect.objectContaining({ kind: "audio", durationSeconds: 2 }),
  ]);
  const refreshed = await f.post("/api/refresh", {
    expectedSourceVersion: guard.expectedSourceVersion,
  });
  expect(refreshed.status).toBe(200);
  expect((await refreshed.json()).session.sourceVersion).not.toBe(
    guard.expectedSourceVersion,
  );
});

it("joins a cancelled media probe and removes its uncommitted copy during session shutdown", async () => {
  let started!: () => void;
  const probing = new Promise<void>((resolve) => {
    started = resolve;
  });
  let stopped = false;
  const f = await fixture(project(), {
    probeAsset: async (_path, signal) => {
      started();
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            stopped = true;
            reject(signal.reason);
          },
          { once: true },
        );
        signal.throwIfAborted();
      });
    },
  });
  const query = new URLSearchParams({
    ...(await f.request()),
    name: "voice.wav",
  });
  const upload = fetch(`${f.server.url}/api/assets?${query}`, {
    method: "POST",
    body: Buffer.from("audio"),
  }).catch(() => undefined);
  await probing;
  await f.server.close();
  await upload;
  expect(stopped).toBe(true);
  expect(await readdir(join(f.cwd, "public/assets"))).toEqual([]);
  expect(
    JSON.parse(await readFile(join(f.cwd, "project.json"), "utf8")),
  ).toEqual(project());
});
