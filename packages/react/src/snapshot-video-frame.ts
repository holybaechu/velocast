import type { VideoFrame } from "./video-clip.js";

const MAX_FRAME_BYTES = 32 * 1024 * 1024;
function failure(code: string, message: string): Error {
  return new Error(`${code}: ${message}`);
}
function identity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[^\x21-\x7e]/.test(value)
  );
}
function integer(headers: Headers, name: string, minimum: number): number {
  const text = headers.get(name);
  const value = Number(text);
  if (
    !text ||
    !/^-?(?:0|[1-9]\d*)$/.test(text) ||
    !Number.isSafeInteger(value) ||
    value < minimum
  )
    throw failure("video.snapshot_frame_headers", `Invalid ${name} header.`);
  return value;
}
async function bodyBytes(
  response: Response,
  maximum: number,
  signal: AbortSignal,
  exact?: number,
): Promise<Uint8Array> {
  if (!response.body)
    throw failure(
      "video.snapshot_frame_body",
      "Frame response body is missing.",
    );
  const bytes = new Uint8Array(maximum);
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  let length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      if (length + next.value.byteLength > maximum)
        throw failure(
          "video.snapshot_frame_body",
          "Frame response exceeds its declared byte limit.",
        );
      bytes.set(next.value, length);
      length += next.value.byteLength;
    }
    if (exact !== undefined && length !== exact)
      throw failure(
        "video.snapshot_frame_body",
        "Frame response byte length does not match its metadata.",
      );
    return length === bytes.length ? bytes : bytes.subarray(0, length);
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Public VideoFrameProvider loader for a versioned static snapshot render session. */
export async function requestSnapshotVideoFrame(
  src: string,
  sourceSeconds: number,
  signal: AbortSignal,
): Promise<VideoFrame> {
  signal.throwIfAborted();
  if (
    typeof window === "undefined" ||
    !window.__velocast ||
    typeof window.__velocast.getSession !== "function"
  )
    throw failure(
      "video.snapshot_runtime_missing",
      "Snapshot video frames require a bound window.__velocast runtime.",
    );
  const runtime = window.__velocast;
  const session = runtime.getSession();
  if (!identity(session?.sessionId) || !identity(session?.sourceVersion))
    throw failure(
      "video.snapshot_session_missing",
      "Snapshot video frames require sessionId and sourceVersion.",
    );
  const { sessionId, sourceVersion } = session;
  if (
    typeof src !== "string" ||
    !src.trim() ||
    src.length > 2048 ||
    !Number.isFinite(sourceSeconds) ||
    sourceSeconds < 0
  )
    throw failure(
      "video.snapshot_invalid_request",
      "src must be nonempty and sourceSeconds finite and nonnegative.",
    );
  const endpoint = new URL("/__velocast-media/frame", window.location.href);
  if (!["http:", "https:"].includes(endpoint.protocol))
    throw failure(
      "video.snapshot_invalid_origin",
      "Snapshot video frames require an HTTP snapshot origin.",
    );
  endpoint.search = new URLSearchParams({
    src,
    seconds: String(sourceSeconds),
    sessionId,
    sourceVersion,
  }).toString();
  const response = await fetch(endpoint, {
    signal,
    redirect: "error",
    credentials: "same-origin",
    cache: "no-store",
  });
  signal.throwIfAborted();
  if (
    response.redirected ||
    (response.url && new URL(response.url).origin !== endpoint.origin)
  ) {
    await response.body?.cancel();
    throw failure(
      "video.snapshot_frame_identity",
      "Frame response changed snapshot origin.",
    );
  }
  if (response.status !== 200) {
    const bytes = await bodyBytes(response, 4096, signal);
    let code = "video.snapshot_http_error",
      message = `Frame endpoint returned HTTP ${response.status}.`;
    try {
      const error = JSON.parse(new TextDecoder().decode(bytes)) as {
        code?: unknown;
        message?: unknown;
      };
      if (
        typeof error.code === "string" &&
        /^video\.[a-z_]+$/.test(error.code) &&
        typeof error.message === "string" &&
        error.message.length <= 512
      ) {
        code = error.code;
        message = error.message;
      }
    } catch {
      /* Non-JSON errors retain their bounded HTTP status message. */
    }
    throw failure(code, message);
  }
  let width: number,
    height: number,
    pts: number,
    numerator: number,
    denominator: number,
    length: number;
  try {
    if (
      response.headers.get("X-Velocast-Session-Id") !== sessionId ||
      response.headers.get("X-Velocast-Source-Version") !== sourceVersion
    )
      throw failure(
        "video.snapshot_frame_identity",
        "Frame response does not match the requested render session.",
      );
    if (
      response.headers
        .get("Content-Type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase() !== "application/octet-stream" ||
      (response.headers.get("Content-Encoding") &&
        response.headers.get("Content-Encoding") !== "identity")
    )
      throw failure(
        "video.snapshot_frame_headers",
        "Expected unencoded RGBA octet-stream bytes.",
      );
    width = integer(response.headers, "X-Velocast-Frame-Width", 1);
    height = integer(response.headers, "X-Velocast-Frame-Height", 1);
    pts = integer(
      response.headers,
      "X-Velocast-Frame-PTS",
      Number.MIN_SAFE_INTEGER,
    );
    numerator = integer(
      response.headers,
      "X-Velocast-Frame-Time-Base-Numerator",
      1,
    );
    denominator = integer(
      response.headers,
      "X-Velocast-Frame-Time-Base-Denominator",
      1,
    );
    length = integer(response.headers, "Content-Length", 1);
    if (
      !Number.isSafeInteger(width * height * 4) ||
      length !== width * height * 4 ||
      length > MAX_FRAME_BYTES
    )
      throw failure(
        "video.snapshot_frame_headers",
        "Frame dimensions and Content-Length must match within 32 MiB.",
      );
  } catch (error) {
    await response.body?.cancel();
    throw error;
  }
  const rgba = await bodyBytes(response, length, signal, length);
  signal.throwIfAborted();
  const current = window.__velocast?.getSession();
  if (
    window.__velocast !== runtime ||
    current?.sessionId !== sessionId ||
    current?.sourceVersion !== sourceVersion
  )
    throw failure(
      "video.snapshot_frame_identity",
      "Render session changed before frame delivery.",
    );
  return { width, height, pts, timeBase: { numerator, denominator }, rgba };
}
