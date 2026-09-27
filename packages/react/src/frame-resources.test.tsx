import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRef } from "react";
import { clearFrameAdaptersForTest } from "@velocast/core/testing";
import * as authoring from "./index.js";

const config = { width: 320, height: 180, fps: 30, durationFrames: 30 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  clearFrameAdaptersForTest();
  document.body.innerHTML = "";
  window.__velocast = undefined;
});
afterEach(async () => {
  await window.__velocast?.destroy();
  clearFrameAdaptersForTest();
  document.body.innerHTML = "";
});

it("exposes an awaited frame-resource hook for imperative media preparation", () => {
  expect(
    "useFrameResource" in authoring && typeof authoring.useFrameResource,
  ).toBe("function");
});

it("awaits actual resource paint and reruns on repeated frames with new props", async () => {
  const decoded = deferred<void>();
  let started = 0;
  function Scene({ label }: { label: string }) {
    const element = useRef<HTMLDivElement>(null);
    const frame = authoring.useCurrentFrame();
    authoring.useFrameResource(async (signal) => {
      started++;
      await decoded.promise;
      signal.throwIfAborted();
      element.current!.textContent = `${label}:${frame}`;
    });
    return <div ref={element}>pending</div>;
  }
  const protocol = authoring.registerReactComposition("scene", {
    ...config,
    component: Scene,
    defaultProps: { label: "first" },
  });
  let ready = false;
  const pending = protocol.seekFrame("scene", 12).then(() => {
    ready = true;
  });
  await vi.waitFor(() => expect(started).toBe(1));
  expect(ready).toBe(false);
  expect(document.body.textContent).toBe("pending");
  decoded.resolve();
  await pending;
  expect(document.body.textContent).toBe("first:12");
  await protocol.setInputProps({ label: "second" });
  await protocol.seekFrame("scene", 12);
  expect(started).toBe(2);
  expect(document.body.textContent).toBe("second:12");
});

it("starts independent resource loads together, cancels siblings on failure and joins before rejection", async () => {
  const first = deferred<void>(),
    second = deferred<void>();
  const signals: AbortSignal[] = [];
  function Scene() {
    authoring.useFrameResource(async (signal) => {
      signals.push(signal);
      await first.promise;
    });
    authoring.useFrameResource(async (signal) => {
      signals.push(signal);
      await second.promise;
    });
    return <div>mounted until jobs join</div>;
  }
  const protocol = authoring.registerReactComposition("scene", {
    ...config,
    component: Scene,
  });
  let failed = false;
  const pending = protocol.seekFrame("scene", 0);
  const observed = pending.catch((error) => {
    failed = true;
    return error;
  });
  await vi.waitFor(() => expect(signals).toHaveLength(2));
  first.reject(new Error("decoder failed"));
  await vi.waitFor(() => expect(signals[1]!.aborted).toBe(true));
  expect(failed).toBe(false);
  second.resolve();
  expect((await observed).message).toContain("decoder failed");
  await expect(protocol.seekFrame("scene", 1)).rejects.toThrow(
    "destroy before retrying a failed composition",
  );
});

it("cancels capture promptly but waits for outstanding resource work before unmount", async () => {
  const decoded = deferred<void>();
  let signal: AbortSignal | undefined;
  let paints = 0;
  function Scene() {
    authoring.useFrameResource(async (active) => {
      signal = active;
      await decoded.promise;
      active.throwIfAborted();
      paints++;
    });
    return <div>owned root</div>;
  }
  const protocol = authoring.registerReactComposition("scene", {
    ...config,
    component: Scene,
  });
  const pending = protocol.seekFrame("scene", 0);
  await vi.waitFor(() => expect(signal).toBeDefined());
  protocol.cancelPending();
  await expect(pending).rejects.toThrow("VELOCAST_REQUEST_CANCELLED");
  let closed = false;
  const cleanup = protocol.destroy().then(() => {
    closed = true;
  });
  expect(closed).toBe(false);
  expect(document.body.textContent).toBe("owned root");
  decoded.resolve();
  await cleanup;
  expect(paints).toBe(0);
  expect(document.body.children).toHaveLength(0);
});
