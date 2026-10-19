import { ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));
import {
  browserApplicationPaths,
  launchCdpBrowser,
  stopBrowser,
} from "./browser-cdp.js";
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
it("tolerates an absent process group after cooperative browser shutdown", async () => {
  vi.useFakeTimers();
  const child = new ChildProcess();
  Object.assign(child, { pid: 456789, exitCode: null, signalCode: null });
  child.kill = vi.fn();
  const kill = vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("no such process"), { code: "ESRCH" });
  });
  const stopping = stopBrowser(child, async () => {
    setTimeout(() => {
      Object.assign(child, { exitCode: 0 });
      child.emit("close", 0, null);
    }, 100);
  });
  await vi.advanceTimersByTimeAsync(100);
  await stopping;
  expect(mocks.spawn).not.toHaveBeenCalled();
  if (process.platform === "win32") expect(kill).not.toHaveBeenCalled();
  else expect(kill).toHaveBeenCalledExactlyOnceWith(-456789, "SIGKILL");
  expect(vi.getTimerCount()).toBe(0);
});
it("surfaces an actual owned-tree termination failure", async () => {
  vi.useFakeTimers();
  const child = new ChildProcess();
  Object.assign(child, { pid: 456789, exitCode: null, signalCode: null });
  child.kill = vi.fn(() => true);
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
  expect(child.kill).not.toHaveBeenCalled();
});

it.skipIf(process.platform === "win32").each(["before", "during"])(
  "terminates owned descendants when the browser leader exits %s shutdown",
  async (phase) => {
    const { spawn } =
      await vi.importActual<typeof import("node:child_process")>(
        "node:child_process",
      );
    const root = await mkdtemp(join(tmpdir(), "velocast-browser-orphan-"));
    const heartbeat = join(root, "heartbeat");
    const descendant = `
const fs = require("node:fs");
const write = () => fs.appendFileSync(process.argv[1], "x");
write();
process.send("ready");
setInterval(write, 20);
`;
    const leader = `
const child = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}, process.argv[1]], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
process.once("SIGTERM", () => process.exit(0));
child.once("message", () => {
  process.send("ready");
  if (${JSON.stringify(phase)} === "before") process.exit(0);
});
`;
    const child = spawn(process.execPath, ["-e", leader, heartbeat], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const closed = once(child, "close");
    try {
      await once(child, "message");
      if (phase === "before") await closed;
      await stopBrowser(child, async () => {
        child.kill("SIGTERM");
      });
      await closed;
      const stopped = (await readFile(heartbeat)).length;
      expect(stopped).toBeGreaterThan(0);
      await delay(120);
      expect((await readFile(heartbeat)).length).toBe(stopped);
    } finally {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch (error) {
        expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
      }
      await closed;
      expect(dirname(resolve(root))).toBe(resolve(tmpdir()));
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32").each(["headers", "body"])(
  "times out stalled target discovery %s and reaps the owned browser/profile",
  async (phase) => {
    const { spawn } =
      await vi.importActual<typeof import("node:child_process")>(
        "node:child_process",
      );
    mocks.spawn.mockImplementation(spawn);
    const root = await mkdtemp(join(tmpdir(), "velocast-browser-discovery-"));
    const executable = join(root, "browser");
    const record = join(root, "browser.json");
    await writeFile(
      executable,
      `#!${process.execPath}
const fs = require("node:fs");
const { createServer } = require("node:http");
const profile = process.argv.find(arg => arg.startsWith("--user-data-dir=")).slice("--user-data-dir=".length);
const server = createServer((_request, response) => {
  if (${JSON.stringify(phase)} === "body") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write("[");
  }
});
server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ pid: process.pid, profile }));
  fs.writeFileSync(profile + "/DevToolsActivePort", String(server.address().port) + "\\n");
});
`,
    );
    await chmod(executable, 0o700);
    const launch = launchCdpBrowser("about:blank", {
      executable,
      timeoutMs: 500,
    });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const error = await Promise.race([
        launch.catch((failure: unknown) => failure),
        new Promise<Error>((resolve) => {
          watchdog = setTimeout(
            () => resolve(new Error("discovery deadline was not enforced")),
            2000,
          );
        }),
      ]);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "audit.browser_target_timeout: DevTools target discovery timed out",
      );
      const owned = JSON.parse(await readFile(record, "utf8"));
      expect(() => process.kill(owned.pid, 0)).toThrow();
      await expect(access(owned.profile)).rejects.toThrow();
    } finally {
      clearTimeout(watchdog);
      try {
        const owned = JSON.parse(await readFile(record, "utf8"));
        process.kill(-owned.pid, "SIGKILL");
      } catch {
        // The owned browser may already have been reaped by startup cleanup.
      }
      await launch.catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  },
);

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
