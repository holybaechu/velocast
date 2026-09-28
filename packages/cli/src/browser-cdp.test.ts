import { ChildProcess } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));
import { browserApplicationPaths, stopBrowser } from "./browser-cdp.js";
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
it("joins delayed owned process termination instead of failing after the graceful deadline", async () => {
  vi.useFakeTimers();
  const child = new ChildProcess();
  Object.assign(child, { pid: 456789, exitCode: null, signalCode: null });
  let requested = false;
  const terminate = () => {
    if (requested) return;
    requested = true;
    setTimeout(() => {
      Object.assign(child, { exitCode: 0 });
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    }, 4500);
  };
  child.kill = vi.fn(() => {
    terminate();
    return true;
  });
  vi.spyOn(process, "kill").mockImplementation(() => {
    terminate();
    return true;
  });
  mocks.spawn.mockImplementation(() => {
    const killer = new ChildProcess();
    terminate();
    setTimeout(() => {
      Object.assign(killer, { exitCode: 0 });
      killer.emit("close", 0, null);
    }, 0);
    return killer;
  });
  let settled = false;
  const result = stopBrowser(child).then(
    () => {
      settled = true;
      return "joined";
    },
    (error) => {
      settled = true;
      return error;
    },
  );
  await vi.advanceTimersByTimeAsync(3500);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(5000);
  expect(await result).toBe("joined");
});
it("bounds cooperative CDP shutdown before forcing only the owned process tree", async () => {
  vi.useFakeTimers();
  const child = new ChildProcess();
  Object.assign(child, { pid: 456789, exitCode: null, signalCode: null });
  const finish = () => {
    Object.assign(child, { exitCode: 0 });
    child.emit("close", 0, null);
  };
  child.kill = vi.fn(() => {
    setTimeout(finish, 4000);
    return true;
  });
  const groupKill = vi.spyOn(process, "kill").mockImplementation(() => {
    setTimeout(finish, 4000);
    return true;
  });
  mocks.spawn.mockImplementation(() => {
    const killer = new ChildProcess();
    setTimeout(() => {
      killer.emit("close", 0, null);
    }, 0);
    setTimeout(finish, 4000);
    return killer;
  });
  const graceful = vi.fn(() => new Promise<void>(() => {}));
  const stopping = stopBrowser(child, graceful);
  await vi.advanceTimersByTimeAsync(1999);
  expect(graceful).toHaveBeenCalledOnce();
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(groupKill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5000);
  await stopping;
  if (process.platform === "win32")
    expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(
      "taskkill.exe",
      ["/pid", "456789", "/t", "/f"],
      { stdio: "ignore", windowsHide: true },
    );
  else expect(groupKill).toHaveBeenCalledExactlyOnceWith(-456789, "SIGKILL");
});
it("does not force a browser that exits during cooperative shutdown", async () => {
  vi.useFakeTimers();
  const child = new ChildProcess();
  Object.assign(child, { pid: 456789, exitCode: null, signalCode: null });
  child.kill = vi.fn();
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  const stopping = stopBrowser(child, async () => {
    setTimeout(() => {
      Object.assign(child, { exitCode: 0 });
      child.emit("close", 0, null);
    }, 100);
  });
  await vi.advanceTimersByTimeAsync(100);
  await stopping;
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(kill).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it("surfaces an actual owned-tree termination failure", async () => {
  vi.useFakeTimers();
  const child = new ChildProcess();
  Object.assign(child, { pid: 456789, exitCode: null, signalCode: null });
  child.kill = vi.fn(() => false);
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("permission denied"), { code: "EPERM" });
  });
  mocks.spawn.mockImplementation(() => {
    const killer = new ChildProcess();
    setTimeout(() => killer.emit("close", 5, null), 0);
    return killer;
  });
  const failed = expect(stopBrowser(child)).rejects.toThrow(
    "audit.browser_termination_failed",
  );
  await vi.runAllTimersAsync();
  await failed;
});

it("discovers standard macOS system and user application bundles", () => {
  expect(browserApplicationPaths("darwin", "/Users/artist")).toEqual([
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Users/artist/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Users/artist/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Users/artist/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ]);
  expect(browserApplicationPaths("linux", "/home/artist")).toEqual([]);
  expect(browserApplicationPaths("win32", "C:/Users/artist")).toContain(
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  );
});
