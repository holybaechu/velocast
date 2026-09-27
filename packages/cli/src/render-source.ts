import { statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Config } from "@velocast/core";
import {
  assertNonEmptyString,
  getInvocationCwd,
  resolvePathFrom,
  type InvocationPathOptions,
} from "./paths.js";

export interface ResolvedRenderSource {
  kind: "serve" | "entry";
  url: string;
  snapshotRoot?: string;
}

export function resolveCompositionRenderSource(
  config: Config,
  options: InvocationPathOptions = {},
): ResolvedRenderSource {
  if (config.source)
    throw new Error(
      "source.operation_unsupported: this operation cannot use a source adapter; use compositions, inspect, frame or render",
    );
  const snapshotRoot = resolveSnapshotRoot(config, options);
  const serveUrl = normalizeOptionalUrl(config.serve?.url);
  if (serveUrl !== undefined) {
    if (snapshotRoot !== undefined)
      throw new Error(
        "snapshot.requires_local_entry: renderer.snapshotRoot cannot freeze serve.url; select a built local entry",
      );
    return {
      kind: "serve",
      url: serveUrl,
    };
  }

  if (config.entry === undefined) {
    if (snapshotRoot !== undefined)
      throw new Error(
        "snapshot.requires_local_entry: renderer.snapshotRoot requires a built local entry",
      );
    throw new Error("config serve.url or entry is required for render");
  }

  return {
    kind: "entry",
    url: resolveEntryUrl(config.entry, options),
    ...(snapshotRoot === undefined ? {} : { snapshotRoot }),
  };
}

export function normalizeConfigEntryFromConfigDir(
  config: Config,
  configDir: string,
): Config {
  assertSourceConfig(config);
  let normalized = config;
  if (config.source) {
    normalized = {
      ...normalized,
      source: {
        ...config.source,
        kind: config.source.kind,
        entry: resolveSourceEntry(config.source.entry, {
          cwd: configDir,
          env: {},
        }),
        prepare: config.source.prepare.bind(config.source),
      },
    };
  }
  if (typeof config.entry === "string" && config.entry.trim()) {
    const entry = config.entry.trim();
    normalized = {
      ...normalized,
      entry:
        parseExplicitUrl(entry) === undefined
          ? resolvePathFrom(configDir, entry)
          : entry,
    };
  }
  if (config.renderer?.snapshotRoot !== undefined) {
    normalized = {
      ...normalized,
      renderer: {
        ...config.renderer,
        snapshotRoot: resolveSnapshotRoot(config, { cwd: configDir, env: {} }),
      },
    };
  }
  return normalized;
}

export function assertSourceConfig(config: Config): void {
  if (config.source === undefined) return;
  if (
    !config.source ||
    typeof config.source.prepare !== "function" ||
    typeof config.source.kind !== "string" ||
    !config.source.kind.trim()
  )
    throw new Error(
      "source.invalid_adapter: source must define kind, entry and prepare",
    );
  if (
    config.entry !== undefined ||
    config.serve !== undefined ||
    config.renderer?.snapshotRoot !== undefined
  )
    throw new Error(
      "source.config_conflict: source cannot be combined with entry, serve or renderer.snapshotRoot",
    );
  assertNonEmptyString(
    config.source.entry,
    "source.entry must be a non-empty local file path",
  );
}

export function resolveSourceEntry(
  entry: string,
  options: InvocationPathOptions = {},
): string {
  assertNonEmptyString(
    entry,
    "source.entry must be a non-empty local file path",
  );
  const url = parseExplicitUrl(entry.trim());
  if (url && url.protocol !== "file:")
    throw new Error(
      "source.invalid_entry: source.entry must be a local file path",
    );
  return url
    ? fileURLToPath(url)
    : resolvePathFrom(getInvocationCwd(options), entry.trim());
}

function resolveSnapshotRoot(
  config: Config,
  options: InvocationPathOptions,
): string | undefined {
  const value = config.renderer?.snapshotRoot;
  if (value === undefined) return;
  assertNonEmptyString(
    value,
    "renderer.snapshotRoot must be a non-empty local directory path",
  );
  const trimmed = value.trim();
  const url = parseExplicitUrl(trimmed);
  if (url && url.protocol !== "file:")
    throw new Error(
      "renderer.snapshotRoot must be a local directory path, not an HTTP URL",
    );
  return url
    ? fileURLToPath(url)
    : resolvePathFrom(getInvocationCwd(options), trimmed);
}

export function resolveEntryUrl(
  entry: string,
  options: InvocationPathOptions = {},
): string {
  assertNonEmptyString(entry, "config entry must be a non-empty string");

  const trimmed = entry.trim();
  const url = parseExplicitUrl(trimmed);
  if (url !== undefined) {
    if (url.protocol !== "file:") {
      throw new Error("config entry URLs must use the file:// scheme");
    }

    const path = fileURLToPath(url);
    assertEntryFile(path);
    return url.href;
  }

  const resolvedPath = resolvePathFrom(getInvocationCwd(options), trimmed);
  assertEntryFile(resolvedPath);
  return pathToFileURL(resolvedPath).href;
}

function normalizeOptionalUrl(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseExplicitUrl(value: string): URL | undefined {
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    return undefined;
  }

  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function assertEntryFile(path: string): void {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw new Error(`config entry was not found: ${path}`);
  }

  if (!stats.isFile()) {
    throw new Error(`config entry must be a file: ${path}`);
  }
}
