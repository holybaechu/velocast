// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadProjectRemotionRuntime } from "./runtime-loader.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function project(
  options: {
    version?: string;
    bundlerVersion?: string;
    reactVersion?: string;
    reactDomVersion?: string;
    duplicateReact?: boolean;
    importError?: string;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "velocast-runtime-test-"));
  directories.push(directory);
  const version = options.version ?? "4.0.244";
  const reactVersion = options.reactVersion ?? "18.3.1";
  const packages = {
    remotion: version,
    "@remotion/bundler": options.bundlerVersion ?? version,
    react: reactVersion,
    "react-dom": options.reactDomVersion ?? reactVersion,
  };
  for (const [name, packageVersion] of Object.entries(packages)) {
    const path = join(directory, "node_modules", name);
    await mkdir(path, { recursive: true });
    await writeFile(
      join(path, "package.json"),
      JSON.stringify({ name, version: packageVersion, main: "index.js" }),
    );
    await writeFile(join(path, "index.js"), "module.exports = {};\n");
  }
  await writeFile(
    join(directory, "node_modules/@remotion/bundler/index.js"),
    options.importError
      ? `throw new TypeError(${JSON.stringify(options.importError)});`
      : "exports.bundle = () => 'project-local';",
  );
  const modern = version !== "4.0.244";
  await writeFile(
    join(directory, "node_modules/remotion/no-react.js"),
    `exports.NoReactInternals = {
    ${modern ? "serializeJSONWithSpecialTypes" : "serializeJSONWithDate"}: ({data}) => ({serializedString: JSON.stringify(data)}),
    ${modern ? "deserializeJSONWithSpecialTypes" : "deserializeJSONWithCustomFields"}: JSON.parse,
  };`,
  );
  if (options.duplicateReact) {
    const path = join(
      directory,
      "node_modules/@remotion/bundler/node_modules/react/package.json",
    );
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ name: "react", version: reactVersion }),
    );
  }
  return join(directory, "src/index.tsx");
}

it.each([
  ["4.0.244", "18.3.1", "legacy-4"],
  ["4.0.526", "18.3.1", "modern-4"],
  ["4.0.527", "19.2.0", "modern-4"],
  ["4.0.528", "19.2.0", "modern-4"],
  ["4.0.529", "19.2.0", "modern-4"],
])(
  "resolves %s and React %s from the entry project using %s",
  async (version, reactVersion, profile) => {
    const runtime = loadProjectRemotionRuntime(
      await project({ version, reactVersion }),
    );
    expect(runtime.version).toBe(version);
    expect(runtime.reactVersion).toBe(reactVersion);
    expect(runtime.profile.id).toBe(profile);
    expect(runtime.bundler.bundle).toBeTypeOf("function");
    expect(
      runtime.deserialize(
        runtime.serialize({
          data: { value: 12 },
          indent: undefined,
          staticBase: null,
        }).serializedString,
      ),
    ).toEqual({ value: 12 });
  },
);

it("rejects mismatched Remotion packages before loading their code", async () => {
  const entry = await project({ bundlerVersion: "4.0.529" });
  expect(() => loadProjectRemotionRuntime(entry)).toThrow(
    "Remotion packages must have matching versions",
  );
});

it.each(["4.0.245", "4.0.530", "5.0.0", "4.0.529-beta.1"])(
  "rejects unverified version %s",
  async (version) => {
    const entry = await project({ version });
    expect(() => loadProjectRemotionRuntime(entry)).toThrow(
      `Unsupported Remotion version ${version}`,
    );
  },
);

it("does not require the native upstream renderer package", async () => {
  const entry = await project();
  expect(() => loadProjectRemotionRuntime(entry)).not.toThrow();
});

it("rejects two React installations even when their versions match", async () => {
  const entry = await project({ duplicateReact: true });
  expect(() => loadProjectRemotionRuntime(entry)).toThrow(
    "@remotion/bundler resolves a different react installation",
  );
});

it("rejects mismatched React and React DOM versions", async () => {
  const entry = await project({ reactDomVersion: "18.2.0" });
  expect(() => loadProjectRemotionRuntime(entry)).toThrow(
    "React packages must have matching versions",
  );
});

it("rejects React versions outside an integration profile", async () => {
  const entry = await project({ reactVersion: "19.2.0" });
  expect(() => loadProjectRemotionRuntime(entry)).toThrow(
    "requires stable React 18",
  );
});

it("reports missing dependencies relative to the supplied entry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "velocast-empty-project-"));
  directories.push(directory);
  expect(() =>
    loadProjectRemotionRuntime(join(directory, "entry.tsx")),
  ).toThrow("Cannot resolve remotion from the Remotion entry project");
});

it("explains upstream's process-wide version conflict and preserves its cause", async () => {
  const importError =
    "🚨 Multiple versions of Remotion detected: 4.0.529 and 4.0.244. This will cause things to break in an unexpected way.";
  const entry = await project({ version: "4.0.529", importError });
  let failure: unknown;
  try {
    loadProjectRemotionRuntime(entry);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(
    "Run projects using different Remotion versions in separate Node processes",
  );
  expect((failure as Error).cause).toMatchObject({
    name: "TypeError",
    message: importError,
  });
});

it("keeps unrelated module import failures unchanged", async () => {
  const entry = await project({ importError: "custom module failure" });
  expect(() => loadProjectRemotionRuntime(entry)).toThrow(
    "custom module failure",
  );
});
