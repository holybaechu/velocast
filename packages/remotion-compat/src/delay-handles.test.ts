import { afterEach, expect, it, vi } from "vitest";
import {
  cancelRender,
  continueRender,
  delayRender,
  waitForDelayHandles,
} from "./delay-handles.js";

const signal = () => new AbortController().signal;

afterEach(async () => {
  try {
    cancelRender(new Error("test cleanup"));
  } catch {
    // With no pending handles, cancellation is delivered to its caller.
  }
  await waitForDelayHandles(signal()).catch(() => {});
  vi.useRealTimers();
});

it("reports a module-level timeout to the first waiter without leaking it to later renders", async () => {
  vi.useFakeTimers();
  const handle = delayRender("module font", { timeoutInMilliseconds: 10 });
  vi.advanceTimersByTime(10);

  await expect(waitForDelayHandles(signal())).rejects.toThrow(
    "VELOCAST_REMOTION_DELAY_TIMEOUT: module font",
  );
  expect(() => continueRender(handle)).toThrow(
    "VELOCAST_REMOTION_DELAY_UNKNOWN",
  );
  await expect(waitForDelayHandles(signal())).resolves.toBeUndefined();
});

it("preserves cancellation before a waiter starts and rejects an active waiter", async () => {
  delayRender("module asset");
  const failure = new Error("asset preparation failed");
  cancelRender(failure);
  await expect(waitForDelayHandles(signal())).rejects.toBe(failure);

  delayRender("next render asset");
  const waiting = waitForDelayHandles(signal());
  const nextFailure = new Error("next asset failed");
  cancelRender(nextFailure);
  await expect(waiting).rejects.toBe(nextFailure);
  await expect(waitForDelayHandles(signal())).resolves.toBeUndefined();
});

it("joins handles created while the preceding batch settles", async () => {
  const first = delayRender("first asset");
  let settled = false;
  const waiting = waitForDelayHandles(signal()).then(() => {
    settled = true;
  });
  continueRender(first);
  const second = delayRender("dependent asset");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(settled).toBe(false);

  continueRender(second);
  await waiting;
  expect(settled).toBe(true);
});

it("leaves unobserved failures for a replacement waiter when a render aborts", async () => {
  vi.useFakeTimers();
  delayRender("abandoned asset", { timeoutInMilliseconds: 10 });
  const controller = new AbortController();
  const waiting = waitForDelayHandles(controller.signal);
  controller.abort(new Error("render replaced"));
  vi.advanceTimersByTime(10);
  await expect(waiting).rejects.toThrow("render replaced");
  await expect(waitForDelayHandles(signal())).rejects.toThrow(
    "VELOCAST_REMOTION_DELAY_TIMEOUT: abandoned asset",
  );
});
