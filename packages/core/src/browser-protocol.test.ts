import { beforeEach, describe, expect, it } from "vitest";
import { clearFrameAdaptersForTest } from "./testing.js";
import {
  installBrowserProtocol,
  registerFrameAdapter,
} from "./browser-protocol.js";
import type { FrameAdapter } from "./types.js";

function adapter(durationFrames = 90): FrameAdapter {
  return {
    id: "test-adapter",
    getDurationFrames() {
      return durationFrames;
    },
    seekFrame() {
      return undefined;
    },
  };
}

describe("adapter browser protocol", () => {
  beforeEach(() => {
    clearFrameAdaptersForTest();
    window.__velocast = undefined;
  });

  it("installs composition discovery from registered adapters", async () => {
    registerFrameAdapter("hero", adapter(90), {
      width: 1200,
      height: 630,
      fps: 30,
      target: "#hero",
    });

    await expect(window.__velocast?.getCompositions()).resolves.toEqual([
      {
        id: "hero",
        width: 1200,
        height: 630,
        fps: 30,
        durationFrames: 90,
        target: "#hero",
      },
    ]);
  });

  it("delegates normalized frame seeks to the registered adapter", async () => {
    const frames: number[] = [];
    registerFrameAdapter(
      "hero",
      {
        id: "tracking-adapter",
        getDurationFrames() {
          return 90;
        },
        seekFrame(frame) {
          frames.push(frame);
        },
      },
      {
        width: 1200,
        height: 630,
        fps: 30,
        target: "#hero",
      },
    );

    await window.__velocast?.seekFrame("hero", 12, {
      compositionId: "hero",
      width: 1200,
      height: 630,
      fps: 30,
      durationFrames: 90,
      target: "#hero",
    });

    await window.__velocast?.seekFrame("hero", 500, {
      compositionId: "hero",
      width: 1200,
      height: 630,
      fps: 30,
      durationFrames: 90,
      target: "#hero",
    });

    expect(frames).toEqual([12, 89]);
  });

  it("clamps seeks against adapter duration instead of caller context duration", async () => {
    const frames: number[] = [];
    registerFrameAdapter(
      "hero",
      {
        id: "tracking-adapter",
        getDurationFrames() {
          return 90;
        },
        seekFrame(frame) {
          frames.push(frame);
        },
      },
      {
        width: 1200,
        height: 630,
        fps: 30,
        target: "#hero",
      },
    );

    await window.__velocast?.seekFrame("hero", 500, {
      compositionId: "hero",
      width: 1,
      height: 1,
      fps: 1,
      durationFrames: 500,
      target: "#wrong",
      inputProps: { sample: true },
    });

    expect(frames).toEqual([89]);
  });

  it("runs adapter init once before seeks", async () => {
    const calls: string[] = [];
    registerFrameAdapter(
      "hero",
      {
        id: "init-adapter",
        init(context) {
          calls.push(`init:${context.compositionId}`);
        },
        getDurationFrames() {
          return 90;
        },
        seekFrame(frame) {
          calls.push(`seek:${frame}`);
        },
      },
      {
        width: 1200,
        height: 630,
        fps: 30,
        target: "#hero",
      },
    );

    await window.__velocast?.seekFrame("hero", 1);
    await window.__velocast?.seekFrame("hero", 2);

    expect(calls).toEqual(["init:hero", "seek:1", "seek:2"]);
  });

  it("wraps adapter init failures as seek failures", async () => {
    registerFrameAdapter(
      "hero",
      {
        id: "init-adapter",
        init() {
          throw new Error("boom");
        },
        getDurationFrames() {
          return 90;
        },
        seekFrame() {
          return undefined;
        },
      },
      {
        width: 1200,
        height: 630,
        fps: 30,
        target: "#hero",
      },
    );

    await expect(window.__velocast?.seekFrame("hero", 12)).rejects.toThrow(
      'VELOCAST_SEEK_FAILED: Adapter "hero" failed while seeking frame 12: boom',
    );
  });

  it("wraps duration getter failures during seek as seek failures", async () => {
    registerFrameAdapter(
      "hero",
      {
        id: "duration-adapter",
        getDurationFrames() {
          throw new Error("boom");
        },
        seekFrame() {
          return undefined;
        },
      },
      {
        width: 1200,
        height: 630,
        fps: 30,
        target: "#hero",
      },
    );

    await expect(window.__velocast?.seekFrame("hero", 1)).rejects.toThrow(
      'VELOCAST_SEEK_FAILED: Adapter "hero" failed while seeking frame 1: boom',
    );
  });

  it("rejects missing adapters with a stable error code", async () => {
    installBrowserProtocol();

    await expect(window.__velocast?.seekFrame("missing", 1)).rejects.toThrow(
      "VELOCAST_COMPOSITION_NOT_FOUND",
    );
  });

  it("rejects invalid adapter durations", async () => {
    registerFrameAdapter("hero", adapter(Number.NaN), {
      width: 1200,
      height: 630,
      fps: 30,
      target: "#hero",
    });

    await expect(window.__velocast?.getCompositions()).rejects.toThrow(
      "VELOCAST_INVALID_DURATION",
    );
  });

  it("rejects zero-length adapter durations", async () => {
    registerFrameAdapter("hero", adapter(0), {
      width: 1200,
      height: 630,
      fps: 30,
      target: "#hero",
    });

    await expect(window.__velocast?.getCompositions()).rejects.toThrow(
      "VELOCAST_INVALID_DURATION",
    );
  });

  it("wraps duration getter failures for getDurationFrames", async () => {
    registerFrameAdapter(
      "hero",
      {
        id: "duration-adapter",
        getDurationFrames() {
          throw new Error("boom");
        },
        seekFrame() {
          return undefined;
        },
      },
      {
        width: 1200,
        height: 630,
        fps: 30,
        target: "#hero",
      },
    );

    await expect(window.__velocast?.getDurationFrames("hero")).rejects.toThrow(
      "VELOCAST_INVALID_DURATION",
    );
  });

  it("wraps duration getter failures for getCompositions", async () => {
    registerFrameAdapter(
      "hero",
      {
        id: "duration-adapter",
        getDurationFrames() {
          throw new Error("boom");
        },
        seekFrame() {
          return undefined;
        },
      },
      {
        width: 1200,
        height: 630,
        fps: 30,
        target: "#hero",
      },
    );

    await expect(window.__velocast?.getCompositions()).rejects.toThrow(
      "VELOCAST_INVALID_DURATION",
    );
  });

  it("destroys adapters and clears initialized state", async () => {
    const calls: string[] = [];
    registerFrameAdapter(
      "hero",
      {
        id: "destroy-adapter",
        init() {
          calls.push("init");
        },
        getDurationFrames() {
          return 90;
        },
        seekFrame() {
          calls.push("seek");
        },
        destroy() {
          calls.push("destroy");
        },
      },
      {
        width: 1200,
        height: 630,
        fps: 30,
        target: "#hero",
      },
    );

    await window.__velocast?.seekFrame("hero", 1);
    await window.__velocast?.destroy?.();
    await window.__velocast?.seekFrame("hero", 2);

    expect(calls).toEqual(["init", "seek", "destroy", "init", "seek"]);
  });

  it("wraps adapter destroy failures with a stable error code", async () => {
    registerFrameAdapter(
      "hero",
      {
        id: "destroy-adapter",
        getDurationFrames() {
          return 90;
        },
        seekFrame() {
          return undefined;
        },
        destroy() {
          throw new Error("boom");
        },
      },
      {
        width: 1200,
        height: 630,
        fps: 30,
        target: "#hero",
      },
    );

    await expect(window.__velocast?.destroy?.()).rejects.toThrow(
      'VELOCAST_DESTROY_FAILED: Adapter "destroy-adapter" for composition "hero" failed during destroy: boom',
    );
  });

  it("continues later cleanup after failure but requires a successful retry before reinitializing", async () => {
    const calls: string[] = [];
    let failCleanup = true;
    registerFrameAdapter(
      "hero",
      {
        id: "first-adapter",
        init() {
          calls.push("hero:init");
        },
        getDurationFrames() {
          return 90;
        },
        seekFrame() {
          calls.push("hero:seek");
        },
        destroy() {
          calls.push("hero:destroy");
          if (failCleanup) {
            failCleanup = false;
            throw new Error("boom");
          }
        },
      },
      {
        width: 1200,
        height: 630,
        fps: 30,
        target: "#hero",
      },
    );
    registerFrameAdapter(
      "secondary",
      {
        id: "second-adapter",
        init() {
          calls.push("secondary:init");
        },
        getDurationFrames() {
          return 45;
        },
        seekFrame() {
          calls.push("secondary:seek");
        },
        destroy() {
          calls.push("secondary:destroy");
        },
      },
      {
        width: 800,
        height: 800,
        fps: 30,
        target: "#secondary",
      },
    );

    await window.__velocast?.seekFrame("hero", 1);
    await window.__velocast?.seekFrame("secondary", 1);
    await expect(window.__velocast?.destroy?.()).rejects.toThrow(
      'VELOCAST_DESTROY_FAILED: Adapter "first-adapter" for composition "hero" failed during destroy: boom',
    );
    await expect(window.__velocast?.seekFrame("hero", 2)).rejects.toThrow(
      "VELOCAST_RUNTIME_CANCELLED",
    );
    await window.__velocast?.destroy?.();
    await window.__velocast?.seekFrame("hero", 2);
    await window.__velocast?.seekFrame("secondary", 2);

    expect(calls).toEqual([
      "hero:init",
      "hero:seek",
      "secondary:init",
      "secondary:seek",
      "hero:destroy",
      "secondary:destroy",
      "hero:destroy",
      "secondary:destroy",
      "hero:init",
      "hero:seek",
      "secondary:init",
      "secondary:seek",
    ]);
  });

  it("clears omitted callbacks on reinstall", () => {
    const waitForReady = () => undefined;

    installBrowserProtocol({ waitForReady });
    expect(window.__velocast?.waitForReady).toBeTypeOf("function");

    installBrowserProtocol();

    expect(window.__velocast?.waitForReady).toBeUndefined();
  });
});
