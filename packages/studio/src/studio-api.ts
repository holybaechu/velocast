import { isRpcSession, type RpcSession } from "./rpc-wire.js";
import type {
  CodeEdit,
  CodeSource,
  StudioClientCommand,
  StudioHeartbeat,
} from "@velocast/core";

export interface StudioSessionDescriptor {
  readonly snapshotUrl: string;
  readonly session: RpcSession;
  readonly inputProps?: unknown;
  readonly sourceRevision?: string;
  readonly codeRevisions?: Readonly<Record<string, string>>;
  readonly autoRefresh?: boolean;
  readonly stagedRefresh?: boolean;
  readonly inputPropsFile?: {
    readonly path: string;
    readonly revision: string;
  };
}

interface SavedSourceGuard {
  expectedSourceVersion: string;
  expectedRevision: string;
}

export interface StudioOutputJob {
  readonly id: string;
  readonly status:
    "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

export type StudioOutputRequest = {
  readonly compositionId: string;
  readonly expectedSourceVersion: string;
} & (
  | { readonly frame: number; readonly range?: never }
  | {
      readonly frame?: never;
      readonly range: { readonly start: number; readonly end: number };
    }
);

export interface StudioApi {
  agentConnection?(
    signal?: AbortSignal,
  ): Promise<{ command: string; args: string[] }>;
  heartbeat?(
    clientId: string,
    heartbeat: StudioHeartbeat,
    signal?: AbortSignal,
  ): Promise<{ commands: StudioClientCommand[] }>;
  disconnect?(clientId: string, signal?: AbortSignal): Promise<void>;
  getSession(signal?: AbortSignal): Promise<StudioSessionDescriptor>;
  refresh(
    expectedSourceVersion: string,
    signal?: AbortSignal,
  ): Promise<StudioSessionDescriptor>;
  output(
    request: StudioOutputRequest,
    signal?: AbortSignal,
    onProgress?: (job: StudioOutputJob) => void,
  ): Promise<unknown>;
  getCode?(compositionId: string, signal?: AbortSignal): Promise<CodeSource>;
  saveCode?(
    request: SavedSourceGuard & { compositionId: string; edits: CodeEdit[] },
    signal?: AbortSignal,
  ): Promise<CodeSource>;
  changeCodeHistory?(
    request: SavedSourceGuard & {
      compositionId: string;
      action: "undo" | "redo";
    },
    signal?: AbortSignal,
  ): Promise<CodeSource>;
  recoverCode?(
    request: { compositionId: string; expectedSourceVersion: string },
    signal?: AbortSignal,
  ): Promise<CodeSource>;
  changes?(
    signal?: AbortSignal,
  ): Promise<{ enabled: boolean; revision: string }>;
  prepareRefresh?(
    expectedSourceVersion: string,
    signal?: AbortSignal,
  ): Promise<StudioSessionDescriptor>;
  commitRefresh?(
    expectedSourceVersion: string,
    candidateSessionId: string,
    signal?: AbortSignal,
  ): Promise<StudioSessionDescriptor>;
  discardRefresh?(
    expectedSourceVersion: string,
    candidateSessionId: string,
    signal?: AbortSignal,
  ): Promise<StudioSessionDescriptor>;
}

export interface HttpStudioApiOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("studio.api_invalid: expected a JSON object");
  return value as Record<string, unknown>;
}

function descriptor(value: unknown): StudioSessionDescriptor {
  const body = record(value);
  if (
    body.codeRevisions !== undefined &&
    Object.values(record(body.codeRevisions)).some(
      (revision) => typeof revision !== "string" || !revision,
    )
  )
    throw new Error("studio.api_invalid: invalid source build receipts");
  if (typeof body.snapshotUrl !== "string" || !isRpcSession(body.session))
    throw new Error(
      "studio.api_invalid: snapshotUrl and session identity are required",
    );
  const url = new URL(body.snapshotUrl);
  if (url.protocol !== "http:")
    throw new Error("studio.api_invalid: snapshot URL must use HTTP");
  return Object.freeze({
    snapshotUrl: url.href,
    session: Object.freeze({ ...body.session }),
    ...(typeof body.sourceRevision === "string"
      ? { sourceRevision: body.sourceRevision }
      : {}),
    ...(body.codeRevisions !== undefined
      ? {
          codeRevisions: Object.freeze({
            ...record(body.codeRevisions),
          }) as Readonly<Record<string, string>>,
        }
      : {}),
    ...(typeof body.autoRefresh === "boolean"
      ? { autoRefresh: body.autoRefresh }
      : {}),
    ...(typeof body.stagedRefresh === "boolean"
      ? { stagedRefresh: body.stagedRefresh }
      : {}),
    ...(body.inputPropsFile &&
    typeof body.inputPropsFile === "object" &&
    typeof (body.inputPropsFile as Record<string, unknown>).path === "string" &&
    typeof (body.inputPropsFile as Record<string, unknown>).revision ===
      "string"
      ? {
          inputPropsFile: Object.freeze({
            ...body.inputPropsFile,
          }) as StudioSessionDescriptor["inputPropsFile"],
        }
      : {}),
    ...(Object.hasOwn(body, "inputProps")
      ? { inputProps: body.inputProps }
      : {}),
  });
}

function checkSavedRevision(request: SavedSourceGuard) {
  if (
    !request.expectedSourceVersion?.trim() ||
    !request.expectedRevision?.trim()
  )
    throw new Error(
      "studio.code_invalid: source version and saved revision are required",
    );
}

function codeSource(value: unknown): CodeSource {
  const source = record(value);
  if (
    typeof source.enabled !== "boolean" ||
    typeof source.compositionId !== "string" ||
    !Array.isArray(source.elements) ||
    typeof source.canUndo !== "boolean" ||
    typeof source.canRedo !== "boolean" ||
    (source.displayedRevision !== undefined &&
      typeof source.displayedRevision !== "string") ||
    (source.recoveryRequired !== undefined &&
      typeof source.recoveryRequired !== "boolean") ||
    (source.recoveryPath !== undefined &&
      typeof source.recoveryPath !== "string") ||
    (source.syntaxError !== undefined &&
      typeof source.syntaxError !== "string") ||
    (source.enabled &&
      (typeof source.path !== "string" ||
        (source.recoveryRequired !== true &&
          typeof source.revision !== "string"))) ||
    (source.revision !== undefined && typeof source.revision !== "string")
  )
    throw new Error("studio.api_invalid: invalid code source");
  for (const item of source.elements) {
    const element = record(item);
    if (
      typeof element.id !== "string" ||
      !element.id ||
      typeof element.name !== "string" ||
      !["layer", "audio", "video"].includes(String(element.kind)) ||
      !Number.isSafeInteger(element.line) ||
      Number(element.line) < 1
    )
      throw new Error("studio.api_invalid: invalid code element");
    for (const item of Object.values(record(element.fields))) {
      const field = record(item);
      if (
        typeof field.editable !== "boolean" ||
        (field.reason !== undefined && typeof field.reason !== "string") ||
        (field.value !== undefined &&
          !["string", "number", "boolean"].includes(typeof field.value)) ||
        (typeof field.value === "number" && !Number.isFinite(field.value))
      )
        throw new Error("studio.api_invalid: invalid code field");
    }
  }
  return source as unknown as CodeSource;
}

function outputJob(value: unknown): StudioOutputJob {
  const body = record(value);
  if (
    typeof body.id !== "string" ||
    !body.id ||
    !["running", "cancelling", "succeeded", "failed", "cancelled"].includes(
      String(body.status),
    )
  )
    throw new Error("studio.api_invalid: invalid output job");
  return body as unknown as StudioOutputJob;
}

function terminal(job: StudioOutputJob): boolean {
  return !["running", "cancelling"].includes(job.status);
}

function pollDelay(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, 250);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function checkOutput(request: StudioOutputRequest): StudioOutputRequest {
  if (!request.compositionId?.trim() || !request.expectedSourceVersion?.trim())
    throw new Error(
      "studio.output_invalid: composition and source version are required",
    );
  const hasFrame = Object.hasOwn(request, "frame");
  const hasRange = Object.hasOwn(request, "range");
  if (hasFrame === hasRange)
    throw new Error(
      "studio.output_invalid: choose exactly one frame or range output",
    );
  if (hasFrame) {
    if (!Number.isSafeInteger(request.frame) || request.frame! < 0)
      throw new Error(
        "studio.output_invalid: frame must be a nonnegative safe integer",
      );
  } else if (
    !Number.isSafeInteger(request.range?.start) ||
    !Number.isSafeInteger(request.range?.end) ||
    request.range!.start < 0 ||
    request.range!.end <= request.range!.start
  )
    throw new Error(
      "studio.output_invalid: range must be a nonempty half-open frame range",
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

export class HttpStudioApi implements StudioApi {
  private readonly baseUrl: string;
  private readonly request: typeof globalThis.fetch;

  constructor(options: HttpStudioApiOptions = {}) {
    this.baseUrl = new URL(
      options.baseUrl ?? globalThis.location?.href ?? "http://127.0.0.1/",
    ).href;
    this.request = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  getSession(signal?: AbortSignal): Promise<StudioSessionDescriptor> {
    return this.sessionRequest("/api/session", undefined, signal);
  }

  async agentConnection(
    signal?: AbortSignal,
  ): Promise<{ command: string; args: string[] }> {
    const value = record(
      await this.jsonRequest("/api/agent-connection", undefined, signal),
    );
    if (
      typeof value.command !== "string" ||
      !value.command ||
      !Array.isArray(value.args) ||
      value.args.some((arg) => typeof arg !== "string")
    )
      throw new Error("studio.api_invalid: invalid agent connection");
    return { command: value.command, args: value.args as string[] };
  }

  async heartbeat(
    clientId: string,
    heartbeat: StudioHeartbeat,
    signal?: AbortSignal,
  ): Promise<{ commands: StudioClientCommand[] }> {
    const value = record(
      await this.jsonRequest(
        `/api/clients/${encodeURIComponent(clientId)}`,
        heartbeat,
        signal,
      ),
    );
    if (!Array.isArray(value.commands))
      throw new Error("studio.api_invalid: invalid client commands");
    const commands = value.commands.map((item) => {
      const command = record(item);
      if (
        typeof command.id !== "string" ||
        !command.id ||
        !Number.isSafeInteger(command.expectedRevision) ||
        Number(command.expectedRevision) < 1 ||
        typeof command.expectedSourceVersion !== "string" ||
        !(
          (command.action === "seek" &&
            Number.isSafeInteger(command.frame) &&
            Number(command.frame) >= 0) ||
          (command.action === "select" &&
            typeof command.elementId === "string" &&
            !!command.elementId) ||
          command.action === "play" ||
          command.action === "pause" ||
          (command.action === "composition" &&
            typeof command.compositionId === "string" &&
            !!command.compositionId)
        )
      )
        throw new Error("studio.api_invalid: invalid client command");
      return command as unknown as StudioClientCommand;
    });
    return { commands };
  }

  async disconnect(clientId: string, signal?: AbortSignal): Promise<void> {
    const response = await this.request(
      new URL(`/api/clients/${encodeURIComponent(clientId)}`, this.baseUrl),
      {
        method: "DELETE",
        credentials: "same-origin",
        signal,
        keepalive: true,
      },
    );
    if (!response.ok)
      throw new Error(
        `studio.api_http_${response.status}: ${await errorMessage(response)}`,
      );
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
      throw new Error("studio.api_invalid: invalid source revision");
    return { enabled: value.enabled, revision: value.revision };
  }

  prepareRefresh(
    expectedSourceVersion: string,
    signal?: AbortSignal,
  ): Promise<StudioSessionDescriptor> {
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
  ): Promise<StudioSessionDescriptor> {
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
  ): Promise<StudioSessionDescriptor> {
    return this.sessionRequest(
      "/api/discard-refresh",
      { expectedSourceVersion, candidateSessionId },
      signal,
    );
  }

  refresh(
    expectedSourceVersion: string,
    signal?: AbortSignal,
  ): Promise<StudioSessionDescriptor> {
    if (!expectedSourceVersion.trim())
      return Promise.reject(
        new Error("studio.refresh_invalid: source version is required"),
      );
    return this.sessionRequest(
      "/api/refresh",
      { expectedSourceVersion },
      signal,
    );
  }

  async output(
    request: StudioOutputRequest,
    signal?: AbortSignal,
    onProgress?: (job: StudioOutputJob) => void,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    // Obtain the owned job ID even if the caller aborts while submission is in flight.
    let job = await this.startJob(request, AbortSignal.timeout(10_000));
    let interruption: unknown;
    try {
      onProgress?.(job);
      signal?.throwIfAborted();
      while (!terminal(job)) {
        await pollDelay(signal);
        job = await this.getJob(job.id, signal);
        onProgress?.(job);
      }
    } catch (error) {
      interruption = error;
      if (!terminal(job)) {
        try {
          job = await this.cancelJob(job.id, AbortSignal.timeout(30_000));
          if (!terminal(job))
            throw new Error(
              "Cancellation did not return a terminal job status",
              { cause: error },
            );
        } catch (cause) {
          throw new Error(
            `studio.cancel_failed: could not confirm job ${job.id} stopped; inspect its status before starting another output`,
            { cause },
          );
        }
        onProgress?.(job);
      }
    }
    if (job.status === "failed")
      throw new Error(
        `${job.error?.code ?? "studio.output_failed"}: ${job.error?.message ?? "Output job failed"}`,
      );
    if (job.status === "cancelled") {
      if (interruption !== undefined) throw interruption;
      const error = new Error(
        `studio.output_cancelled: job ${job.id} was cancelled`,
      );
      error.name = "AbortError";
      throw error;
    }
    return job.result;
  }

  async startJob(
    request: StudioOutputRequest,
    signal?: AbortSignal,
  ): Promise<StudioOutputJob> {
    return outputJob(
      await this.jsonRequest("/api/jobs", checkOutput(request), signal),
    );
  }

  async getJob(id: string, signal?: AbortSignal): Promise<StudioOutputJob> {
    return outputJob(
      await this.jsonRequest(
        `/api/jobs/${encodeURIComponent(id)}`,
        undefined,
        signal,
      ),
    );
  }

  async cancelJob(id: string, signal?: AbortSignal): Promise<StudioOutputJob> {
    return outputJob(
      await this.jsonRequest(
        `/api/jobs/${encodeURIComponent(id)}/cancel`,
        {},
        signal,
      ),
    );
  }

  async getCode(
    compositionId: string,
    signal?: AbortSignal,
  ): Promise<CodeSource> {
    if (!compositionId.trim())
      throw new Error("studio.code_invalid: composition is required");
    return codeSource(
      await this.jsonRequest(
        `/api/code?${new URLSearchParams({ compositionId })}`,
        undefined,
        signal,
      ),
    );
  }

  async saveCode(
    request: SavedSourceGuard & { compositionId: string; edits: CodeEdit[] },
    signal?: AbortSignal,
  ): Promise<CodeSource> {
    checkSavedRevision(request);
    if (
      !request.compositionId.trim() ||
      !Array.isArray(request.edits) ||
      !request.edits.length ||
      request.edits.some(
        (edit) =>
          !edit.id?.trim() ||
          !edit.field?.trim() ||
          !["string", "number", "boolean"].includes(typeof edit.value) ||
          (typeof edit.value === "number" && !Number.isFinite(edit.value)),
      )
    )
      throw new Error(
        "studio.code_invalid: composition and supported literal edits are required",
      );
    return codeSource(await this.jsonRequest("/api/code", request, signal));
  }

  async changeCodeHistory(
    request: SavedSourceGuard & {
      compositionId: string;
      action: "undo" | "redo";
    },
    signal?: AbortSignal,
  ): Promise<CodeSource> {
    checkSavedRevision(request);
    if (
      !request.compositionId.trim() ||
      !["undo", "redo"].includes(request.action)
    )
      throw new Error(
        "studio.code_invalid: composition and undo or redo are required",
      );
    return codeSource(
      await this.jsonRequest("/api/code/history", request, signal),
    );
  }

  async recoverCode(
    request: { compositionId: string; expectedSourceVersion: string },
    signal?: AbortSignal,
  ): Promise<CodeSource> {
    if (!request.compositionId.trim() || !request.expectedSourceVersion.trim())
      throw new Error(
        "studio.code_invalid: composition and source version are required",
      );
    return codeSource(
      await this.jsonRequest("/api/code/recover", request, signal),
    );
  }

  private async sessionRequest(
    path: string,
    body: object | undefined,
    signal?: AbortSignal,
  ): Promise<StudioSessionDescriptor> {
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
    return this.readResponse(response, signal);
  }

  private async readResponse(
    response: Response,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!response.ok)
      throw new Error(
        `studio.api_http_${response.status}: ${await errorMessage(response)}`,
      );
    try {
      return (await response.json()) as unknown;
    } catch (cause) {
      signal?.throwIfAborted();
      throw new Error("studio.api_invalid: response is not valid JSON", {
        cause,
      });
    }
  }
}
