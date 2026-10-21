import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { Config } from "@velocast/core";

export interface ServeProcess {
  exited?: Promise<ServeProcessExit>;
  stop(): Promise<void> | void;
}

export interface ServeProcessExit {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
}

export interface ServeCommandDependencies {
  isUrlReady(url: string, signal?: AbortSignal): Promise<boolean>;
  now?: () => number;
  readyPollMs?: number;
  readyTimeoutMs?: number;
  sleep(ms: number): Promise<void>;
  spawnServeCommand(command: string): ServeProcess;
  signal?: AbortSignal;
}

const serveReadyTimeoutMs = 30_000;
const serveReadyPollMs = 100;
const serveReadyProbeTimeoutMs = 5_000;

const defaultServeCommandDependencies: ServeCommandDependencies = {
  isUrlReady: (url, signal) => isServeUrlReady(url, undefined, signal),
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  spawnServeCommand: spawnServeCommand,
};

export async function withServeCommand(
  serve: Config["serve"] | undefined,
  render: () => Promise<void>,
  overrides: Partial<ServeCommandDependencies> = {},
): Promise<void> {
  const dependencies = { ...defaultServeCommandDependencies, ...overrides };
  dependencies.signal?.throwIfAborted();
  if (
    !serve?.url ||
    !serve.command ||
    (await dependencies.isUrlReady(serve.url, dependencies.signal))
  ) {
    dependencies.signal?.throwIfAborted();
    await render();
    return;
  }

  dependencies.signal?.throwIfAborted();
  const process = dependencies.spawnServeCommand(serve.command);
  try {
    await waitForServeUrl(serve.url, serve.command, dependencies, process);
    dependencies.signal?.throwIfAborted();
    await render();
  } catch (primary) {
    const errors = [primary];
    try {
      await process.stop();
    } catch (secondary) {
      errors.push(secondary);
    }
    if (errors.length > 1) {
      const message = (error: unknown) =>
        error instanceof Error ? error.message : String(error);
      throw new AggregateError(
        errors,
        `${message(primary)}\nFailed to stop serve.command: ${message(errors[1])}`,
        { cause: primary },
      );
    }
    throw primary;
  }
  await process.stop();
}

async function waitForServeUrl(
  url: string,
  command: string,
  dependencies: ServeCommandDependencies,
  process: ServeProcess,
): Promise<void> {
  const readyTimeoutMs = dependencies.readyTimeoutMs ?? serveReadyTimeoutMs;
  const readyPollMs = dependencies.readyPollMs ?? serveReadyPollMs;
  const now = dependencies.now ?? Date.now;
  const deadline = now() + readyTimeoutMs;
  while (now() < deadline) {
    dependencies.signal?.throwIfAborted();
    await throwIfServeProcessExited(process, command, url, dependencies.signal);
    if (await isServeProcessUrlReady(process, command, url, dependencies)) {
      return;
    }
    await waitForNextServePoll(process, command, url, dependencies, readyPollMs);
  }

  dependencies.signal?.throwIfAborted();
  await throwIfServeProcessExited(process, command, url, dependencies.signal);
  throw new Error(`serve.url ${url} did not become ready`);
}

async function isServeProcessUrlReady(
  process: ServeProcess,
  command: string,
  url: string,
  dependencies: ServeCommandDependencies,
): Promise<boolean> {
  if (!process.exited) {
    return dependencies.isUrlReady(url, dependencies.signal);
  }

  const controller = new AbortController();
  const ready = dependencies.isUrlReady(
    url,
    dependencies.signal
      ? AbortSignal.any([controller.signal, dependencies.signal])
      : controller.signal,
  );
  try {
    return await Promise.race([
      ready,
      process.exited.then((exit) => {
        dependencies.signal?.throwIfAborted();
        throw serveProcessExitError(command, url, exit);
      }),
    ]);
  } finally {
    controller.abort();
    // Custom probes may ignore cancellation; join only the fetch we own.
    if (dependencies.isUrlReady === defaultServeCommandDependencies.isUrlReady)
      await ready.catch(() => {});
  }
}

async function waitForNextServePoll(
  process: ServeProcess,
  command: string,
  url: string,
  dependencies: ServeCommandDependencies,
  readyPollMs: number,
): Promise<void> {
  if (!process.exited) {
    await dependencies.sleep(readyPollMs);
    return;
  }

  const exit = await Promise.race([
    process.exited,
    dependencies.sleep(readyPollMs).then(() => undefined),
  ]);
  if (exit) {
    dependencies.signal?.throwIfAborted();
    throw serveProcessExitError(command, url, exit);
  }
}

async function throwIfServeProcessExited(
  process: ServeProcess,
  command: string,
  url: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!process.exited) {
    return;
  }

  const exit = await Promise.race([
    process.exited,
    Promise.resolve(undefined),
  ]);
  if (exit) {
    signal?.throwIfAborted();
    throw serveProcessExitError(command, url, exit);
  }
}

function serveProcessExitError(
  command: string,
  url: string,
  exit: ServeProcessExit,
): Error {
  if (exit.error) {
    return new Error(
      `serve.command failed before serve.url ${url} became ready: ${exit.error.message}`,
    );
  }

  const reason =
    exit.signal !== undefined && exit.signal !== null
      ? `signal ${exit.signal}`
      : `code ${exit.code ?? -1}`;
  return new Error(
    `serve.command exited before serve.url ${url} became ready (${reason}): ${command}`,
  );
}

export async function isServeUrlReady(
  url: string,
  timeoutMs = serveReadyProbeTimeoutMs,
  signal?: AbortSignal,
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, resolveServeReadyProbeTimeoutMs(timeoutMs));

  try {
    const response = await fetch(url, {
      method: "HEAD",
      signal: signal
        ? AbortSignal.any([controller.signal, signal])
        : controller.signal,
    });
    return response.ok || response.status < 500;
  } catch {
    signal?.throwIfAborted();
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function resolveServeReadyProbeTimeoutMs(value: number): number {
  return Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : serveReadyProbeTimeoutMs;
}

function spawnServeCommand(command: string): ServeProcess {
  const child = spawn(command, {
    shell: true,
    stdio: "inherit",
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  const exited = new Promise<ServeProcessExit>((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const defaultSignalExit = {
    SIGINT: process.listenerCount("SIGINT") === 0,
    SIGTERM: process.listenerCount("SIGTERM") === 0,
  };
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= stopServeProcess(child).finally(() => {
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onTerminate);
    });
    return stopping;
  };
  const forwardSignal = (signal: "SIGINT" | "SIGTERM") => {
    // Existing once handlers may have removed themselves before we run.
    const restoreDefault =
      defaultSignalExit[signal] && process.listenerCount(signal) === 1;
    void stop()
      .finally(() => {
        // Detached servers miss terminal signals. Finish their cleanup before
        // restoring default termination, while preserving application handlers.
        if (restoreDefault && process.listenerCount(signal) === 0)
          process.kill(process.pid, signal);
      })
      .catch(() => {
        // withServeCommand observes the same shutdown failure in finally.
      });
  };
  const onInterrupt = () => forwardSignal("SIGINT");
  const onTerminate = () => forwardSignal("SIGTERM");
  if (process.platform !== "win32") {
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
  }

  return {
    exited,
    stop,
  };
}

async function stopServeProcess(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  const pid = child.pid;
  let onExit: (() => void) | undefined;
  const exited =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          onExit = resolve;
          child.once("exit", onExit);
        });
  try {
    if (process.platform === "win32") {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve, reject) => {
        const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
          stdio: "ignore",
          windowsHide: true,
        });
        let failure: Error | undefined;
        killer.once("error", (error) => {
          failure = error;
        });
        killer.once("close", (code) => {
          if (
            child.exitCode !== null ||
            child.signalCode !== null ||
            (code === 0 && !failure)
          ) {
            resolve();
            return;
          }
          try {
            process.kill(pid, 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") {
              resolve();
              return;
            }
          }
          reject(
            new Error(
              `serve.command cleanup failed: taskkill for owned PID ${pid} ${failure ? `could not start (${failure.message})` : `exited with code ${code ?? -1}`}; stop the process tree manually before retrying`,
              { cause: failure },
            ),
          );
        });
      });
      await exited;
      return;
    }
    // The shell can exit before the actual server. Own and stop its whole group,
    // even when the group leader has already exited or accepted SIGTERM.
    if (signalServeProcessGroup(pid, "SIGTERM")) {
      const deadline = Date.now() + 1_000;
      while (signalServeProcessGroup(pid, 0)) {
        if (Date.now() >= deadline) {
          signalServeProcessGroup(pid, "SIGKILL");
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    await exited;
  } finally {
    if (onExit) child.removeListener("exit", onExit);
  }
}

function signalServeProcessGroup(
  pid: number,
  signal: NodeJS.Signals | 0,
): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
