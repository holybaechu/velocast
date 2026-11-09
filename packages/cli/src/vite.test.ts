import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { studioSourcePlugin } from "./vite.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const finish of cleanup.splice(0).reverse()) await finish();
});
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "velocast-build-receipt-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"));
  await writeFile(
    join(root, "index.html"),
    '<script type="module" src="/src/main.js"></script>',
  );
  await writeFile(
    join(root, "src/main.js"),
    'import { answer } from "./demo.js"; document.body.textContent = answer;',
  );
  const source = '\ufeff// Authored bytes\r\nexport const answer = "café";\r\n';
  await writeFile(join(root, "src/demo.js"), source);
  const vite = await import(
    new URL(
      "../../studio/node_modules/vite/dist/node/index.js",
      import.meta.url,
    ).href
  );
  return {
    root,
    source,
    build: vite.build,
    receipt: async () =>
      JSON.parse(
        await readFile(join(root, "dist/_velocast-sources.json"), "utf8"),
      ),
  };
}

it("emits exact loaded source hashes and updates comment-only watch builds while reusing unchanged modules", async () => {
  const f = await fixture();
  let builds = 0;
  const errors: Error[] = [];
  const watcher = await f.build({
    root: f.root,
    configFile: false,
    logLevel: "silent",
    plugins: [
      studioSourcePlugin({ demo: "src/demo.js" }),
      {
        name: "observe-completed-test-builds",
        writeBundle() {
          builds++;
        },
      },
    ],
    build: { watch: {}, emptyOutDir: false },
  });
  cleanup.push(() => watcher.close());
  watcher.on("event", (event: { code: string; error?: Error }) => {
    if (event.code === "ERROR") errors.push(event.error!);
  });
  await vi.waitFor(
    async () =>
      expect(await f.receipt()).toEqual({
        version: 1,
        revisions: { demo: hash(f.source) },
      }),
    { timeout: 5000 },
  );
  const assets = join(f.root, "dist/assets");
  const javascript = (await readdir(assets)).find((name) =>
    name.endsWith(".js"),
  )!;
  const originalBundle = await readFile(join(assets, javascript), "utf8");
  const comment =
    f.source +
    "// A comment changes the saved source, not the rendered JavaScript.\r\n";
  await writeFile(join(f.root, "src/demo.js"), comment);
  await vi.waitFor(
    async () =>
      expect(await f.receipt()).toEqual({
        version: 1,
        revisions: { demo: hash(comment) },
      }),
    { timeout: 5000 },
  );
  expect(await readFile(join(assets, javascript), "utf8")).toBe(originalBundle);
  const before = builds;
  await writeFile(
    join(f.root, "src/main.js"),
    'import { answer } from "./demo.js"; document.body.textContent = answer + "!";',
  );
  await vi.waitFor(() => expect(builds).toBeGreaterThan(before), {
    timeout: 5000,
  });
  expect((await f.receipt()).revisions.demo).toBe(hash(comment));
  await writeFile(join(f.root, "src/demo.js"), "export const invalid = <");
  await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0), {
    timeout: 5000,
  });
  expect((await f.receipt()).revisions.demo).toBe(hash(comment));
}, 30_000);

it("refuses a receipt for a configured source absent from the current compiled graph", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "src/missing.js"), "export const unused = 1;");
  await expect(
    f.build({
      root: f.root,
      configFile: false,
      logLevel: "silent",
      plugins: [
        studioSourcePlugin({ demo: "src/demo.js", missing: "src/missing.js" }),
      ],
    }),
  ).rejects.toThrow("missing");
});

it("records the loaded bytes when a source file changes after loading but before output publication", async () => {
  const f = await fixture();
  const changed = f.source + "// Written during compilation\n";
  await f.build({
    root: f.root,
    configFile: false,
    logLevel: "silent",
    plugins: [
      studioSourcePlugin({ demo: "src/demo.js" }),
      {
        name: "external-source-edit-during-build",
        async transform(_code: string, id: string) {
          if (id.replaceAll("\\", "/").endsWith("/src/demo.js"))
            await writeFile(join(f.root, "src/demo.js"), changed);
        },
      },
    ],
  });
  expect(await readFile(join(f.root, "src/demo.js"), "utf8")).toBe(changed);
  expect((await f.receipt()).revisions.demo).toBe(hash(f.source));
});

it.each([false, true])(
  "preserves the last receipt when a later asynchronous output hook fails (previous build: %s)",
  async (previousBuild) => {
    const f = await fixture();
    const config = {
      root: f.root,
      configFile: false,
      logLevel: "silent",
      build: { emptyOutDir: false },
    };
    if (previousBuild)
      await f.build({
        ...config,
        plugins: [studioSourcePlugin({ demo: "src/demo.js" })],
      });
    await writeFile(
      join(f.root, "src/demo.js"),
      f.source + "// New revision\n",
    );
    await expect(
      f.build({
        ...config,
        plugins: [
          studioSourcePlugin({ demo: "src/demo.js" }),
          {
            name: "late-output-failure",
            async writeBundle() {
              await new Promise((resolve) => setTimeout(resolve, 120));
              throw new Error("output hook failed");
            },
          },
        ],
      }),
    ).rejects.toThrow("output hook failed");
    if (previousBuild)
      expect((await f.receipt()).revisions.demo).toBe(hash(f.source));
    else await expect(f.receipt()).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("rejects another post-output hook with actionable ordering guidance", async () => {
  const f = await fixture();
  await expect(
    f.build({
      root: f.root,
      configFile: false,
      logLevel: "silent",
      plugins: [
        studioSourcePlugin({ demo: "src/demo.js" }),
        {
          name: "another-post-publisher",
          writeBundle: { order: "post", handler() {} },
        },
      ],
    }),
  ).rejects.toThrow(
    "studio.source_hook_order: another-post-publisher must use a regular writeBundle hook",
  );
  await expect(f.receipt()).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects output-only post hooks before replacing the previous receipt", async () => {
  const f = await fixture();
  const config = {
    root: f.root,
    configFile: false,
    logLevel: "silent",
  };
  await f.build({
    ...config,
    plugins: [studioSourcePlugin({ demo: "src/demo.js" })],
  });
  await writeFile(join(f.root, "src/demo.js"), f.source + "// New revision\n");
  await expect(
    f.build({
      ...config,
      plugins: [studioSourcePlugin({ demo: "src/demo.js" })],
      build: {
        emptyOutDir: false,
        rolldownOptions: {
          output: {
            plugins: [
              {
                name: "output-only-post-publisher",
                writeBundle: {
                  order: "post",
                  async handler() {
                    await new Promise((resolve) => setTimeout(resolve, 120));
                    throw new Error("output-only hook failed");
                  },
                },
              },
            ],
          },
        },
      },
    }),
  ).rejects.toThrow(
    "studio.source_hook_order: output-only-post-publisher must use a regular writeBundle hook",
  );
  expect((await f.receipt()).revisions.demo).toBe(hash(f.source));
});
