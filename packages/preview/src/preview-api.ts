import { isRpcSession, type RpcSession } from "./rpc-wire.js";

export interface PreviewSessionDescriptor {
  readonly snapshotUrl: string;
  readonly session: RpcSession;
  readonly inputProps?: unknown;
  readonly sourceRevision?: string;
  readonly autoRefresh?: boolean;
  readonly stagedRefresh?: boolean;
}

export type PreviewOutputRequest = {
  readonly compositionId: string;
  readonly expectedSourceVersion: string;
} & (
  | { readonly frame: number; readonly range?: never }
  | {
      readonly frame?: never;
      readonly range: { readonly start: number; readonly end: number };
    }
);

export interface PreviewApi {
  getSession(signal?: AbortSignal): Promise<PreviewSessionDescriptor>;
  refresh(
    expectedSourceVersion: string,
    signal?: AbortSignal,
  ): Promise<PreviewSessionDescriptor>;
  output(request: PreviewOutputRequest, signal?: AbortSignal): Promise<unknown>;
  changes?(
    signal?: AbortSignal,
  ): Promise<{ enabled: boolean; revision: string }>;
  prepareRefresh?(
    expectedSourceVersion: string,
    signal?: AbortSignal,
  ): Promise<PreviewSessionDescriptor>;
  commitRefresh?(
    expectedSourceVersion: string,
    candidateSessionId: string,
    signal?: AbortSignal,
  ): Promise<PreviewSessionDescriptor>;
  discardRefresh?(
    expectedSourceVersion: string,
    candidateSessionId: string,
    signal?: AbortSignal,
  ): Promise<PreviewSessionDescriptor>;
}

export interface HttpPreviewApiOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("preview.api_invalid: expected a JSON object");
  return value as Record<string, unknown>;
}

function descriptor(value: unknown): PreviewSessionDescriptor {
  const body = record(value);
  if (typeof body.snapshotUrl !== "string" || !isRpcSession(body.session))
    throw new Error(
      "preview.api_invalid: snapshotUrl and session identity are required",
    );
  const url = new URL(body.snapshotUrl);
  if (url.protocol !== "http:")
    throw new Error("preview.api_invalid: snapshot URL must use HTTP");
  return Object.freeze({
    snapshotUrl: url.href,
    session: Object.freeze({ ...body.session }),
    ...(typeof body.sourceRevision === "string"
      ? { sourceRevision: body.sourceRevision }
      : {}),
    ...(typeof body.autoRefresh === "boolean"
      ? { autoRefresh: body.autoRefresh }
      : {}),
    ...(typeof body.stagedRefresh === "boolean"
      ? { stagedRefresh: body.stagedRefresh }
      : {}),
    ...(Object.hasOwn(body, "inputProps")
      ? { inputProps: body.inputProps }
      : {}),
  });
}

function checkOutput(request: PreviewOutputRequest): PreviewOutputRequest {
  if (!request.compositionId?.trim() || !request.expectedSourceVersion?.trim())
    throw new Error(
      "preview.output_invalid: composition and source version are required",
    );
  const hasFrame = Object.hasOwn(request, "frame");
  const hasRange = Object.hasOwn(request, "range");
  if (hasFrame === hasRange)
    throw new Error(
      "preview.output_invalid: choose exactly one frame or range output",
    );
  if (hasFrame) {
    if (!Number.isSafeInteger(request.frame) || request.frame! < 0)
      throw new Error(
        "preview.output_invalid: frame must be a nonnegative safe integer",
      );
  } else if (
    !Number.isSafeInteger(request.range?.start) ||
    !Number.isSafeInteger(request.range?.end) ||
    request.range!.start < 0 ||
    request.range!.end <= request.range!.start
  )
    throw new Error(
      "preview.output_invalid: range must be a nonempty half-open frame range",
    );
  return request;
}

async function errorMessage(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) return response.statusText || `HTTP ${response.status}`;
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === "object") {
      const body = value as Record<string, unknown>;
      if (typeof body.error === "string") return body.error;
      if (typeof body.message === "string")
        return typeof body.code === "string"
          ? `${body.code}: ${body.message}`
          : body.message;
    }
  } catch {
    // Plain-text failures are deliberately preserved for actionable diagnostics.
  }
  return text;
}

export class HttpPreviewApi implements PreviewApi {
  private readonly baseUrl: string;
  private readonly request: typeof globalThis.fetch;

  constructor(options: HttpPreviewApiOptions = {}) {
    this.baseUrl = new URL(
      options.baseUrl ?? globalThis.location?.href ?? "http://127.0.0.1/",
    ).href;
    this.request = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  getSession(signal?: AbortSignal): Promise<PreviewSessionDescriptor> {
    return this.sessionRequest("/api/session", undefined, signal);
  }

  async changes(
    signal?: AbortSignal,
  ): Promise<{ enabled: boolean; revision: string }> {
    const value = record(
      await this.jsonRequest("/api/changes", undefined, signal),
    );
    if (
      typeof value.enabled !== "boolean" ||
      typeof value.revision !== "string"
    )
      throw new Error("preview.api_invalid: invalid source revision");
    return { enabled: value.enabled, revision: value.revision };
  }

  prepareRefresh(
    expectedSourceVersion: string,
    signal?: AbortSignal,
  ): Promise<PreviewSessionDescriptor> {
    return this.sessionRequest(
      "/api/prepare-refresh",
      { expectedSourceVersion },
      signal,
    );
  }

  commitRefresh(
    expectedSourceVersion: string,
    candidateSessionId: string,
    signal?: AbortSignal,
  ): Promise<PreviewSessionDescriptor> {
    return this.sessionRequest(
      "/api/commit-refresh",
      { expectedSourceVersion, candidateSessionId },
      signal,
    );
  }

  discardRefresh(
    expectedSourceVersion: string,
    candidateSessionId: string,
    signal?: AbortSignal,
  ): Promise<PreviewSessionDescriptor> {
    return this.sessionRequest(
      "/api/discard-refresh",
      { expectedSourceVersion, candidateSessionId },
      signal,
    );
  }

  refresh(
    expectedSourceVersion: string,
    signal?: AbortSignal,
  ): Promise<PreviewSessionDescriptor> {
    if (!expectedSourceVersion.trim())
      return Promise.reject(
        new Error("preview.refresh_invalid: source version is required"),
      );
    return this.sessionRequest(
      "/api/refresh",
      { expectedSourceVersion },
      signal,
    );
  }

  async output(
    request: PreviewOutputRequest,
    signal?: AbortSignal,
  ): Promise<unknown> {
    checkOutput(request);
    return this.jsonRequest("/api/output", request, signal);
  }

  private async sessionRequest(
    path: string,
    body: object | undefined,
    signal?: AbortSignal,
  ): Promise<PreviewSessionDescriptor> {
    return descriptor(await this.jsonRequest(path, body, signal));
  }

  private async jsonRequest(
    path: string,
    body: object | undefined,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await this.request(new URL(path, this.baseUrl), {
      method: body ? "POST" : "GET",
      cache: "no-store",
      credentials: "same-origin",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    if (!response.ok)
      throw new Error(
        `preview.api_http_${response.status}: ${await errorMessage(response)}`,
      );
    try {
      return (await response.json()) as unknown;
    } catch (cause) {
      throw new Error("preview.api_invalid: response is not valid JSON", {
        cause,
      });
    }
  }
}
