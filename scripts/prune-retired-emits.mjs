import { lstat, realpath, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import console from "node:console";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const retired = Object.freeze({
  core: ["registry", "dom-discovery", "composition-definitions"],
  cli: ["job", "remotion-command", "linux-cef-runtime"],
  "remotion-compat": ["upstream-browser"],
});
const emitSuffixes = [".js", ".js.map", ".d.ts", ".d.ts.map"];
const sourceSuffixes = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".d.ts",
];

async function inspect(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}
function samePath(left, right) {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
async function directory(path, optional = false) {
  const stat = await inspect(path);
  if (!stat && optional) return false;
  if (
    !stat ||
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    !samePath(await realpath(path), path)
  ) {
    throw new Error(`retired_emit.unsafe_directory: ${path}`);
  }
  return true;
}

/** Only exact retired module emits, never a glob or a recursive directory removal.
 * The root argument exists for isolated filesystem tests; CLI callers use this repository.
 */
export async function pruneRetiredEmits(packageName, root = repository) {
  if (!Object.hasOwn(retired, packageName)) {
    throw new Error(`retired_emit.unknown_package: ${packageName}`);
  }
  root = resolve(root);
  const packages = join(root, "packages");
  const packageRoot = join(packages, packageName);
  const source = join(packageRoot, "src");
  const dist = join(packageRoot, "dist");
  // Check every boundary before resolving/deleting a candidate underneath it.
  for (const path of [root, packages, packageRoot, source])
    await directory(path);
  for (const module of retired[packageName]) {
    for (const suffix of sourceSuffixes) {
      if (await inspect(join(source, module + suffix))) {
        throw new Error(`retired_emit.source_present: ${module + suffix}`);
      }
    }
  }
  if (!(await directory(dist, true))) return [];
  const candidates = [];
  for (const module of retired[packageName]) {
    for (const suffix of emitSuffixes) {
      const path = join(dist, module + suffix);
      const stat = await inspect(path);
      if (!stat) continue;
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        !samePath(await realpath(path), path)
      ) {
        throw new Error(`retired_emit.unsafe_file: ${path}`);
      }
      candidates.push(path);
    }
  }
  // Validate the complete list first so a bad entry cannot cause a partial prune.
  for (const path of candidates) {
    for (const boundary of [root, packages, packageRoot, source, dist])
      await directory(boundary);
    const stat = await inspect(path);
    if (
      !stat ||
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      !samePath(await realpath(path), path)
    ) {
      throw new Error(`retired_emit.changed_file: ${path}`);
    }
    await unlink(path);
  }
  return candidates;
}

if (
  process.argv[1] &&
  samePath(resolve(process.argv[1]), fileURLToPath(import.meta.url))
) {
  const removed = await pruneRetiredEmits(process.argv[2]);
  console.log(
    `retired emits: ${process.argv[2]} removed ${removed.length} files`,
  );
}
