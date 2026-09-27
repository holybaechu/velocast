import { existsSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Config } from "@velocast/core";
import { tsImport } from "tsx/esm/api";
import { isObjectRecord, uniquePaths } from "./internal/validation.js";
import {
  assertNonEmptyString,
  getInvocationCwd,
  resolvePathFrom,
  type InvocationPathOptions,
} from "./paths.js";
import { normalizeConfigEntryFromConfigDir } from "./render-source.js";

interface ConfigModule {
  default?: unknown;
}

export type ConfigLoaderOptions = InvocationPathOptions;

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function findWorkspaceRoot(start: string): string {
  let current = start;

  while (true) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current || current === parse(current).root) {
      return start;
    }
    current = parent;
  }
}

function findTsconfig(): string | false {
  const tsconfig = resolve(packageRoot, "tsconfig.json");
  return existsSync(tsconfig) ? tsconfig : false;
}

export function resolveConfigPath(
  path: string,
  options: ConfigLoaderOptions = {},
): string {
  assertNonEmptyString(path, "--config must be a non-empty string");

  const cwd = getInvocationCwd({ cwd: options.cwd, env: {} });
  const candidates = uniquePaths([
    resolvePathFrom(getInvocationCwd({ cwd, env: options.env }), path),
    resolvePathFrom(cwd, path),
    resolvePathFrom(findWorkspaceRoot(cwd), path),
  ]);

  return (
    candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!
  );
}

export async function loadConfigFromPath(
  path: string,
  options: ConfigLoaderOptions = {},
): Promise<Config> {
  const configPath = resolveConfigPath(path, options);
  const module = await importConfigModule(configPath);

  const config = unwrapDefaultConfig(module);
  if (config === undefined) {
    throw new Error(`config ${path} must export a default config`);
  }
  if (!isConfigObject(config)) {
    throw new Error(`config ${path} must export a default config object`);
  }

  return normalizeConfigEntryFromConfigDir(config, dirname(configPath));
}

async function importConfigModule(configPath: string): Promise<ConfigModule> {
  const href = pathToFileURL(configPath).href;
  try {
    return (await import(href)) as ConfigModule;
  } catch (error) {
    if (!shouldFallbackToTsImport(error)) {
      throw error;
    }
  }

  return (await tsImport(href, {
    parentURL: import.meta.url,
    tsconfig: findTsconfig(),
  })) as ConfigModule;
}

function shouldFallbackToTsImport(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("Unknown file extension") ||
    error.message.includes("ERR_UNKNOWN_FILE_EXTENSION")
  );
}

function unwrapDefaultConfig(module: ConfigModule): unknown {
  const config = module.default;
  if (isModuleNamespaceWithoutDefault(config)) {
    return undefined;
  }
  if (isNestedDefaultModule(config)) {
    return unwrapDefaultConfig(config);
  }

  return config;
}

function isModuleNamespaceWithoutDefault(value: unknown): boolean {
  return (
    isObjectRecord(value) &&
    value.__esModule === true &&
    !Object.prototype.hasOwnProperty.call(value, "default")
  );
}

function isNestedDefaultModule(value: unknown): value is ConfigModule {
  return (
    isObjectRecord(value) &&
    "default" in value &&
    Object.keys(value).length === 1
  );
}

function isConfigObject(value: unknown): value is Config {
  return isObjectRecord(value);
}
