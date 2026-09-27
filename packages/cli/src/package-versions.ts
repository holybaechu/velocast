import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { VelocastReleaseManifest } from "./release-manifest.js";

const officialPackages = [
  "velocast",
  "@velocast/core",
  "@velocast/gsap",
] as const;

export function installedVelocastVersions(): Record<string, string> {
  const versions: Record<string, string> = {};
  const own = findPackageJson(dirname(fileURLToPath(import.meta.url)));
  if (own) {
    const metadata = readPackageMetadata(own);
    if (metadata.name === "velocast" && metadata.version) {
      versions.velocast = metadata.version;
    }
  }
  const require = createRequire(import.meta.url);
  for (const name of officialPackages.slice(1)) {
    try {
      const entry = require.resolve(name);
      const packageJson = findPackageJson(dirname(entry));
      if (!packageJson) continue;
      const metadata = readPackageMetadata(packageJson);
      if (metadata.name === name && metadata.version) {
        versions[name] = metadata.version;
      }
    } catch {
      // Optional official integration package is not installed.
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

function readPackageMetadata(path: string): {
  name?: string;
  version?: string;
} {
  return JSON.parse(readFileSync(path, "utf8")) as {
    name?: string;
    version?: string;
  };
}
