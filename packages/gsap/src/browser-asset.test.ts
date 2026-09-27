// @vitest-environment jsdom
declare const process: {
  cwd(): string;
};

import { beforeEach, describe, expect, it, vi } from "vitest";

type BrowserScope = typeof globalThis & {
  gsap?: unknown;
  Velocast?: unknown;
  VelocastGSAP?: {
    register(
      compositionId: string,
      timeline: unknown,
      options?: Record<string, unknown>,
    ): unknown;
  };
};

type FakeTimeline = {
  duration: ReturnType<typeof vi.fn<() => number>>;
  totalTime: ReturnType<
    typeof vi.fn<(time: number, suppressEvents?: boolean) => void>
  >;
  paused: ReturnType<typeof vi.fn<() => boolean>>;
  pause: ReturnType<typeof vi.fn<() => void>>;
};

function fakeTimeline(durationSeconds = 4): FakeTimeline {
  return {
    duration: vi.fn(() => durationSeconds),
    totalTime: vi.fn(),
    paused: vi.fn(() => false),
    pause: vi.fn(),
  };
}

async function loadBrowserAsset(): Promise<void> {
  // @ts-expect-error This package intentionally avoids Node ambient types.
  const { readFileSync } = (await import("node:fs")) as {
    readFileSync(path: string, encoding: "utf8"): string;
  };
  // @ts-expect-error This package intentionally avoids Node ambient types.
  const { resolve } = (await import("node:path")) as {
    resolve(...paths: string[]): string;
  };
  const code = readFileSync(
    resolve(process.cwd(), "browser/velocast-gsap.global.js"),
    "utf8",
  );
  (0, eval)(code);
}

describe("committed Velocast GSAP browser asset", () => {
  beforeEach(() => {
    const scope = globalThis as BrowserScope;
    delete scope.gsap;
    delete scope.Velocast;
    delete scope.VelocastGSAP;
    window.__velocast = undefined;
  });

  it("installs Velocast and VelocastGSAP globals", async () => {
    (globalThis as BrowserScope).gsap = {};

    await loadBrowserAsset();

    expect(window.Velocast?.registerAdapter).toBeTypeOf("function");
    expect((globalThis as BrowserScope).VelocastGSAP?.register).toBeTypeOf(
      "function",
    );
  });

  it("registers and seeks a fake timeline", async () => {
    const timeline = fakeTimeline(4);
    (globalThis as BrowserScope).gsap = {};

    await loadBrowserAsset();
    (globalThis as BrowserScope).VelocastGSAP?.register("hero", timeline, {
      width: 1920,
      height: 1080,
      fps: 60,
      target: "#hero",
    });

    await expect(window.__velocast?.getCompositions()).resolves.toEqual([
      {
        id: "hero",
        width: 1920,
        height: 1080,
        fps: 60,
        durationFrames: 240,
        target: "#hero",
      },
    ]);

    await window.__velocast?.seekFrame("hero", 30);

    expect(timeline.totalTime).toHaveBeenCalledWith(0.5, false);
  });
});
