import type { RenderSession } from "@velocast/core";

export const RPC_KIND = "velocast-preview-rpc";
export const RPC_VERSION = 1;
export type RpcSession = RenderSession & { readonly sourceVersion: string };
export type RpcMethod =
  | "connect"
  | "initialize"
  | "seek"
  | "audioPlan"
  | "inspect"
  | "cancel"
  | "destroy";
export interface RpcRequest {
  kind: typeof RPC_KIND;
  version: typeof RPC_VERSION;
  type: "request";
  channel: string;
  requestId: number;
  session: RpcSession;
  method: RpcMethod;
  payload?: unknown;
}
export interface RpcResponse {
  kind: typeof RPC_KIND;
  version: typeof RPC_VERSION;
  type: "response";
  channel: string;
  requestId: number;
  session: RpcSession;
  method: RpcMethod;
  ok: boolean;
  value?: unknown;
  error?: { name: string; message: string };
}
export interface MessageHost {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
}
export interface MessageTarget {
  postMessage(message: unknown, targetOrigin: string): void;
}
export function sameRpcSession(left: RpcSession, right: RpcSession): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.sourceVersion === right.sourceVersion
  );
}
export function isRpcSession(value: unknown): value is RpcSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Record<string, unknown>;
  return (
    typeof session.sessionId === "string" &&
    !!session.sessionId.trim() &&
    typeof session.sourceVersion === "string" &&
    !!session.sourceVersion.trim()
  );
}
export function isRpcEnvelope(
  value: unknown,
): value is RpcRequest | RpcResponse {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return (
    message.kind === RPC_KIND &&
    message.version === RPC_VERSION &&
    (message.type === "request" || message.type === "response") &&
    typeof message.channel === "string" &&
    message.channel.length > 0 &&
    message.channel.length <= 128 &&
    Number.isSafeInteger(message.requestId) &&
    Number(message.requestId) > 0 &&
    isRpcSession(message.session) &&
    [
      "connect",
      "initialize",
      "seek",
      "audioPlan",
      "inspect",
      "cancel",
      "destroy",
    ].includes(String(message.method))
  );
}
export function loopbackOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "preview.rpc_origin: expected an explicit loopback HTTP origin",
    );
  return url.origin;
}
