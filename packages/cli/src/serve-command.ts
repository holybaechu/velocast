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
  isUrlReady(url: string): Promise<boolean>;
  now?: () => number;
  readyPollMs?: number;
  readyTimeoutMs?: number;
  sleep(ms: number): Promise<void>;
  spawnServeCommand(command: string): ServeProcess;
}

const serveReadyTimeoutMs = 30_000;
const serveReadyPollMs = 100;
const serveReadyProbeTimeoutMs = 5_000;

const defaultServeCommandDependencies: ServeCommandDependencies = {
  isUrlReady: isServeUrlReady,
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  spawnServeCommand: spawnServeCommand,
};

export async function withServeCommand(
  serve: Config["serve"] | undefined,
  render: () => Promise<void>,
  dependencies: ServeCommandDependencies = defaultServeCommandDependencies,
): Promise<void> {
  if (
    !serve?.url ||
    !serve.command ||
    (await dependencies.isUrlReady(serve.url))
  ) {
    await render();
    return;
  }

  const process = dependencies.spawnServeCommand(serve.command);
  try {
    await waitForServeUrl(serve.url, serve.command, dependencies, process);
    await render();
  } finally {
    await process.stop();
  }
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
    await throwIfServeProcessExited(process, command, url);
    if (await isServeProcessUrlReady(process, command, url, dependencies)) {
      return;
    }
    await waitForNextServePoll(process, command, url, dependencies, readyPollMs);
  }

  await throwIfServeProcessExited(process, command, url);
  throw new Error(`serve.url ${url} did not become ready`);
}

async function isServeProcessUrlReady(
  process: ServeProcess,
  command: string,
  url: string,
  dependencies: ServeCommandDependencies,
): Promise<boolean> {
  const ready = dependencies.isUrlReady(url);
  if (!process.exited) {
    return ready;
  }

  const result = await Promise.race([
    ready,
    process.exited.then((exit) => {
      throw serveProcessExitError(command, url, exit);
    }),
  ]);
  return result;
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
    throw serveProcessExitError(command, url, exit);
  }
}

async function throwIfServeProcessExited(
  process: ServeProcess,
  command: string,
  url: string,
): Promise<void> {
  if (!process.exited) {
    return;
  }

  const exit = await Promise.race([
    process.exited,
    Promise.resolve(undefined),
  ]);
  if (exit) {
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
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, resolveServeReadyProbeTimeoutMs(timeoutMs));

  try {
    const response = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
    });
    return response.ok || response.status < 500;
  } catch {
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
  });
  const exited = new Promise<ServeProcessExit>((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  return {
    exited,
    async stop() {
      await stopServeProcess(child);
    },
  };
}

async function stopServeProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.killed) {
    return;
  }

  if (process.platform === "win32" && child.pid !== undefined) {
    await new Promise<void>((resolve) => {
      const killer = spawn(
        "taskkill",
        ["/pid", String(child.pid), "/t", "/f"],
        {
          stdio: "ignore",
          windowsHide: true,
        },
      );
      killer.once("exit", () => resolve());
      killer.once("error", () => {
        child.kill();
        resolve();
      });
    });
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 1_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill();
  });
}
