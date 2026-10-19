import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearFrameAdaptersForTest } from "@velocast/core/testing";
import { gsap } from "gsap";
import {
  createGsapFrameAdapter,
  defineGsapComposition,
  registerGsapTimeline,
} from "./index.js";

type FakeTimeline = {
  duration: ReturnType<typeof vi.fn<() => number>>;
  totalTime: ReturnType<
    typeof vi.fn<(time: number, suppressEvents?: boolean) => void>
  >;
  paused?: ReturnType<typeof vi.fn<() => boolean>>;
  pause: ReturnType<typeof vi.fn<() => void>>;
  revert?: ReturnType<typeof vi.fn<() => void>>;
  kill?: ReturnType<typeof vi.fn<() => void>>;
};

function fakeTimeline(durationSeconds = 3): FakeTimeline {
  return {
    duration: vi.fn(() => durationSeconds),
    totalTime: vi.fn(),
    paused: vi.fn(() => false),
    pause: vi.fn(),
  };
}

describe("createGsapFrameAdapter", () => {
  it("derives duration frames from timeline duration and fps", () => {
    const timeline = fakeTimeline(2.5);
    const adapter = createGsapFrameAdapter(timeline, {
      compositionId: "hero",
      fps: 60,
    });

    expect(adapter.getDurationFrames()).toBe(150);
  });

  it("uses explicit duration frame overrides", () => {
    const timeline = fakeTimeline(2.5);
    const adapter = createGsapFrameAdapter(timeline, {
      compositionId: "hero",
      fps: 60,
      durationFrames: 240,
    });

    expect(adapter.getDurationFrames()).toBe(240);
  });

  it("includes finite repeats and repeat delays in inferred duration", () => {
    const timeline = gsap
      .timeline({ paused: true, repeat: 2, repeatDelay: 0.5 })
      .to({ x: 0 }, { x: 1, duration: 2 });
    try {
      const adapter = createGsapFrameAdapter(timeline, {
        compositionId: "hero",
        fps: 30,
      });
      expect(adapter.getDurationFrames()).toBe(210);
    } finally {
      timeline.revert();
      gsap.ticker.sleep();
    }
  });

  it.each(["timeline", "child"])(
    "requires a duration override for an infinite %s repeat",
    (repeating) => {
      const timeline = gsap
        .timeline({ paused: true, repeat: repeating === "timeline" ? -1 : 0 })
        .to(
          { x: 0 },
          { x: 1, duration: 2, repeat: repeating === "child" ? -1 : 0 },
        );
      try {
        expect(() =>
          createGsapFrameAdapter(timeline, {
            compositionId: "hero",
            fps: 30,
          }),
        ).toThrow("provide durationFrames for an infinite timeline");
        expect(
          createGsapFrameAdapter(timeline, {
            compositionId: "hero",
            fps: 30,
            durationFrames: 120,
          }).getDurationFrames(),
        ).toBe(120);
      } finally {
        timeline.revert();
        gsap.ticker.sleep();
      }
    },
  );

  it("does not count inactive infinite branches toward parent duration", () => {
    const branch = gsap
      .timeline({ paused: true })
      .to({ x: 0 }, { x: 1, duration: 1, repeat: -1 });
    const timeline = gsap
      .timeline({ paused: true })
      .to({ x: 0 }, { x: 1, duration: 2 })
      .add(branch, 0);
    try {
      for (const paused of [true, false]) {
        branch.paused(paused).timeScale(paused ? 1 : 0);
        expect(
          createGsapFrameAdapter(timeline, {
            compositionId: "hero",
            fps: 30,
          }).getDurationFrames(),
        ).toBe(60);
      }
    } finally {
      timeline.revert();
      gsap.ticker.sleep();
    }
  });

  it("rejects explicit zero duration frame overrides", () => {
    const timeline = fakeTimeline(2.5);

    expect(() =>
      createGsapFrameAdapter(timeline, {
        compositionId: "hero",
        fps: 60,
        durationFrames: 0,
      }),
    ).toThrow("VELOCAST_GSAP_INVALID_OPTIONS");
  });

  it("rejects zero-second timelines when deriving duration", () => {
    const timeline = fakeTimeline(0);

    expect(() =>
      createGsapFrameAdapter(timeline, {
        compositionId: "hero",
        fps: 60,
      }),
    ).toThrow("VELOCAST_GSAP_INVALID_TIMELINE");
  });

  it("seeks by canonical frame time", async () => {
    const timeline = fakeTimeline(2.5);
    const adapter = createGsapFrameAdapter(timeline, {
      compositionId: "hero",
      fps: 60,
    });

    await adapter.seekFrame(30, {
      compositionId: "hero",
      width: 1920,
      height: 1080,
      fps: 60,
      durationFrames: 150,
    });

    expect(timeline.totalTime).toHaveBeenCalledWith(0.5, false);
  });

  it("rejects timeline-like objects missing pause()", () => {
    const timeline = {
      duration: vi.fn(() => 2.5),
      totalTime: vi.fn(),
      paused: vi.fn(() => false),
    };

    expect(() =>
      createGsapFrameAdapter(timeline, {
        compositionId: "hero",
        fps: 60,
      }),
    ).toThrow("VELOCAST_GSAP_INVALID_TIMELINE");
  });

  it("rejects timeline-like objects with malformed paused", () => {
    const timeline = {
      duration: vi.fn(() => 2.5),
      totalTime: vi.fn(),
      pause: vi.fn(),
      paused: true,
    };

    expect(() =>
      createGsapFrameAdapter(timeline, {
        compositionId: "hero",
        fps: 60,
      }),
    ).toThrow("VELOCAST_GSAP_INVALID_TIMELINE");
  });

  it("pauses unpaused timelines during adapter creation", () => {
    const timeline = fakeTimeline(2.5);
    createGsapFrameAdapter(timeline, {
      compositionId: "hero",
      fps: 60,
    });

    expect(timeline.pause).toHaveBeenCalledTimes(1);
  });

  it("pauses timelines when paused() is absent", () => {
    const timeline: FakeTimeline = {
      duration: vi.fn(() => 2.5),
      totalTime: vi.fn(),
      pause: vi.fn(),
    };

    createGsapFrameAdapter(timeline, {
      compositionId: "hero",
      fps: 60,
    });

    expect(timeline.pause).toHaveBeenCalledTimes(1);
  });

  it("pauses defensively during adapter init", async () => {
    const timeline = fakeTimeline(2.5);
    timeline
      .paused!.mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const adapter = createGsapFrameAdapter(timeline, {
      compositionId: "hero",
      fps: 60,
    });

    await adapter.init?.({
      compositionId: "hero",
      width: 1920,
      height: 1080,
      fps: 60,
      durationFrames: 150,
    });

    expect(timeline.pause).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid timeline objects", () => {
    expect(() =>
      createGsapFrameAdapter(undefined, {
        compositionId: "hero",
        fps: 60,
      }),
    ).toThrow("VELOCAST_GSAP_INVALID_TIMELINE");
  });
});

describe("registerGsapTimeline", () => {
  beforeEach(() => {
    clearFrameAdaptersForTest();
    window.__velocast = undefined;
  });

  it("registers a GSAP timeline as a Velocast composition", async () => {
    const timeline = fakeTimeline(4);

    registerGsapTimeline("hero", timeline, {
      width: 1920,
      height: 1080,
      fps: 60,
      target: "#hero",
      durationFrames: 240,
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
  });

  it("retains legacy defaults when the options object is omitted", async () => {
    const timeline = fakeTimeline(4);

    registerGsapTimeline("hero", timeline);

    await expect(window.__velocast?.getCompositions()).resolves.toEqual([
      {
        id: "hero",
        width: 1920,
        height: 1080,
        fps: 30,
        durationFrames: 120,
        target: "#hero",
      },
    ]);
  });

  it("pauses unpaused timelines during registration", () => {
    const timeline = fakeTimeline(4);

    registerGsapTimeline("hero", timeline, {
      width: 1920,
      height: 1080,
      fps: 60,
      target: "#hero",
      durationFrames: 240,
    });

    expect(timeline.pause).toHaveBeenCalledTimes(1);
  });

  it("pauses timelines without paused() during registration", () => {
    const timeline: FakeTimeline = {
      duration: vi.fn(() => 4),
      totalTime: vi.fn(),
      pause: vi.fn(),
    };

    registerGsapTimeline("hero", timeline, {
      width: 1920,
      height: 1080,
      fps: 60,
      target: "#hero",
      durationFrames: 240,
    });

    expect(timeline.pause).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid registration options with stable errors", () => {
    const timeline = fakeTimeline(4);

    expect(() =>
      registerGsapTimeline("hero", timeline, {
        width: 0,
      } as never),
    ).toThrow("VELOCAST_GSAP_INVALID_OPTIONS");
  });

  it("rejects non-object registration options with stable errors", () => {
    const timeline = fakeTimeline(4);

    expect(() =>
      registerGsapTimeline("hero", timeline, "bad-options" as never),
    ).toThrow("VELOCAST_GSAP_INVALID_OPTIONS");
  });

  it("rejects undefined adapter options with stable errors", () => {
    const timeline = fakeTimeline(4);

    expect(() => createGsapFrameAdapter(timeline, undefined as never)).toThrow(
      "VELOCAST_GSAP_INVALID_OPTIONS",
    );
  });
});

describe("defineGsapComposition", () => {
  const video = {
    width: 1280,
    height: 720,
    fps: 30,
    durationFrames: 90,
    target: "#hero",
  };

  it("keeps definition pure and opens a fresh paused timeline per session", async () => {
    const firstTimeline = fakeTimeline(3);
    const secondTimeline = fakeTimeline(3);
    firstTimeline.revert = vi.fn();
    firstTimeline.kill = vi.fn();
    secondTimeline.kill = vi.fn();
    const createTimeline = vi
      .fn()
      .mockReturnValueOnce(firstTimeline)
      .mockReturnValueOnce(secondTimeline);
    const composition = defineGsapComposition({
      id: "hero",
      video,
      defaultProps: { distance: 500 },
      createTimeline,
    });
    expect(createTimeline).not.toHaveBeenCalled();
    expect(composition.video).toEqual(video);

    const context = {
      compositionId: "hero",
      ...video,
      inputProps: { distance: 500 },
      signal: new AbortController().signal,
    };
    const first = await composition.source.open(context);
    const second = await composition.source.open(context);
    expect(createTimeline).toHaveBeenCalledTimes(2);
    expect(createTimeline).toHaveBeenCalledWith(context);
    expect(firstTimeline.pause).toHaveBeenCalledOnce();
    expect(secondTimeline.pause).toHaveBeenCalledOnce();

    await first.seekFrame(60, context);
    await first.seekFrame(15, context);
    await first.seekFrame(60, context);
    expect(firstTimeline.totalTime.mock.calls).toEqual([
      [2, true],
      [0.5, true],
      [2, true],
    ]);
    await first.dispose?.();
    await first.dispose?.();
    expect(firstTimeline.revert).toHaveBeenCalledOnce();
    expect(firstTimeline.kill).not.toHaveBeenCalled();
    expect(secondTimeline.kill).not.toHaveBeenCalled();
    await second.dispose?.();
    expect(secondTimeline.kill).toHaveBeenCalledOnce();
  });

  it("requires static authored duration frames", () => {
    expect(() =>
      defineGsapComposition({
        id: "hero",
        video: { ...video, durationFrames: undefined } as never,
        createTimeline: () => fakeTimeline(3),
      }),
    ).toThrow("video.durationFrames is required");
  });

  it("opens a real paused timeline without waiting for completion and seeks in either direction", async () => {
    const target = { x: 0 };
    const onUpdate = vi.fn();
    const timeline = gsap
      .timeline({ paused: true, repeat: 1, repeatDelay: 0.25, yoyo: true })
      .to(target, { x: 100, duration: 1, ease: "none", onUpdate });
    const composition = defineGsapComposition({
      id: "hero",
      video,
      createTimeline: () => timeline,
    });
    const context = {
      compositionId: "hero",
      ...video,
      inputProps: undefined,
      signal: new AbortController().signal,
    };
    // GSAP timelines are thenables. Unblock the old completion wait so a
    // regression fails on the advanced playhead and still releases its work.
    const unblock = setTimeout(() => timeline.totalProgress(1), 100);
    try {
      const session = await composition.source.open(context);
      clearTimeout(unblock);
      expect(timeline.totalTime()).toBe(0);
      for (const [frame, x] of [
        [15, 50],
        [45, 75],
        [30, 100],
        [0, 0],
        [75, 0],
        [15, 50],
      ] as const) {
        await session.seekFrame(frame, context);
        expect(target.x).toBe(x);
      }
      expect(onUpdate).not.toHaveBeenCalled();
      await session.dispose?.();
      expect(target.x).toBe(0);
      expect(timeline.parent).toBeNull();
    } finally {
      clearTimeout(unblock);
      timeline.revert();
      gsap.ticker.sleep();
    }
  });

  it("honors cancellation before opening and seeking", async () => {
    const timeline = fakeTimeline(3);
    const createTimeline = vi.fn(() => timeline);
    const composition = defineGsapComposition({
      id: "hero",
      video,
      createTimeline,
    });
    const controller = new AbortController();
    const context = {
      compositionId: "hero",
      ...video,
      inputProps: undefined,
      signal: controller.signal,
    };
    const session = await composition.source.open(context);
    controller.abort(new Error("cancelled"));
    expect(() => session.seekFrame(30, context)).toThrow("cancelled");
    expect(timeline.totalTime).not.toHaveBeenCalled();
    await expect(composition.source.open(context)).rejects.toThrow("cancelled");
    expect(createTimeline).toHaveBeenCalledOnce();
  });

  it("reverts a timeline if opening is cancelled after its factory runs", async () => {
    const controller = new AbortController();
    const timeline = fakeTimeline(3);
    timeline.revert = vi.fn();
    timeline.kill = vi.fn();
    const composition = defineGsapComposition({
      id: "hero",
      video,
      createTimeline: async () => {
        await Promise.resolve();
        controller.abort(new Error("cancelled during open"));
        return timeline;
      },
    });
    const context = {
      compositionId: "hero",
      ...video,
      inputProps: undefined,
      signal: controller.signal,
    };

    await expect(composition.source.open(context)).rejects.toThrow(
      "cancelled during open",
    );
    expect(timeline.revert).toHaveBeenCalledOnce();
    expect(timeline.kill).not.toHaveBeenCalled();
  });
});
