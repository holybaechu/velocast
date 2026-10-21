import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { VelocastReleaseManifest } from "./release-manifest.js";

const officialPackages = [
  "velocast",
  "@velocast/core",
  "@velocast/gsap",
  "@velocast/react",
  "@velocast/preview",
  "@velocast/remotion",
  "@velocast/remotion-source",
] as const;

export function installedVelocastVersions(): Record<string, string> {
  const versions: Record<string, string> = {};
  const own = findPackageJson(dirname(fileURLToPath(import.meta.url)));
  if (!own)
    throw new Error(
      "package.metadata_invalid: cannot locate velocast/package.json",
    );
  versions.velocast = readPackageMetadata(own, "velocast").version;
  const require = createRequire(import.meta.url);
  for (const name of officialPackages.slice(1)) {
    for (const directory of require.resolve.paths(name) ?? []) {
      const packageJson = join(directory, name, "package.json");
      let metadata;
      try {
        metadata = readPackageMetadata(packageJson, name);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          (code === "ENOENT" || code === "ENOTDIR") &&
          !existsSync(join(directory, name))
        )
          continue;
        throw error;
      }
      versions[name] = metadata.version;
      break;
    }
  }
  return versions;
}

export function assertCompatibleVelocastVersions(
  manifest: VelocastReleaseManifest,
  versions = installedVelocastVersions(),
): void {
  for (const [name, version] of Object.entries(versions)) {
    if (version !== manifest.packageVersion) {
      throw new Error(
        `package.version_mismatch: ${name}@${version} is incompatible with Velocast ${manifest.packageVersion}; install matching versions of all official Velocast packages`,
      );
    }
  }
  if (
    manifest.productVersion !== manifest.packageVersion ||
    manifest.nativeRendererVersion !== manifest.packageVersion
  ) {
    throw new Error(
      "release.compatibility_invalid: product, package and native renderer versions must match for artifact schema 1",
    );
  }
}

function findPackageJson(start: string): string | undefined {
  let current = start;
  while (true) {
    const candidate = join(current, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function readPackageMetadata(
  path: string,
  name: string,
): { name: string; version: string } {
  const metadata: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    !metadata ||
    typeof metadata !== "object" ||
    !("name" in metadata) ||
    metadata.name !== name ||
    !("version" in metadata) ||
    typeof metadata.version !== "string" ||
    !metadata.version.trim()
  ) {
    throw new Error(
      `package.metadata_invalid: ${path} must identify ${name} and its version`,
    );
  }
  return { name, version: metadata.version };
}
