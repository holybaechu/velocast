import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { createProject } from "./init-command.js";
import { TEMPLATE_CATALOG } from "./template-catalog.js";

const roots: string[] = [];
const exec = promisify(execFile);
const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

async function buildProject(
  root: string,
  directory: string,
  sources?: Record<string, string>,
) {
  const slash = (value: string) => value.replaceAll("\\", "/");
  const testConfig = join(root, "vite.integration.config.mjs");
  const alias = (find: string, path: string) =>
    `{ find: ${JSON.stringify(find)}, replacement: ${JSON.stringify(slash(join(repositoryRoot, path)))} }`;
  await writeFile(
    testConfig,
    `${sources ? `import {studioSourcePlugin} from ${JSON.stringify(slash(join(repositoryRoot, "packages/cli/src/vite.ts")))};` : ""}
    export default {
      base: "./",
      ${sources ? `plugins: [studioSourcePlugin(${JSON.stringify(sources)})],` : ""}
      build: { outDir: ${JSON.stringify(slash(join(directory, "dist")))}, emptyOutDir: true },
      resolve: { alias: [
        ${alias("@velocast/react", "packages/react/src/index.ts")},
        ${alias("@velocast/core", "packages/core/src/index.ts")},
        ${alias("react-dom/client", "packages/react/node_modules/react-dom/client.js")},
        ${alias("react-dom", "packages/react/node_modules/react-dom/index.js")},
        ${alias("react/jsx-runtime", "packages/react/node_modules/react/jsx-runtime.js")},
        ${alias("react/jsx-dev-runtime", "packages/react/node_modules/react/jsx-dev-runtime.js")},
        ${alias("react", "packages/react/node_modules/react/index.js")}
      ] }
    };`,
  );
  const vite = join(
    repositoryRoot,
    "packages/studio/node_modules/vite/bin/vite.js",
  );
  await exec(
    process.execPath,
    [vite, "build", directory, "--config", testConfig],
    {
      cwd: repositoryRoot,
      timeout: 30_000,
    },
  );
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

it("creates and builds React demo and social compositions with real local audio", async () => {
  const root = await mkdtemp(join(tmpdir(), "velocast-project-build-"));
  roots.push(root);
  const result = await createProject(join(root, "video"));
  expect(result.template).toBe("product-demo");
  expect(result.files).toContain("src/social-card.jsx");
  await exec(
    process.execPath,
    [join(result.directory, "scripts/prepare-media.mjs")],
    { cwd: result.directory },
  );
  await buildProject(root, result.directory, {
    "product-demo": "src/product-demo.jsx",
    "social-card": "src/social-card.jsx",
  });
  const receipt = JSON.parse(
    await readFile(
      join(result.directory, "dist/_velocast-sources.json"),
      "utf8",
    ),
  );
  expect(receipt.revisions["product-demo"]).toBe(
    createHash("sha256")
      .update(await readFile(join(result.directory, "src/product-demo.jsx")))
      .digest("hex"),
  );
  const wav = await readFile(join(result.directory, "dist/assets/music.wav"));
  expect(wav.subarray(0, 4).toString()).toBe("RIFF");
  expect(wav.readUInt32LE(24)).toBe(48000);
  expect(wav.readUInt32LE(40)).toBe(30 * 48000 * 2);
  expect(wav.subarray(44).some((value) => value !== 0)).toBe(true);
  expect(
    await readFile(join(result.directory, "dist/assets/overview.svg"), "utf8"),
  ).toContain("<svg");
  expect(TEMPLATE_CATALOG.map((entry) => entry.id)).toEqual([
    "product-demo",
    "blank",
  ]);
}, 30_000);

it("builds the blank project without media setup", async () => {
  const root = await mkdtemp(join(tmpdir(), "velocast-blank-build-"));
  roots.push(root);
  const result = await createProject(join(root, "video"), {
    template: "blank",
  });
  await buildProject(root, result.directory, { video: "src/video.jsx" });
  expect(
    await readFile(join(result.directory, "dist/index.html"), "utf8"),
  ).toContain('type="module"');
}, 30_000);
