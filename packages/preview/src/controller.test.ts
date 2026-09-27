import { describe, expect, it, vi } from "vitest";
import { PreviewController } from "./controller.js";
import type { PreviewSource, PreviewTransport } from "./types.js";
import type { AudioPlanClock } from "./types.js";

function source(version = "v1"): PreviewSource {
  return {
    session: { sessionId: "session", sourceVersion: version },
    composition: {
      id: "scene",
      width: 320,
      height: 180,
      fps: 30,
      durationFrames: 90,
      target: "#scene",
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function transport(): PreviewTransport<string> {
  return {
    initialize: vi.fn(async () => {}),
    seekFrame: vi.fn(async (frame) => `frame-${frame}`),
    dispose: vi.fn(async () => {}),
  };
}

describe("preview latest-intent transport", () => {
  it("seeks the exact shared rounded audio boundary at44100/24", async () => {
    const clock: AudioPlanClock = {
      sampleRate: 44100,
      durationSamples: 44100,
      currentSample: () => 0,
      play: async () => {},
      pause: vi.fn(),
      seek: vi.fn(),
      dispose: vi.fn(async () => {}),
    };
    const audioSource: PreviewSource = {
      ...source(),
      composition: { ...source().composition, fps: 24, durationFrames: 24 },
      audioPlan: { sampleRate: 44100, durationSamples: 44100, clips: [] },
    };
    const controller = new PreviewController({
      transport: transport(),
      prepareAudio: async () => clock,
    });
    await controller.refresh(audioSource, 1);
    expect(clock.seek).toHaveBeenLastCalledWith(1838);
    await controller.dispose();
  });

  it("cleans up current errors without another command and preserves original cause", async () => {
    const original = new Error("broken source");
    const port = transport();
    vi.mocked(port.seekFrame).mockRejectedValueOnce(original);
    const controller = new PreviewController({ transport: port });
    await expect(controller.refresh(source())).rejects.toMatchObject({
      cause: original,
    });
    expect(port.dispose).toHaveBeenCalledOnce();
    expect(controller.getState().error?.cause).toBe(original);
    await controller.dispose();
    expect(port.dispose).toHaveBeenCalledOnce();
  });

  it("invalid input pauses/disposes audio and retains cleanup errors for a later retry", async () => {
    const port = transport();
    const closeFailure = new Error("close failed");
    const clock: AudioPlanClock = {
      sampleRate: 48000,
      durationSamples: 144000,
      currentSample: () => 0,
      play: async () => {},
      pause: vi.fn(),
      seek: vi.fn(),
      dispose: vi.fn(async () => {}),
    };
    const controller = new PreviewController({
      transport: port,
      prepareAudio: async () => clock,
    });
    await controller.refresh({
      ...source(),
      audioPlan: { sampleRate: 48000, durationSamples: 144000, clips: [] },
    });
    vi.mocked(port.dispose).mockRejectedValueOnce(closeFailure);
    await expect(controller.seek(Number.NaN)).rejects.toMatchObject({
      code: "preview.invalid_frame",
      cleanupError: expect.any(AggregateError),
    });
    expect(clock.pause).toHaveBeenCalled();
    expect(clock.dispose).toHaveBeenCalledOnce();
    expect(controller.getState().error?.cause).toBeInstanceOf(RangeError);
    await controller.dispose();
    expect(port.dispose).toHaveBeenCalledTimes(2);
  });
  it("does not replace the active source when refresh validation fails", async () => {
    const port = transport();
    const controller = new PreviewController({ transport: port });
    await controller.refresh(source());
    await expect(controller.refresh(source("v2"), Number.NaN)).rejects.toThrow(
      "preview.invalid_source",
    );
    expect(controller.getState().phase).toBe("error");
    await controller.seek(1);
    expect(
      vi.mocked(port.seekFrame).mock.calls.at(-1)![1].session.sourceVersion,
    ).toBe("v1");
    await controller.dispose();
  });

  it("supports reentrant state commands without aborting already-published work", async () => {
    const port = transport();
    const aborted = vi.fn();
    vi.mocked(port.seekFrame).mockImplementation(
      async (frame, _source, signal) => {
        signal.addEventListener("abort", aborted);
        return `frame-${frame}`;
      },
    );
    const controller = new PreviewController({ transport: port });
    let next: Promise<void> | undefined;
    controller.subscribe((state) => {
      if (state.phase === "ready" && state.presentedFrame === 0)
        next = controller.seek(1);
    });
    await controller.refresh(source());
    await next;
    expect(aborted).not.toHaveBeenCalled();
    expect(controller.getState().presentedFrame).toBe(1);
    await controller.dispose();
  });
  it("coalesces queued seeks, joins old work, and never publishes its late result", async () => {
    const port = transport();
    const gate = deferred<string>();
    const events: number[] = [];
    const controller = new PreviewController({ transport: port });
    controller.subscribe((state) => {
      if (state.presentedFrame !== undefined) events.push(state.presentedFrame);
    });
    await controller.refresh(source());
    vi.mocked(port.seekFrame).mockImplementationOnce(() => gate.promise);
    const old = controller.seek(1);
    const cancelled = expect(old).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(port.seekFrame).toHaveBeenCalledTimes(2));
    const skipped = controller.seek(2);
    const skippedResult = expect(skipped).rejects.toMatchObject({
      name: "AbortError",
    });
    const latest = controller.seek(3);
    expect(port.seekFrame).toHaveBeenCalledTimes(2);
    gate.resolve("late-one");
    await Promise.all([cancelled, skippedResult, latest]);
    expect(vi.mocked(port.seekFrame).mock.calls.map((call) => call[0])).toEqual(
      [0, 1, 3],
    );
    expect(events).toEqual([0, 3]);
    expect(controller.getState().frame).toBe("frame-3");
    await controller.dispose();
  });

  it("refresh waits for old seek and cleanup before initializing the next source", async () => {
    const calls: string[] = [];
    const gate = deferred<string>();
    let first = true;
    const port: PreviewTransport<string> = {
      initialize: async (s) => {
        calls.push(`init-${s.session.sourceVersion}`);
      },
      seekFrame: async (_frame, s) => {
        calls.push(`seek-${s.session.sourceVersion}`);
        if (first) {
          first = false;
          return gate.promise;
        }
        return "new";
      },
      dispose: async () => {
        calls.push("dispose");
      },
    };
    const controller = new PreviewController({ transport: port });
    const old = controller.refresh(source());
    const cancelled = expect(old).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(calls).toEqual(["init-v1", "seek-v1"]));
    const next = controller.refresh(source("v2"), 12);
    expect(calls).toEqual(["init-v1", "seek-v1"]);
    gate.resolve("stale");
    await Promise.all([cancelled, next]);
    expect(calls).toEqual([
      "init-v1",
      "seek-v1",
      "dispose",
      "init-v2",
      "seek-v2",
    ]);
    expect(controller.getState()).toMatchObject({
      phase: "ready",
      presentedFrame: 12,
      source: { session: { sourceVersion: "v2" } },
    });
    await controller.dispose();
  });

  it("dispose aborts but still joins active work and rejects future commands", async () => {
    const port = transport();
    const gate = deferred<string>();
    vi.mocked(port.seekFrame).mockImplementation(() => gate.promise);
    const controller = new PreviewController({ transport: port });
    const pending = controller.refresh(source());
    const cancelled = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.waitFor(() => expect(port.seekFrame).toHaveBeenCalledOnce());
    const signal = vi.mocked(port.seekFrame).mock.calls[0]![2];
    const disposal = controller.dispose();
    expect(signal.aborted).toBe(true);
    expect(port.dispose).not.toHaveBeenCalled();
    gate.resolve("late");
    await Promise.all([cancelled, disposal]);
    expect(port.dispose).toHaveBeenCalledOnce();
    expect(controller.getState()).toEqual({ phase: "disposed" });
    await expect(controller.seek(1)).rejects.toThrow("preview.disposed");
  });
});
