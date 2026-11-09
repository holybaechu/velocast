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
      expect(process.kill).not.toHaveBeenCalled();
      expect(run.child.kill).not.toHaveBeenCalled();
    } finally {
      await run.finish();
    }
  },
);

// A missing/exited root does not prove its descendants stopped (native controlled red).
it.each(["missing-pid", "observed-exit", "launch-error-after-exit"])(
  "rejects a failed tree helper despite %s",
  async (status) => {
    const run = startServe();
    try {
      await flushMicrotasks();
      const launchError = new Error("taskkill unavailable");
      if (status === "missing-pid")
        vi.mocked(process.kill).mockImplementation(() => {
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        });
      else run.exit();
      if (status === "launch-error-after-exit")
        run.killer.emit("error", launchError);
      run.killer.emit("exit", 255, null);
      await flushMicrotasks();
      expect(run.settled()).toBe(false);
      run.killer.emit("close", 255, null);
      await expect(run.result).rejects.toMatchObject({
        message: expect.stringMatching(
          /cleanup failed: taskkill.*owned PID 456789/,
        ),
        ...(status === "launch-error-after-exit" ? { cause: launchError } : {}),
      });
      expect(process.kill).not.toHaveBeenCalled();
      expect(run.child.listenerCount("exit")).toBe(
        status === "missing-pid" ? 1 : 0,
      );
    } finally {
      await run.finish();
    }
  },
);

it("preserves a natural exit before shutdown without starting a tree helper", async () => {
  const run = startServe(false, async () => run.exit());
  try {
    await run.result;
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(process.kill).not.toHaveBeenCalled();
  } finally {
    await run.finish();
  }
});

it("preserves the render error and failed tree cleanup after the root exits", async () => {
  const primary = new Error("render failed");
  const run = startServe(false, async () => {
    throw primary;
  });
  try {
    await flushMicrotasks();
    run.exit();
    run.killer.emit("close", 1, null);
    await expect(run.result).rejects.toMatchObject({
      cause: primary,
      errors: [
        primary,
        expect.objectContaining({
          message: expect.stringContaining("cleanup failed: taskkill"),
        }),
      ],
    });
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  } finally {
    await run.finish();
  }
});

function startServe(
  killed = false,
  render: () => Promise<void> = async () => {},
) {
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
    render,
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
