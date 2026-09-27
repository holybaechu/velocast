import type {
  BrowserProtocol,
  CompositionManifest,
  RenderContext,
} from "@velocast/core";
import type { BrowserRuntime } from "./browser-runtime.js";
import { inspectElement } from "./element-inspection.js";
import {
  RPC_KIND,
  RPC_VERSION,
  isRpcEnvelope,
  loopbackOrigin,
  sameRpcSession,
  type MessageHost,
  type MessageTarget,
  type RpcRequest,
  type RpcResponse,
  type RpcSession,
} from "./rpc-wire.js";

export interface ChildBridgeHost extends MessageHost {
  readonly parent: MessageTarget;
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly __velocast?: BrowserProtocol;
  readonly document?: Document;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("preview.rpc_payload: expected object");
  return value as Record<string, unknown>;
}
function cancelled(): Error {
  const error = new Error("preview.rpc_cancelled: request was cancelled");
  error.name = "AbortError";
  return error;
}

/** Installed synchronously by bridge.js, before source discovery/initialization. */
export function installChildBridge(
  host: ChildBridgeHost,
  parentOrigin: string,
  runtime: BrowserRuntime,
  protocolVersion: number,
): () => void {
  const origin = loopbackOrigin(parentOrigin);
  let binding: { channel: string; session: RpcSession } | undefined;
  let lastRequest = 0;
  let closed = false;
  let connected = false;
  let initialized: CompositionManifest | undefined;
  let inputProps: unknown;
  let queue = Promise.resolve();
  const operations = new Map<number, AbortController>();
  const protocol = () => {
    runtime.assertProtocol(protocolVersion);
    return host.__velocast!;
  };
  const reply = (request: RpcRequest, ok: boolean, value: unknown) => {
    const message: RpcResponse = {
      kind: RPC_KIND,
      version: RPC_VERSION,
      type: "response",
      channel: request.channel,
      requestId: request.requestId,
      session: request.session,
      method: request.method,
      ok,
      ...(ok
        ? { value }
        : {
            error: {
              name: value instanceof Error ? value.name : "Error",
              message: value instanceof Error ? value.message : String(value),
            },
          }),
    };
    host.parent.postMessage(message, origin);
  };
  const context = (composition: CompositionManifest): RenderContext => ({
    compositionId: composition.id,
    width: composition.width,
    height: composition.height,
    fps: composition.fps,
    durationFrames: composition.durationFrames,
    target: composition.target,
    inputProps,
    renderSession: binding!.session,
  });
  const execute = async (
    request: RpcRequest,
    signal: AbortSignal,
  ): Promise<unknown> => {
    signal.throwIfAborted();
    const api = protocol();
    switch (request.method) {
      case "connect": {
        if (connected)
          throw new Error(
            "preview.rpc_connected: a channel binds inputs only once",
          );
        connected = true;
        inputProps = record(request.payload).inputProps;
        await runtime.bindSession(binding!.session);
        await api.setInputProps(inputProps);
        await runtime.waitForReady();
        return { protocolVersion, compositions: await api.getCompositions() };
      }
      case "initialize": {
        const id = record(request.payload).compositionId;
        if (initialized && initialized.id !== id)
          throw new Error(
            "preview.composition_change: reload before selecting another composition",
          );
        const composition = (await api.getCompositions()).find(
          (item) => item.id === id,
        );
        if (!composition)
          throw new Error(
            "preview.composition_missing: select a registered composition",
          );
        if (
          host.innerWidth !== composition.width ||
          host.innerHeight !== composition.height
        )
          throw new Error(
            "preview.viewport_mismatch: resize the iframe before initialization",
          );
        runtime.renderEnvironment(composition.width, composition.height);
        runtime.selectTarget(composition.target ?? "");
        await runtime.completeFrame(
          () => api.seekFrame(composition.id, 0, context(composition)),
          signal,
        );
        initialized = composition;
        return {
          composition,
          audioPlan:
            (await api.getAudioPlan?.(composition.id, context(composition))) ??
            null,
        };
      }
      case "seek": {
        if (!initialized)
          throw new Error(
            "preview.not_initialized: initialize a composition before seeking",
          );
        const frame = record(request.payload).frame;
        if (
          !Number.isSafeInteger(frame) ||
          Number(frame) < 0 ||
          Number(frame) >= initialized.durationFrames
        )
          throw new Error(
            "preview.frame_invalid: frame is outside the composition",
          );
        await runtime.completeFrame(
          () =>
            api.seekFrame(
              initialized!.id,
              Number(frame),
              context(initialized!),
            ),
          signal,
        );
        return { frame, compositionId: initialized.id };
      }
      case "audioPlan": {
        if (!initialized)
          throw new Error(
            "preview.not_initialized: audio plan requires initialized frame zero",
          );
        return (
          (await api.getAudioPlan?.(initialized.id, context(initialized))) ??
          null
        );
      }
      case "inspect": {
        if (!initialized || !host.document)
          throw new Error(
            "preview.not_initialized: inspection requires an initialized composition",
          );
        const selector = record(request.payload).selector;
        if (typeof selector !== "string")
          throw new Error(
            "preview.selector_invalid: a CSS selector is required",
          );
        return inspectElement(host.document, selector, initialized.target);
      }
      case "destroy":
        await api.destroy();
        initialized = undefined;
        closed = true;
        return null;
      default:
        throw new Error("preview.rpc_method: unsupported operation");
    }
  };
  const receive = (event: MessageEvent) => {
    if (
      closed ||
      event.source !== host.parent ||
      event.origin !== origin ||
      !isRpcEnvelope(event.data) ||
      event.data.type !== "request"
    )
      return;
    const request = event.data;
    if (!binding) {
      if (request.method !== "connect") return;
      binding = {
        channel: request.channel,
        session: Object.freeze({ ...request.session }),
      };
    }
    if (
      request.channel !== binding.channel ||
      !sameRpcSession(request.session, binding.session) ||
      request.requestId <= lastRequest
    )
      return;
    lastRequest = request.requestId;
    if (request.method === "cancel") {
      const target = (request.payload as { requestId?: unknown } | undefined)
        ?.requestId;
      if (Number.isSafeInteger(target) && operations.has(Number(target))) {
        operations.get(Number(target))!.abort(cancelled());
        host.__velocast?.cancelPending();
      }
      reply(request, true, null);
      return;
    }
    if (request.method === "destroy") {
      for (const operation of operations.values()) operation.abort(cancelled());
      host.__velocast?.cancelPending();
    }
    const operation = new AbortController();
    operations.set(request.requestId, operation);
    queue = queue.then(async () => {
      try {
        const value = await execute(request, operation.signal);
        operation.signal.throwIfAborted();
        reply(request, true, value);
      } catch (error) {
        reply(request, false, error);
      } finally {
        operations.delete(request.requestId);
      }
    });
  };
  host.addEventListener("message", receive);
  return () => {
    closed = true;
    for (const operation of operations.values()) operation.abort(cancelled());
    host.__velocast?.cancelPending();
    operations.clear();
    host.removeEventListener("message", receive);
  };
}
