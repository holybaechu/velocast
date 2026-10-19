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
import { afterEach, expect, it, vi } from "vitest";
import { writeJsonOutput } from "./atomic-json-output.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, writeFile: vi.fn(fs.writeFile) };
});

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

it("leaves no partial new output when writing fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "velocast-json-output-write-"));
  roots.push(root);
  const output = join(root, "value.json");
  const fs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  const failure = new Error("simulated full disk");
  vi.mocked(writeFile).mockImplementationOnce(async (path, _data, options) => {
    await fs.writeFile(path, '{"partial":', options);
    throw failure;
  });
  await expect(
    writeJsonOutput(output, '{"complete":true}\n', false),
  ).rejects.toBe(failure);
  expect(await readdir(root)).toEqual([]);
});
