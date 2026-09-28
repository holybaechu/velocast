import { renderFrame, inspectCompositions } from "./commands.js";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createMediaSession,
  runMediaOperation,
  withMediaRuntimeContext,
} from "./media-runtime.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture(label: string) {
  const root = await mkdtemp(join(tmpdir(), "velocast-media-context-"));
  roots.push(root);
  const marker = {
    schema: "velocast-electron-runtime-v1",
    browserHost: "electron",
    platform: process.platform,
    arch: process.arch,
    renderer: process.platform === "win32" ? "renderer.exe" : "renderer",
    electron: "electron",
    hostScript: "host/main.cjs",
    mediaClient: "host/media-client.cjs",
    mediaBundle: "host/media-runtime.cjs",
  };
  for (const file of Object.values(marker).filter((value) =>
    [
      marker.renderer,
      marker.electron,
      marker.hostScript,
      marker.mediaClient,
      marker.mediaBundle,
    ].includes(value),
  )) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), "fixture");
  }
  await writeFile(join(root, "electron-runtime.json"), JSON.stringify(marker));
  await writeFile(
    join(root, marker.mediaClient),
    `const label=${JSON.stringify(label)}; const run=async(_operation,options)=>({label,binary:options.env.VELOCAST_ELECTRON_BINARY,host:options.env.VELOCAST_ELECTRON_HOST_SCRIPT});module.exports={runMediaOperation:run,createMediaSession:async(options)=>({run:operation=>run(operation,options),close:async()=>{}})};`,
  );
  return {
    root,
    binary: join(root, marker.renderer),
    electron: join(root, marker.electron),
    host: join(root, marker.hostScript),
  };
}
it("routes config-only installed bundles using their own media client and relative invocation directory", async () => {
  const f = await fixture("configured");
  const result = await withMediaRuntimeContext(
    {
      configuredBinary: relative(f.root, f.binary),
      cwd: f.root,
      env: { INIT_CWD: f.root },
    },
    () => runMediaOperation({ kind: "route-test" }),
  );
  expect(result).toEqual({
    label: "configured",
    binary: f.electron,
    host: f.host,
  });
});
it("keeps simultaneous source request contexts and persistent sessions isolated", async () => {
  const a = await fixture("A"),
    b = await fixture("B");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const before = { ...process.env };
  const first = withMediaRuntimeContext(
    { configuredBinary: a.binary, cwd: a.root, env: {} },
    async () => {
      await gate;
      const session = await createMediaSession();
      try {
        return await session.run({ kind: "route-test" });
      } finally {
        await session.close();
      }
    },
  );
  const second = withMediaRuntimeContext(
    { configuredBinary: b.binary, cwd: b.root, env: {} },
    async () => {
      const result = await runMediaOperation({ kind: "route-test" });
      release();
      return result;
    },
  );
  expect(await Promise.all([first, second])).toEqual([
    { label: "A", binary: a.electron, host: a.host },
    { label: "B", binary: b.electron, host: b.host },
  ]);
  expect(process.env).toEqual(before);
});
it("retains environment renderer precedence over the config without reusing another bundle's host", async () => {
  const a = await fixture("A"),
    b = await fixture("B");
  const result = await withMediaRuntimeContext(
    {
      configuredBinary: a.binary,
      cwd: a.root,
      env: {
        VELOCAST_RENDERER_BINARY: b.binary,
        VELOCAST_ELECTRON_BINARY: a.electron,
        VELOCAST_ELECTRON_HOST_SCRIPT: a.host,
      },
    },
    () => runMediaOperation({ kind: "route-test" }),
  );
  expect(result).toEqual({ label: "B", binary: b.electron, host: b.host });
});
it("does not resolve a runtime for metadata operations that never request media", async () => {
  expect(
    await withMediaRuntimeContext(
      { configuredBinary: "missing-runtime", env: {} },
      async () => "metadata",
    ),
  ).toBe("metadata");
});

it("carries each command's config through source preparation, capture and close", async () => {
  const a = await fixture("A"),
    b = await fixture("B");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
    "base64",
  );
  const render = async (f: Awaited<ReturnType<typeof fixture>>) => {
    const seen: string[] = [];
    await renderFrame(
      {
        renderer: { binary: relative(f.root, f.binary) },
        source: {
          kind: "test",
          entry: "fixture.tsx",
          async prepare() {
            seen.push(
              (
                await runMediaOperation<{ label: string }>({
                  kind: "route-test",
                })
              ).label,
            );
            return {
              compositions: [
                {
                  id: "Fixture",
                  width: 1,
                  height: 1,
                  fps: 30,
                  durationFrames: 1,
                },
              ],
              async renderFrame(_frame: number, output: string) {
                const session = await createMediaSession();
                try {
                  seen.push(
                    (
                      await session.run<{ label: string }>({
                        kind: "route-test",
                      })
                    ).label,
                  );
                  await writeFile(output, png);
                } finally {
                  await session.close();
                }
              },
              async close() {
                seen.push(
                  (
                    await runMediaOperation<{ label: string }>({
                      kind: "route-test",
                    })
                  ).label,
                );
              },
            };
          },
        },
      },
      "Fixture",
      join(f.root, "output.png"),
      { frame: 0 },
      {
        onOutputResult: () => {},
        pathOptions: {
          cwd: f.root,
          env: {
            INIT_CWD: f.root,
            VELOCAST_RENDERER_BINARY: "",
            VELOCAST_ELECTRON_BINARY: "",
            VELOCAST_ELECTRON_HOST_SCRIPT: "",
          },
        },
      },
    );
    return seen;
  };
  expect(await Promise.all([render(a), render(b)])).toEqual([
    ["A", "A", "A"],
    ["B", "B", "B"],
  ]);
});
it("keeps plain source metadata inspection lazy even with a missing configured runtime", async () => {
  await expect(
    inspectCompositions(
      {
        renderer: { binary: "not-installed" },
        source: {
          kind: "test",
          entry: "fixture.tsx",
          async prepare() {
            return {
              compositions: [
                {
                  id: "Fixture",
                  width: 1,
                  height: 1,
                  fps: 30,
                  durationFrames: 1,
                },
              ],
              async close() {},
            };
          },
        },
      },
      "Fixture",
      {},
      { onOutputResult: () => {} },
    ),
  ).resolves.toBeUndefined();
});
it("shares request context across separately loaded source and installed module instances", async () => {
  const f = await fixture("separate-module");
  const moduleUrl = "./media-runtime.js?separate-module";
  const alternate = (await import(
    moduleUrl
  )) as typeof import("./media-runtime.js");
  const result = await withMediaRuntimeContext(
    { configuredBinary: f.binary, cwd: f.root, env: {} },
    () => alternate.runMediaOperation({ kind: "route-test" }),
  );
  expect(result).toEqual({
    label: "separate-module",
    binary: f.electron,
    host: f.host,
  });
});
