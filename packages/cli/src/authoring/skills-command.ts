import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getInvocationCwd, resolvePathFrom } from "../project/paths.js";

const skillName = "velocast";
const receiptName = ".velocast-skill.json";
const bundledDirectory = fileURLToPath(
  new URL("../../skills/velocast/", import.meta.url),
);

function hash(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

export async function bundledSkillFiles(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function visit(directory: string, prefix: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory())
        await visit(join(directory, entry.name), `${name}/`);
      else if (entry.isFile())
        files[name] = await readFile(join(directory, entry.name), "utf8");
      else throw new Error(`skills.bundle_invalid: unsupported entry ${name}`);
    }
  }
  await visit(bundledDirectory, "");
  if (!files["SKILL.md"])
    throw new Error("skills.bundle_missing: reinstall the Velocast package");
  return files;
}

export async function skillProjectFiles(): Promise<Record<string, string>> {
  const files = await bundledSkillFiles();
  const { version } = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const receipt = {
    schemaVersion: 1,
    packageVersion: version,
    files: Object.fromEntries(
      Object.entries(files).map(([name, contents]) => [name, hash(contents)]),
    ),
  };
  return { ...files, [receiptName]: `${JSON.stringify(receipt, null, 2)}\n` };
}

async function assertNoLinks(path: string): Promise<void> {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute
    .slice(current.length)
    .split(sep)
    .filter(Boolean)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error(
          `skills.invalid_target: symlinks/junctions are unsupported: ${current}`,
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  await assertNoLinks(path);
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function receiptHashes(contents: string | undefined): Record<string, string> {
  if (contents === undefined) return {};
  try {
    const receipt = JSON.parse(contents);
    if (
      receipt?.schemaVersion !== 1 ||
      typeof receipt.packageVersion !== "string" ||
      !receipt.files ||
      typeof receipt.files !== "object" ||
      Array.isArray(receipt.files) ||
      Object.values(receipt.files).some(
        (value) => typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value),
      )
    )
      throw new Error("invalid receipt");
    return receipt.files;
  } catch {
    throw new Error(
      "skills.receipt_invalid: preserve this skill and install into a new --directory",
    );
  }
}

export async function skillsCommand(
  action: string | undefined,
  options: { directory?: string; json?: boolean } = {},
): Promise<void> {
  if (action !== undefined && action !== "install" && action !== "update")
    throw new Error(
      "skills.unknown_action: choose install or update; omit the action to list skills",
    );
  const directory = join(
    resolvePathFrom(getInvocationCwd(), options.directory ?? ".agents/skills"),
    skillName,
  );
  const files = await skillProjectFiles();
  if (action) {
    await assertNoLinks(directory);
    const receipt = await readOptional(join(directory, receiptName));
    if (receipt === undefined) {
      try {
        await lstat(directory);
        throw new Error(
          `skills.unmanaged_target: preserve ${directory} and install into a new --directory`,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const prior = receiptHashes(receipt);
    const changed: [string, string][] = [];
    const conflicts: string[] = [];
    for (const [name, contents] of Object.entries(files)) {
      if (name === receiptName) continue;
      const current = await readOptional(join(directory, name));
      if (current === contents) continue;
      if (
        current === undefined
          ? prior[name] !== undefined
          : hash(current) !== prior[name]
      )
        conflicts.push(name);
      else changed.push([name, contents]);
    }
    if (conflicts.length)
      throw new Error(
        `skills.local_changes: preserved ${conflicts.join(", ")}; install into a new --directory, then merge your changes before updating`,
      );
    // Publish the receipt last: an interrupted update is detected as a conflict
    // on the next run, rather than treating partially replaced files as owned.
    for (const [name, contents] of [
      ...changed,
      [receiptName, files[receiptName]!] as [string, string],
    ]) {
      const destination = join(directory, name);
      await assertNoLinks(destination);
      await mkdir(dirname(destination), { recursive: true });
      const temporary = join(
        dirname(destination),
        `.velocast-skill-${randomUUID()}`,
      );
      try {
        await writeFile(temporary, contents, { flag: "wx" });
        await rename(temporary, destination);
      } finally {
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    }
  }
  const report = {
    skill: skillName,
    directory,
    action: action ?? "list",
    files: Object.keys(files)
      .filter((name) => name !== receiptName)
      .sort(),
    description: "Create, revise, inspect and render videos with Velocast",
    install: "velocast skills install",
  };
  process.stdout.write(
    options.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : action
        ? `${action === "install" ? "Installed" : "Updated"} /velocast: ${directory}\nReload your agent's skills, then ask it to make a video.\n`
        : `/velocast — ${report.description}\nInstall in this project: ${report.install}\n`,
  );
}
