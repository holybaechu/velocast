// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
import { fileURLToPath } from "node:url";

const upstream = vi.hoisted(() => ({
  bundle: vi.fn(),
  closeBrowser: vi.fn(),
  closeServer: vi.fn(),
  selectComposition: vi.fn(),
  renderMedia: vi.fn(),
  renderStill: vi.fn(),
  getCompositions: vi.fn(),
  cancel: vi.fn(),
  assetDir: "",
  modern: false,
}));
vi.mock("./runtime-loader.js", async () => {
  const { NoReactInternals } = await import("remotion/no-react");
  return {
    loadProjectRemotionRuntime: () => ({
      version: "4.0.244",
      reactVersion: "18.3.1",
      profile: {
        id: upstream.modern ? "modern-4" : "legacy-4",
        serverThreads: upstream.modern
          ? "offthreadVideoThreads"
          : "concurrency",
        metadataLogLevelBug: !upstream.modern,
        browserClose: upstream.modern ? "options" : "positional",
      },
      serialize: NoReactInternals.serializeJSONWithDate,
      deserialize: NoReactInternals.deserializeJSONWithCustomFields,
      bundler: { bundle: upstream.bundle },
      renderer: {
        openBrowser: vi.fn(async () => ({ close: upstream.closeBrowser })),
        makeCancelSignal: () => ({
          cancel: upstream.cancel,
          cancelSignal: () => {},
        }),
        selectComposition: upstream.selectComposition,
        getCompositions: upstream.getCompositions,
        renderMedia: upstream.renderMedia,
        renderStill: upstream.renderStill,
        RenderInternals: {
          makeDownloadMap: () => ({ assetDir: upstream.assetDir }),
          serveStatic: vi.fn(async () => ({
            port: 3100,
            close: upstream.closeServer,
          })),
        },
      },
    }),
  };
});

import {
  prepareRemotionSource,
  discoverRemotionCompositions,
} from "./upstream-host.js";

let directory: string;
const entryPoint = fileURLToPath(import.meta.url);
const composition = {
  id: "Original",
  width: 64,
  height: 64,
  durationInFrames: 2,
  fps: 30,
  props: { date: new Date("2025-01-01T00:00:00Z") },
  defaultProps: {},
};

beforeEach(async () => {
  vi.clearAllMocks();
  upstream.modern = false;
  directory = await mkdtemp(join(tmpdir(), "velocast-host-test-"));
  upstream.assetDir = join(directory, "assets");
  await mkdir(upstream.assetDir);
  await writeFile(join(directory, "caller-owned.txt"), "keep");
  upstream.bundle.mockImplementation(async ({ outDir }: { outDir: string }) => {
    await mkdir(outDir, { recursive: true });
    await writeFile(
      join(outDir, "index.html"),
      '<html><head></head><body><script>window.process={env:{}}</script><script src="/bundle.js"></script></body></html>',
    );
    return outDir;
  });
  upstream.selectComposition.mockResolvedValue(composition);
  upstream.getCompositions.mockResolvedValue([composition]);
  upstream.renderStill.mockResolvedValue({ buffer: null });
  upstream.renderMedia.mockResolvedValue({ buffer: null });
  upstream.closeBrowser.mockResolvedValue(undefined);
  upstream.closeServer.mockResolvedValue(undefined);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it("keeps the original HTML and installs the native bridge only in its copy", async () => {
  const source = await prepareRemotionSource({
    entryPoint,
    compositionId: "Original",
    workDirectory: directory,
  });
  try {
    const ownedDirectory = (await readdir(directory)).find((name) =>
      name.startsWith("velocast-remotion-"),
    )!;
    const original = await readFile(
      join(directory, ownedDirectory, "bundle/index.html"),
      "utf8",
    );
    const native = await readFile(
      join(directory, ownedDirectory, "bundle/velocast.html"),
      "utf8",
    );
    expect(original).not.toContain("__velocast");
    expect(native).toContain("__velocast");
    expect(native.indexOf("window.process={env:{}}")).toBeLessThan(
      native.indexOf("__velocast"),
    );
    expect(native.indexOf("__velocast")).toBeLessThan(
      native.indexOf('src="/bundle.js"'),
    );
    expect(source.url).toBe("http://localhost:3100/velocast.html");
    expect(source.composition).toEqual(composition);
    expect(upstream.bundle.mock.calls[0]![0]).not.toHaveProperty(
      "webpackOverride",
    );
  } finally {
    await source.close();
  }
  expect(await readdir(directory)).toEqual(["caller-owned.txt"]);
  await source.close();
  expect(upstream.closeBrowser).toHaveBeenCalledTimes(1);
  expect(upstream.closeServer).toHaveBeenCalledTimes(1);
});

it("uses upstream audio and reference rendering with the original props and URL", async () => {
  const inputProps = { text: "hello" };
  const source = await prepareRemotionSource({
    entryPoint,
    compositionId: "Original",
    inputProps,
    workDirectory: directory,
  });
  try {
    expect(await source.renderAudio(join(directory, "audio.wav"))).toBe(
      join(directory, "audio.wav"),
    );
    await source.renderReference(join(directory, "reference.mp4"));
    const [audio, reference] = upstream.renderMedia.mock.calls.map(
      ([options]) => options,
    );
    expect(audio).toMatchObject({
      codec: "wav",
      inputProps,
      composition,
      serveUrl: "http://localhost:3100",
    });
    expect(reference).toMatchObject({
      codec: "h264",
      inputProps,
      composition,
      serveUrl: "http://localhost:3100",
    });
    upstream.renderMedia.mockRejectedValueOnce(
      new Error(
        "The output format has neither audio nor video. This can happen if you are rendering an audio codec and the output file has no audio or the muted flag was passed.",
      ),
    );
    expect(await source.renderAudio(join(directory, "silent.wav"))).toBeNull();
    upstream.renderMedia.mockRejectedValueOnce(
      new Error("media download failed"),
    );
    await expect(
      source.renderAudio(join(directory, "broken.wav")),
    ).rejects.toThrow("media download failed");
  } finally {
    await source.close();
  }
  await expect(
    source.renderReference(join(directory, "closed.mp4")),
  ).rejects.toThrow("closed");
});

it("cleans acquired resources when metadata resolution fails", async () => {
  upstream.selectComposition.mockRejectedValueOnce(
    new Error("No composition found"),
  );
  await expect(
    prepareRemotionSource({
      entryPoint,
      compositionId: "Missing",
      workDirectory: directory,
    }),
  ).rejects.toThrow("No composition found");
  expect(upstream.closeBrowser).toHaveBeenCalledOnce();
  expect(upstream.closeServer).toHaveBeenCalledOnce();
  expect(await readdir(directory)).toEqual(["caller-owned.txt"]);
});

it("keeps upstream AAC encoding and rejects unsupported audio extensions before rendering", async () => {
  const source = await prepareRemotionSource({
    entryPoint,
    compositionId: "Original",
    workDirectory: directory,
  });
  try {
    const outputPath = join(directory, "audio.aac");
    expect(await source.renderAudio(outputPath)).toBe(outputPath);
    expect(upstream.renderMedia.mock.calls[0]![0]).toMatchObject({
      codec: "aac",
      outputLocation: outputPath,
    });
    await expect(
      source.renderAudio(join(directory, "audio.mp3")),
    ).rejects.toThrow(
      'Unsupported Remotion audio output extension ".mp3". Use .aac or .wav.',
    );
    await expect(source.renderAudio(join(directory, "audio"))).rejects.toThrow(
      'Unsupported Remotion audio output extension "". Use .aac or .wav.',
    );
    expect(upstream.renderMedia).toHaveBeenCalledTimes(1);
  } finally {
    await source.close();
  }
});

it("does not start work for an aborted request and closes a prepared source on abort", async () => {
  const alreadyAborted = AbortSignal.abort(new Error("stopped"));
  await expect(
    prepareRemotionSource({
      entryPoint,
      compositionId: "Original",
      signal: alreadyAborted,
    }),
  ).rejects.toThrow("stopped");
  expect(upstream.bundle).not.toHaveBeenCalled();
  const controller = new AbortController();
  const source = await prepareRemotionSource({
    entryPoint,
    compositionId: "Original",
    workDirectory: directory,
    signal: controller.signal,
  });
  controller.abort(new Error("stopped"));
  await source.close();
  expect(upstream.cancel).toHaveBeenCalled();
  expect(await readdir(directory)).toEqual(["caller-owned.txt"]);
});

it.each([undefined, "warn", "info", "error", "verbose"] as const)(
  "avoids upstream's accidental verbose metadata logging for %s",
  async (logLevel) => {
    const source = await prepareRemotionSource({
      entryPoint,
      compositionId: "Original",
      workDirectory: directory,
      logLevel,
    });
    try {
      const selectionOptions = upstream.selectComposition.mock.calls[0]![0];
      if (logLevel === "verbose")
        expect(selectionOptions.logLevel).toBe("verbose");
      else expect(selectionOptions).not.toHaveProperty("logLevel");
    } finally {
      await source.close();
    }
  },
);

it("pins input and resolved metadata snapshots across caller mutations, preserving Dates", async () => {
  const inputProps = {
    nested: { label: "snapshot-original" },
    date: new Date("2030-01-01T00:00:00Z"),
  };
  const preparing = prepareRemotionSource({
    entryPoint,
    compositionId: "Original",
    inputProps,
    workDirectory: directory,
  });
  inputProps.nested.label = "caller-mutated";
  inputProps.date.setUTCFullYear(2040);
  const source = await preparing;
  try {
    const selectedInput =
      upstream.selectComposition.mock.calls[0]![0].inputProps;
    expect(selectedInput).toEqual({
      nested: { label: "snapshot-original" },
      date: new Date("2030-01-01T00:00:00Z"),
    });
    expect(selectedInput.date).toBeInstanceOf(Date);
    source.composition.width = 999;
    (source.composition.props.date as Date).setUTCFullYear(2050);
    source.composition.defaultProps.changed = true;
    await source.renderAudio(join(directory, "audio.wav"));
    await source.renderReference(join(directory, "reference.mp4"));
    for (const [renderOptions] of upstream.renderMedia.mock.calls) {
      expect(renderOptions.inputProps).toEqual(selectedInput);
      expect(renderOptions.inputProps).not.toBe(inputProps);
      expect(renderOptions.composition).toEqual(composition);
      expect(renderOptions.composition).not.toBe(source.composition);
      expect(renderOptions.composition.props.date).toBeInstanceOf(Date);
    }
    const ownedDirectory = (await readdir(directory)).find((name) =>
      name.startsWith("velocast-remotion-"),
    )!;
    const native = await readFile(
      join(directory, ownedDirectory, "bundle/velocast.html"),
      "utf8",
    );
    expect(native).toContain("snapshot-original");
    expect(native).toContain("2030-01-01");
    expect(native).not.toContain("caller-mutated");
    expect(native).not.toContain("2040-01-01");
  } finally {
    await source.close();
  }
});

it("discovers all upstream compositions and cleans its resources", async () => {
  const result = await discoverRemotionCompositions({
    entryPoint,
    workDirectory: directory,
  });
  expect(result).toEqual([composition]);
  expect(upstream.selectComposition).not.toHaveBeenCalled();
  expect(upstream.getCompositions).toHaveBeenCalledWith(
    "http://localhost:3100",
    expect.objectContaining({ inputProps: {} }),
  );
  expect(upstream.closeBrowser).toHaveBeenCalledOnce();
  expect(upstream.closeServer).toHaveBeenCalledOnce();
  expect(await readdir(directory)).toEqual(["caller-owned.txt"]);
});

it("renders a reference frame with fixed metadata, validates bounds and output format", async () => {
  const source = await prepareRemotionSource({
    entryPoint,
    compositionId: "Original",
    workDirectory: directory,
  });
  try {
    await source.renderReferenceFrame(1, join(directory, "frame.png"));
    expect(upstream.renderStill).toHaveBeenCalledWith(
      expect.objectContaining({ frame: 1, imageFormat: "png", composition }),
    );
    await expect(
      source.renderReferenceFrame(2, join(directory, "frame.png")),
    ).rejects.toThrow("within the composition duration");
    await expect(
      source.renderReferenceFrame(0, join(directory, "frame.gif")),
    ).rejects.toThrow("Reference frame output");
    expect(upstream.renderStill).toHaveBeenCalledTimes(1);
  } finally {
    await source.close();
  }
});

it("cleans discovery resources when calculateMetadata fails", async () => {
  upstream.getCompositions.mockRejectedValueOnce(new Error("metadata failed"));
  await expect(
    discoverRemotionCompositions({ entryPoint, workDirectory: directory }),
  ).rejects.toThrow("metadata failed");
  expect(upstream.closeBrowser).toHaveBeenCalledOnce();
  expect(upstream.closeServer).toHaveBeenCalledOnce();
  expect(await readdir(directory)).toEqual(["caller-owned.txt"]);
});

it("releases the bundle queue after a failed build", async () => {
  upstream.bundle.mockRejectedValueOnce(new Error("webpack failed"));
  await expect(
    discoverRemotionCompositions({ entryPoint, workDirectory: directory }),
  ).rejects.toThrow("webpack failed");
  await expect(
    discoverRemotionCompositions({ entryPoint, workDirectory: directory }),
  ).resolves.toEqual([composition]);
  expect(upstream.bundle).toHaveBeenCalledTimes(2);
  expect(await readdir(directory)).toEqual(["caller-owned.txt"]);
});

it("uses the modern close signature and quiet metadata log level", async () => {
  upstream.modern = true;
  await discoverRemotionCompositions({ entryPoint, workDirectory: directory });
  expect(upstream.closeBrowser).toHaveBeenCalledWith({ silent: true });
  expect(upstream.getCompositions).toHaveBeenCalledWith(
    "http://localhost:3100",
    expect.objectContaining({ logLevel: "warn" }),
  );
});
