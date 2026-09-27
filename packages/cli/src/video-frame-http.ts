import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createVideoFramePool,
  type VideoFramePool,
} from "./video-frame-pool.js";
import type { DecodedVideoFrame } from "./video-frame-source.js";

export interface VideoFrameHttpOptions {
  env?: NodeJS.ProcessEnv;
  directory: string;
  ffmpegPath?: string;
  ffprobePath?: string;
}
export interface VideoFrameHttpSnapshot {
  url: string;
  session: { sessionId: string; sourceVersion: string };
}
export interface VideoFrameHttp {
  handle(
    request: IncomingMessage,
    response: ServerResponse,
    snapshot: VideoFrameHttpSnapshot,
  ): Promise<void>;
  close(): Promise<void>;
}
export interface VideoFrameHttpDependencies {
  createPool?: typeof createVideoFramePool;
}

const ENDPOINT = "/__velocast-media/frame";
const MAX_FRAME_BYTES = 32 * 1024 * 1024;
class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
function invalid(message: string): never {
  throw new HttpError(400, "video.http_invalid_request", message);
}
function identity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[^\x21-\x7e]/.test(value)
  );
}
function validateFrame(frame: DecodedVideoFrame): number {
  const length = frame?.width * frame?.height * 4;
  if (
    !frame ||
    !Number.isSafeInteger(frame.width) ||
    frame.width < 1 ||
    !Number.isSafeInteger(frame.height) ||
    frame.height < 1 ||
    !Number.isSafeInteger(length) ||
    length > MAX_FRAME_BYTES ||
    !ArrayBuffer.isView(frame.rgba) ||
    frame.rgba.BYTES_PER_ELEMENT !== 1 ||
    frame.rgba.byteLength !== length ||
    !Number.isSafeInteger(frame.pts) ||
    !Number.isSafeInteger(frame.timeBase?.numerator) ||
    frame.timeBase.numerator < 1 ||
    !Number.isSafeInteger(frame.timeBase?.denominator) ||
    frame.timeBase.denominator < 1
  )
    throw new HttpError(
      500,
      "video.http_invalid_frame",
      "Decoder returned invalid bounded RGBA frame metadata or bytes.",
    );
  return length;
}

/** Host/Origin admission belongs to the owning InputSnapshot server, before dispatch. */
export function createVideoFrameHttp(
  options: VideoFrameHttpOptions,
  dependencies: VideoFrameHttpDependencies = {},
): VideoFrameHttp {
  const owner = new AbortController();
  const active = new Set<Promise<void>>();
  let bound: VideoFrameHttpSnapshot | undefined;
  let pool: Promise<VideoFramePool> | undefined;
  let closed = false;
  let closePromise: Promise<void> | undefined;

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
    snapshot: VideoFrameHttpSnapshot,
  ): Promise<void> {
    const client = new AbortController();
    const signal = closed
      ? client.signal
      : AbortSignal.any([owner.signal, client.signal]);
    const disconnected = () => {
      if (!response.writableFinished) client.abort();
    };
    const aborted = () => client.abort();
    const destroy = () => response.destroy();
    request.once("aborted", aborted);
    response.once("close", disconnected);
    response.once("error", aborted);
    signal.addEventListener("abort", destroy, { once: true });
    async function send(
      status: number,
      headers: Record<string, string>,
      body: Uint8Array,
    ) {
      if (response.destroyed || signal.aborted) return;
      await new Promise<void>((done, reject) => {
        const finished = () => {
          response.removeListener("finish", finished);
          response.removeListener("close", finished);
          done();
        };
        response.once("finish", finished);
        response.once("close", finished);
        try {
          response.writeHead(status, {
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            ...headers,
          });
          response.end(body);
        } catch (error) {
          response.removeListener("finish", finished);
          response.removeListener("close", finished);
          reject(error);
        }
      });
    }
    try {
      if (closed)
        throw new HttpError(
          503,
          "video.http_closed",
          "Video frame service is closed.",
        );
      if (request.aborted || response.destroyed) client.abort();
      signal.throwIfAborted();
      if (request.method !== "GET")
        throw new HttpError(
          405,
          "video.http_method",
          "Video frames require GET.",
        );
      if (
        !request.url ||
        request.url.length > 8192 ||
        !request.url.startsWith("/") ||
        request.url.startsWith("//")
      )
        invalid("Invalid frame request target.");
      const url = new URL(request.url, "http://127.0.0.1");
      if (
        request.url.split("?", 1)[0] !== ENDPOINT ||
        url.pathname !== ENDPOINT ||
        url.hash
      )
        throw new HttpError(
          404,
          "video.http_not_found",
          "Unknown video frame endpoint.",
        );
      const names = ["src", "seconds", "sessionId", "sourceVersion"];
      if (
        [...url.searchParams.keys()].some((name) => !names.includes(name)) ||
        names.some((name) => url.searchParams.getAll(name).length !== 1)
      )
        invalid(
          "Exactly one src, seconds, sessionId and sourceVersion is required.",
        );
      const src = url.searchParams.get("src")!;
      const secondsText = url.searchParams.get("seconds")!;
      const seconds = Number(secondsText);
      if (
        !src.trim() ||
        src.length > 2048 ||
        !/^(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(secondsText) ||
        !Number.isFinite(seconds)
      )
        invalid(
          "src must be nonempty and seconds must be finite and nonnegative.",
        );
      if (
        !identity(snapshot.session.sessionId) ||
        !identity(snapshot.session.sourceVersion)
      )
        throw new HttpError(
          409,
          "video.http_session_mismatch",
          "A bound versioned render session is required.",
        );
      if (
        url.searchParams.get("sessionId") !== snapshot.session.sessionId ||
        url.searchParams.get("sourceVersion") !== snapshot.session.sourceVersion
      )
        throw new HttpError(
          409,
          "video.http_session_mismatch",
          "Request identity does not match the frozen render session.",
        );
      if (
        bound &&
        (bound.url !== snapshot.url ||
          bound.session.sessionId !== snapshot.session.sessionId ||
          bound.session.sourceVersion !== snapshot.session.sourceVersion)
      )
        throw new HttpError(
          409,
          "video.http_session_mismatch",
          "Video frame service cannot change its bound snapshot identity.",
        );
      if (!bound)
        bound = { url: snapshot.url, session: { ...snapshot.session } };
      pool ??= (dependencies.createPool ?? createVideoFramePool)({
        ...options,
        snapshot: bound,
        signal: owner.signal,
      });
      const frames = await pool;
      signal.throwIfAborted();
      const frame = await frames.frameAt(src, seconds, signal);
      signal.throwIfAborted();
      const length = validateFrame(frame);
      await send(
        200,
        {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(length),
          "X-Velocast-Frame-Width": String(frame.width),
          "X-Velocast-Frame-Height": String(frame.height),
          "X-Velocast-Frame-PTS": String(frame.pts),
          "X-Velocast-Frame-Time-Base-Numerator": String(
            frame.timeBase.numerator,
          ),
          "X-Velocast-Frame-Time-Base-Denominator": String(
            frame.timeBase.denominator,
          ),
          "X-Velocast-Session-Id": bound.session.sessionId,
          "X-Velocast-Source-Version": bound.session.sourceVersion,
        },
        frame.rgba,
      );
    } catch (error) {
      if (!signal.aborted && !response.destroyed && !response.headersSent) {
        const failure =
          error instanceof HttpError
            ? error
            : new HttpError(
                422,
                "video.http_decode_failed",
                "The frozen source could not provide the requested video frame.",
              );
        const body = Buffer.from(
          JSON.stringify({ code: failure.code, message: failure.message }),
        );
        await send(
          failure.status,
          {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": String(body.length),
            ...(failure.status === 405 ? { Allow: "GET" } : {}),
          },
          body,
        );
      }
    } finally {
      request.removeListener("aborted", aborted);
      response.removeListener("close", disconnected);
      response.removeListener("error", aborted);
      signal.removeEventListener("abort", destroy);
    }
  }

  return {
    handle(request, response, snapshot) {
      const work = handle(request, response, snapshot);
      active.add(work);
      void work.then(
        () => active.delete(work),
        () => active.delete(work),
      );
      return work;
    },
    close() {
      if (!closePromise) {
        closed = true;
        owner.abort();
        closePromise = (async () => {
          let frames: VideoFramePool | undefined;
          try {
            frames = await pool;
          } catch {
            /* Failed factory has no pool to close. */
          }
          try {
            await frames?.close();
          } finally {
            await Promise.allSettled([...active]);
          }
        })();
      }
      return closePromise;
    },
  };
}
