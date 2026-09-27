import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearFrameAdaptersForTest } from "@velocast/core/testing";
import { registerReactComposition, Sequence, useInputProps } from "./index.js";
import {
  VideoClip,
  VideoFrameProvider,
  type VideoFrame,
} from "./video-clip.js";

const config = { width: 320, height: 180, fps: 10, durationFrames: 60 };
const put = vi.fn(),
  clear = vi.fn();
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  clearFrameAdaptersForTest();
  window.__velocast = undefined;
  document.body.innerHTML = "";
  put.mockReset();
  clear.mockReset();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect: clear,
    putImageData: put,
    createImageData: (width: number, height: number) => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4),
    }),
  } as unknown as CanvasRenderingContext2D);
});

it("keeps capture pending and clears old pixels while a new source frame loads", async () => {
  const waiting = deferred<VideoFrame>(),
    started = deferred<void>();
  let calls = 0;
  const getFrame = vi.fn(async (_src: string, seconds: number) => {
    if (calls++ === 0) return frame(seconds);
    started.resolve();
    return waiting.promise;
  });
  const protocol = registerReactComposition("clip", {
    ...config,
    component: () => (
      <VideoFrameProvider getFrame={getFrame}>
        <VideoClip src="clip.webm" muted />
      </VideoFrameProvider>
    ),
  });
  await protocol.seekFrame("clip", 0);
  expect(put).toHaveBeenCalledTimes(1);
  let done = false;
  const next = protocol.seekFrame("clip", 1).then(() => {
    done = true;
  });
  await started.promise;
  const canvas = document.querySelector("canvas")!;
  expect(done).toBe(false);
  expect(canvas.style.visibility).toBe("hidden");
  expect(canvas.dataset.velocastVideoPts).toBeUndefined();
  waiting.resolve(frame(0.1));
  await next;
  expect(canvas.dataset.velocastVideoPts).toBe("100");
  expect(put).toHaveBeenCalledTimes(2);
});

it("does not paint a late provider result after cancellation and joins it before destroy", async () => {
  const waiting = deferred<VideoFrame>(),
    started = deferred<void>();
  let seen: AbortSignal | undefined;
  const protocol = registerReactComposition("clip", {
    ...config,
    component: () => (
      <VideoFrameProvider
        getFrame={async (_src, _seconds, signal) => {
          seen = signal;
          started.resolve();
          return waiting.promise;
        }}
      >
        <VideoClip src="clip.webm" muted />
      </VideoFrameProvider>
    ),
  });
  const seek = protocol.seekFrame("clip", 0);
  const rejected = expect(seek).rejects.toThrow(/CANCELLED|cancelled/);
  await started.promise;
  protocol.cancelPending();
  expect(seen!.aborted).toBe(true);
  let destroyed = false;
  const cleanup = protocol.destroy().then(() => {
    destroyed = true;
  });
  await Promise.resolve();
  expect(destroyed).toBe(false);
  waiting.resolve(frame(0));
  await rejected;
  await cleanup;
  expect(put).not.toHaveBeenCalled();
  expect(document.querySelector("canvas")).toBeNull();
});

it("propagates provider failure without exposing previous pixels", async () => {
  let failed = false;
  const protocol = registerReactComposition("clip", {
    ...config,
    component: () => (
      <VideoFrameProvider
        getFrame={async (_src, seconds) => {
          if (failed) throw new Error("decode failed");
          return frame(seconds);
        }}
      >
        <VideoClip src="clip.webm" muted />
      </VideoFrameProvider>
    ),
  });
  await protocol.seekFrame("clip", 0);
  failed = true;
  await expect(protocol.seekFrame("clip", 1)).rejects.toThrow("decode failed");
  expect(put).toHaveBeenCalledTimes(1);
  const canvas = document.querySelector("canvas");
  expect(!canvas || canvas.style.visibility === "hidden").toBe(true);
});

it("accepts cross-realm byte views and rejects malformed RGBA dimensions", async () => {
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  const ForeignBytes = (
    iframe.contentWindow as unknown as { Uint8Array: typeof Uint8Array }
  ).Uint8Array;
  const foreign = new ForeignBytes([7, 0, 0, 255, 0, 0, 0, 255]);
  expect(foreign instanceof Uint8Array).toBe(false);
  const protocol = registerReactComposition("clip", {
    ...config,
    component: () => (
      <VideoFrameProvider
        getFrame={async () => ({ ...frame(0), rgba: foreign })}
      >
        <VideoClip src="clip.webm" muted />
      </VideoFrameProvider>
    ),
  });
  await protocol.seekFrame("clip", 0);
  expect(put.mock.calls[0]![0].data[0]).toBe(7);
  await protocol.destroy();
  clearFrameAdaptersForTest();
  const invalid = registerReactComposition("bad", {
    ...config,
    component: () => (
      <VideoFrameProvider getFrame={async () => ({ ...frame(0), width: 0 })}>
        <VideoClip src="clip.webm" muted />
      </VideoFrameProvider>
    ),
  });
  await expect(invalid.seekFrame("bad", 0)).rejects.toThrow(
    "VELOCAST_VIDEO_INVALID_FRAME",
  );
});

it("updates same-frame src and trim props instead of reusing an old frame", async () => {
  const getFrame = vi.fn(async (_src: string, seconds: number) =>
    frame(seconds),
  );
  const protocol = registerReactComposition("clip", {
    ...config,
    defaultProps: { src: "first.webm", trim: 0 },
    component: () => {
      const { src, trim } = useInputProps<{ src: string; trim: number }>();
      return (
        <VideoFrameProvider getFrame={getFrame}>
          <VideoClip src={src} muted trimBeforeFrames={trim} />
        </VideoFrameProvider>
      );
    },
  });
  await protocol.seekFrame("clip", 2);
  await protocol.setInputProps({ src: "second.webm", trim: 3 });
  await protocol.seekFrame("clip", 2);
  expect(getFrame).toHaveBeenLastCalledWith(
    "second.webm",
    0.5,
    expect.any(AbortSignal),
  );
});

it.each(["short-bytes", "wide-elements", "bad-timebase"])(
  "rejects %s provider data before painting",
  async (kind) => {
    const value = frame(0);
    const bad =
      kind === "short-bytes"
        ? { ...value, rgba: new Uint8Array(7) }
        : kind === "wide-elements"
          ? { ...value, rgba: new Uint16Array(4) as unknown as Uint8Array }
          : { ...value, timeBase: { numerator: 1, denominator: 0 } };
    const protocol = registerReactComposition("bad", {
      ...config,
      component: () => (
        <VideoFrameProvider getFrame={async () => bad}>
          <VideoClip src="clip.webm" muted />
        </VideoFrameProvider>
      ),
    });
    await expect(protocol.seekFrame("bad", 0)).rejects.toThrow(
      "VELOCAST_VIDEO_INVALID_FRAME",
    );
    expect(put).not.toHaveBeenCalled();
  },
);

it("requires explicit muting and treats an empty trim as hidden", async () => {
  const getFrame = vi.fn(async () => frame(0));
  const empty = registerReactComposition("empty", {
    ...config,
    component: () => (
      <VideoFrameProvider getFrame={getFrame}>
        <VideoClip
          src="clip.webm"
          muted
          trimBeforeFrames={3}
          trimAfterFrames={3}
        />
      </VideoFrameProvider>
    ),
  });
  await empty.seekFrame("empty", 0);
  expect(getFrame).not.toHaveBeenCalled();
  expect(document.querySelector("canvas")!.style.display).toBe("none");
  await empty.destroy();
  clearFrameAdaptersForTest();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const suppressExpected = (event: ErrorEvent) => event.preventDefault();
  window.addEventListener("error", suppressExpected);
  const bad = registerReactComposition("bad", {
    ...config,
    component: () => (
      <VideoFrameProvider getFrame={getFrame}>
        <VideoClip src="clip.webm" muted={false as true} />
      </VideoFrameProvider>
    ),
  });
  try {
    await expect(bad.seekFrame("bad", 0)).rejects.toThrow(
      "VELOCAST_VIDEO_AUDIO_UNSUPPORTED",
    );
  } finally {
    window.removeEventListener("error", suppressExpected);
  }
});
afterEach(async () => {
  await window.__velocast?.destroy();
  vi.restoreAllMocks();
  clearFrameAdaptersForTest();
  document.body.innerHTML = "";
});
function frame(seconds: number): VideoFrame {
  return {
    pts: Math.round(seconds * 1000),
    timeBase: { numerator: 1, denominator: 1000 },
    width: 2,
    height: 1,
    rgba: new Uint8Array([Math.round(seconds * 100), 0, 0, 255, 0, 0, 0, 255]),
  };
}

it("uses Sequence-local time plus output-FPS trim, and clears at the exclusive end", async () => {
  const getFrame = vi.fn(async (_src: string, seconds: number) =>
    frame(seconds),
  );
  const protocol = registerReactComposition("clip", {
    ...config,
    component: () => (
      <VideoFrameProvider getFrame={getFrame}>
        <Sequence from={10} durationFrames={20}>
          <VideoClip
            src="clip.webm"
            muted
            trimBeforeFrames={5}
            trimAfterFrames={8}
            className="clip-style"
            style={{ width: 200, opacity: 0.7 }}
          />
        </Sequence>
      </VideoFrameProvider>
    ),
  });
  await protocol.seekFrame("clip", 9);
  expect(getFrame).not.toHaveBeenCalled();
  await protocol.seekFrame("clip", 10);
  expect(getFrame).toHaveBeenLastCalledWith(
    "clip.webm",
    0.5,
    expect.any(AbortSignal),
  );
  const canvas = document.querySelector("canvas")!;
  expect(canvas.className).toBe("clip-style");
  expect(canvas.style.width).toBe("200px");
  expect(canvas.style.opacity).toBe("0.7");
  await protocol.seekFrame("clip", 12);
  expect(getFrame).toHaveBeenLastCalledWith(
    "clip.webm",
    0.7,
    expect.any(AbortSignal),
  );
  const count = getFrame.mock.calls.length;
  await protocol.seekFrame("clip", 13);
  expect(getFrame).toHaveBeenCalledTimes(count);
  expect(canvas.style.display).toBe("none");
  expect(canvas.width).toBe(0);
  await protocol.seekFrame("clip", 11);
  const first = [...put.mock.calls.at(-1)![0].data];
  await protocol.seekFrame("clip", 11);
  expect([...put.mock.calls.at(-1)![0].data]).toEqual(first);
  expect(canvas.style.display).toBe("");
  expect(canvas.width).toBe(2);
});
