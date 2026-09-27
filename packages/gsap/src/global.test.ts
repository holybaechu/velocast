import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearFrameAdaptersForTest } from "@velocast/core/testing";

type FakeTimeline = {
  duration: ReturnType<typeof vi.fn<() => number>>;
  totalTime: ReturnType<
    typeof vi.fn<(time: number, suppressEvents?: boolean) => void>
  >;
  paused: ReturnType<typeof vi.fn<() => boolean>>;
  pause: ReturnType<typeof vi.fn<() => void>>;
};

function fakeTimeline(durationSeconds = 3): FakeTimeline {
  return {
    duration: vi.fn(() => durationSeconds),
    totalTime: vi.fn(),
    paused: vi.fn(() => false),
    pause: vi.fn(),
  };
}

describe("VelocastGSAP global", () => {
  beforeEach(() => {
    vi.resetModules();
    clearFrameAdaptersForTest();
    window.__velocast = undefined;
    delete window.Velocast;
    delete (globalThis as typeof globalThis & { VelocastGSAP?: unknown })
      .VelocastGSAP;
    delete (globalThis as typeof globalThis & { gsap?: unknown }).gsap;
  });

  it("attaches VelocastGSAP and Velocast globals", async () => {
    (globalThis as typeof globalThis & { gsap?: unknown }).gsap = {};

    await import("./global.js");

    expect(window.Velocast?.registerAdapter).toBeTypeOf("function");
    expect(
      (globalThis as typeof globalThis & {
        VelocastGSAP?: { register?: unknown };
      }).VelocastGSAP?.register,
    ).toBeTypeOf("function");
  });

  it("reports missing GSAP for global registration", async () => {
    await import("./global.js");

    const globalApi = (globalThis as typeof globalThis & {
      VelocastGSAP?: { register: (...args: unknown[]) => unknown };
    }).VelocastGSAP;

    expect(() =>
      globalApi?.register("hero", undefined, {
        width: 1920,
        height: 1080,
        fps: 60,
        target: "#hero",
      }),
    ).toThrow("VELOCAST_GSAP_MISSING");
  });

  it("registers timelines through the explicit global API", async () => {
    const timeline = fakeTimeline(4);
    (globalThis as typeof globalThis & { gsap?: unknown }).gsap = {};

    await import("./global.js");
    (
      globalThis as typeof globalThis & {
        VelocastGSAP?: {
          register(
            compositionId: string,
            timeline: unknown,
            options?: Record<string, unknown>,
          ): unknown;
        };
      }
    ).VelocastGSAP?.register("root", timeline, {
      width: 1920,
      height: 1080,
      fps: 30,
      target: "#root",
    });

    await expect(window.__velocast?.getCompositions()).resolves.toEqual([
      {
        id: "root",
        width: 1920,
        height: 1080,
        fps: 30,
        durationFrames: 120,
        target: "#root",
      },
    ]);
  });

  it("supports repeatable seeks for explicitly registered timelines", async () => {
    const timeline = fakeTimeline(4);
    (globalThis as typeof globalThis & { gsap?: unknown }).gsap = {};

    await import("./global.js");
    (
      globalThis as typeof globalThis & {
        VelocastGSAP?: {
          register(
            compositionId: string,
            timeline: unknown,
            options?: Record<string, unknown>,
          ): unknown;
        };
      }
    ).VelocastGSAP?.register("root", timeline, {
      width: 1920,
      height: 1080,
      fps: 30,
      target: "#root",
    });

    await window.__velocast?.seekFrame("root", 15);
    await window.__velocast?.seekFrame("root", 15);

    expect(timeline.totalTime).toHaveBeenNthCalledWith(1, 0.5, false);
    expect(timeline.totalTime).toHaveBeenNthCalledWith(2, 0.5, false);
  });
});
