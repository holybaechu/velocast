import { beforeEach, describe, expect, it, vi } from "vitest";
import { remotionSource } from "./source.js";

const host = vi.hoisted(() => ({
  discover: vi.fn(),
  prepare: vi.fn(),
}));
vi.mock("./upstream-host.js", () => ({
  discoverRemotionCompositions: host.discover,
  prepareRemotionSource: host.prepare,
}));

const composition = {
  id: "Scene",
  width: 160,
  height: 96,
  fps: 12,
  durationInFrames: 24,
};

function context(operation: "inspect" | "frame" | "render") {
  return {
    entry: "C:/project/src/index.tsx",
    compositionId: operation === "inspect" ? undefined : "Scene",
    inputProps: { label: "original" },
    signal: new AbortController().signal,
    operation,
  };
}

beforeEach(() => {
  host.discover.mockReset();
  host.prepare.mockReset();
  host.discover.mockResolvedValue([composition]);
});

describe("remotionSource", () => {
  it("discovers all original compositions for inspection", async () => {
    const source = remotionSource({ entry: "./src/index.tsx" });
    const prepared = await source.prepare(context("inspect"));
    expect(host.discover).toHaveBeenCalledWith(
      expect.objectContaining({
        entryPoint: "C:/project/src/index.tsx",
        inputProps: { label: "original" },
      }),
    );
    expect(prepared.compositions).toEqual([
      {
        id: "Scene",
        width: 160,
        height: 96,
        fps: 12,
        durationFrames: 24,
        target: "#remotion-canvas",
      },
    ]);
    await prepared.close();
  });

  it("prepares native capture and delegates audio to Remotion", async () => {
    const renderAudio = vi.fn().mockResolvedValue("C:/tmp/audio.wav");
    const close = vi.fn().mockResolvedValue(undefined);
    host.prepare.mockResolvedValue({
      composition,
      url: "http://localhost:1234/velocast.html",
      renderAudio,
      close,
    });
    const prepared = await remotionSource({ entry: "./src/index.tsx" }).prepare(
      context("render"),
    );
    expect(host.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ compositionId: "Scene" }),
    );
    expect(prepared.url).toContain("velocast.html");
    expect(prepared.renderVideo).toBeUndefined();
    expect(prepared.renderFrame).toBeUndefined();
    await expect(
      prepared.renderAudio!("C:/tmp/audio.wav", new AbortController().signal),
    ).resolves.toBe("C:/tmp/audio.wav");
    expect(renderAudio).toHaveBeenCalledWith("C:/tmp/audio.wav");
    await prepared.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("inspects only the requested composition", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    host.prepare.mockResolvedValue({ composition, close });
    const prepared = await remotionSource({ entry: "./src/index.tsx" }).prepare(
      {
        ...context("inspect"),
        compositionId: "Scene",
      },
    );
    expect(host.discover).not.toHaveBeenCalled();
    expect(host.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ compositionId: "Scene" }),
    );
    expect(prepared.compositions).toHaveLength(1);
    expect(close).toHaveBeenCalledOnce();
    await prepared.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects the removed reference backend before starting any host work", () => {
    expect(() =>
      remotionSource({
        entry: "./src/index.tsx",
        // @ts-expect-error Removed backend must also fail for JavaScript consumers.
        backend: "reference",
      }),
    ).toThrow("use backend: 'native' or omit backend");
    expect(host.prepare).not.toHaveBeenCalled();
    expect(host.discover).not.toHaveBeenCalled();
  });

  it("rejects a missing composition before starting the host", async () => {
    await expect(
      remotionSource({ entry: "./src/index.tsx" }).prepare({
        ...context("render"),
        compositionId: undefined,
      }),
    ).rejects.toThrow("remotion.composition_required");
    expect(host.prepare).not.toHaveBeenCalled();
  });

  it("snapshots options when the adapter is created", async () => {
    const options = {
      entry: " ./src/index.tsx ",
      browserExecutable: "C:/Chrome/chrome.exe",
      backend: "native" as const,
    };
    const source = remotionSource(options);
    options.entry = "./other.tsx";
    options.browserExecutable = "C:/Other/chrome.exe";
    expect(source.entry).toBe("./src/index.tsx");
    await source.prepare(context("inspect"));
    expect(host.discover).toHaveBeenCalledWith(
      expect.objectContaining({ browserExecutable: "C:/Chrome/chrome.exe" }),
    );
    expect(Object.isFrozen(source)).toBe(true);
  });
});
