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
import { createProject, initCommand } from "./init-command.js";
import { runCli } from "../cli.js";

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
  expect(result.files).toContain("public/assets/overview.svg");
  expect(result.files).toContain("src/product-demo.jsx");
  expect(result.files).toContain("src/social-card.jsx");
  expect(
    await readFile(join(target, "src/product-demo.jsx"), "utf8"),
  ).toContain("createMediaTimeline");
  expect(loadConfig).not.toHaveBeenCalled();
  expect(setup).not.toHaveBeenCalled();
});

it("preserves nonempty targets including hidden files and refuses a second init", async () => {
  const cwd = await temporary(),
    target = join(cwd, "existing");
  await mkdir(target);
  await writeFile(join(target, ".keep"), "user bytes");
  await expect(createProject(target)).rejects.toThrow("init.target_not_empty");
  expect(await readFile(join(target, ".keep"), "utf8")).toBe("user bytes");
  expect(await readdir(target)).toEqual([".keep"]);
  const generated = await createProject(join(cwd, "new"));
  const original = await readFile(join(generated.directory, "package.json"));
  await expect(createProject(generated.directory)).rejects.toThrow(
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
  const first = await createProject("empty", { cwd, env: {} });
  const second = await createProject("nested/other", {
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
  await expect(createProject(file)).rejects.toThrow("init.invalid_target");
  await expect(createProject(" ")).rejects.toThrow("init.invalid_target");
  const outside = join(cwd, "outside");
  await mkdir(outside);
  await symlink(
    outside,
    join(cwd, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await expect(createProject(join(cwd, "linked"))).rejects.toThrow(
    "init.invalid_target",
  );
  await expect(createProject(join(cwd, "linked/child"))).rejects.toThrow(
    "init.invalid_target",
  );
  expect(await readFile(file, "utf8")).toBe("original");
  expect(await readdir(outside)).toEqual([]);
});

it("allows only one concurrent publisher and preserves its complete project", async () => {
  const cwd = await temporary(),
    target = join(cwd, "project");
  const results = await Promise.allSettled([
    createProject(target),
    createProject(target),
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

it("creates a blank React composition with its source configured for Studio", async () => {
  const cwd = await temporary();
  const writes: string[] = [];
  const result = await initCommand(
    "my-video",
    { json: true, template: "blank" },
    { pathOptions: { cwd, env: {} }, write: (text) => writes.push(text) },
  );
  expect(result).toMatchObject({
    template: "blank",
    compositionId: "video",
    dependenciesInstalled: false,
  });
  expect(JSON.parse(writes.join(""))).toEqual(result);
  expect(await readdir(result.directory)).not.toContain("node_modules");
  expect(
    await readFile(join(result.directory, "velocast.config.ts"), "utf8"),
  ).toContain('"video": "src/video.jsx"');
  expect(
    await readFile(join(result.directory, "src/main.jsx"), "utf8"),
  ).toContain("startVelocast([video])");
});
