import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));
import { withServeCommand } from "./serve-command.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => {
  Object.defineProperty(process, "platform", {
    value: "win32",
    configurable: true,
  });
  vi.spyOn(process, "kill").mockReturnValue(true);
});
afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  vi.restoreAllMocks();
  mocks.spawn.mockReset();
});

it.each([false, true])(
  "joins the tree helper and owned exit after signal sent=%s",
  async (killed) => {
    const run = startServe(killed);
    try {
      await flushMicrotasks();
      expect(mocks.spawn).toHaveBeenCalledWith(
        "taskkill",
        ["/pid", "456789", "/t", "/f"],
        {
          stdio: "ignore",
          windowsHide: true,
        },
      );
      run.killer.emit("exit", 0, null);
      await flushMicrotasks();
      expect(run.settled()).toBe(false);
      run.killer.emit("close", 0, null);
      await flushMicrotasks();
      expect(run.settled()).toBe(false);
      run.exit();
      await run.result;
      expect(run.child.listenerCount("exit")).toBe(0);
      expect(process.kill).not.toHaveBeenCalled();
    } finally {
      await run.finish();
    }
  },
);

it.each(["running", "permission-denied", "launch-error"])(
  "reports failed tree termination while owned PID is %s",
  async (status) => {
    const launchError = new Error("taskkill unavailable");
    if (status === "permission-denied")
      vi.mocked(process.kill).mockImplementation(() => {
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      });
    const run = startServe();
    try {
      await flushMicrotasks();
      if (status === "launch-error") run.killer.emit("error", launchError);
      run.killer.emit("exit", 255, null);
      await flushMicrotasks();
      const pendingBeforeClose = !run.settled();
      run.killer.emit("close", 255, null);
      await expect(run.result).rejects.toMatchObject({
        message: expect.stringMatching(
          /taskkill.*owned PID 456789.*stop the process tree/i,
        ),
        ...(status === "launch-error" ? { cause: launchError } : {}),
      });
      expect(pendingBeforeClose).toBe(true);
      expect(process.kill).toHaveBeenCalledWith(456789, 0);
      expect(run.child.kill).not.toHaveBeenCalled();
    } finally {
      await run.finish();
    }
  },
);

it.each(["missing-pid", "observed-exit"])(
  "accepts a failed helper after %s and joins the owned exit",
  async (status) => {
    const run = startServe();
    try {
      await flushMicrotasks();
      if (status === "observed-exit") run.exit();
      else
        vi.mocked(process.kill).mockImplementation(() => {
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        });
      run.killer.emit("exit", 255, null);
      run.killer.emit("close", 255, null);
      await flushMicrotasks();
      if (status === "missing-pid") {
        expect(run.settled()).toBe(false);
        expect(process.kill).toHaveBeenCalledWith(456789, 0);
        run.exit();
      } else expect(process.kill).not.toHaveBeenCalled();
      await run.result;
    } finally {
      await run.finish();
    }
  },
);

function startServe(killed = false) {
  const child = Object.assign(new EventEmitter(), {
    pid: 456789,
    exitCode: null as number | null,
    signalCode: null,
    killed,
    kill: vi.fn(() => true),
  });
  const killer = new EventEmitter();
  mocks.spawn.mockReturnValueOnce(child).mockReturnValueOnce(killer);
  let requests = 0;
  const result = withServeCommand(
    { command: "owned-server", url: "http://127.0.0.1:4545" },
    async () => {},
    { isUrlReady: async () => ++requests > 1 },
  );
  let settled = false;
  void result.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const exit = () => {
    child.exitCode = 0;
    child.emit("exit", 0, null);
  };
  return {
    child,
    killer,
    result,
    exit,
    settled: () => settled,
    async finish() {
      killer.emit("close", 0, null);
      exit();
      await result.catch(() => {});
    },
  };
}

async function flushMicrotasks() {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
}
