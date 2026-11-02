import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  assertNonEmptyString,
  getInvocationCwd,
  resolvePathFrom,
  type InvocationPathOptions,
} from "../project/paths.js";
import {
  projectStarterFiles,
  type ProjectTemplate,
} from "./templates/project.js";
export type { ProjectTemplate } from "./templates/project.js";
export interface InitProjectResult {
  directory: string;
  template: ProjectTemplate;
  templateVersion: number;
  compositionId: string;
  dependenciesInstalled: false;
  files: string[];
}
export interface InitCommandOptions {
  json?: boolean;
  template?: ProjectTemplate;
}
export interface InitCommandDependencies {
  pathOptions?: InvocationPathOptions;
  write?: (text: string) => void;
}
export interface CreateProjectOptions extends InvocationPathOptions {
  template?: ProjectTemplate;
}

async function assertNoSymlinks(path: string): Promise<void> {
  const absolute = resolve(path),
    prefix = parse(absolute).root;
  let current = prefix;
  for (const part of absolute.slice(prefix.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error(
          `init.invalid_target: symlink/junction targets are not supported: ${current}`,
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function emptyTargetIdentity(
  target: string,
): Promise<string | undefined> {
  let stat;
  try {
    stat = await lstat(target, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error(
      `init.invalid_target: expected a missing or empty directory: ${target}`,
    );
  if ((await readdir(target)).length)
    throw new Error(
      `init.target_not_empty: refusing to overwrite files in ${target}`,
    );
  return `${stat.dev}:${stat.ino}`;
}

function assertOwnedStage(parent: string, stage: string): void {
  const relativeStage = relative(parent, resolve(stage));
  if (
    dirname(resolve(stage)) !== resolve(parent) ||
    relativeStage.startsWith("..") ||
    !basename(stage).startsWith(".velocast-init-")
  )
    throw new Error(
      "init.cleanup_scope: staging path escaped its owned parent",
    );
}

export async function createProject(
  directory: string,
  options: CreateProjectOptions = {},
): Promise<InitProjectResult> {
  assertNonEmptyString(
    directory,
    "init.invalid_target: directory must be a non-empty path",
  );
  const target = resolvePathFrom(getInvocationCwd(options), directory);
  if (target === parse(target).root)
    throw new Error(
      "init.invalid_target: a filesystem root is not a project directory",
    );
  await assertNoSymlinks(target);
  const identity = await emptyTargetIdentity(target);
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const template = options.template ?? "product-demo";
  if (template !== "product-demo" && template !== "blank")
    throw new Error(
      `init.unknown_template: ${String(template)}; choose product-demo or blank`,
    );
  const selected = {
    files: projectStarterFiles(template),
    version: 2,
    compositionId: template === "blank" ? "video" : "product-demo",
  };
  let stage: string | undefined = await mkdtemp(
    join(parent, ".velocast-init-"),
  );
  let removedEmptyTarget = false;
  try {
    for (const [name, contents] of Object.entries(selected.files)) {
      const file = join(stage, name);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, contents, { flag: "wx" });
    }
    await assertNoSymlinks(target);
    const current = await emptyTargetIdentity(target);
    if (current !== identity)
      throw new Error(
        `init.target_changed: destination changed during creation: ${target}`,
      );
    if (identity !== undefined) {
      // Non-recursive removal refuses any concurrently added user files.
      await rmdir(target);
      removedEmptyTarget = true;
    }
    assertOwnedStage(parent, stage);
    if (dirname(resolve(target)) !== resolve(parent))
      throw new Error(
        "init.invalid_target: destination escaped its selected parent",
      );
    await rename(stage, target);
    stage = undefined;
    return {
      directory: target,
      template,
      templateVersion: selected.version,
      compositionId: selected.compositionId,
      dependenciesInstalled: false,
      files: Object.keys(selected.files).sort(),
    };
  } catch (error) {
    if (removedEmptyTarget) {
      try {
        await mkdir(target);
      } catch (restoreError) {
        if ((restoreError as NodeJS.ErrnoException).code !== "EEXIST")
          throw new AggregateError(
            [error, restoreError],
            "init.failed: creation failed and the empty target could not be restored",
            { cause: restoreError },
          );
      }
    }
    throw error;
  } finally {
    if (stage) {
      assertOwnedStage(parent, stage);
      await rm(stage, { recursive: true, force: true });
    }
  }
}

export async function initCommand(
  directory: string,
  options: InitCommandOptions = {},
  dependencies: InitCommandDependencies = {},
): Promise<InitProjectResult> {
  const result = await createProject(directory, {
    ...dependencies.pathOptions,
    template: options.template,
  });
  const write =
    dependencies.write ?? ((text: string) => process.stdout.write(text));
  write(
    options.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : `Created ${result.template} project: ${result.directory}\nNo dependencies were installed.\nInside that directory, run:\n  npm install\n  npm run studio\nThen export with:\n  npm run render\n`,
  );
  return result;
}
