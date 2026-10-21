import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));
import {
  terminateRendererProcess,
  type RendererProcess,
} from "./renderer-process.js";
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
it("accepts a missing owned PID when taskkill finishes before Node reports the renderer exit", async () => {
  Object.defineProperty(process, "platform", {
    value: "win32",
    configurable: true,
  });
  const child = Object.assign(new EventEmitter(), {
    pid: 456789,
    exitCode: null,
    signalCode: null,
  }) as RendererProcess;
  const killer = new EventEmitter();
  mocks.spawn.mockReturnValue(killer);
  const exists = vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("no such process"), { code: "ESRCH" });
  });
  const stopping = terminateRendererProcess(
    child,
    { cause: "abort", escalate: () => {} },
    1000,
  );
  const completed = expect(stopping).resolves.toBeUndefined();
  killer.emit("exit", 255, null);
  killer.emit("close", 255, null);
  await completed;
  expect(child.exitCode).toBeNull();
  expect(exists).toHaveBeenCalledWith(456789, 0);
  expect(mocks.spawn).toHaveBeenCalledWith(
    "taskkill",
    ["/pid", "456789", "/t", "/f"],
    { stdio: "ignore", windowsHide: true },
  );
});
it.each(["running", "permission-denied"])(
  "retains a real termination failure when the owned process is %s",
  async (status) => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });
    const child = Object.assign(new EventEmitter(), {
      pid: 456789,
      exitCode: null,
      signalCode: null,
    }) as RendererProcess;
    const killer = new EventEmitter();
    mocks.spawn.mockReturnValue(killer);
    const exists = vi.spyOn(process, "kill").mockImplementation(() => {
      if (status === "permission-denied")
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      return true;
    });
    const failed = expect(
      terminateRendererProcess(
        child,
        { cause: "abort", escalate: () => {} },
        1000,
      ),
    ).rejects.toThrow("taskkill exited with code 255");
    killer.emit("exit", 255, null);
    killer.emit("close", 255, null);
    await failed;
    expect(exists).toHaveBeenCalledExactlyOnceWith(456789, 0);
  },
);
it("waits for the tree-kill helper to close and skips probing after successful termination", async () => {
  Object.defineProperty(process, "platform", {
    value: "win32",
    configurable: true,
  });
  const child = Object.assign(new EventEmitter(), {
    pid: 456789,
    exitCode: null,
    signalCode: null,
  }) as RendererProcess;
  const killer = new EventEmitter();
  mocks.spawn.mockReturnValue(killer);
  const exists = vi.spyOn(process, "kill").mockReturnValue(true);
  let settled = false;
  const stopping = terminateRendererProcess(
    child,
    { cause: "abort", escalate: () => {} },
    1000,
  ).then(() => {
    settled = true;
  });
  killer.emit("exit", 0, null);
  await Promise.resolve();
  expect(settled).toBe(false);
  killer.emit("close", 0, null);
  await stopping;
  expect(exists).not.toHaveBeenCalled();
});
it("does not launch termination for an already observed renderer exit", async () => {
  Object.defineProperty(process, "platform", {
    value: "win32",
    configurable: true,
  });
  const child = Object.assign(new EventEmitter(), {
    pid: 456789,
    exitCode: 0,
    signalCode: null,
  }) as RendererProcess;
  await terminateRendererProcess(
    child,
    { cause: "abort", escalate: () => {} },
    1000,
  );
  expect(mocks.spawn).not.toHaveBeenCalled();
});
