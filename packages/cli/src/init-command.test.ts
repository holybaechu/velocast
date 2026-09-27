import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createReactProject, initCommand } from "./init-command.js";
import { runCli } from "./cli.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

it("dispatches init to real filesystem creation without loading config or invoking setup", async () => {
  const cwd = await temporary(),
    target = join(cwd, "한국어 video");
  const write = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  const loadConfig = vi.fn(),
    setup = vi.fn();
  await runCli(["node", "velocast", "init", target, "--json"], {
    loadConfigFromPath: loadConfig,
    setupCommand: setup,
  });
  const result = JSON.parse(
    write.mock.calls.map((call) => String(call[0])).join(""),
  );
  expect(result.directory).toBe(target);
  expect(result.files).toContain("public/cover.svg");
  expect(
    JSON.parse(await readFile(join(target, "velocast-template.json"), "utf8")),
  ).toEqual({
    template: "react-static",
    templateVersion: 3,
    compositionId: "hello-react",
    width: 640,
    height: 360,
    fps: 30,
    durationFrames: 90,
  });
  expect(loadConfig).not.toHaveBeenCalled();
  expect(setup).not.toHaveBeenCalled();
});

it("preserves nonempty targets including hidden files and refuses a second init", async () => {
  const cwd = await temporary(),
    target = join(cwd, "existing");
  await mkdir(target);
  await writeFile(join(target, ".keep"), "user bytes");
  await expect(createReactProject(target)).rejects.toThrow(
    "init.target_not_empty",
  );
  expect(await readFile(join(target, ".keep"), "utf8")).toBe("user bytes");
  expect(await readdir(target)).toEqual([".keep"]);
  const generated = await createReactProject(join(cwd, "new"));
  const original = await readFile(join(generated.directory, "package.json"));
  await expect(createReactProject(generated.directory)).rejects.toThrow(
    "init.target_not_empty",
  );
  expect(await readFile(join(generated.directory, "package.json"))).toEqual(
    original,
  );
  expect(
    (await readdir(cwd)).some((name) => name.startsWith(".velocast-init-")),
  ).toBe(false);
});

it("accepts an existing empty directory and generates byte-identical repeatable template files", async () => {
  const cwd = await temporary();
  await mkdir(join(cwd, "empty"));
  const first = await createReactProject("empty", { cwd, env: {} });
  const second = await createReactProject("nested/other", {
    cwd: join(cwd, "empty"),
    env: { INIT_CWD: cwd },
  });
  expect(second.directory).toBe(join(cwd, "nested/other"));
  expect(second.files).toEqual(first.files);
  for (const file of first.files)
    expect(await readFile(join(first.directory, file))).toEqual(
      await readFile(join(second.directory, file)),
    );
  expect(
    (await readdir(cwd)).some((name) => name.startsWith(".velocast-init-")),
  ).toBe(false);
});

it("refuses file, blank, symlink/junction and symlink-ancestor destinations", async () => {
  const cwd = await temporary();
  const file = join(cwd, "file.txt");
  await writeFile(file, "original");
  await expect(createReactProject(file)).rejects.toThrow("init.invalid_target");
  await expect(createReactProject(" ")).rejects.toThrow("init.invalid_target");
  const outside = join(cwd, "outside");
  await mkdir(outside);
  await symlink(
    outside,
    join(cwd, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await expect(createReactProject(join(cwd, "linked"))).rejects.toThrow(
    "init.invalid_target",
  );
  await expect(createReactProject(join(cwd, "linked/child"))).rejects.toThrow(
    "init.invalid_target",
  );
  expect(await readFile(file, "utf8")).toBe("original");
  expect(await readdir(outside)).toEqual([]);
});

it("allows only one concurrent publisher and preserves its complete project", async () => {
  const cwd = await temporary(),
    target = join(cwd, "project");
  const results = await Promise.allSettled([
    createReactProject(target),
    createReactProject(target),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(
    1,
  );
  const succeeded = results.find((result) => result.status === "fulfilled");
  if (succeeded?.status !== "fulfilled")
    throw new Error("no project published");
  for (const file of succeeded.value.files)
    expect((await readFile(join(target, file))).byteLength).toBeGreaterThan(0);
  expect(
    (await readdir(cwd)).some((name) => name.startsWith(".velocast-init-")),
  ).toBe(false);
});

async function temporary() {
  const root = await mkdtemp(join(tmpdir(), "velocast-init-test-"));
  roots.push(root);
  return root;
}

it("creates the versioned static React starter without installing anything", async () => {
  const cwd = await temporary();
  const writes: string[] = [];
  const result = await initCommand(
    "my-video",
    { json: true },
    { pathOptions: { cwd, env: {} }, write: (text) => writes.push(text) },
  );
  const metadata = JSON.parse(
    await readFile(join(result.directory, "package.json"), "utf8"),
  );
  expect(metadata.dependencies).toMatchObject({
    "@velocast/react": "0.1.0",
    react: "18.3.1",
    "react-dom": "18.3.1",
  });
  expect(metadata.devDependencies).toMatchObject({
    velocast: "0.1.0",
    vite: "8.3.0",
  });
  expect(metadata.scripts.build).toBe("vite build");
  expect(metadata.scripts.preview).toBe(
    'npm run build && velocast preview --watch-command "vite build --watch"',
  );
  expect(metadata.scripts.render).toBe(
    "velocast render hello-react --output renders/hello-react.mp4",
  );
  expect(result).toMatchObject({
    template: "react-static",
    templateVersion: 3,
    compositionId: "hello-react",
    dependenciesInstalled: false,
  });
  expect(JSON.parse(writes.join(""))).toEqual(result);
  expect(await readdir(result.directory)).not.toContain("node_modules");
  const readme = await readFile(join(result.directory, "README.md"), "utf8");
  expect(readme).toContain("npm run preview");
  expect(readme).toContain("Refresh source");
  expect(readme).not.toContain("does not provide a playback/preview command");
  expect(
    await readFile(join(result.directory, "velocast.config.ts"), "utf8"),
  ).toContain('snapshotRoot: "dist"');
  expect(
    await readFile(join(result.directory, "src/main.jsx"), "utf8"),
  ).toContain("defineReactComposition({");
  expect(
    await readFile(join(result.directory, "public/cover.svg"), "utf8"),
  ).toContain("<svg");
});
