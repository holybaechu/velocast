import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type * as Bundler from "@remotion/bundler";
import {
  selectRemotionIntegrationProfile,
  type RemotionIntegrationProfile,
} from "./profiles.js";

type Serializer = (options: {
  data: Record<string, unknown>;
  indent: number | undefined;
  staticBase: string | null;
}) => { serializedString: string };
type Deserializer = <T = Record<string, unknown>>(data: string) => T;

export interface ProjectRemotionRuntime {
  readonly version: string;
  readonly reactVersion: string;
  readonly profile: RemotionIntegrationProfile;
  readonly bundler: typeof Bundler;
  readonly serialize: Serializer;
  readonly deserialize: Deserializer;
}

function requireFunction(value: unknown, name: string, version: string): void {
  if (typeof value !== "function")
    throw new Error(
      `Remotion ${version} is missing required capability ${name}. Reinstall the project's matching Remotion packages.`,
    );
}

function isProjectDependency(
  entryPoint: string,
  name: string,
  resolvedPath: string,
): boolean {
  // createRequire also searches NODE_PATH. Package-manager launchers can put
  // Velocast's own dependencies there, which must never satisfy project imports.
  for (
    let directory = dirname(resolve(entryPoint));
    ;
    directory = dirname(directory)
  ) {
    const candidate = join(directory, "node_modules", name, "package.json");
    if (
      existsSync(candidate) &&
      // Native realpath also normalizes Windows drive casing and short names.
      realpathSync.native(candidate) === realpathSync.native(resolvedPath)
    )
      return true;
    if (dirname(directory) === directory) return false;
  }
}

/** Resolves only from the entry project, never from Velocast's installation. */
export function loadProjectRemotionRuntime(
  entryPoint: string,
): ProjectRemotionRuntime {
  const projectRequire = createRequire(resolve(entryPoint));
  const packages = new Map<string, { version: string; path: string }>();
  for (const name of ["remotion", "@remotion/bundler", "react", "react-dom"]) {
    try {
      const path = projectRequire.resolve(`${name}/package.json`);
      if (!isProjectDependency(entryPoint, name, path))
        throw new Error(
          `Resolved outside the entry project's dependency tree (for example, through NODE_PATH): ${path}`,
        );
      const manifest = projectRequire(path) as { version?: unknown };
      if (typeof manifest.version !== "string")
        throw new Error("package.json has no version");
      packages.set(name, { version: manifest.version, path });
    } catch (cause) {
      throw new Error(
        `Cannot resolve ${name} from the Remotion entry project (${resolve(entryPoint)}). Install ${name} in that project's dependencies.`,
        { cause },
      );
    }
  }
  const version = packages.get("remotion")!.version;
  for (const name of ["@remotion/bundler"]) {
    if (packages.get(name)!.version !== version)
      throw new Error(
        `Remotion packages must have matching versions: remotion@${version}, ${name}@${packages.get(name)!.version}. Update the entry project's dependencies and lockfile together.`,
      );
  }
  const profile = selectRemotionIntegrationProfile(version);
  const reactVersion = packages.get("react")!.version;
  if (packages.get("react-dom")!.version !== reactVersion)
    throw new Error(
      `React packages must have matching versions: react@${reactVersion}, react-dom@${packages.get("react-dom")!.version}.`,
    );
  if (
    !/^\d+\.\d+\.\d+$/.test(reactVersion) ||
    !profile.reactMajors.includes(Number(reactVersion.split(".")[0]))
  )
    throw new Error(
      `Remotion ${version}'s ${profile.id} integration profile requires stable React ${profile.reactMajors.join(" or ")}; found ${reactVersion}.`,
    );

  // Upstream webpack aliases use its own package resolution. Checking the actual
  // singleton prevents those aliases from silently replacing the user's runtime.
  for (const owner of ["remotion", "@remotion/bundler", "react-dom"]) {
    const ownerRequire = createRequire(packages.get(owner)!.path);
    for (const dependency of owner === "react-dom"
      ? ["react"]
      : ["remotion", "react", "react-dom"]) {
      let actual: string;
      try {
        actual = realpathSync.native(
          ownerRequire.resolve(`${dependency}/package.json`),
        );
      } catch (cause) {
        throw new Error(
          `${owner} cannot resolve the project's ${dependency} singleton. Reinstall the project's dependencies.`,
          { cause },
        );
      }
      if (actual !== realpathSync.native(packages.get(dependency)!.path))
        throw new Error(
          `${owner} resolves a different ${dependency} installation than the entry project. Deduplicate the project's ${dependency} dependency to preserve a single runtime.`,
        );
    }
  }
  const loadModule = (name: string): unknown => {
    try {
      return projectRequire(name);
    } catch (cause) {
      if (
        cause instanceof Error &&
        cause.message.includes("Multiple versions of Remotion detected:")
      ) {
        throw new Error(
          `Cannot load Remotion ${version} for ${resolve(entryPoint)} because another Remotion version is already loaded in this Node process. Remotion permits only one version per process. Run projects using different Remotion versions in separate Node processes (for example, separate Velocast CLI invocations).`,
          { cause },
        );
      }
      throw cause;
    }
  };
  const bundler = loadModule("@remotion/bundler") as typeof Bundler;
  const noReact = loadModule("remotion/no-react") as {
    NoReactInternals?: Record<string, unknown>;
  };
  requireFunction(bundler.bundle, "bundle", version);
  requireFunction(
    noReact.NoReactInternals?.[profile.serialize],
    profile.serialize,
    version,
  );
  requireFunction(
    noReact.NoReactInternals?.[profile.deserialize],
    profile.deserialize,
    version,
  );
  return {
    version,
    reactVersion,
    profile,
    bundler,
    serialize: noReact.NoReactInternals![profile.serialize] as Serializer,
    deserialize: noReact.NoReactInternals![profile.deserialize] as Deserializer,
  };
}
