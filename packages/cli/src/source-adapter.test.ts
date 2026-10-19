import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Config,
  PreparedSource,
  SourceAdapterContext,
} from "@velocast/core";
import { afterEach, expect, it, vi } from "vitest";
import {
  executeRendererJob,
  inspectCompositions,
  renderComposition,
  renderFrame,
  type RendererRunDependencies,
} from "./commands.js";
import { normalizeConfigEntryFromConfigDir } from "./render-source.js";
import type { OutputResult } from "./output-result.js";
import { previewCommand } from "./preview-command.js";
import { createPreviewServer } from "./preview-server.js";

const temporary: string[] = [];
const composition = {
  id: "Intro",
  width: 1,
  height: 1,
  fps: 30,
  durationFrames: 60,
};
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
  "base64",
);

function nativeResult(
  outputPath: string,
  overrides: Partial<NonNullable<OutputResult["composition"]>> = {},
): OutputResult {
  return {
    apiVersion: 1,
    status: "success",
    operation: "render",
    renderSession: { sessionId: "native-session" },
    sourceMode: "unversioned",
    composition: { ...composition, ...overrides },
    compositions: [{ ...composition, ...overrides }],
    request: {
      compositionId: "Intro",
      frame: null,
      range: { startFrame: 0, endFrame: 60 },
    },
    outputPath,
    error: null,
  };
}

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "velocast-adapter-test-"));
  temporary.push(path);
  return path;
}

function fixture(source: Partial<PreparedSource> = {}) {
  const close = vi.fn(async () => {});
  const prepare = vi.fn(
    async (context: SourceAdapterContext): Promise<PreparedSource> => {
      void context;
      return {
        compositions: [composition],
        close,
        ...source,
      };
    },
  );
  const config: Config = {
    source: { kind: "test", entry: "src/index.tsx", prepare },
  };
  const results: OutputResult[] = [];
  const dependencies: RendererRunDependencies = {
    onOutputResult: (result) => {
      results.push(result);
    },
    pathOptions: { cwd: process.cwd(), env: {} },
    resolveRendererBinary: () => {
      throw new Error("unexpected native runtime acquisition");
    },
  };
  return { config, prepare, close, results, dependencies };
}

afterEach(async () => {
  for (const path of temporary.splice(0))
    await rm(path, { recursive: true, force: true });
});

it("lists and inspects source metadata through the common Node API without a native runtime", async () => {
  const f = fixture();
  await inspectCompositions(
    f.config,
    undefined,
    { json: true },
    f.dependencies,
  );
  await inspectCompositions(f.config, "Intro", {}, f.dependencies);
  expect(f.results[0]).toMatchObject({
    status: "success",
    operation: "inspect",
    composition: null,
    compositions: [composition],
    sourceMode: "unversioned",
  });
  expect(f.results[1]?.composition).toEqual(composition);
  expect(f.close).toHaveBeenCalledTimes(2);
});

it("normalizes a source entry from the config directory and preserves adapter method binding", async () => {
  const f = fixture();
  const root = await directory();
  const normalized = normalizeConfigEntryFromConfigDir(f.config, root);
  await inspectCompositions(normalized, undefined, {}, f.dependencies);
  expect(f.prepare.mock.calls[0]?.[0].entry).toBe(join(root, "src/index.tsx"));
  for (const conflicting of [
    { entry: "other" },
    { serve: {} },
    { renderer: { snapshotRoot: "dist" } },
  ])
    expect(() =>
      normalizeConfigEntryFromConfigDir({ ...f.config, ...conflicting }, root),
    ).toThrow("source.config_conflict");
});

it("captures props once and routes native video, source audio, and cleanup through the transaction", async () => {
  const root = await directory();
  const propsPath = join(root, "props.json");
  await writeFile(
    propsPath,
    JSON.stringify({ title: "original", nested: { count: 1 } }),
  );
  const order: string[] = [];
  const f = fixture({
    url: "http://localhost:1234",
    renderAudio: async () => {
      order.push("audio");
      return null;
    },
    close: async () => {
      order.push("close");
    },
  });
  let frozen: string | undefined;
  await renderComposition(
    f.config,
    "Intro",
    join(root, "video.mp4"),
    { inputPropsFile: propsPath, codec: "h264", bitrate: "4M" },
    {
      ...f.dependencies,
      executeNativeSourceJob: async (request, dependencies) => {
        order.push("video");
        expect(request.config.source).toBeUndefined();
        expect(request.config.serve?.url).toBe("http://localhost:1234");
        expect(request.options).toMatchObject({ codec: "h264", bitrate: "4M" });
        await writeFile(propsPath, JSON.stringify({ title: "changed" }));
        frozen = request.options?.inputPropsFile;
        expect(JSON.parse(await readFile(frozen!, "utf8"))).toEqual({
          title: "original",
          nested: { count: 1 },
        });
        dependencies!.onOutputResult!(
          nativeResult("output" in request ? request.output : ""),
        );
      },
      renderSourceOutput: async (options) => {
        await options.renderVideo(join(root, "stage.mp4"), options.signal!);
        await options.renderAudio(join(root, "stage.aac"), options.signal!);
        order.push("publish");
        return options.output;
      },
    },
  );
  expect(order).toEqual(["video", "audio", "close", "publish"]);
  const props = f.prepare.mock.calls[0]![0].inputProps;
  expect(Object.isFrozen(props)).toBe(true);
  expect(Object.isFrozen(props.nested)).toBe(true);
  await expect(readFile(frozen!)).rejects.toThrow();
  expect(f.results[0]).toMatchObject({
    operation: "render",
    status: "success",
    request: { range: { startFrame: 0, endFrame: 60 } },
    outputPath: join(root, "video.mp4"),
  });
});

it("publishes a reference frame only after source cleanup and reports the final path", async () => {
  const root = await directory();
  const output = join(root, "frame.png");
  await writeFile(output, "old frame");
  const f = fixture({
    renderFrame: async (frame, path) => {
      expect(frame).toBe(42);
      expect(path).not.toBe(output);
      await writeFile(path, png);
    },
    close: async () => {
      expect(await readFile(output, "utf8")).toBe("old frame");
    },
  });
  await renderFrame(f.config, "Intro", output, { frame: 42 }, f.dependencies);
  expect(await readFile(output)).toEqual(png);
  expect(await readdir(root)).toEqual(["frame.png"]);
  expect(f.results[0]).toMatchObject({
    status: "success",
    operation: "frame",
    outputPath: output,
    request: { frame: 42 },
  });
});

it.each(["render", "close", "invalid", "cancel"])(
  "preserves an existing frame on %s failure",
  async (failure) => {
    const root = await directory();
    const output = join(root, "frame.png");
    await writeFile(output, "old frame");
    const controller = new AbortController();
    const close = vi.fn(async () => {
      if (failure === "close") throw new Error("close failed");
    });
    const f = fixture({
      close,
      renderFrame: async (_frame, path) => {
        await writeFile(path, failure === "invalid" ? "invalid" : png);
        if (failure === "render") throw new Error("render failed");
        if (failure === "cancel") controller.abort();
      },
    });
    await expect(
      renderFrame(
        f.config,
        "Intro",
        output,
        { frame: 0 },
        { ...f.dependencies, signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(await readFile(output, "utf8")).toBe("old frame");
    expect(close).toHaveBeenCalledTimes(1);
    expect(await readdir(root)).toEqual(["frame.png"]);
    expect(f.results[0]?.status).toBe("failure");
  },
);

it("rejects unsupported range and reference options without silently changing the request", async () => {
  const f = fixture({ renderVideo: async () => {} });
  await expect(
    renderComposition(
      f.config,
      "Intro",
      "video.mp4",
      { startFrame: 1, endFrame: 2 },
      f.dependencies,
    ),
  ).rejects.toThrow("source.range_unsupported");
  expect(f.prepare).not.toHaveBeenCalled();
  await expect(
    renderComposition(
      f.config,
      "Intro",
      "video.mp4",
      { codec: "h265" },
      f.dependencies,
    ),
  ).rejects.toThrow("source.option_unsupported");
  await expect(
    renderComposition(
      f.config,
      "Intro",
      "video.mp4",
      { mediaBackend: "native" },
      f.dependencies,
    ),
  ).rejects.toThrow(
    "source.option_unsupported: source renderer override cannot honor mediaBackend",
  );
  expect(f.close).toHaveBeenCalledTimes(2);
});

it("cleans up after missing composition or malformed source metadata", async () => {
  const f = fixture();
  await expect(
    inspectCompositions(f.config, "Missing", {}, f.dependencies),
  ).rejects.toThrow("source.composition_missing");
  expect(f.close).toHaveBeenCalledOnce();
  const invalid = fixture({ compositions: [composition, composition] });
  await expect(
    inspectCompositions(invalid.config, undefined, {}, invalid.dependencies),
  ).rejects.toThrow("source.invalid_compositions");
  expect(invalid.close).toHaveBeenCalledOnce();
});

it("rejects snapshot identity and unsupported operations with structured failures", async () => {
  const f = fixture();
  await expect(
    inspectCompositions(
      f.config,
      undefined,
      {},
      { ...f.dependencies, expectedSourceVersion: "a".repeat(64) },
    ),
  ).rejects.toThrow("source.version_unsupported");
  await expect(
    executeRendererJob(
      {
        kind: "url",
        config: f.config,
        url: "https://example.com",
        selector: "body",
        output: "video.mp4",
      },
      f.dependencies,
    ),
  ).rejects.toThrow("source.operation_unsupported");
  expect(f.results).toHaveLength(2);
  expect(f.prepare).not.toHaveBeenCalled();
});

it.each([
  { id: "Other" },
  { width: 2 },
  { height: 2 },
  { fps: 24 },
  { durationFrames: 61 },
  { target: "#other" },
])(
  "preserves existing output when native metadata differs: %j",
  async (changed) => {
    const root = await directory();
    const output = join(root, "frame.png");
    await writeFile(output, "previous frame");
    const f = fixture({ url: "http://localhost:1234" });
    await expect(
      renderFrame(
        f.config,
        "Intro",
        output,
        { frame: 0 },
        {
          ...f.dependencies,
          executeNativeSourceJob: async (request, dependencies) => {
            const path = "output" in request ? request.output : "";
            await writeFile(path, png);
            dependencies!.onOutputResult!({
              ...nativeResult(path, changed),
              operation: "frame",
              request: { compositionId: "Intro", frame: 0, range: null },
            });
          },
        },
      ),
    ).rejects.toThrow("source.manifest_mismatch");
    expect(await readFile(output, "utf8")).toBe("previous frame");
    expect(f.close).toHaveBeenCalledOnce();
    expect(await readdir(root)).toEqual(["frame.png"]);
  },
);

it.each(["header", "truncated", "trailing"])(
  "preserves existing output for a %s PNG",
  async (invalid) => {
    const root = await directory();
    const output = join(root, "frame.png");
    await writeFile(output, "previous frame");
    const bytes =
      invalid === "header"
        ? png.subarray(0, 33)
        : invalid === "truncated"
          ? png.subarray(0, png.length - 1)
          : Buffer.concat([png, Buffer.from("trailing")]);
    const f = fixture({
      renderFrame: async (_frame, path) => {
        await writeFile(path, bytes);
      },
    });
    await expect(
      renderFrame(f.config, "Intro", output, { frame: 0 }, f.dependencies),
    ).rejects.toThrow("source.frame_invalid");
    expect(await readFile(output, "utf8")).toBe("previous frame");
    expect(f.close).toHaveBeenCalledOnce();
    expect(await readdir(root)).toEqual(["frame.png"]);
  },
);

it("accepts consumed CLI routing options for reference frame rendering", async () => {
  const root = await directory();
  const output = join(root, "frame.png");
  const f = fixture({
    renderFrame: async (_frame, path) => {
      await writeFile(path, png);
    },
  });
  const options = { frame: 0, config: "velocast.config.ts", output, "--": [] };
  await renderFrame(f.config, "Intro", output, options, f.dependencies);
  expect(f.results[0]?.status).toBe("success");
});

it("rejects source preview before starting watchers or acquiring runtime", async () => {
  const f = fixture();
  const createServer = vi.fn();
  await expect(previewCommand(f.config, {}, { createServer })).rejects.toThrow(
    "preview.source_unsupported",
  );
  await expect(createPreviewServer(f.config)).rejects.toThrow(
    "preview.source_unsupported",
  );
  expect(createServer).not.toHaveBeenCalled();
  expect(f.prepare).not.toHaveBeenCalled();
});
