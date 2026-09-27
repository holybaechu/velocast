import { readFileSync } from "node:fs";
import { isAbsolute, posix, win32 } from "node:path";
import { assertNonEmptyString as assertNonEmptyStringInternal } from "./internal/validation.js";

export interface InvocationPathOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export function getInvocationCwd(options: InvocationPathOptions = {}): string {
  const env = options.env ?? process.env;
  if (env.INIT_CWD?.trim()) {
    return env.INIT_CWD;
  }
  if (options.cwd?.trim()) {
    return options.cwd;
  }
  return process.cwd();
}

export function resolvePathFrom(base: string, path: string): string {
  if (isAbsolutePath(path)) {
    return path;
  }

  return pathFlavorFor(base, path).resolve(base, path);
}

export function resolveCliOutputPath(
  output: string,
  options: InvocationPathOptions = {},
): string {
  assertNonEmptyString(output, "--output must be a non-empty string");

  return resolvePathFrom(getInvocationCwd(options), output);
}

export function resolveCliReportPath(
  reportPath: string | undefined,
  options: InvocationPathOptions = {},
  errorMessage = "renderer.reportPath must be a non-empty string",
): string | undefined {
  if (reportPath === undefined) {
    return undefined;
  }

  assertNonEmptyString(reportPath, errorMessage);

  return resolveCliOutputPath(reportPath, options);
}

export function resolveCliInputPropsPath(
  inputPropsPath: string | undefined,
  options: InvocationPathOptions = {},
): string | undefined {
  if (inputPropsPath === undefined) {
    return undefined;
  }

  assertNonEmptyString(
    inputPropsPath,
    "--input-props-file must be a non-empty string",
  );

  const resolved = resolveCliOutputPath(inputPropsPath, options);
  let contents: string;
  try {
    contents = readFileSync(resolved, "utf8");
  } catch (error) {
    throw new Error(
      `--input-props-file could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }

  try {
    JSON.parse(stripUtf8Bom(contents));
  } catch {
    throw new Error("--input-props-file must contain valid JSON");
  }

  return resolved;
}

function isAbsolutePath(path: string): boolean {
  return isAbsolute(path) || win32.isAbsolute(path) || posix.isAbsolute(path);
}

function pathFlavorFor(...paths: string[]): {
  resolve(...paths: string[]): string;
} {
  return paths.some(hasWindowsPathSyntax) ? win32 : posix;
}

function hasWindowsPathSyntax(path: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.startsWith("\\\\") ||
    path.includes("\\")
  );
}

export function assertNonEmptyString(
  value: unknown,
  errorMessage: string,
): asserts value is string {
  assertNonEmptyStringInternal(value, errorMessage);
}

function stripUtf8Bom(contents: string): string {
  return contents.charCodeAt(0) === 0xfeff ? contents.slice(1) : contents;
}
