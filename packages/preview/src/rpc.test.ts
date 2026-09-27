import { afterEach, expect, it, vi } from "vitest";
import type { BrowserProtocol, CompositionManifest } from "@velocast/core";
import { PreviewRpcClient } from "./rpc-client.js";
import { installChildBridge, type ChildBridgeHost } from "./child-bridge.js";
import type { BrowserRuntime } from "./browser-runtime.js";
import {
  RPC_KIND,
  RPC_VERSION,
  type MessageTarget,
  type RpcRequest,
  type RpcResponse,
  type RpcSession,
} from "./rpc-wire.js";

const session: RpcSession = { sessionId: "session", sourceVersion: "source" };
class Host {
  readonly listeners = new Set<(event: MessageEvent) => void>();
  addEventListener(_type: "message", listener: (event: MessageEvent) => void) {
    this.listeners.add(listener);
  }
  removeEventListener(
    _type: "message",
    listener: (event: MessageEvent) => void,
  ) {
    this.listeners.delete(listener);
  }
  dispatch(data: unknown, source: unknown, origin: string) {
    for (const listener of this.listeners)
      listener({ data, source, origin } as MessageEvent);
  }
}
afterEach(() => vi.useRealTimers());

it("host rejects wrong windows/origins/channels/requests/sessions and accepts its exact response", async () => {
  const host = new Host();
  const messages: RpcRequest[] = [];
  const target: MessageTarget = {
    postMessage: (message) => {
      messages.push(message as RpcRequest);
    },
  };
  const client = new PreviewRpcClient({
    host,
    target,
    targetOrigin: "http://127.0.0.1:9001",
    session,
    channel: "channel",
  });
  let resolved = false;
  const result = client.request<number>("seek", { frame: 4 }).then((value) => {
    resolved = true;
    return value;
  });
  const response: RpcResponse = {
    ...messages[0]!,
    type: "response",
    ok: true,
    value: 4,
  };
  host.dispatch(response, {}, "http://127.0.0.1:9001");
  host.dispatch(response, target, "http://127.0.0.1:9002");
  host.dispatch(
    { ...response, channel: "wrong" },
    target,
    "http://127.0.0.1:9001",
  );
  host.dispatch(
    { ...response, requestId: 99 },
    target,
    "http://127.0.0.1:9001",
  );
  host.dispatch(
    { ...response, session: { ...session, sourceVersion: "old" } },
    target,
    "http://127.0.0.1:9001",
  );
  await Promise.resolve();
  expect(resolved).toBe(false);
  host.dispatch(response, target, "http://127.0.0.1:9001");
  await expect(result).resolves.toBe(4);
  client.close();
  expect(host.listeners.size).toBe(0);
});

it("host abort and timeout cancel their precise child request and release listeners", async () => {
  vi.useFakeTimers();
  const host = new Host();
  const messages: RpcRequest[] = [];
  const target: MessageTarget = {
    postMessage: (message) => {
      messages.push(message as RpcRequest);
    },
  };
  const client = new PreviewRpcClient({
    host,
    target,
    targetOrigin: "http://127.0.0.1:9001",
    session,
    channel: "channel",
    timeoutMs: 10,
  });
  const abort = new AbortController();
  const request = client.request("seek", { frame: 1 }, abort.signal);
  const cancelled = expect(request).rejects.toMatchObject({
    name: "AbortError",
  });
  abort.abort();
  await cancelled;
  expect(messages[1]).toMatchObject({
    method: "cancel",
    payload: { requestId: 1 },
  });
  const timed = client.request("audioPlan");
  const failed = expect(timed).rejects.toThrow("preview.rpc_timeout");
  await vi.advanceTimersByTimeAsync(11);
  await failed;
  expect(messages.at(-1)).toMatchObject({
    method: "cancel",
    payload: { requestId: 3 },
  });
  client.close();
  expect(host.listeners.size).toBe(0);
});

function child() {
  const host = new Host();
  const responses: RpcResponse[] = [];
  const parent: MessageTarget = {
    postMessage: (message) => {
      responses.push(message as RpcResponse);
    },
  };
  const order: string[] = [];
  const composition: CompositionManifest = {
    id: "scene",
    width: 320,
    height: 180,
    fps: 30,
    durationFrames: 90,
    target: "#root",
  };
  const api: BrowserProtocol = {
    protocolVersion: 3,
    beginSession: async () => {},
    getSession: () => session,
    cancelPending: vi.fn(),
    getCompositions: async () => [composition],
    getDurationFrames: async () => 90,
    setInputProps: async () => {
      order.push("props");
    },
    seekFrame: async (_id, frame) => {
      order.push(`seek-${frame}`);
    },
    getAudioPlan: async () => {
      order.push("audio");
      return null;
    },
    destroy: vi.fn(async () => {}),
  };
  const runtime: BrowserRuntime = {
    assertProtocol: (version) => {
      expect(version).toBe(3);
      return 3;
    },
    bindSession: async () => {
      order.push("bind");
    },
    renderEnvironment: () => {
      order.push("viewport");
    },
    selectTarget: () => {
      order.push("target");
    },
    waitForReady: async () => {},
    completeFrame: async (seek) => {
      const value = await seek();
      order.push("paint-ready");
      return value;
    },
  };
  const environment: ChildBridgeHost = Object.assign(host, {
    parent,
    innerWidth: 320,
    innerHeight: 180,
    __velocast: api,
  });
  const close = installChildBridge(
    environment,
    "http://127.0.0.1:9000",
    runtime,
    3,
  );
  let id = 0;
  const send = (method: RpcRequest["method"], payload?: unknown) => {
    const request: RpcRequest = {
      kind: RPC_KIND,
      version: RPC_VERSION,
      type: "request",
      channel: "channel",
      requestId: ++id,
      session,
      method,
      payload,
    };
    host.dispatch(request, parent, "http://127.0.0.1:9000");
    return request;
  };
  return { host, parent, api, runtime, responses, order, send, close };
}

it("child binds props, waits real frame-zero readiness, then asks for its audio plan", async () => {
  const test = child();
  test.send("connect", { inputProps: { title: "title" } });
  await vi.waitFor(() => expect(test.responses).toHaveLength(1));
  test.send("initialize", { compositionId: "scene" });
  await vi.waitFor(() => expect(test.responses).toHaveLength(2));
  expect(test.order).toEqual([
    "bind",
    "props",
    "viewport",
    "target",
    "seek-0",
    "paint-ready",
    "audio",
  ]);
  test.send("seek", { frame: 12 });
  await vi.waitFor(() => expect(test.responses).toHaveLength(3));
  expect(test.responses[2]).toMatchObject({
    ok: true,
    value: { frame: 12, compositionId: "scene" },
    session,
  });
  test.close();
});

it("child ignores other origins/windows/identities and prevents replayed requests", async () => {
  const test = child();
  const request: RpcRequest = {
    kind: RPC_KIND,
    version: RPC_VERSION,
    type: "request",
    channel: "channel",
    requestId: 1,
    session,
    method: "connect",
    payload: {},
  };
  test.host.dispatch(request, {}, "http://127.0.0.1:9000");
  test.host.dispatch(request, test.parent, "http://127.0.0.1:9002");
  await Promise.resolve();
  expect(test.responses).toHaveLength(0);
  test.host.dispatch(request, test.parent, "http://127.0.0.1:9000");
  await vi.waitFor(() => expect(test.responses).toHaveLength(1));
  test.host.dispatch(request, test.parent, "http://127.0.0.1:9000");
  test.host.dispatch(
    {
      ...request,
      requestId: 2,
      session: { ...session, sourceVersion: "different" },
    },
    test.parent,
    "http://127.0.0.1:9000",
  );
  await Promise.resolve();
  expect(test.responses).toHaveLength(1);
  test.close();
});
