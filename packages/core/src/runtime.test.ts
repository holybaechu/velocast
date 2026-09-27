import { beforeEach, describe, expect, it, vi } from "vitest";
import { VelocastRuntime } from "./runtime.js";
import type { FrameAdapter } from "./types.js";

function adapter(durationFrames = 90, calls: string[] = []): FrameAdapter {
  return {
    id: `test-adapter-${durationFrames}`,
    init(context) {
      calls.push(`init:${context.compositionId}`);
    },
    getDurationFrames() {
      return durationFrames;
    },
    seekFrame(frame, context) {
      calls.push(`seek:${context.compositionId}:${frame}`);
    },
    destroy() {
      calls.push("destroy");
    },
  };
}

describe("VelocastRuntime", () => {
  beforeEach(() => {
    window.__velocast = undefined;
    window.Velocast = undefined;
  });

  it("pins a session/source identity and rejects stale frame contexts before mutation", async () => {
    const runtime = new VelocastRuntime();
    const seen: unknown[] = [];
    const options = { width: 320, height: 180, fps: 30, target: "#hero" };
    const protocol = runtime.registerFrameAdapter(
      "hero",
      {
        id: "identity-fixture",
        getDurationFrames: () => 120,
        seekFrame(_frame, context) {
          seen.push(context.renderSession);
        },
      },
      options,
    );
    const session = { sessionId: "job-a", sourceVersion: "sha256:source-a" };
    await protocol.beginSession(session);
    session.sourceVersion = "changed-by-caller";
    expect(protocol.getSession()).toEqual({
      sessionId: "job-a",
      sourceVersion: "sha256:source-a",
    });
    const context = { ...options, compositionId: "hero", durationFrames: 120 };
    await expect(protocol.seekFrame("hero", 90, context)).rejects.toThrow(
      "VELOCAST_SESSION_MISMATCH",
    );
    await expect(
      protocol.seekFrame("hero", 90, {
        ...context,
        renderSession: { sessionId: "job-a", sourceVersion: "sha256:source-b" },
      }),
    ).rejects.toThrow("VELOCAST_SESSION_MISMATCH");
    await protocol.seekFrame("hero", 90, {
      ...context,
      renderSession: protocol.getSession(),
    });
    expect(seen).toEqual([
      { sessionId: "job-a", sourceVersion: "sha256:source-a" },
    ]);
    await expect(protocol.beginSession({ sessionId: "job-b" })).rejects.toThrow(
      "VELOCAST_SESSION_MISMATCH",
    );
    await protocol.destroy();
    expect(protocol.getSession()).toBeUndefined();
    await protocol.beginSession({ sessionId: "job-b" });
    expect(protocol.getSession()).toEqual({ sessionId: "job-b" });
  });

  it("cancels a pending mount and waits for its cleanup before reopening the runtime", async () => {
    const runtime = new VelocastRuntime();
    let releaseMount: (() => void) | undefined;
    let signal: AbortSignal | undefined;
    let mounts = 0;
    const seeks: number[] = [];
    const protocol = runtime.registerFrameAdapter(
      "hero",
      {
        id: "cancel-fixture",
        getDurationFrames: () => 120,
        async init(context) {
          signal = context.signal;
          mounts++;
          if (mounts === 1)
            await new Promise<void>((resolve) => {
              releaseMount = resolve;
            });
        },
        seekFrame(frame) {
          seeks.push(frame);
        },
      },
      { width: 320, height: 180, fps: 30, target: "#hero" },
    );
    const pending = protocol.seekFrame("hero", 90);
    await vi.waitFor(() => expect(releaseMount).toBeTypeOf("function"));
    protocol.cancelPending();
    await expect(pending).rejects.toThrow("VELOCAST_REQUEST_CANCELLED");
    expect(signal?.aborted).toBe(true);
    await expect(protocol.seekFrame("hero", 12)).rejects.toThrow(
      "VELOCAST_RUNTIME_CANCELLED",
    );
    const destroyed = protocol.destroy?.();
    releaseMount?.();
    await destroyed;
    expect(seeks).toEqual([]);
    await protocol.seekFrame("hero", 12);
    expect(mounts).toBe(2);
    expect(seeks).toEqual([12]);
  });

  it("rejects overlapping frame mutation instead of initializing the same adapter twice", async () => {
    const runtime = new VelocastRuntime();
    let release: (() => void) | undefined;
    const init = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const protocol = runtime.registerFrameAdapter(
      "hero",
      {
        id: "busy-fixture",
        getDurationFrames: () => 120,
        init,
        seekFrame() {},
      },
      { width: 320, height: 180, fps: 30, target: "#hero" },
    );
    const first = protocol.seekFrame("hero", 0);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await expect(protocol.seekFrame("hero", 90)).rejects.toThrow(
      "VELOCAST_RUNTIME_BUSY",
    );
    release?.();
    await first;
    await protocol.seekFrame("hero", 90);
    expect(init).toHaveBeenCalledOnce();
  });

  it("passes cancellation to readiness hooks and waits for their cleanup", async () => {
    const runtime = new VelocastRuntime();
    let release: (() => void) | undefined;
    let readySignal: AbortSignal | undefined;
    const protocol = runtime.installBrowserProtocol({
      waitForReady(signal) {
        readySignal = signal;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    const readiness = protocol.waitForReady?.();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    protocol.cancelPending();
    await expect(readiness).rejects.toThrow("VELOCAST_REQUEST_CANCELLED");
    expect(readySignal?.aborted).toBe(true);
    const cleanup = protocol.destroy();
    release?.();
    await cleanup;
  });

  it("keeps a failed teardown closed until cleanup is retried successfully", async () => {
    const runtime = new VelocastRuntime();
    const destroy = vi
      .fn()
      .mockRejectedValueOnce(new Error("cleanup failed"))
      .mockResolvedValue(undefined);
    const protocol = runtime.registerFrameAdapter(
      "hero",
      {
        id: "cleanup-fixture",
        getDurationFrames: () => 120,
        seekFrame() {},
        destroy,
      },
      { width: 320, height: 180, fps: 30, target: "#hero" },
    );
    await expect(protocol.destroy()).rejects.toThrow("VELOCAST_DESTROY_FAILED");
    await expect(protocol.seekFrame("hero", 0)).rejects.toThrow(
      "VELOCAST_RUNTIME_CANCELLED",
    );
    await protocol.destroy();
    await expect(protocol.seekFrame("hero", 0)).resolves.toBeUndefined();
  });

  it("preserves input props across native frame contexts that omit them", async () => {
    const runtime = new VelocastRuntime();
    const seen: unknown[] = [];
    const protocol = runtime.registerFrameAdapter(
      "hero",
      {
        id: "props-fixture",
        getDurationFrames: () => 120,
        init: (context) => {
          seen.push(context.inputProps);
        },
        seekFrame: (_frame, context) => {
          seen.push(context.inputProps);
        },
      },
      { width: 640, height: 360, fps: 60, target: "#hero" },
    );
    const props = { title: "한글 제목" };
    await protocol.setInputProps?.(props);
    for (const frame of [0, 90, 12, 90]) {
      await protocol.seekFrame("hero", frame, {
        compositionId: "hero",
        width: 640,
        height: 360,
        fps: 60,
        durationFrames: 120,
      });
    }
    expect(seen).toEqual([props, props, props, props, props]);
  });

  it("clears session input props when destroying adapters", async () => {
    const runtime = new VelocastRuntime();
    const seen: unknown[] = [];
    const protocol = runtime.registerFrameAdapter(
      "hero",
      {
        id: "props-fixture",
        getDurationFrames: () => 120,
        seekFrame: (_frame, context) => {
          seen.push(context.inputProps);
        },
      },
      { width: 640, height: 360, fps: 60, target: "#hero" },
    );
    await protocol.setInputProps?.({ session: "previous" });
    await protocol.seekFrame("hero", 0);
    await protocol.destroy?.();
    await protocol.seekFrame("hero", 0);
    expect(seen).toEqual([{ session: "previous" }, undefined]);
  });

  it("provides the mounted root to the first seek when init creates it", async () => {
    document.body.innerHTML = "";
    const runtime = new VelocastRuntime();
    let seenRoot: HTMLElement | undefined;
    const protocol = runtime.registerFrameAdapter(
      "hero",
      {
        id: "lazy-root",
        getDurationFrames: () => 120,
        async init() {
          await Promise.resolve();
          document.body.innerHTML = '<div id="mounted-hero"></div>';
        },
        seekFrame: (_frame, context) => {
          seenRoot = context.rootElement;
        },
      },
      {
        width: 640,
        height: 360,
        fps: 60,
        target: "#mounted-hero",
        rootElement: "#mounted-hero",
      },
    );

    await protocol.seekFrame("hero", 90);
    expect(seenRoot).toBe(document.getElementById("mounted-hero"));
  });

  it("keeps per-frame props overrides separate from session defaults", async () => {
    const runtime = new VelocastRuntime();
    const seen: unknown[] = [];
    const options = { width: 640, height: 360, fps: 60, target: "#hero" };
    const protocol = runtime.registerFrameAdapter(
      "hero",
      {
        id: "props-fixture",
        getDurationFrames: () => 120,
        seekFrame: (_frame, context) => {
          seen.push(context.inputProps);
        },
      },
      options,
    );
    await protocol.setInputProps?.({ title: "default" });
    await protocol.seekFrame("hero", 90, {
      ...options,
      compositionId: "hero",
      durationFrames: 120,
      inputProps: null,
    });
    await protocol.seekFrame("hero", 90);
    await protocol.setInputProps?.({ title: "updated" });
    await protocol.seekFrame("hero", 90);
    expect(seen).toEqual([null, { title: "default" }, { title: "updated" }]);
  });

  it("does not publish input props when the asynchronous application hook fails", async () => {
    const runtime = new VelocastRuntime();
    const seen: unknown[] = [];
    runtime.registerFrameAdapter(
      "hero",
      {
        id: "props-fixture",
        getDurationFrames: () => 120,
        seekFrame: (_frame, context) => {
          seen.push(context.inputProps);
        },
      },
      { width: 640, height: 360, fps: 60, target: "#hero" },
    );
    const protocol = runtime.installBrowserProtocol({
      async setInputProps(props) {
        if (props === "bad") throw new Error("input rejected");
      },
    });
    await protocol.setInputProps?.("good");
    await expect(protocol.setInputProps?.("bad")).rejects.toThrow(
      "input rejected",
    );
    await protocol.seekFrame("hero", 90);
    expect(seen).toEqual(["good"]);
  });

  it("rejects missing required metadata from script callers before registration", async () => {
    const runtime = new VelocastRuntime();
    const options = {
      height: 630,
      fps: 30,
      target: "#hero",
    } as Parameters<VelocastRuntime["registerFrameAdapter"]>[2];

    expect(() =>
      runtime.registerFrameAdapter("hero", adapter(10), options),
    ).toThrow(
      "VELOCAST_INVALID_COMPOSITION: composition hero width must be a positive integer",
    );
    await expect(
      runtime.installBrowserProtocol().getCompositions(),
    ).resolves.toEqual([]);
  });

  it("lists the same renderable compositions as the browser protocol", async () => {
    const runtime = new VelocastRuntime();
    const calls: string[] = [];
    const protocol = runtime.registerFrameAdapter("hero", adapter(12, calls), {
      width: 640,
      height: 480,
      fps: 24,
      target: " #hero ",
      maxConcurrency: 2,
    });

    expect(runtime.getRenderableCompositions()).toEqual([
      {
        id: "hero",
        width: 640,
        height: 480,
        fps: 24,
        durationFrames: 12,
        target: "#hero",
        maxConcurrency: 2,
      },
    ]);
    await expect(protocol.getCompositions()).resolves.toEqual(
      runtime.getRenderableCompositions(),
    );
    await protocol.seekFrame("hero", 15);
    expect(calls).toEqual(["init:hero", "seek:hero:11"]);
  });

  it("isolates browser protocol adapters and initialization state", async () => {
    const firstCalls: string[] = [];
    const secondCalls: string[] = [];
    const first = new VelocastRuntime();
    const second = new VelocastRuntime();

    const firstProtocol = first.registerFrameAdapter(
      "hero",
      adapter(10, firstCalls),
      {
        width: 1200,
        height: 630,
        fps: 30,
        target: "#hero",
      },
    );
    const secondProtocol = second.registerFrameAdapter(
      "hero",
      adapter(20, secondCalls),
      {
        width: 800,
        height: 800,
        fps: 24,
        target: "#hero-secondary",
      },
    );

    await expect(firstProtocol.getCompositions()).resolves.toEqual([
      {
        id: "hero",
        width: 1200,
        height: 630,
        fps: 30,
        durationFrames: 10,
        target: "#hero",
      },
    ]);
    await expect(secondProtocol.getCompositions()).resolves.toEqual([
      {
        id: "hero",
        width: 800,
        height: 800,
        fps: 24,
        durationFrames: 20,
        target: "#hero-secondary",
      },
    ]);

    await firstProtocol.seekFrame("hero", 99);
    await firstProtocol.seekFrame("hero", 1);
    await secondProtocol.seekFrame("hero", 99);

    expect(firstCalls).toEqual(["init:hero", "seek:hero:9", "seek:hero:1"]);
    expect(secondCalls).toEqual(["init:hero", "seek:hero:19"]);
  });

  it("isolates browser protocol options across runtime instances", async () => {
    const calls: string[] = [];
    const first = new VelocastRuntime();
    const second = new VelocastRuntime();

    const firstProtocol = first.installBrowserProtocol({
      setInputProps(inputProps) {
        calls.push(`first:set:${JSON.stringify(inputProps)}`);
      },
      waitForReady() {
        calls.push("first:ready");
      },
    });
    const secondProtocol = second.installBrowserProtocol({
      setInputProps(inputProps) {
        calls.push(`second:set:${JSON.stringify(inputProps)}`);
      },
      waitForReady() {
        calls.push("second:ready");
      },
    });

    await firstProtocol.setInputProps?.({ value: 1 });
    await secondProtocol.setInputProps?.({ value: 2 });
    await firstProtocol.waitForReady?.();
    await secondProtocol.waitForReady?.();

    expect(calls).toEqual([
      'first:set:{"value":1}',
      'second:set:{"value":2}',
      "first:ready",
      "second:ready",
    ]);
  });

  it("reinstalls adapter protocols on the configured target window", async () => {
    const runtime = new VelocastRuntime();
    const customTarget = {
      document,
      __velocast: undefined,
      Velocast: undefined,
    } as unknown as Window;

    runtime.installBrowserProtocol({}, customTarget);
    const protocol = runtime.registerFrameAdapter("hero", adapter(12), {
      width: 640,
      height: 480,
      fps: 24,
      target: "#hero",
    });

    expect(customTarget.__velocast).toBe(protocol);
    expect(customTarget.Velocast).toBe(runtime.global);
    expect(window.__velocast).toBeUndefined();
    await expect(protocol.getDurationFrames("hero")).resolves.toBe(12);
  });

  it("binds the browser global adapter facade to its owning runtime", async () => {
    const runtime = new VelocastRuntime();
    const protocol = runtime.global.registerAdapter("hero", adapter(12), {
      width: 640,
      height: 480,
      fps: 24,
      target: "#hero",
    });

    expect(window.Velocast).toBe(runtime.global);
    expect(window.__velocast).toBe(protocol);
    await expect(protocol.getDurationFrames("hero")).resolves.toBe(12);
  });
});
