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
const mocks = vi.hoisted(() => ({
  bundle: vi.fn(),
  close: vi.fn(),
  evaluate: vi.fn(),
  call: vi.fn(),
  media: vi.fn(),
  launch: vi.fn(),
  audio: false,
  frame: 0,
}));
vi.mock("velocast/source-media", () => ({
  launchCdpBrowser: mocks.launch,
  runMediaOperation: mocks.media,
  createMediaSession: vi.fn(),
}));
vi.mock("./runtime-loader.js", async () => {
  const { NoReactInternals } = await import("remotion/no-react");
  return {
    loadProjectRemotionRuntime: () => ({
      version: "4.0.244",
      profile: { id: "legacy-4" },
      serialize: NoReactInternals.serializeJSONWithDate,
      deserialize: NoReactInternals.deserializeJSONWithCustomFields,
      bundler: { bundle: mocks.bundle },
    }),
  };
});
import { NoReactInternals } from "remotion/no-react";
import {
  prepareRemotionSource,
  discoverRemotionCompositions,
} from "./upstream-host.js";
let directory: string;
const entryPoint = fileURLToPath(import.meta.url);
const serialize = (data: Record<string, unknown>) =>
  NoReactInternals.serializeJSONWithDate({
    data,
    indent: undefined,
    staticBase: null,
  }).serializedString;
const raw = {
  id: "Original",
  width: 64,
  height: 64,
  durationInFrames: 2,
  fps: 30,
  defaultCodec: null,
  serializedResolvedPropsWithCustomSchema: serialize({
    date: new Date("2025-01-01"),
  }),
  serializedDefaultPropsWithCustomSchema: serialize({}),
};
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.audio = false;
  mocks.frame = 0;
  directory = await mkdtemp(join(tmpdir(), "velocast-remotion-host-test-"));
  await writeFile(join(directory, "caller-owned.txt"), "keep");
  mocks.bundle.mockImplementation(async ({ outDir }: { outDir: string }) => {
    await mkdir(outDir, { recursive: true });
    await writeFile(
      join(outDir, "index.html"),
      '<html><body><script src="/bundle.js"></script></body></html>',
    );
    await writeFile(join(outDir, "audio.wav"), "media");
    return outDir;
  });
  mocks.launch.mockResolvedValue({
    call: mocks.call,
    evaluate: mocks.evaluate,
    close: mocks.close,
  });
  mocks.close.mockResolvedValue(undefined);
  mocks.call.mockResolvedValue({ data: Buffer.from("png").toString("base64") });
  mocks.evaluate.mockImplementation(async (expression: string) => {
    if (expression.startsWith("Boolean(")) return true;
    if (
      expression.includes("remotion_calculateComposition") ||
      expression.includes("getStaticCompositions")
    )
      return [raw];
    const frame = /seekFrame\("Original",(\d+)\)/.exec(expression);
    if (frame) mocks.frame = Number(frame[1]);
    if (expression.includes("remotion_collectAssets"))
      return mocks.audio
        ? [
            {
              type: "audio",
              id: "a",
              src: "/audio.wav",
              frame: mocks.frame,
              mediaFrame: mocks.frame + 2,
              playbackRate: 1,
              toneFrequency: null,
              volume: 0.5,
            },
          ]
        : [];
    return undefined;
  });
  mocks.media.mockImplementation(async (operation: { outputPath: string }) => {
    await writeFile(operation.outputPath, "media");
    return {};
  });
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
it("keeps authored bundle unchanged, snapshots input, and closes only its own directory", async () => {
  const props = { label: "original" };
  const pending = prepareRemotionSource({
    entryPoint,
    compositionId: "Original",
    inputProps: props,
    workDirectory: directory,
  });
  props.label = "mutated";
  const source = await pending;
  try {
    const owned = (await readdir(directory)).find((name) =>
      name.startsWith("velocast-remotion-"),
    )!;
    const original = await readFile(
        join(directory, owned, "bundle/index.html"),
        "utf8",
      ),
      native = await readFile(
        join(directory, owned, "bundle/velocast.html"),
        "utf8",
      );
    expect(original).not.toContain("__velocast");
    expect(native).toContain("__velocast");
    expect(native).toContain("original");
    expect(native).not.toContain("mutated");
    expect(source.composition.props.date).toBeInstanceOf(Date);
    expect(source.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/velocast.html$/);
  } finally {
    await source.close();
  }
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(await readdir(directory)).toEqual(["caller-owned.txt"]);
});
it("discovers original metadata without upstream compositor APIs", async () => {
  expect(
    await discoverRemotionCompositions({
      entryPoint,
      workDirectory: directory,
    }),
  ).toMatchObject([{ id: "Original", fps: 30 }]);
  expect(mocks.close).toHaveBeenCalledOnce();
});
it("mixes captured trim and frame volume with WebCodecs and distinguishes silence", async () => {
  const source = await prepareRemotionSource({
    entryPoint,
    compositionId: "Original",
    workDirectory: directory,
  });
  try {
    expect(await source.renderAudio(join(directory, "silent.wav"))).toBeNull();
    mocks.audio = true;
    expect(await source.renderAudio(join(directory, "audio.wav"))).toBe(
      join(directory, "audio.wav"),
    );
    const operation = mocks.media.mock.calls[0]![0];
    expect(operation).toMatchObject({
      kind: "mix-audio",
      channels: 2,
      format: "wav",
      plan: {
        sampleRate: 48000,
        durationSamples: 3200,
        clips: [
          {
            startSample: 0,
            sourceStartSample: 3200,
            durationSamples: 3200,
            gain: 0.5,
          },
        ],
      },
    });
    await expect(
      source.renderAudio(join(directory, "old.aac")),
    ).rejects.toThrow("remotion.audio_format");
  } finally {
    await source.close();
  }
});
it("assembles reference PNGs with the media encoder and validates still bounds", async () => {
  const source = await prepareRemotionSource({
    entryPoint,
    compositionId: "Original",
    workDirectory: directory,
  });
  try {
    await source.renderReference(join(directory, "reference.mp4"));
    expect(mocks.media).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "encode-frames",
        fps: 30,
        framePaths: expect.arrayContaining([
          expect.stringContaining("frame-0.png"),
        ]),
      }),
      expect.anything(),
    );
    await source.renderReferenceFrame(1, join(directory, "frame.png"));
    expect(await readFile(join(directory, "frame.png"), "utf8")).toBe("png");
    await expect(
      source.renderReferenceFrame(2, join(directory, "bad.png")),
    ).rejects.toThrow("within the composition");
    await expect(
      source.renderReferenceFrame(0, join(directory, "bad.gif")),
    ).rejects.toThrow("Reference frame output");
  } finally {
    await source.close();
  }
});
it("cleans failed preparations and rejects already cancelled work", async () => {
  mocks.bundle.mockRejectedValueOnce(new Error("bundle failed"));
  await expect(
    prepareRemotionSource({
      entryPoint,
      compositionId: "Original",
      workDirectory: directory,
    }),
  ).rejects.toThrow("bundle failed");
  expect(await readdir(directory)).toEqual(["caller-owned.txt"]);
  const owner = new AbortController();
  owner.abort(new Error("stopped"));
  await expect(
    prepareRemotionSource({
      entryPoint,
      compositionId: "Original",
      signal: owner.signal,
    }),
  ).rejects.toThrow("stopped");
});
it("aborting a prepared source closes the browser and owned media server", async () => {
  const owner = new AbortController();
  const source = await prepareRemotionSource({
    entryPoint,
    compositionId: "Original",
    signal: owner.signal,
    workDirectory: directory,
  });
  owner.abort();
  await source.close();
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(await readdir(directory)).toEqual(["caller-owned.txt"]);
});
it("preserves an existing audio output when media work fails", async () => {
  const source = await prepareRemotionSource({
    entryPoint,
    compositionId: "Original",
    workDirectory: directory,
  });
  try {
    mocks.audio = true;
    const output = join(directory, "existing.wav");
    await writeFile(output, "original");
    mocks.media.mockImplementationOnce(
      async (operation: { outputPath: string }) => {
        await writeFile(operation.outputPath, "partial");
        throw new Error("encoder failed");
      },
    );
    await expect(source.renderAudio(output)).rejects.toThrow("encoder failed");
    expect(await readFile(output, "utf8")).toBe("original");
    await source.renderAudio(output);
    expect(await readFile(output, "utf8")).toBe("media");
  } finally {
    await source.close();
  }
});
