import {
  RPC_KIND,
  RPC_VERSION,
  isRpcEnvelope,
  isRpcSession,
  loopbackOrigin,
  sameRpcSession,
  type MessageHost,
  type MessageTarget,
  type RpcMethod,
  type RpcRequest,
  type RpcSession,
} from "./rpc-wire.js";

interface Pending {
  method: RpcMethod;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}
export interface RpcClientOptions {
  host: MessageHost;
  target: MessageTarget;
  targetOrigin: string;
  session: RpcSession;
  channel?: string;
  timeoutMs?: number;
}
function abortError(): Error {
  const error = new Error("preview.rpc_cancelled: request was cancelled");
  error.name = "AbortError";
  return error;
}

/** Fixed-method, session-scoped cross-origin RPC. No code strings are evaluated. */
export class PreviewRpcClient {
  readonly channel: string;
  private readonly origin: string;
  private readonly session: RpcSession;
  private readonly timeout: number;
  private nextId = 0;
  private closed = false;
  private readonly pending = new Map<number, Pending>();
  constructor(private readonly options: RpcClientOptions) {
    this.origin = loopbackOrigin(options.targetOrigin);
    if (!isRpcSession(options.session))
      throw new Error("preview.rpc_session: invalid session");
    this.session = Object.freeze({ ...options.session });
    this.channel = options.channel ?? crypto.randomUUID();
    this.timeout = options.timeoutMs ?? 15000;
    if (
      !this.channel ||
      this.channel.length > 128 ||
      !Number.isSafeInteger(this.timeout) ||
      this.timeout <= 0
    )
      throw new Error("preview.rpc_options: invalid channel or timeout");
    options.host.addEventListener("message", this.receive);
  }
  request<Result>(
    method: RpcMethod,
    payload?: unknown,
    signal?: AbortSignal,
  ): Promise<Result> {
    if (this.closed)
      return Promise.reject(new Error("preview.rpc_closed: client is closed"));
    if (signal?.aborted) return Promise.reject(abortError());
    const requestId = ++this.nextId;
    return new Promise<Result>((resolve, reject) => {
      const fail = (error: Error, notify: boolean) => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        pending.cleanup();
        if (notify) this.sendCancel(requestId);
        reject(error);
      };
      const abort = () => fail(abortError(), true);
      const timer = setTimeout(
        () =>
          fail(
            new Error(`preview.rpc_timeout: ${method} did not finish`),
            true,
          ),
        this.timeout,
      );
      this.pending.set(requestId, {
        method,
        resolve: (value) => resolve(value as Result),
        reject,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        },
      });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.post({
          kind: RPC_KIND,
          version: RPC_VERSION,
          type: "request",
          channel: this.channel,
          requestId,
          session: this.session,
          method,
          payload,
        });
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)), false);
      }
    });
  }
  close(): void {
    if (this.closed) return;
    for (const [id, pending] of this.pending) {
      this.sendCancel(id);
      pending.cleanup();
      pending.reject(abortError());
    }
    this.pending.clear();
    this.closed = true;
    this.options.host.removeEventListener("message", this.receive);
  }
  private post(request: RpcRequest): void {
    this.options.target.postMessage(request, this.origin);
  }
  private sendCancel(requestId: number): void {
    try {
      this.post({
        kind: RPC_KIND,
        version: RPC_VERSION,
        type: "request",
        channel: this.channel,
        requestId: ++this.nextId,
        session: this.session,
        method: "cancel",
        payload: { requestId },
      });
    } catch {
      /* The original failure is returned; teardown still removes the iframe. */
    }
  }
  private receive = (event: MessageEvent): void => {
    if (
      this.closed ||
      event.source !== this.options.target ||
      event.origin !== this.origin ||
      !isRpcEnvelope(event.data)
    )
      return;
    const message = event.data;
    if (
      message.type !== "response" ||
      message.channel !== this.channel ||
      !sameRpcSession(message.session, this.session)
    )
      return;
    const pending = this.pending.get(message.requestId);
    if (
      !pending ||
      pending.method !== message.method ||
      typeof message.ok !== "boolean"
    )
      return;
    if (
      !message.ok &&
      (!message.error ||
        typeof message.error.message !== "string" ||
        typeof message.error.name !== "string")
    )
      return;
    this.pending.delete(message.requestId);
    pending.cleanup();
    if (message.ok) pending.resolve(message.value);
    else {
      const error = new Error(message.error!.message);
      error.name = message.error!.name;
      pending.reject(error);
    }
  };
}
