import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { writeJsonOutput } from "./atomic-json-output.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

it("requires explicit overwrite and atomically replaces complete JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "velocast-json-output-"));
  roots.push(root);
  const output = join(root, "nested", "value.json");
  await writeJsonOutput(output, '{"version":1}\n', false);
  await expect(
    writeJsonOutput(output, '{"version":2}\n', false),
  ).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(output, "utf8")).toBe('{"version":1}\n');
  await writeJsonOutput(output, '{"version":2}\n', true);
  expect(await readFile(output, "utf8")).toBe('{"version":2}\n');
  expect(await readdir(join(root, "nested"))).toEqual(["value.json"]);
});

it("preserves an existing output when staging fails before publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "velocast-json-output-failure-"));
  roots.push(root);
  const output = join(root, "value.json");
  await mkdir(output);
  await expect(
    writeJsonOutput(output, "replacement\n", true),
  ).rejects.toBeInstanceOf(Error);
  expect(await readdir(root)).toEqual(["value.json"]);
});
