import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isObjectRecord } from "./internal/validation.js";

export interface ElectronRuntime {
  root: string;
  renderer: string;
  electron: string;
  hostScript: string;
}

/** Local candidate layout. Published artifacts additionally use ArtifactResolver's
 * signature/inventory checks; this marker does not assert release trust. */
export function inspectElectronRuntime(
  renderer: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ElectronRuntime | undefined {
  const root = dirname(resolve(renderer));
  const marker = join(root, "electron-runtime.json");
  if (!existsSync(marker)) return undefined;
  try {
    const record: unknown = JSON.parse(readFileSync(marker, "utf8"));
    if (
      !isObjectRecord(record) ||
      record.schema !== "velocast-electron-runtime-v1" ||
      record.browserHost !== "electron" ||
      record.platform !== platform ||
      record.arch !== arch
    )
      throw new Error("unsupported manifest schema, host, or platform");
    const file = (value: unknown): string => {
      if (typeof value !== "string" || !value || isAbsolute(value))
        throw new Error("runtime paths must be relative files");
      const path = resolve(root, value);
      const contained = (candidate: string, base: string) => {
        const delta = relative(base, candidate);
        return (
          delta !== ".." && !delta.startsWith(`..${sep}`) && !isAbsolute(delta)
        );
      };
      if (
        !contained(path, root) ||
        !statSync(path).isFile() ||
        !contained(realpathSync(path), realpathSync(root))
      )
        throw new Error(
          `runtime file is missing or escapes its directory: ${value}`,
        );
      return path;
    };
    const native = file(record.renderer);
    if (realpathSync(native) !== realpathSync(renderer))
      throw new Error("manifest names a different renderer");
    file(record.ffmpeg);
    file(record.ffprobe);
    return {
      root,
      renderer: native,
      electron: file(record.electron),
      hostScript: file(record.hostScript),
    };
  } catch (error) {
    throw new Error(
      `runtime.electron_invalid: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function electronRuntimeEnvironment(
  runtime: ElectronRuntime,
  inherited: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  assertElectronBrowserSelection(inherited);
  const env = { ...inherited };
  for (const key of Object.keys(env)) {
    if (
      key.toUpperCase() === "CEF_PATH" ||
      key.startsWith("VELOCAST_CEF_") ||
      key.startsWith("VELOCAST_LINUX_RENDERER_RUNTIME_")
    )
      delete env[key];
  }
  const key =
    Object.keys(env).find((name) => name.toLowerCase() === "path") ?? "PATH";
  const delimiter = platform === "win32" ? ";" : ":";
  env[key] = [
    runtime.root,
    ...(env[key] ?? "")
      .split(delimiter)
      .filter((path) => path !== runtime.root),
  ].join(delimiter);
  if (platform === "linux")
    env.LD_LIBRARY_PATH = [runtime.root, env.LD_LIBRARY_PATH]
      .filter(Boolean)
      .join(":");
  env.VELOCAST_BROWSER = "electron";
  env.VELOCAST_EXPERIMENTAL_BROWSER = "electron";
  env.VELOCAST_ELECTRON_BINARY = runtime.electron;
  env.VELOCAST_ELECTRON_HOST_SCRIPT = runtime.hostScript;
  return env;
}

/** Retired hosts fail explicitly; an old Electron selector remains compatible. */
export function assertElectronBrowserSelection(env: NodeJS.ProcessEnv): void {
  for (const key of ["VELOCAST_BROWSER", "VELOCAST_EXPERIMENTAL_BROWSER"]) {
    const selected = env[key]?.trim();
    if (selected && selected !== "electron")
      throw new Error(
        `browser.host_not_supported: ${key}=${selected}; this renderer supports only Electron`,
      );
  }
}

export function resolveDeveloperElectronRuntime(
  renderer: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): ElectronRuntime {
  assertElectronBrowserSelection(env);
  const roots: string[] = [];
  for (const start of [cwd, dirname(fileURLToPath(import.meta.url))]) {
    let current = resolve(start);
    while (true) {
      if (!roots.includes(current)) roots.push(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  const hostScript =
    env.VELOCAST_ELECTRON_HOST_SCRIPT?.trim() ||
    roots
      .map((root) => join(root, "packages/electron-host/main.cjs"))
      .find((file) => existsSync(file));
  if (
    !hostScript ||
    !isAbsolute(hostScript) ||
    !existsSync(hostScript) ||
    !statSync(hostScript).isFile()
  )
    throw new Error(
      "runtime.electron_missing: Electron host script is missing; install the matching renderer bundle or set VELOCAST_ELECTRON_HOST_SCRIPT to its absolute main.cjs path",
    );
  let electron = env.VELOCAST_ELECTRON_BINARY?.trim();
  if (!electron) {
    try {
      const packageRoot = join(dirname(hostScript), "node_modules/electron");
      if (!statSync(join(packageRoot, "package.json")).isFile())
        throw new Error("private Electron package missing");
      const executable = readFileSync(
        join(packageRoot, "path.txt"),
        "utf8",
      ).trim();
      electron = resolve(packageRoot, "dist", executable);
      const delta = relative(join(packageRoot, "dist"), electron);
      if (
        !executable ||
        isAbsolute(executable) ||
        delta === ".." ||
        delta.startsWith(`..${sep}`)
      )
        throw new Error("invalid Electron executable path");
    } catch (cause) {
      throw new Error(
        "runtime.electron_missing: the private Electron host runtime is not installed; run pnpm install, then node packages/electron-host/node_modules/electron/install.js in the Velocast workspace, or install a complete renderer bundle",
        { cause },
      );
    }
  }
  if (
    !isAbsolute(electron) ||
    !existsSync(electron) ||
    !statSync(electron).isFile()
  )
    throw new Error(
      "runtime.electron_missing: Electron executable is missing; install the pinned private host runtime or set VELOCAST_ELECTRON_BINARY to an existing absolute executable",
    );
  return {
    root: dirname(resolve(renderer)),
    renderer: resolve(renderer),
    electron,
    hostScript,
  };
}
