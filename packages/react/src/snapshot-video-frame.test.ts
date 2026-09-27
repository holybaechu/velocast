import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearFrameAdaptersForTest } from "@velocast/core/testing";
import {
  registerReactComposition,
  requestSnapshotVideoFrame,
} from "./index.js";

const session = { sessionId: "render-a", sourceVersion: "source-a" };
const pixels = new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]);
function response(headers: Record<string, string> = {}, body = pixels) {
  return new Response(body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": "8",
      "X-Velocast-Session-Id": session.sessionId,
      "X-Velocast-Source-Version": session.sourceVersion,
      "X-Velocast-Frame-Width": "2",
      "X-Velocast-Frame-Height": "1",
      "X-Velocast-Frame-PTS": "2600",
      "X-Velocast-Frame-Time-Base-Numerator": "1",
      "X-Velocast-Frame-Time-Base-Denominator": "1000",
      ...headers,
    },
  });
}
function signal() {
  return new AbortController().signal;
}
beforeEach(async () => {
  clearFrameAdaptersForTest();
  window.__velocast = undefined;
  const runtime = registerReactComposition("video-transport", {
    component: () => null,
    width: 2,
    height: 1,
    fps: 10,
    durationFrames: 30,
  });
  await runtime.beginSession(session);
});
afterEach(async () => {
  await window.__velocast?.destroy?.();
  window.__velocast = undefined;
  clearFrameAdaptersForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("is directly usable as a provider loader and sends both current runtime identities", async () => {
  const fetcher = vi.fn(async () => response());
  vi.stubGlobal("fetch", fetcher);
  const abort = signal();
  const frame = await requestSnapshotVideoFrame("media/a b.webm", 0.3, abort);
  expect(frame).toEqual({
    width: 2,
    height: 1,
    pts: 2600,
    timeBase: { numerator: 1, denominator: 1000 },
    rgba: pixels,
  });
  const [url, options] = fetcher.mock.calls[0]! as unknown as [
    URL,
    RequestInit,
  ];
  expect(url.origin).toBe(window.location.origin);
  expect(url.pathname).toBe("/__velocast-media/frame");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    src: "media/a b.webm",
    seconds: "0.3",
    ...session,
  });
  expect(options).toMatchObject({
    signal: abort,
    redirect: "error",
    credentials: "same-origin",
    cache: "no-store",
  });
});

it("fails clearly without a bound versioned runtime and never fetches", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const runtime = window.__velocast!;
  window.__velocast = undefined;
  await expect(
    requestSnapshotVideoFrame("a.webm", 0, signal()),
  ).rejects.toThrow("video.snapshot_runtime_missing");
  window.__velocast = runtime;
  vi.spyOn(runtime, "getSession").mockReturnValue({ sessionId: "unmanaged" });
  await expect(
    requestSnapshotVideoFrame("a.webm", 0, signal()),
  ).rejects.toThrow("video.snapshot_session_missing");
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([
  ["X-Velocast-Session-Id", "stale", "video.snapshot_frame_identity"],
  ["X-Velocast-Source-Version", "stale", "video.snapshot_frame_identity"],
  ["Content-Type", "image/png", "video.snapshot_frame_headers"],
  ["Content-Encoding", "gzip", "video.snapshot_frame_headers"],
  ["Content-Length", "9", "video.snapshot_frame_headers"],
  ["X-Velocast-Frame-Width", "0", "video.snapshot_frame_headers"],
  ["X-Velocast-Frame-Height", "2.5", "video.snapshot_frame_headers"],
  ["X-Velocast-Frame-PTS", "9007199254740992", "video.snapshot_frame_headers"],
  ["X-Velocast-Frame-Time-Base-Numerator", "0", "video.snapshot_frame_headers"],
  [
    "X-Velocast-Frame-Time-Base-Denominator",
    "NaN",
    "video.snapshot_frame_headers",
  ],
] as const)(
  "rejects wrong identity or malformed response header %s",
  async (name, value, message) => {
    vi.stubGlobal("fetch", async () => response({ [name]: value }));
    await expect(
      requestSnapshotVideoFrame("a.webm", 0, signal()),
    ).rejects.toThrow(message);
  },
);

it("rejects a missing required header and dimensions above the allocation cap", async () => {
  const missing = response();
  missing.headers.delete("X-Velocast-Frame-PTS");
  vi.stubGlobal("fetch", async () => missing);
  await expect(
    requestSnapshotVideoFrame("a.webm", 0, signal()),
  ).rejects.toThrow("video.snapshot_frame_headers");
  vi.stubGlobal("fetch", async () =>
    response({
      "X-Velocast-Frame-Width": "10000000",
      "Content-Length": "40000000",
    }),
  );
  await expect(
    requestSnapshotVideoFrame("a.webm", 0, signal()),
  ).rejects.toThrow("video.snapshot_frame_headers");
});

it.each([7, 9])(
  "rejects a %i-byte body when metadata declares eight",
  async (length) => {
    vi.stubGlobal("fetch", async () => response({}, new Uint8Array(length)));
    await expect(
      requestSnapshotVideoFrame("a.webm", 0, signal()),
    ).rejects.toThrow("video.snapshot_frame_body");
  },
);

it("preserves bounded stable JSON errors from the frame endpoint", async () => {
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          code: "video.http_session_mismatch",
          message: "Identity mismatch.",
        }),
        { status: 409 },
      ),
  );
  await expect(
    requestSnapshotVideoFrame("a.webm", 0, signal()),
  ).rejects.toThrow("video.http_session_mismatch: Identity mismatch.");
});

it("cancels the streaming body and never returns partial or late pixels", async () => {
  let began!: () => void;
  const started = new Promise<void>((done) => {
    began = done;
  });
  const cancelled = vi.fn();
  const good = response();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      began();
      controller.enqueue(pixels.subarray(0, 4));
      return new Promise(() => {});
    },
    cancel: cancelled,
  });
  vi.stubGlobal(
    "fetch",
    async () => new Response(stream, { headers: good.headers }),
  );
  const controller = new AbortController();
  const result = requestSnapshotVideoFrame("a.webm", 0, controller.signal);
  const rejected = expect(result).rejects.toThrow();
  await started;
  controller.abort();
  await rejected;
  expect(cancelled).toHaveBeenCalledTimes(1);
});

it("rejects a session replacement before returning otherwise valid pixels", async () => {
  const runtime = window.__velocast!;
  let calls = 0;
  vi.spyOn(runtime, "getSession").mockImplementation(() =>
    calls++ ? { ...session, sessionId: "replacement" } : session,
  );
  vi.stubGlobal("fetch", async () => response());
  await expect(
    requestSnapshotVideoFrame("a.webm", 0, signal()),
  ).rejects.toThrow("video.snapshot_frame_identity");
});

it("checks input/cancellation before network work", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(requestSnapshotVideoFrame("", 0, signal())).rejects.toThrow(
    "video.snapshot_invalid_request",
  );
  await expect(
    requestSnapshotVideoFrame("a.webm", -1, signal()),
  ).rejects.toThrow("video.snapshot_invalid_request");
  const controller = new AbortController();
  controller.abort();
  await expect(
    requestSnapshotVideoFrame("a.webm", 0, controller.signal),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
