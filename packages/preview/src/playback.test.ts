import { expect, it, vi } from "vitest";
import { PreviewController } from "./controller.js";
import type {
  AudioPlanClock,
  PreviewScheduler,
  PreviewSource,
  PreviewTransport,
} from "./types.js";

function source(fps = 10, durationFrames = 10): PreviewSource {
  return {
    session: { sessionId: "session", sourceVersion: "version" },
    composition: {
      id: "scene",
      width: 320,
      height: 180,
      fps,
      durationFrames,
      target: "#scene",
    },
  };
}
function scheduler() {
  let time = 0;
  const callbacks = new Set<() => void>();
  const port: PreviewScheduler = {
    now: vi.fn(() => time),
    schedule: vi.fn((callback) => {
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
      };
    }),
  };
  return {
    port,
    callbacks,
    advance(value: number) {
      time = value;
      const ready = [...callbacks];
      callbacks.clear();
      for (const callback of ready) callback();
    },
  };
}
function transport(): PreviewTransport<string> {
  return {
    initialize: vi.fn(async () => {}),
    seekFrame: vi.fn(async (frame) => `frame-${frame}`),
    dispose: vi.fn(async () => {}),
  };
}
function audioClock(sampleRate = 44100, durationSamples = 44100) {
  let position = 0;
  const port: AudioPlanClock = {
    sampleRate,
    durationSamples,
    currentSample: vi.fn(() => position),
    play: vi.fn(async () => {}),
    pause: vi.fn(),
    seek: vi.fn((sample) => {
      position = sample;
    }),
    dispose: vi.fn(async () => {}),
  };
  return {
    port,
    sample(value: number) {
      position = value;
    },
  };
}
function audioSource(): PreviewSource {
  return {
    ...source(24, 24),
    audioPlan: { sampleRate: 44100, durationSamples: 44100, clips: [] },
  };
}

it("plays a silent source on an absolute monotonic clock, clips the endpoint and replays", async () => {
  const clock = scheduler();
  const port = transport();
  const controller = new PreviewController({
    transport: port,
    scheduler: clock.port,
  });
  await controller.refresh(source());
  await controller.play();
  expect(controller.getState().phase).toBe("playing");
  clock.advance(350);
  await vi.waitFor(() => expect(controller.getState().presentedFrame).toBe(3));
  expect(clock.callbacks.size).toBe(1);
  clock.advance(2000);
  await vi.waitFor(() =>
    expect(controller.getState()).toMatchObject({
      phase: "ready",
      presentedFrame: 9,
      ended: true,
      playing: false,
    }),
  );
  expect(clock.callbacks.size).toBe(0);
  await controller.play();
  expect(controller.getState()).toMatchObject({
    phase: "playing",
    presentedFrame: 0,
    ended: false,
  });
  await controller.pause();
  expect(controller.getState().phase).toBe("ready");
  expect(clock.callbacks.size).toBe(0);
  await controller.dispose();
});

it("uses audio samples as master and never re-seeks or re-starts audio on visual ticks", async () => {
  const clock = scheduler();
  vi.mocked(clock.port.now).mockImplementation(() => {
    throw new Error("silent clock must not run");
  });
  const audio = audioClock();
  const controller = new PreviewController({
    transport: transport(),
    scheduler: clock.port,
    prepareAudio: async () => audio.port,
  });
  await controller.refresh(audioSource());
  await controller.play();
  const seeks = vi.mocked(audio.port.seek).mock.calls.length;
  audio.sample(8820);
  clock.advance(999999);
  await vi.waitFor(() => expect(controller.getState().presentedFrame).toBe(4));
  audio.sample(18375);
  clock.advance(1000000);
  await vi.waitFor(() => expect(controller.getState().presentedFrame).toBe(10));
  expect(audio.port.seek).toHaveBeenCalledTimes(seeks);
  expect(audio.port.play).toHaveBeenCalledOnce();
  expect(clock.port.now).not.toHaveBeenCalled();
  await controller.seek(1);
  expect(audio.port.seek).toHaveBeenLastCalledWith(1838);
  expect(audio.port.play).toHaveBeenCalledTimes(2);
  await controller.pause();
  expect(controller.getState().presentedFrame).toBe(1);
  expect(clock.callbacks.size).toBe(0);
  await controller.dispose();
});

it("clips playback and manual seeks to a half-open selected range", async () => {
  const clock = scheduler();
  const controller = new PreviewController({
    transport: transport(),
    scheduler: clock.port,
  });
  await controller.refresh(source());
  await controller.setPlaybackRange({ start: 2, end: 5 });
  expect(controller.getState().presentedFrame).toBe(2);
  await controller.seek(99);
  expect(controller.getState().presentedFrame).toBe(4);
  await controller.seek(-10);
  expect(controller.getState().presentedFrame).toBe(2);
  await controller.play();
  clock.advance(300);
  await vi.waitFor(() =>
    expect(controller.getState()).toMatchObject({
      phase: "ready",
      presentedFrame: 4,
      ended: true,
    }),
  );
  expect(clock.callbacks.size).toBe(0);
  await controller.dispose();
});

it("awaits slow visual seeks then samples the newest clock rather than enqueuing every tick", async () => {
  const clock = scheduler();
  const port = transport();
  let resolve!: (value: string) => void;
  const controller = new PreviewController({
    transport: port,
    scheduler: clock.port,
  });
  await controller.refresh(source());
  await controller.play();
  vi.mocked(port.seekFrame).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  clock.advance(100);
  await vi.waitFor(() => expect(port.seekFrame).toHaveBeenCalledTimes(3));
  clock.advance(800);
  expect(clock.callbacks.size).toBe(0);
  expect(port.seekFrame).toHaveBeenCalledTimes(3);
  resolve("frame-1");
  await vi.waitFor(() => expect(clock.callbacks.size).toBe(1));
  clock.advance(800);
  await vi.waitFor(() => expect(controller.getState().presentedFrame).toBe(8));
  expect(vi.mocked(port.seekFrame).mock.calls.map((call) => call[0])).toEqual([
    0, 0, 1, 8,
  ]);
  await controller.dispose();
});

it("invalid clock positions are visible and close resources without another command", async () => {
  const clock = scheduler();
  const audio = audioClock();
  const port = transport();
  const controller = new PreviewController({
    transport: port,
    scheduler: clock.port,
    prepareAudio: async () => audio.port,
  });
  await controller.refresh(audioSource());
  await controller.play();
  audio.sample(Number.NaN);
  clock.advance(1);
  await vi.waitFor(() => expect(audio.port.dispose).toHaveBeenCalledOnce());
  expect(controller.getState()).toMatchObject({
    phase: "error",
    playing: false,
  });
  expect(controller.getState().error?.cause).toBeInstanceOf(Error);
  expect(port.dispose).toHaveBeenCalledOnce();
  expect(clock.callbacks.size).toBe(0);
  await controller.dispose();
});

it("reports blocked audio resume and preserves its cause after cleanup", async () => {
  const original = new Error("resume denied");
  const clock = scheduler();
  const audio = audioClock();
  const port = transport();
  vi.mocked(audio.port.play).mockRejectedValueOnce(original);
  const controller = new PreviewController({
    transport: port,
    scheduler: clock.port,
    prepareAudio: async () => audio.port,
  });
  await controller.refresh(audioSource());
  await expect(controller.play()).rejects.toMatchObject({ cause: original });
  expect(controller.getState().phase).toBe("error");
  expect(audio.port.dispose).toHaveBeenCalledOnce();
  expect(port.dispose).toHaveBeenCalledOnce();
  expect(clock.callbacks.size).toBe(0);
  await controller.dispose();
});

it("pause can cancel an unresolved audio resume and joins disposal before replacement", async () => {
  let resume!: () => void;
  const first = audioClock();
  const replacement = audioClock();
  const clock = scheduler();
  const port = transport();
  vi.mocked(first.port.play).mockImplementation(
    () =>
      new Promise<void>((done) => {
        resume = done;
      }),
  );
  const factory = vi
    .fn()
    .mockResolvedValueOnce(first.port)
    .mockResolvedValueOnce(replacement.port);
  const controller = new PreviewController({
    transport: port,
    scheduler: clock.port,
    prepareAudio: factory,
  });
  await controller.refresh(audioSource());
  const playing = controller.play();
  const cancelled = expect(playing).rejects.toMatchObject({
    name: "AbortError",
  });
  await vi.waitFor(() => expect(first.port.play).toHaveBeenCalledOnce());
  await controller.pause();
  await cancelled;
  expect(first.port.dispose).toHaveBeenCalledOnce();
  expect(controller.getState().phase).toBe("ready");
  resume();
  await Promise.resolve();
  expect(replacement.port.play).not.toHaveBeenCalled();
  expect(clock.callbacks.size).toBe(0);
  await controller.dispose();
});

it("refresh during playback joins the old frame and clock before publishing the new version", async () => {
  const clock = scheduler();
  const first = audioClock();
  const second = audioClock();
  const port = transport();
  const factory = vi
    .fn()
    .mockResolvedValueOnce(first.port)
    .mockResolvedValueOnce(second.port);
  const controller = new PreviewController({
    transport: port,
    scheduler: clock.port,
    prepareAudio: factory,
  });
  const published: string[] = [];
  controller.subscribe((state) => {
    if (state.frame !== undefined)
      published.push(
        `${state.source!.session.sourceVersion}:${state.presentedFrame}`,
      );
  });
  await controller.refresh(audioSource());
  await controller.play();
  let finish!: (value: string) => void;
  vi.mocked(port.seekFrame).mockImplementationOnce(
    () =>
      new Promise((done) => {
        finish = done;
      }),
  );
  const old = controller.seek(1);
  const cancelled = expect(old).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(port.seekFrame).toHaveBeenCalledTimes(3));
  const next = controller.refresh(
    {
      ...audioSource(),
      session: { sessionId: "session", sourceVersion: "new" },
    },
    2,
  );
  expect(factory).toHaveBeenCalledOnce();
  finish("stale-old");
  await Promise.all([cancelled, next]);
  expect(first.port.dispose).toHaveBeenCalledOnce();
  expect(second.port.play).toHaveBeenCalledOnce();
  expect(published).toEqual(["version:0", "version:0", "new:2"]);
  expect(controller.getState().phase).toBe("playing");
  await controller.dispose();
});

it("late cancelled callbacks cannot lose the current schedule's disposal handle", async () => {
  const clock = scheduler();
  const port = transport();
  const controller = new PreviewController({
    transport: port,
    scheduler: clock.port,
  });
  await controller.refresh(source());
  await controller.play();
  const late = [...clock.callbacks][0]!;
  await controller.seek(3);
  expect(clock.callbacks.size).toBe(1);
  const count = vi.mocked(port.seekFrame).mock.calls.length;
  late();
  expect(port.seekFrame).toHaveBeenCalledTimes(count);
  await controller.dispose();
  expect(clock.callbacks.size).toBe(0);
});

it("a regressing silent clock fails visibly and stops further scheduling", async () => {
  const clock = scheduler();
  const port = transport();
  const controller = new PreviewController({
    transport: port,
    scheduler: clock.port,
  });
  await controller.refresh(source());
  await controller.play();
  clock.advance(100);
  await vi.waitFor(() => expect(controller.getState().presentedFrame).toBe(1));
  clock.advance(50);
  await vi.waitFor(() => expect(port.dispose).toHaveBeenCalledOnce());
  expect(controller.getState()).toMatchObject({
    phase: "error",
    playing: false,
  });
  expect(clock.callbacks.size).toBe(0);
  await controller.dispose();
});

it("pause during queued source refresh keeps its selected frame instead of the old audio cursor", async () => {
  const clock = scheduler();
  const first = audioClock();
  const second = audioClock();
  const port = transport();
  const factory = vi
    .fn()
    .mockResolvedValueOnce(first.port)
    .mockResolvedValueOnce(second.port);
  const controller = new PreviewController({
    transport: port,
    scheduler: clock.port,
    prepareAudio: factory,
  });
  await controller.refresh(audioSource());
  await controller.play();
  let finish!: (value: string) => void;
  vi.mocked(port.seekFrame).mockImplementationOnce(
    () =>
      new Promise((done) => {
        finish = done;
      }),
  );
  const old = controller.seek(1);
  const oldCancelled = expect(old).rejects.toMatchObject({
    name: "AbortError",
  });
  await vi.waitFor(() => expect(port.seekFrame).toHaveBeenCalledTimes(3));
  const refreshed = controller.refresh(
    {
      ...audioSource(),
      session: { sessionId: "session", sourceVersion: "new" },
    },
    8,
  );
  const refreshCancelled = expect(refreshed).rejects.toMatchObject({
    name: "AbortError",
  });
  const paused = controller.pause();
  finish("old");
  await Promise.all([oldCancelled, refreshCancelled, paused]);
  expect(controller.getState()).toMatchObject({
    phase: "ready",
    presentedFrame: 8,
    playing: false,
    source: { session: { sourceVersion: "new" } },
  });
  expect(second.port.seek).toHaveBeenLastCalledWith(14700);
  await controller.dispose();
});

it("scheduler cancellation failure does not prevent immediate audio stop or joined cleanup", async () => {
  const clock = scheduler();
  const stopFailure = new Error("cancel failed");
  vi.mocked(clock.port.schedule).mockImplementation((callback) => {
    clock.callbacks.add(callback);
    return () => {
      clock.callbacks.delete(callback);
      throw stopFailure;
    };
  });
  const audio = audioClock();
  const port = transport();
  const controller = new PreviewController({
    transport: port,
    scheduler: clock.port,
    prepareAudio: async () => audio.port,
  });
  await controller.refresh(audioSource());
  await controller.play();
  vi.mocked(audio.port.pause).mockClear();
  const failed = controller.seek(Number.NaN);
  expect(audio.port.pause).toHaveBeenCalled();
  await expect(failed).rejects.toMatchObject({
    code: "preview.invalid_frame",
    cleanupError: expect.any(AggregateError),
  });
  expect(audio.port.dispose).toHaveBeenCalledOnce();
  expect(port.dispose).toHaveBeenCalledOnce();
  expect(controller.getState().error?.cause).toBeInstanceOf(RangeError);
  await controller.dispose();
});
