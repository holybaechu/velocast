import { afterEach, describe, expect, it, vi } from "vitest";
import { isServeUrlReady, withServeCommand } from "./serve-command.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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
});

describe("withServeCommand", () => {
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
