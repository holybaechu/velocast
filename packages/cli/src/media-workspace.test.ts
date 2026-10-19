import {
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { mediaWorkspace } from "./media-workspace.js";

const paths: string[] = [];

afterEach(async () => {
  for (const path of paths.splice(0))
    await rm(path, { recursive: true, force: true });
});

it("removes the owned workspace and its contents", async () => {
  const workspace = await mediaWorkspace();
  paths.push(workspace.path);
  const nested = join(workspace.path, "nested");
  await mkdir(nested);
  await writeFile(join(nested, "frame.rgba"), "frame bytes");

  await workspace.close();

  await expect(stat(workspace.path)).rejects.toMatchObject({ code: "ENOENT" });
});

it("unlinks a replaced workspace without deleting its sibling target", async () => {
  const workspace = await mediaWorkspace();
  paths.push(workspace.path);
  const sibling = await mediaWorkspace();
  paths.push(sibling.path);
  const marker = join(sibling.path, "frame.rgba");
  await writeFile(marker, "another workspace's frame");
  await rm(workspace.path, { recursive: true });
  await symlink(sibling.path, workspace.path, "junction");

  await workspace.close();

  expect(await readFile(marker, "utf8")).toBe("another workspace's frame");
  await expect(stat(workspace.path)).rejects.toMatchObject({ code: "ENOENT" });
});
