import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { RendererRuntimeResolver } from "./renderer-binary.js";
import { createInputSnapshot } from "./input-snapshot.js";
import { executeRendererJob } from "./commands.js";
import { failedOutputResult, type OutputResult } from "./output-result.js";
import type { RustRenderJob } from "./render-command-job.js";

const directories: string[] = [];
function fakeRuntimeResolver(): RendererRuntimeResolver {
  const resolver = new RendererRuntimeResolver();
  resolver.resolveProcessEnv = () => ({});
  return resolver;
}
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "velocast-output-command-"));
  directories.push(cwd);
  mkdirSync(join(cwd, "dist"));
  writeFileSync(join(cwd, "dist/index.html"), "frozen original");
  return {
    cwd,
    config: { entry: "dist/index.html", renderer: { snapshotRoot: "dist" } },
  };
}
const composition = {
  id: "hero",
  width: 320,
  height: 180,
  fps: 30,
  durationFrames: 120,
};
function nativeSuccess(job: RustRenderJob) {
  const result = {
    ...failedOutputResult(job, "pending"),
    status: "success",
    error: null,
    composition: job.composition_id ? composition : null,
    compositions: [composition],
    request: {
      compositionId: job.composition_id ?? null,
      frame: job.output_frame ?? null,
      range:
        job.operation === "inspect" || job.operation === "frame"
          ? null
          : (job.output_range ?? { startFrame: 0, endFrame: 120 }),
    },
  };
  writeFileSync(job.result_path!, JSON.stringify(result));
}

it("rejects changed preview source before acquiring or launching native and retains previous output", async () => {
  const { cwd, config } = fixture();
  const version = await createInputSnapshot({
    root: join(cwd, "dist"),
    entryPath: "index.html",
  });
  const expectedSourceVersion = version.session.sourceVersion;
  await version.close();
  writeFileSync(join(cwd, "dist/index.html"), "new authored version");
  writeFileSync(join(cwd, "previous.png"), "previous complete output");
  const acquire = vi.fn();
  const results: OutputResult[] = [];
  await expect(
    executeRendererJob(
      {
        kind: "frame",
        config,
        compositionId: "hero",
        frame: 12,
        output: "previous.png",
      },
      {
        expectedSourceVersion,
        pathOptions: { cwd, env: {} },
        runtimeAcquisition: { acquire },
        onOutputResult: (result) => results.push(result),
      },
    ),
  ).rejects.toThrow("snapshot.version_mismatch");
  expect(acquire).not.toHaveBeenCalled();
  expect(results[0]?.error?.code).toBe("snapshot.version_mismatch");
  expect(readFileSync(join(cwd, "previous.png"), "utf8")).toBe(
    "previous complete output",
  );
});

it.each([false, true])(
  "keeps the media service bound to the frozen job and closes it after native settles (failure=%s)",
  async (failed) => {
    const { cwd, config } = fixture();
    const order: string[] = [];
    let sourceUrl = "";
    let closed = false;
    const results: OutputResult[] = [];
    const run = executeRendererJob(
      { kind: "inspect", config },
      {
        pathOptions: { cwd, env: {} },
        runtimeAcquisition: {
          acquire: async () => ({
            binary: "native",
            env: { PATH: "private-media-tools" },
            source: "local" as const,
          }),
        },
        probeCapabilities: () => ({ available: true, outputApiVersion: 1 }),
        onOutputResult: (result) => results.push(result),
        createMediaService: (options) => {
          expect(options.env?.PATH).toBe("private-media-tools");
          return {
            async handle(_request, response, identity) {
              order.push("media");
              expect(identity.url).toBe(sourceUrl);
              expect(identity.session.sourceVersion).toMatch(/^[a-f0-9]{64}$/);
              response.end("decoded pixels");
            },
            async close() {
              order.push("close");
              expect(await (await fetch(sourceUrl)).text()).toBe(
                "frozen original",
              );
              closed = true;
            },
          };
        },
        runRenderer: async (_binary, value) => {
          const job = value as RustRenderJob;
          sourceUrl = job.serve_url;
          expect(
            await (
              await fetch(new URL("/__velocast-media/frame", sourceUrl))
            ).text(),
          ).toBe("decoded pixels");
          expect(closed).toBe(false);
          order.push("settled");
          if (failed) throw new Error("native failure");
          nativeSuccess(job);
        },
      },
    );
    if (failed) await expect(run).rejects.toThrow("native failure");
    else await run;
    expect(order).toEqual(["media", "settled", "close"]);
    await expect(fetch(sourceUrl)).rejects.toThrow();
  },
);

it("inspects through a frozen session and closes source/result lifetime after completion", async () => {
  const { cwd, config } = fixture(),
    results: OutputResult[] = [];
  let served = "",
    record = "";
  await executeRendererJob(
    { kind: "inspect", config, options: { json: true } },
    {
      pathOptions: { cwd, env: {} },
      runtimeResolver: fakeRuntimeResolver(),
      resolveRendererBinary: () => "native",
      probeCapabilities: () => ({ available: true, outputApiVersion: 1 }),
      onOutputResult: (value) => results.push(value),
      runRenderer: async (_binary, value) => {
        const job = value as RustRenderJob;
        served = job.serve_url;
        record = job.result_path!;
        expect(job.operation).toBe("inspect");
        expect(job.composition_id).toBeNull();
        writeFileSync(join(cwd, "dist/index.html"), "changed live source");
        expect(await (await fetch(served)).text()).toBe("frozen original");
        nativeSuccess(job);
      },
    },
  );
  expect(results[0]).toMatchObject({
    status: "success",
    operation: "inspect",
    sourceMode: "snapshot",
    compositions: [composition],
  });
  expect(existsSync(record)).toBe(false);
  await expect(fetch(served)).rejects.toThrow();
});

it("refuses an old native before launch and preserves an existing frame output", async () => {
  const { cwd, config } = fixture(),
    results: OutputResult[] = [];
  const output = join(cwd, "old.png");
  writeFileSync(output, "previous PNG");
  let launched = false;
  await expect(
    executeRendererJob(
      {
        kind: "frame",
        config,
        compositionId: "hero",
        frame: 12,
        output,
        options: { json: true },
      },
      {
        pathOptions: { cwd, env: {} },
        runtimeResolver: fakeRuntimeResolver(),
        resolveRendererBinary: () => "old-native",
        probeCapabilities: () => ({ available: true }),
        onOutputResult: (value) => results.push(value),
        runRenderer: async () => {
          launched = true;
        },
      },
    ),
  ).rejects.toThrow("output.native_incompatible");
  expect(launched).toBe(false);
  expect(readFileSync(output, "utf8")).toBe("previous PNG");
  expect(results[0]).toMatchObject({
    status: "failure",
    request: { compositionId: "hero", frame: 12 },
    error: { code: "output.native_incompatible" },
  });
});

it("passes a public range separately from worker fields and keeps source composition metadata", async () => {
  const { cwd, config } = fixture(),
    results: OutputResult[] = [];
  await executeRendererJob(
    {
      kind: "composition",
      config,
      compositionId: "hero",
      output: "range.mp4",
      options: { startFrame: 12, endFrame: 20, json: true },
    },
    {
      pathOptions: { cwd, env: {} },
      runtimeResolver: fakeRuntimeResolver(),
      resolveRendererBinary: () => "native",
      probeCapabilities: () => ({ available: true, outputApiVersion: 1 }),
      onOutputResult: (value) => results.push(value),
      runRenderer: async (_binary, value) => {
        const job = value as RustRenderJob;
        expect(job.output_range).toEqual({ startFrame: 12, endFrame: 20 });
        expect(job.frame_start).toBeUndefined();
        expect(job.frame_end).toBeUndefined();
        nativeSuccess(job);
      },
    },
  );
  expect(results[0]).toMatchObject({
    status: "success",
    composition: { durationFrames: 120 },
    request: { range: { startFrame: 12, endFrame: 20 } },
  });
});

it("treats a native zero exit without matching metadata as failure and preserves the original output", async () => {
  const { cwd, config } = fixture(),
    results: OutputResult[] = [];
  const output = join(cwd, "old.png");
  writeFileSync(output, "previous PNG");
  await expect(
    executeRendererJob(
      {
        kind: "frame",
        config,
        compositionId: "hero",
        frame: 12,
        output,
        options: { json: true },
      },
      {
        pathOptions: { cwd, env: {} },
        runtimeResolver: fakeRuntimeResolver(),
        resolveRendererBinary: () => "native",
        probeCapabilities: () => ({ available: true, outputApiVersion: 1 }),
        onOutputResult: (value) => results.push(value),
        runRenderer: async () => {},
      },
    ),
  ).rejects.toThrow("output.result_missing");
  expect(readFileSync(output, "utf8")).toBe("previous PNG");
  expect(results[0]?.status).toBe("failure");
});
