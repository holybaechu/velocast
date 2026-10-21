import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isServeUrlReady, withServeCommand } from "./serve-command.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function createServeFixture() {
  const directory = mkdtempSync(join(tmpdir(), "velocast-serve-command-"));
  const script = join(directory, "server.cjs");
  const pidPath = join(directory, "server.pid");
  const heartbeatPath = join(directory, "heartbeat");
  writeFileSync(
    script,
    `const fs = require("node:fs");
process.on("SIGTERM", () => {});
fs.writeFileSync(process.argv[2], String(process.pid));
fs.writeFileSync(process.argv[3], ".");
setInterval(() => fs.appendFileSync(process.argv[3], "."), 10);
`,
  );
  const quote = (value: string) =>
    process.platform === "win32"
      ? `"${value}"`
      : `'${value.replaceAll("'", "'\\''")}'`;
  return {
    heartbeatPath,
    command: `${[process.execPath, script, pidPath, heartbeatPath].map(quote).join(" ")}${process.platform === "win32" ? "" : "; wait"}`,
    close() {
      if (existsSync(pidPath)) {
        try {
          process.kill(Number(readFileSync(pidPath, "utf8")), "SIGKILL");
        } catch {
          // Cleanup also runs when the server already exited.
        }
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe("isServeUrlReady", () => {
  it("treats non-5xx HEAD responses as ready", async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: false, status: 405 }) as Response,
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      isServeUrlReady("http://127.0.0.1:4545", 25),
    ).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4545",
      expect.objectContaining({
        method: "HEAD",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("returns false when the HEAD probe stalls past the probe timeout", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("probe aborted"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = isServeUrlReady("http://127.0.0.1:4545", 25);
    await vi.advanceTimersByTimeAsync(25);

    await expect(result).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts and joins an active HEAD probe when its caller cancels", async () => {
    const controller = new AbortController();
    const failure = new Error("render interrupted");
    vi.stubGlobal(
      "fetch",
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const ready = isServeUrlReady(
      "http://127.0.0.1:4545",
      5_000,
      controller.signal,
    );
    controller.abort(failure);
    await expect(ready).rejects.toBe(failure);
  });
});

describe("withServeCommand", () => {
  it("stops the owned server process tree before completing", async () => {
    const fixture = createServeFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: existsSync(fixture.heartbeatPath),
        status: existsSync(fixture.heartbeatPath) ? 200 : 503,
      })),
    );
    try {
      await withServeCommand(
        {
          command: fixture.command,
          url: "http://127.0.0.1:4545",
        },
        async () => {},
      );
      const heartbeat = readFileSync(fixture.heartbeatPath, "utf8");
      await delay(100);
      expect(readFileSync(fixture.heartbeatPath, "utf8")).toBe(heartbeat);
    } finally {
      fixture.close();
    }
  });

  it.skipIf(process.platform === "win32").each([false, true])(
    "cleans up on SIGINT and preserves an existing once handler: %s",
    async (existingHandler) => {
      const fixture = createServeFixture();
      const moduleUrl = new URL("./serve-command.ts", import.meta.url).href;
      const owner = spawn(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
import { withServeCommand } from ${JSON.stringify(moduleUrl)};
import { existsSync } from "node:fs";
const done = ${existingHandler ? 'new Promise(resolve => process.once("SIGINT", resolve))' : "new Promise(() => {})"};
globalThis.fetch = async () => {
  const ready = ${existingHandler} && existsSync(${JSON.stringify(fixture.heartbeatPath)});
  return { ok: ready, status: ready ? 200 : 503 };
};
await withServeCommand(${JSON.stringify({ command: fixture.command, url: "http://127.0.0.1:4545" })}, () => done).catch(() => {});
`,
        ],
        { stdio: "ignore" },
      );
      const exited = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve, reject) => {
        owner.once("error", reject);
        owner.once("close", (code, signal) => resolve({ code, signal }));
      });
      try {
        await vi.waitFor(() =>
          expect(existsSync(fixture.heartbeatPath)).toBe(true),
        );
        owner.kill("SIGINT");
        await expect(exited).resolves.toEqual(
          existingHandler
            ? { code: 0, signal: null }
            : { code: null, signal: "SIGINT" },
        );
        const heartbeat = readFileSync(fixture.heartbeatPath, "utf8");
        await delay(100);
        expect(readFileSync(fixture.heartbeatPath, "utf8")).toBe(heartbeat);
      } finally {
        owner.kill("SIGKILL");
        await exited;
        fixture.close();
      }
    },
  );

  it("starts the configured serve command before rendering when the URL is not ready", async () => {
    const events: string[] = [];
    let readinessChecks = 0;

    await withServeCommand(
      {
        command: "pnpm --filter playground dev",
        url: "http://127.0.0.1:4545",
      },
      async () => {
        events.push("render");
      },
      {
        isUrlReady: async () => {
          readinessChecks += 1;
          return readinessChecks > 1;
        },
        sleep: async () => undefined,
        spawnServeCommand: (command) => {
          events.push(`spawn:${command}`);
          return {
            stop: async () => {
              events.push("stop");
            },
          };
        },
      },
    );

    expect(events).toEqual([
      "spawn:pnpm --filter playground dev",
      "render",
      "stop",
    ]);
  });

  it("does not start the serve command when the URL is already ready", async () => {
    const events: string[] = [];

    await withServeCommand(
      {
        command: "pnpm --filter playground dev",
        url: "http://127.0.0.1:4545",
      },
      async () => {
        events.push("render");
      },
      {
        isUrlReady: async () => true,
        sleep: async () => undefined,
        spawnServeCommand: () => {
          throw new Error("serve command should not start");
        },
      },
    );

    expect(events).toEqual(["render"]);
  });

  it("stops the serve command when readiness times out", async () => {
    const events: string[] = [];
    let now = 0;

    await expect(
      withServeCommand(
        {
          command: "pnpm --filter playground dev",
          url: "http://127.0.0.1:4545",
        },
        async () => {
          events.push("render");
        },
        {
          isUrlReady: async () => false,
          now: () => now,
          readyPollMs: 25,
          readyTimeoutMs: 50,
          sleep: async (ms) => {
            events.push(`sleep:${ms}`);
            now += ms;
          },
          spawnServeCommand: (command) => {
            events.push(`spawn:${command}`);
            return {
              stop: async () => {
                events.push("stop");
              },
            };
          },
        },
      ),
    ).rejects.toThrow("serve.url http://127.0.0.1:4545 did not become ready");

    expect(events).toEqual([
      "spawn:pnpm --filter playground dev",
      "sleep:25",
      "sleep:25",
      "stop",
    ]);
  });

  it("stops the serve command when rendering fails after readiness", async () => {
    const events: string[] = [];
    let readinessChecks = 0;

    await expect(
      withServeCommand(
        {
          command: "pnpm --filter playground dev",
          url: "http://127.0.0.1:4545",
        },
        async () => {
          events.push("render");
          throw new Error("render failed");
        },
        {
          isUrlReady: async () => {
            readinessChecks += 1;
            return readinessChecks > 1;
          },
          sleep: async () => {
            events.push("sleep");
          },
          spawnServeCommand: (command) => {
            events.push(`spawn:${command}`);
            return {
              stop: async () => {
                events.push("stop");
              },
            };
          },
        },
      ),
    ).rejects.toThrow("render failed");

    expect(events).toEqual([
      "spawn:pnpm --filter playground dev",
      "render",
      "stop",
    ]);
  });

  it.each([
    ["readiness", new Error("readiness primary")],
    ["render", new Error("render primary")],
    ["render", undefined],
  ] as const)(
    "preserves %s failure %s when shutdown also fails",
    async (source, primary) => {
      const secondary = new Error("stop secondary");
      let readinessChecks = 0;
      const stop = vi.fn(async () => {
        throw secondary;
      });
      const result = withServeCommand(
        { command: "owned-server", url: "http://127.0.0.1:4545" },
        async () => {
          throw primary;
        },
        {
          isUrlReady: async () => {
            if (++readinessChecks === 1) return false;
            if (source === "readiness") throw primary;
            return true;
          },
          spawnServeCommand: () => ({ stop }),
        },
      );

      await expect(result).rejects.toMatchObject({
        message: `${primary?.message ?? "undefined"}\nFailed to stop serve.command: stop secondary`,
        cause: primary,
        errors: [primary, secondary],
      });
      expect(stop).toHaveBeenCalledTimes(1);
    },
  );

  it("fails early when the serve command exits before the URL is ready", async () => {
    const events: string[] = [];

    await expect(
      withServeCommand(
        {
          command: "pnpm --filter playground dev",
          url: "http://127.0.0.1:4545",
        },
        async () => {
          events.push("render");
        },
        {
          isUrlReady: async () => false,
          sleep: async () => {
            events.push("sleep");
          },
          spawnServeCommand: (command) => {
            events.push(`spawn:${command}`);
            return {
              exited: Promise.resolve({ code: 1, signal: null }),
              stop: async () => {
                events.push("stop");
              },
            };
          },
        },
      ),
    ).rejects.toThrow(
      "serve.command exited before serve.url http://127.0.0.1:4545 became ready (code 1): pnpm --filter playground dev",
    );

    expect(events).toEqual(["spawn:pnpm --filter playground dev", "stop"]);
  });

  it("fails early when the serve command exits during a slow readiness check", async () => {
    const events: string[] = [];
    let resolveReadinessStarted!: () => void;
    const readinessStarted = new Promise<void>((resolve) => {
      resolveReadinessStarted = resolve;
    });
    let readinessChecks = 0;
    let resolveExit!: (exit: { code: null; signal: NodeJS.Signals }) => void;
    const exited = new Promise<{ code: null; signal: NodeJS.Signals }>(
      (resolve) => {
        resolveExit = resolve;
      },
    );

    const result = withServeCommand(
      {
        command: "pnpm --filter playground dev",
        url: "http://127.0.0.1:4545",
      },
      async () => {
        events.push("render");
      },
      {
        isUrlReady: async () => {
          readinessChecks += 1;
          if (readinessChecks === 1) {
            return false;
          }
          events.push("ready");
          resolveReadinessStarted();
          return new Promise<boolean>(() => undefined);
        },
        sleep: async () => {
          events.push("sleep");
        },
        spawnServeCommand: (command) => {
          events.push(`spawn:${command}`);
          return {
            exited,
            stop: async () => {
              events.push("stop");
            },
          };
        },
      },
    );

    await readinessStarted;
    resolveExit({ code: null, signal: "SIGTERM" });

    await expect(result).rejects.toThrow(
      "serve.command exited before serve.url http://127.0.0.1:4545 became ready (signal SIGTERM): pnpm --filter playground dev",
    );
    expect(events).toEqual([
      "spawn:pnpm --filter playground dev",
      "ready",
      "stop",
    ]);
  });

  it.each(["exit", "abort"])(
    "joins an owned readiness probe before stopping after %s",
    async (failure) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const abortReason = new Error("caller cancelled readiness");
      const events: string[] = [];
      let startProbe!: () => void;
      const started = new Promise<void>((resolve) => {
        startProbe = resolve;
      });
      let finishProbe!: () => void;
      const probeCleanup = new Promise<void>((resolve) => {
        finishProbe = resolve;
      });
      let resolveExit!: (exit: { code: number }) => void;
      const exited = new Promise<{ code: number }>((resolve) => {
        resolveExit = resolve;
      });
      let readinessChecks = 0;
      let probeSignal: AbortSignal | undefined;
      let probe: Promise<Response> | undefined;
      vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
        if (++readinessChecks === 1)
          return Promise.resolve({ ok: false, status: 503 });
        probeSignal = init.signal!;
        startProbe();
        probe = new Promise<Response>((_resolve, reject) => {
          probeSignal!.addEventListener(
            "abort",
            () => reject(probeSignal!.reason),
            { once: true },
          );
        }).finally(async () => {
          await probeCleanup;
          events.push("probe released");
        });
        return probe;
      });
      const result = withServeCommand(
        { command: "owned-server", url: "http://127.0.0.1:4545" },
        async () => {
          events.push("render");
        },
        {
          signal: controller.signal,
          spawnServeCommand: () => ({
            exited,
            stop: () => {
              events.push("stop");
            },
          }),
        },
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

      await started;
      if (failure === "exit") resolveExit({ code: 1 });
      else controller.abort(abortReason);
      await vi.advanceTimersByTimeAsync(0);
      const abortedBeforeRelease = probeSignal?.aborted;
      const pendingBeforeRelease = !settled;
      finishProbe();

      try {
        if (failure === "exit")
          await expect(result).rejects.toThrow(
            "serve.command exited before serve.url http://127.0.0.1:4545 became ready (code 1): owned-server",
          );
        else await expect(result).rejects.toBe(abortReason);
        expect(abortedBeforeRelease).toBe(true);
        expect(pendingBeforeRelease).toBe(true);
        expect(events).toEqual(["probe released", "stop"]);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        controller.abort();
        finishProbe();
        await probe?.catch(() => {});
      }
    },
  );

  it("surfaces serve command spawn errors before the readiness timeout", async () => {
    const events: string[] = [];

    await expect(
      withServeCommand(
        {
          command: "missing-dev-server",
          url: "http://127.0.0.1:4545",
        },
        async () => {
          events.push("render");
        },
        {
          isUrlReady: async () => false,
          sleep: async () => {
            events.push("sleep");
          },
          spawnServeCommand: (command) => {
            events.push(`spawn:${command}`);
            return {
              exited: Promise.resolve({
                error: new Error("spawn missing-dev-server ENOENT"),
              }),
              stop: async () => {
                events.push("stop");
              },
            };
          },
        },
      ),
    ).rejects.toThrow(
      "serve.command failed before serve.url http://127.0.0.1:4545 became ready: spawn missing-dev-server ENOENT",
    );

    expect(events).toEqual(["spawn:missing-dev-server", "stop"]);
  });
});
