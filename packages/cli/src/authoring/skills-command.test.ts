import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runCli } from "../cli.js";
import { createProject } from "./init-command.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

it("includes the same discoverable skill in a newly scaffolded project", async () => {
  const root = await mkdtemp(join(tmpdir(), "velocast-skills-init-"));
  roots.push(root);
  const project = await createProject(join(root, "project"), {
    template: "blank",
  });
  expect(project.files).toContain(".agents/skills/velocast/SKILL.md");
  expect(
    await readFile(
      join(project.directory, ".agents/skills/velocast/SKILL.md"),
      "utf8",
    ),
  ).toContain("name: velocast");
});

it("installs the bundled video skill without loading a project or runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "velocast-skills-test-"));
  roots.push(root);
  const write = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  const loadConfigFromPath = vi.fn();
  await runCli(
    ["node", "velocast", "skills", "install", "--directory", root, "--json"],
    { loadConfigFromPath },
  );
  const result = JSON.parse(
    write.mock.calls.map(([value]) => String(value)).join(""),
  );
  expect(result).toMatchObject({
    skill: "velocast",
    directory: join(root, "velocast"),
  });
  expect(await readFile(join(root, "velocast", "SKILL.md"), "utf8")).toContain(
    "name: velocast",
  );
  expect(loadConfigFromPath).not.toHaveBeenCalled();
});

it("updates unchanged managed files, preserves extra files and refuses local edits before writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "velocast-skills-update-"));
  roots.push(root);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const command = (action: string) =>
    runCli(["node", "velocast", "skills", action, "--directory", root]);
  await command("install");
  const skill = join(root, "velocast");
  const receiptPath = join(skill, ".velocast-skill.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  const original = await readFile(join(skill, "SKILL.md"), "utf8");
  const old = "old published skill";
  await writeFile(join(skill, "SKILL.md"), old);
  receipt.files["SKILL.md"] = createHash("sha256").update(old).digest("hex");
  await writeFile(receiptPath, JSON.stringify(receipt));
  await writeFile(join(skill, "my-notes.md"), "user notes");
  await command("update");
  expect(await readFile(join(skill, "SKILL.md"), "utf8")).toBe(original);
  expect(await readFile(join(skill, "my-notes.md"), "utf8")).toBe("user notes");
  await writeFile(join(skill, "SKILL.md"), old);
  receipt.files["SKILL.md"] = createHash("sha256").update(old).digest("hex");
  await writeFile(receiptPath, JSON.stringify(receipt));
  await writeFile(join(skill, "references/setup.md"), "my installation policy");
  const beforeReceipt = await readFile(receiptPath, "utf8");
  await expect(command("update")).rejects.toThrow("skills.local_changes");
  expect(await readFile(join(skill, "SKILL.md"), "utf8")).toBe(old);
  expect(await readFile(join(skill, "references/setup.md"), "utf8")).toBe(
    "my installation policy",
  );
  expect(await readFile(receiptPath, "utf8")).toBe(beforeReceipt);
});

it("gives recovery instructions for an invalid receipt without replacing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "velocast-skills-receipt-"));
  roots.push(root);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await runCli(["node", "velocast", "skills", "install", "--directory", root]);
  await writeFile(join(root, "velocast/.velocast-skill.json"), "broken JSON");
  await expect(
    runCli(["node", "velocast", "skills", "update", "--directory", root]),
  ).rejects.toThrow("skills.receipt_invalid");
  expect(
    await readFile(join(root, "velocast/.velocast-skill.json"), "utf8"),
  ).toBe("broken JSON");
});
