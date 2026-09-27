import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isNonEmptyString, uniquePaths } from "./internal/validation.js";
import { OUTPUT_API_VERSION } from "./generated/renderer-contracts.js";
import {
  electronRuntimeEnvironment,
  inspectElectronRuntime,
  resolveDeveloperElectronRuntime,
  assertElectronBrowserSelection,
} from "./electron-runtime.js";
import {
  rendererExecutableNameForPlatform,
  resolveNativeRendererPlatform,
} from "./native-platform.js";
import { getInvocationCwd, resolvePathFrom } from "./paths.js";
import {
  probeRendererCapabilities,
  type RendererCapabilitySpawn,
  type RendererCapabilitySupport,
} from "./renderer-capabilities.js";

export interface ResolveRendererBinaryOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fallbackTargetDirs?: string[];
  platform?: NodeJS.Platform;
  arch?: string;
  rendererBinary?: string;
  isUsableAutoBinary?: (binary: string) => boolean;
  spawnRendererCapabilities?: RendererCapabilitySpawn;
}

export type RendererBinarySource =
  "env" | "config" | "platform-package" | "managed-cache";

export interface ResolveRendererBinaryPathInput {
  env: Record<string, string | undefined>;
  configBinary?: string;
  platformPackageBinary?: string;
  managedCacheBinary?: string;
}

export interface ResolvedRendererBinary {
  path: string;
  source: RendererBinarySource;
}

export interface RendererRuntime {
  binary: string;
  env: NodeJS.ProcessEnv;
}

export interface RendererRuntimeResolveBinaryOptions {
  cacheKey?: string;
  isUsableAutoBinary?: ResolveRendererBinaryOptions["isUsableAutoBinary"];
}

export class RendererRuntimeResolver {
  private readonly binaryCache = new Map<string, string>();
  private readonly processEnvCache = new Map<string, NodeJS.ProcessEnv>();
  private readonly capabilityCache = new Map<
    string,
    RendererCapabilitySupport
  >();

  constructor(private readonly options: ResolveRendererBinaryOptions = {}) {}

  resolveBinary(
    configuredBinary?: string,
    options: RendererRuntimeResolveBinaryOptions = {},
  ): string {
    assertElectronBrowserSelection(this.options.env ?? process.env);
    const cacheKey = rendererRuntimeBinaryCacheKey(
      configuredBinary,
      options.cacheKey,
    );
    const cached = this.binaryCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const customUsability =
      options.isUsableAutoBinary ?? this.options.isUsableAutoBinary;
    const supportsCurrentOutputApi = (candidate: string): boolean => {
      try {
        const capabilities = this.inspectCapabilities(candidate);
        return (
          capabilities?.available === true &&
          capabilities.outputApiVersion === OUTPUT_API_VERSION
        );
      } catch {
        return false;
      }
    };
    const binary = resolveRendererBinary(configuredBinary, {
      ...this.options,
      isUsableAutoBinary: customUsability ?? supportsCurrentOutputApi,
    });
    const env = this.options.env ?? process.env;
    const automatic =
      (configuredBinary === undefined || configuredBinary === "auto") &&
      !isNonEmptyString(env[rendererBinaryEnv]);
    if (
      automatic &&
      customUsability === undefined &&
      !supportsCurrentOutputApi(binary)
    ) {
      throw new Error(
        "renderer.binary_unavailable: no capable automatic renderer candidate was found",
      );
    }
    this.binaryCache.set(cacheKey, binary);
    return binary;
  }

  resolveProcessEnv(
    rendererBinary: string = this.resolveBinary(),
  ): NodeJS.ProcessEnv {
    const cached = this.processEnvCache.get(rendererBinary);
    if (cached !== undefined) {
      return { ...cached };
    }

    const capability = this.inspectCapabilities(rendererBinary);
    if (
      !capability?.available ||
      capability.outputApiVersion !== OUTPUT_API_VERSION
    )
      throw new Error(
        capability?.reason ??
          "renderer.electron_unsupported: rebuild or install an Electron renderer with the current output API",
      );
    const env = resolveRendererProcessEnv({ ...this.options, rendererBinary });
    this.processEnvCache.set(rendererBinary, { ...env });
    return { ...env };
  }

  /** Reports source locations without preparing files or populating the launch cache. */
  inspectProcessEnv(
    rendererBinary: string = this.resolveBinary(),
  ): NodeJS.ProcessEnv {
    return inspectRendererProcessEnv({ ...this.options, rendererBinary });
  }

  inspectCapabilities(binary: string): RendererCapabilitySupport | undefined {
    let capabilities = this.capabilityCache.get(binary);
    if (capabilities === undefined) {
      capabilities = probeRendererCapabilities(
        binary,
        rendererCapabilityEnvironment({
          ...this.options,
          rendererBinary: binary,
        }),
        this.options.spawnRendererCapabilities,
      );
      this.capabilityCache.set(binary, capabilities);
    }
    return capabilities;
  }

  resolve(configuredBinary?: string): RendererRuntime {
    const binary = this.resolveBinary(configuredBinary);
    return {
      binary,
      env: this.resolveProcessEnv(binary),
    };
  }
}

function rendererRuntimeBinaryCacheKey(
  configuredBinary: string | undefined,
  discriminator = "default",
): string {
  return JSON.stringify([configuredBinary ?? null, discriminator]);
}

const rendererBinaryEnv = "VELOCAST_RENDERER_BINARY";
const cargoTargetDirEnv = "CARGO_TARGET_DIR";

export function resolveRendererBinaryPath(
  input: ResolveRendererBinaryPathInput,
): ResolvedRendererBinary {
  const envBinary = input.env[rendererBinaryEnv];
  if (isNonEmptyString(envBinary)) {
    return { path: envBinary, source: "env" };
  }
  if (isNonEmptyString(input.configBinary)) {
    return { path: input.configBinary, source: "config" };
  }
  if (isNonEmptyString(input.platformPackageBinary)) {
    return { path: input.platformPackageBinary, source: "platform-package" };
  }
  if (isNonEmptyString(input.managedCacheBinary)) {
    return { path: input.managedCacheBinary, source: "managed-cache" };
  }
  throw new Error(
    "renderer.binary_unavailable: install the platform renderer package, set VELOCAST_RENDERER_BINARY, or run velocast doctor",
  );
}

export function resolveRendererBinary(
  explicit?: string,
  options: ResolveRendererBinaryOptions = {},
): string {
  const env = options.env ?? process.env;
  assertElectronBrowserSelection(env);
  if (isNonEmptyString(env[rendererBinaryEnv])) {
    return resolveRendererBinaryPath({
      env,
      configBinary: explicit === "auto" ? undefined : explicit,
    }).path;
  }

  if (isNonEmptyString(explicit) && explicit !== "auto") {
    return resolvePathFrom(resolveRendererCwd(options), explicit);
  }

  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const exe = rendererExecutableNameForPlatform(platform, arch);
  const cwd = resolveRendererCwd(options);
  const workspaceRoot = findRendererWorkspaceRoot(cwd);
  const fallbackTargetDirs =
    options.fallbackTargetDirs ??
    (platform === "win32" ? ["C:\\vc-target"] : []);
  const targetDirs = uniquePaths(
    [
      env[cargoTargetDirEnv],
      join(cwd, "target"),
      workspaceRoot ? join(workspaceRoot, "target") : undefined,
      join(cwd, "target", "electron"),
      workspaceRoot ? join(workspaceRoot, "target", "electron") : undefined,
      ...fallbackTargetDirs,
    ].filter(isNonEmptyString),
  );

  const autoCandidates: string[] = [];
  for (const targetDir of targetDirs) {
    const releasePath = join(targetDir, "release", exe);
    if (existsSync(releasePath)) {
      autoCandidates.push(releasePath);
    }

    const debugPath = join(targetDir, "debug", exe);
    if (existsSync(debugPath)) {
      autoCandidates.push(debugPath);
    }
  }

  const platformPackageBinary = findInstalledPlatformRendererBinary(
    workspaceRoot ?? cwd,
    exe,
    platform,
    arch,
  );
  if (platformPackageBinary !== undefined) {
    autoCandidates.push(platformPackageBinary);
  }

  const managedCacheBinary = findManagedCacheRendererBinary(cwd, exe);
  if (managedCacheBinary !== undefined) {
    autoCandidates.push(managedCacheBinary);
  }

  const autoBinary = selectAutoBinary(
    uniquePaths(autoCandidates),
    options.isUsableAutoBinary ??
      ((binary) => {
        try {
          return probeRendererCapabilities(
            binary,
            rendererCapabilityEnvironment({
              ...options,
              rendererBinary: binary,
            }),
            options.spawnRendererCapabilities,
          ).available;
        } catch {
          return false;
        }
      }),
  );
  if (autoBinary !== undefined) {
    return autoBinary;
  }

  return resolveRendererBinaryPath({
    env,
    configBinary: undefined,
  }).path;
}

function rendererCapabilityEnvironment(
  options: ResolveRendererBinaryOptions,
): NodeJS.ProcessEnv {
  try {
    return inspectRendererProcessEnv(options);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.startsWith("runtime.electron_missing:")
    )
      throw error;
    // Native capability inspection does not start Electron. Missing browser
    // files should be diagnosed during acquisition, after identifying the binary.
    return {
      ...developerNativeEnvironment(options),
      VELOCAST_BROWSER: "electron",
    };
  }
}

export function resolveRendererProcessEnv(
  options: ResolveRendererBinaryOptions = {},
): NodeJS.ProcessEnv {
  return inspectRendererProcessEnv(options);
}

function inspectRendererProcessEnv(
  options: ResolveRendererBinaryOptions,
): NodeJS.ProcessEnv {
  const env = { ...(options.env ?? process.env) };
  assertElectronBrowserSelection(env);
  const platform = options.platform ?? process.platform;
  const binary = options.rendererBinary;
  if (!binary) return env;
  const bundled = inspectElectronRuntime(
    binary,
    platform,
    options.arch ?? process.arch,
  );
  if (bundled) return electronRuntimeEnvironment(bundled, env, platform);
  const developerEnv = developerNativeEnvironment(options);
  return electronRuntimeEnvironment(
    resolveDeveloperElectronRuntime(
      binary,
      resolveRendererCwd(options),
      developerEnv,
    ),
    developerEnv,
    platform,
  );
}

function developerNativeEnvironment(
  options: ResolveRendererBinaryOptions,
): NodeJS.ProcessEnv {
  const env = { ...(options.env ?? process.env) };
  const platform = options.platform ?? process.platform;
  const cwd = resolveRendererCwd(options);
  const workspaceRoot = findRendererWorkspaceRoot(cwd) ?? cwd;
  // This is only the developer DLL/tool environment. Browser files are resolved
  // separately, and marked bundles bypass workspace settings altogether.
  const envFile = join(workspaceRoot, ".velocast", "accelerated-env.ps1");
  if (existsSync(envFile)) {
    const configured = parseAcceleratedEnvFile(readFileSync(envFile, "utf8"));
    for (const [key, value] of Object.entries(configured.variables)) {
      if (!key.startsWith("VELOCAST_") && key !== "CEF_PATH") env[key] = value;
    }
    prependPathEntries(env, configured.pathAdditions, platform);
  }
  return env;
}

function findRendererWorkspaceRoot(start: string): string | undefined {
  let current = start;
  while (true) {
    if (existsSync(join(current, "crates", "renderer", "Cargo.toml"))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function resolveRendererCwd(options: ResolveRendererBinaryOptions): string {
  return isNonEmptyString(options.cwd)
    ? options.cwd
    : getInvocationCwd({ env: options.env });
}

function selectAutoBinary(
  candidates: string[],
  isUsableAutoBinary: ((binary: string) => boolean) | undefined,
): string | undefined {
  if (candidates.length === 0) {
    return undefined;
  }
  if (isUsableAutoBinary === undefined) {
    return candidates[0];
  }

  return candidates.find((candidate) => isUsableAutoBinary(candidate));
}

function findInstalledPlatformRendererBinary(
  start: string,
  exe: string,
  platform: NodeJS.Platform,
  arch: string,
): string | undefined {
  const nativePlatform = resolveNativeRendererPlatform(platform, arch);
  if (!nativePlatform?.packageName) {
    return undefined;
  }

  for (const root of ancestorDirs(start)) {
    const packageBinary = join(
      root,
      "node_modules",
      ...nativePlatform.packageName.split("/"),
      "bin",
      exe,
    );
    if (existsSync(packageBinary)) {
      return packageBinary;
    }
  }

  if (!nativePlatform.workspacePackageDir) {
    return undefined;
  }

  const workspaceBinary = join(
    start,
    "packages",
    nativePlatform.workspacePackageDir,
    "bin",
    exe,
  );
  return existsSync(workspaceBinary) ? workspaceBinary : undefined;
}

function findManagedCacheRendererBinary(
  cwd: string,
  exe: string,
): string | undefined {
  for (const profile of ["release", "debug"]) {
    const binary = join(cwd, "target", profile, exe);
    if (existsSync(binary)) {
      return binary;
    }
  }
  return undefined;
}

function ancestorDirs(start: string): string[] {
  const dirs: string[] = [];
  let current = start;
  while (true) {
    dirs.push(current);
    const parent = dirname(current);
    if (parent === current) {
      return dirs;
    }
    current = parent;
  }
}

function parseAcceleratedEnvFile(source: string): {
  variables: Record<string, string>;
  pathAdditions: string[];
} {
  const variables: Record<string, string> = {};
  const pathAdditions: string[] = [];
  let inPathAdditions = false;

  for (const line of source.split(/\r?\n/)) {
    const variable = line.match(
      /^\$env:([A-Za-z0-9_]+)\s*=\s*'((?:[^']|'')*)'\s*$/,
    );
    const variableName = variable?.[1];
    const variableValue = variable?.[2];
    if (variableName && variableValue !== undefined) {
      variables[variableName] =
        decodePowerShellSingleQuotedString(variableValue);
      continue;
    }

    if (/^\$pathAdditions\s*=\s*@\(\s*$/.test(line)) {
      inPathAdditions = true;
      continue;
    }

    if (inPathAdditions && /^\)\s*$/.test(line)) {
      inPathAdditions = false;
      continue;
    }

    const pathEntry = inPathAdditions
      ? line.match(/^\s*'((?:[^']|'')*)'\s*$/)
      : undefined;
    const pathEntryValue = pathEntry?.[1];
    if (pathEntryValue !== undefined) {
      pathAdditions.push(decodePowerShellSingleQuotedString(pathEntryValue));
    }
  }

  return { variables, pathAdditions };
}

function decodePowerShellSingleQuotedString(value: string): string {
  return value.replaceAll("''", "'");
}

function prependPathEntries(
  env: NodeJS.ProcessEnv,
  pathAdditions: string[],
  platform: NodeJS.Platform = process.platform,
): void {
  const pathKey =
    Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const delimiter = pathDelimiterFor(platform);
  const existing = env[pathKey] ?? "";
  const existingParts = existing.split(delimiter).filter(Boolean);
  const existingSet = new Set(
    existingParts.map((part) =>
      platform === "win32" ? part.toLowerCase() : part,
    ),
  );
  const additions = pathAdditions.filter((entry) => {
    if (!entry || !existsSync(entry)) {
      return false;
    }
    const key = platform === "win32" ? entry.toLowerCase() : entry;
    if (existingSet.has(key)) {
      return false;
    }
    existingSet.add(key);
    return true;
  });

  if (additions.length > 0) {
    env[pathKey] = [...additions, existing].filter(Boolean).join(delimiter);
  }
}

function pathDelimiterFor(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}
