import { afterEach, expect, it, vi } from "vitest";
import { BROWSER_PROTOCOL_VERSION } from "@velocast/core";
import { IframePreviewConnection } from "./iframe-transport.js";
import type { RpcRequest } from "./rpc-wire.js";

const available = [
  {
    id: "scene",
    width: 320,
    height: 180,
    fps: 30,
    durationFrames: 90,
    target: "#root",
  },
];

function fixture() {
  const listeners = new Set<(event: MessageEvent) => void>();
  const requests: RpcRequest[] = [];
  const target = {
    postMessage(request: RpcRequest) {
      requests.push(request);
      if (request.method === "destroy")
        queueMicrotask(() => respond(request, null));
    },
  };
  const host = {
    location: { origin: "http://127.0.0.1:9000" },
    addEventListener(_type: string, listener: (event: MessageEvent) => void) {
      listeners.add(listener);
    },
    removeEventListener(
      _type: string,
      listener: (event: MessageEvent) => void,
    ) {
      listeners.delete(listener);
    },
  };
  let attached = false;
  const iframe = Object.assign(new EventTarget(), {
    style: {},
    contentWindow: target,
    setAttribute() {},
    remove() {
      attached = false;
    },
  });
  const addListener = vi.spyOn(iframe, "addEventListener");
  const removeListener = vi.spyOn(iframe, "removeEventListener");
  const appendChild = vi.fn(() => {
    attached = true;
  });
  const container = {
    ownerDocument: { createElement: () => iframe },
    appendChild,
  };
  const connection = new IframePreviewConnection(
    {
      snapshotUrl: "http://127.0.0.1:9001/snapshot",
      session: { sessionId: "session", sourceVersion: "revision" },
    },
    {
      container: container as unknown as HTMLElement,
      hostWindow: host as unknown as Window,
      timeoutMs: 100,
      teardownTimeoutMs: 10,
      onCleanupWarning: () => {},
    },
  );
  function respond(request: RpcRequest, value: unknown) {
    for (const listener of listeners)
      listener({
        source: target,
        origin: "http://127.0.0.1:9001",
        data: { ...request, type: "response", ok: true, value },
      } as unknown as MessageEvent);
  }
  return {
    connection,
    iframe,
    listeners,
    requests,
    appendChild,
    addListener,
    removeListener,
    respond,
    attached: () => attached,
  };
}

afterEach(() => vi.useRealTimers());

it("shares discovery across concurrent connects and releases the single RPC listener", async () => {
  const f = fixture();
  const first = f.connection.connect();
  const second = f.connection.connect();
  let third: ReturnType<typeof f.connection.connect> | undefined;
  try {
    expect(f.appendChild).toHaveBeenCalledOnce();
    f.iframe.dispatchEvent(new Event("load"));
    await Promise.resolve();
    let settled = false;
    third = f.connection.connect().then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.method).toBe("connect");
    f.respond(f.requests[0]!, {
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      compositions: available,
    });
    const results = await Promise.all([first, second, third]);
    expect(results).toEqual([available, available, available]);
    expect(await f.connection.connect()).toEqual(available);
    expect(f.requests).toHaveLength(1);
    expect(f.listeners.size).toBe(1);
  } finally {
    await f.connection.dispose();
    await Promise.allSettled([first, second, third]);
  }
  expect(f.listeners.size).toBe(0);
  expect(f.attached()).toBe(false);
});

it.each(["dispose", "abort"])(
  "%s during iframe load cancels and joins shared discovery without leaving a timer",
  async (action) => {
    vi.useFakeTimers();
    const f = fixture();
    const controller = new AbortController();
    const requests = [
      f.connection.connect(),
      f.connection.connect(controller.signal),
    ];
    const settled = Promise.allSettled(requests);
    try {
      if (action === "dispose") await f.connection.dispose();
      else controller.abort();
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(0);
      for (const [type, listener] of f.addListener.mock.calls)
        expect(f.removeListener).toHaveBeenCalledWith(type, listener);
      expect(await settled).toEqual([
        {
          status: "rejected",
          reason: expect.objectContaining({ name: "AbortError" }),
        },
        {
          status: "rejected",
          reason: expect.objectContaining({ name: "AbortError" }),
        },
      ]);
      expect(f.attached()).toBe(false);
      expect(f.listeners.size).toBe(0);
      await expect(f.connection.connect()).rejects.toMatchObject({
        name: "AbortError",
      });
    } finally {
      await vi.runAllTimersAsync();
      await f.connection.dispose();
      await settled;
    }
  },
);
