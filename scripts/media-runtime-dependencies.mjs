import { createRequire } from "node:module";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

function packageRoot(name, from) {
  const require = createRequire(join(from, "package.json"));
  // Some ESM-only packages export neither a CommonJS entry nor package.json.
  for (const directory of require.resolve.paths(name) ?? []) {
    const candidate = join(directory, name);
    if (existsSync(join(candidate, "package.json")))
      return realpathSync(candidate);
  }
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    let directory = dirname(require.resolve(name));
    while (dirname(directory) !== directory) {
      const manifest = join(directory, "package.json");
      if (
        existsSync(manifest) &&
        JSON.parse(readFileSync(manifest, "utf8")).name === name
      )
        return directory;
      directory = dirname(directory);
    }
    throw new Error(`runtime.package_missing: ${name}`);
  }
}

// Materialize the installed production dependency graph, including platform
// bindings and licenses, without npm hooks, downloads, or pnpm store symlinks.
// Identical package instances are hoisted so Mediabunny's codec registry stays
// shared between the host and its server extension.
export function stageMediaDependencies({ host, output, mediabunny }) {
  host = resolve(host);
  output = resolve(output);
  const modules = join(output, "node_modules");
  const hoisted = new Map();
  const visited = new Set();
  const stagedSources = new Map();
  const packages = [];
  const stage = (name, source, parent = output) => {
    source = realpathSync(source);
    const manifest = JSON.parse(
      readFileSync(join(source, "package.json"), "utf8"),
    );
    if (manifest.name !== name)
      throw new Error(`runtime.package_identity: ${name}`);
    const previous = hoisted.get(name);
    // An intervening nested dependency may shadow the root's version.
    for (
      let directory = parent;
      directory.startsWith(output);
      directory = dirname(directory)
    ) {
      const visible = stagedSources.get(join(directory, "node_modules", name));
      if (visible) {
        if (visible === source) return;
        break;
      }
      if (directory === output) break;
    }
    const destination = previous
      ? join(parent, "node_modules", name)
      : join(modules, name);
    if (visited.has(destination)) return;
    visited.add(destination);
    stagedSources.set(destination, source);
    if (!previous) hoisted.set(name, { source, destination });
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, {
      recursive: true,
      dereference: true,
      force: false,
      errorOnExist: true,
      filter(file) {
        const first = relative(source, file).split(/[\\/]/)[0];
        // Published packages can use src/ as their runtime entrypoint (debug
        // does). Preserve package contents rather than guessing which folders
        // are development-only; omit dependency links and native build debris.
        return (
          !["node_modules", ".git"].includes(first) &&
          !/\.(pdb|lib|obj)$/i.test(basename(file))
        );
      },
    });
    packages.push({
      name,
      version: manifest.version,
      path: relative(output, destination).replaceAll("\\", "/"),
    });
    const optional = manifest.optionalDependencies ?? {};
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.peerDependencies,
      ...optional,
    };
    for (const dependency of Object.keys(dependencies).sort()) {
      let dependencyRoot;
      try {
        dependencyRoot = packageRoot(dependency, source);
      } catch (error) {
        if (
          dependency in optional ||
          manifest.peerDependenciesMeta?.[dependency]?.optional
        )
          continue;
        throw new Error(`runtime.package_missing: ${name} -> ${dependency}`, {
          cause: error,
        });
      }
      stage(dependency, dependencyRoot, destination);
    }
  };
  stage("mediabunny", resolve(mediabunny ?? packageRoot("mediabunny", host)));
  stage("@mediabunny/server", packageRoot("@mediabunny/server", host));
  return packages.sort((a, b) => a.path.localeCompare(b.path));
}
