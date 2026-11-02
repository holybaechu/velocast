import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Config } from "@velocast/core";
import { isObjectRecord } from "../internal/validation.js";

type StudioConfig = NonNullable<Config["studio"]>;
const roots = new WeakMap<StudioConfig, string>();

export class StudioCodeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function checkCodePath(root: string, path: string): void {
  const name = relative(root, path);
  if (
    !name ||
    isAbsolute(name) ||
    name === ".." ||
    name.startsWith("..\\") ||
    name.startsWith("../")
  )
    throw new StudioCodeError(
      400,
      "studio.code_path",
      "Studio source files must be inside the config directory",
    );
  let current = root;
  const segments = name.split(/[\\/]/);
  try {
    if (realpathSync(root) !== root || lstatSync(root).isSymbolicLink())
      throw new Error("the configured project directory changed");
    for (const [index, part] of segments.entries()) {
      current = join(current, part);
      const info = lstatSync(current);
      if (
        info.isSymbolicLink() ||
        (index === segments.length - 1 ? !info.isFile() : !info.isDirectory())
      )
        throw new Error(
          "symbolic links and non-regular source files are not editable",
        );
    }
  } catch (error) {
    throw new StudioCodeError(
      400,
      "studio.code_path",
      `${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function normalizeStudioConfig(
  studio: StudioConfig,
  configDir: string,
): StudioConfig {
  if (
    !isObjectRecord(studio) ||
    Object.keys(studio).some((key) => key !== "sources") ||
    !isObjectRecord(studio.sources)
  )
    throw new StudioCodeError(
      400,
      "studio.code_config",
      "studio.sources must map composition IDs to local JS, JSX, TS or TSX source files",
    );
  const root = realpathSync(configDir);
  const sources: Record<string, string> = Object.create(null);
  const seen = new Set<string>();
  for (const [id, name] of Object.entries(studio.sources)) {
    if (
      !id.trim() ||
      typeof name !== "string" ||
      !name.trim() ||
      !/\.(jsx?|tsx?)$/i.test(name)
    )
      throw new StudioCodeError(
        400,
        "studio.code_config",
        `studio.sources.${id}: expected a JS, JSX, TS or TSX source file`,
      );
    const path = resolve(root, name);
    checkCodePath(root, path);
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    if (seen.has(key))
      throw new StudioCodeError(
        400,
        "studio.code_config",
        "Each composition needs its own editable source file",
      );
    seen.add(key);
    sources[id] = path;
  }
  const normalized = { sources };
  roots.set(normalized, root);
  return normalized;
}

export function codeSourceConfig(
  studio: StudioConfig | undefined,
  cwd: string,
) {
  if (!studio) return { root: cwd, sources: {} };
  const normalized = roots.has(studio)
    ? studio
    : normalizeStudioConfig(studio, cwd);
  return { root: roots.get(normalized)!, sources: normalized.sources };
}
