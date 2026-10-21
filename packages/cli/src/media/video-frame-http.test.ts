import { createServer, type Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import {
  createVideoFrameHttp,
  type VideoFrameHttp,
  type VideoFrameHttpSnapshot,
} from "./video-frame-http.js";
import type { VideoFramePool } from "./video-frame-pool.js";
import type { DecodedVideoFrame } from "./video-frame-source.js";

const servers: Server[] = [],
  handlers: VideoFrameHttp[] = [];
afterEach(async () => {
  for (const handler of handlers.splice(0)) await handler.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const rgba = new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]);
function frame(): DecodedVideoFrame {
  return {
    width: 2,
    height: 1,
    pts: 2600,
    timeBase: { numerator: 1, denominator: 1000 },
    rgba,
    keyframePts: 2300,
    cacheHit: false,
    elapsedMs: 1,
  };
}
async function fixture(overrides: Partial<VideoFramePool> = {}) {
  const frameAt = vi.fn<VideoFramePool["frameAt"]>(async () => frame());
  const close = vi.fn(async () => {});
  const createPool = vi.fn(async () => ({ frameAt, close, ...overrides }));
  const service = createVideoFrameHttp(
    { directory: "unused-mock-directory" },
    { createPool },
  );
  handlers.push(service);
  const snapshot: VideoFrameHttpSnapshot = {
    url: "",
    session: { sessionId: "render-a", sourceVersion: "source-a" },
  };
  const server = createServer((request, response) => {
    void service
      .handle(request, response, snapshot)
      .catch(() => response.destroy());
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("server missing");
  const origin = `http://127.0.0.1:${address.port}`;
  snapshot.url = `${origin}/index.html`;
  const url = (values: Record<string, string> = {}) =>
    `${origin}/__velocast-media/frame?${new URLSearchParams({ src: "clip.webm", seconds: "0.3", ...snapshot.session, ...values })}`;
  return { service, snapshot, origin, url, createPool, frameAt, close };
}

it("serves exact RGBA/PTS/session headers and lazily shares one pool across workers", async () => {
  const f = await fixture();
  const results = await Promise.all([
    fetch(f.url()),
    fetch(f.url({ seconds: "0" })),
  ]);
  for (const result of results) {
    expect(result.status).toBe(200);
    expect(result.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(result.headers.get("Content-Length")).toBe("8");
    expect(result.headers.get("X-Velocast-Frame-Width")).toBe("2");
    expect(result.headers.get("X-Velocast-Frame-Height")).toBe("1");
    expect(result.headers.get("X-Velocast-Frame-PTS")).toBe("2600");
    expect(result.headers.get("X-Velocast-Frame-Time-Base-Numerator")).toBe(
      "1",
    );
    expect(result.headers.get("X-Velocast-Frame-Time-Base-Denominator")).toBe(
      "1000",
    );
    expect(result.headers.get("X-Velocast-Session-Id")).toBe("render-a");
    expect(result.headers.get("X-Velocast-Source-Version")).toBe("source-a");
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(rgba);
  }
  expect(f.createPool).toHaveBeenCalledTimes(1);
  expect(f.frameAt.mock.calls.map((call) => call.slice(0, 2))).toEqual([
    ["clip.webm", 0.3],
    ["clip.webm", 0],
  ]);
  await f.service.close();
  await f.service.close();
  expect(f.close).toHaveBeenCalledTimes(1);
});

it.each(["-1", "NaN", "Infinity", "1e999", " 1", "", "01"])(
  "rejects invalid seconds %s before creating a pool",
  async (seconds) => {
    const f = await fixture();
    const result = await fetch(f.url({ seconds }));
    expect(result.status).toBe(400);
    expect(await result.json()).toMatchObject({
      code: "video.http_invalid_request",
      message: expect.any(String),
    });
    expect(f.createPool).not.toHaveBeenCalled();
  },
);

it("rejects duplicate/missing/unknown query parameters and other endpoints/methods", async () => {
  const f = await fixture();
  for (const url of [
    f.url() + "&seconds=0",
    f.url() + "&extra=1",
    `${f.origin}/__velocast-media/frame?src=clip.webm`,
  ]) {
    expect((await fetch(url)).status).toBe(400);
  }
  expect(
    (await fetch(f.url().replace("/frame?", "/frame/other?"))).status,
  ).toBe(404);
  const method = await fetch(f.url(), { method: "POST" });
  expect(method.status).toBe(405);
  expect(method.headers.get("Allow")).toBe("GET");
  expect(f.createPool).not.toHaveBeenCalled();
});

it("rejects stale request identity and never changes a previously bound snapshot", async () => {
  const f = await fixture();
  expect((await fetch(f.url({ sourceVersion: "stale" }))).status).toBe(409);
  expect(f.createPool).not.toHaveBeenCalled();
  expect((await fetch(f.url())).status).toBe(200);
  f.snapshot.session.sourceVersion = "source-b";
  const stale = await fetch(f.url());
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({
    code: "video.http_session_mismatch",
  });
  expect(f.frameAt).toHaveBeenCalledTimes(1);
});

it("returns bounded stable errors without exposing decoder command/stderr details", async () => {
  const f = await fixture({
    frameAt: async () => {
      throw new Error("private path and webcodecs stderr");
    },
  });
  const response = await fetch(f.url());
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({
    code: "video.http_decode_failed",
    message: "The frozen source could not provide the requested video frame.",
  });
});

it("rejects oversized or inconsistent RGBA before writing success headers", async () => {
  const f = await fixture({
    frameAt: async () => ({ ...frame(), width: 100_000 }),
  });
  const response = await fetch(f.url());
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({
    code: "video.http_invalid_frame",
  });
  expect(response.headers.get("X-Velocast-Frame-PTS")).toBeNull();
});

it("client disconnect aborts its frame request while leaving the shared pool available", async () => {
  const started = deferred<AbortSignal>(),
    ended = deferred<void>();
  let calls = 0;
  const f = await fixture({
    frameAt: async (_src, _seconds, signal) => {
      if (calls++) return frame();
      started.resolve(signal!);
      await new Promise<void>((_done, reject) =>
        signal!.addEventListener(
          "abort",
          () => {
            ended.resolve();
            reject(signal!.reason);
          },
          { once: true },
        ),
      );
      return frame();
    },
  });
  const controller = new AbortController();
  const request = fetch(f.url(), { signal: controller.signal });
  const rejection = expect(request).rejects.toThrow();
  const signal = await started.promise;
  controller.abort();
  await rejection;
  await ended.promise;
  expect(signal.aborted).toBe(true);
  expect(f.close).not.toHaveBeenCalled();
  expect((await fetch(f.url())).status).toBe(200);
});

it("close aborts active work, joins late decoders, and returns a stable closed response afterwards", async () => {
  const started = deferred<void>(),
    done = deferred<void>();
  let signal!: AbortSignal;
  const f = await fixture({
    frameAt: async (_src, _seconds, value) => {
      signal = value!;
      started.resolve();
      await done.promise;
      return frame();
    },
    close: async () => {
      done.resolve();
    },
  });
  const request = fetch(f.url());
  const rejection = expect(request).rejects.toThrow();
  await started.promise;
  await f.service.close();
  await rejection;
  expect(signal.aborted).toBe(true);
  const closed = await fetch(f.url());
  expect(closed.status).toBe(503);
  expect(await closed.json()).toMatchObject({ code: "video.http_closed" });
});
