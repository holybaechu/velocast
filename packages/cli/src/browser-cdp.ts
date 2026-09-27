import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

export interface BrowserCdpOptions {
  executable?: string;
  headless?: boolean;
  timeoutMs?: number;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export interface CdpBrowser {
  executable: string;
  call<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
  evaluate<T>(expression: string): Promise<T>;
  close(): Promise<void>;
}

const WINDOWS_BROWSERS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

export function resolveAuditBrowser(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = explicit ?? env.VELOCAST_BROWSER_BINARY ?? env.CHROME_PATH;
  if (configured) {
    if (!existsSync(configured))
      throw new Error(`audit.browser_not_found: ${configured}`);
    return configured;
  }
  if (process.platform === "win32") {
    const found = WINDOWS_BROWSERS.find(existsSync);
    if (found) return found;
  }
  for (const candidate of ["google-chrome", "chromium", "chromium-browser"])
    if (commandOnPath(candidate, env)) return candidate;
  throw new Error(
    "audit.browser_not_found: install Chrome/Edge or set VELOCAST_BROWSER_BINARY",
  );
}

function commandOnPath(command: string, env: NodeJS.ProcessEnv): boolean {
  const path = env.PATH ?? "";
  const separator = process.platform === "win32" ? ";" : ":";
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  return path
    .split(separator)
    .filter(Boolean)
    .some((directory) =>
      extensions.some((extension) =>
        existsSync(join(directory, `${command}${extension}`)),
      ),
    );
}

async function waitForEndpoint(
  profile: string,
  child: ChildProcess,
  timeoutMs: number,
  getSpawnFailure: () => Error | undefined,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const spawnFailure = getSpawnFailure();
    if (spawnFailure) throw spawnFailure;
    if (child.exitCode !== null)
      throw new Error(
        `audit.browser_exited: browser exited with code ${child.exitCode}`,
      );
    try {
      const [port] = (
        await readFile(join(profile, "DevToolsActivePort"), "utf8")
      )
        .trim()
        .split(/\r?\n/);
      if (/^\d+$/.test(port ?? "")) return `http://127.0.0.1:${port}`;
    } catch {
      // Chrome writes this file only after DevTools is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("audit.browser_timeout: DevTools did not become ready");
}

function ownedProfile(path: string): void {
  const parent = resolve(tmpdir());
  const target = resolve(path);
  const childPath = relative(parent, target);
  if (
    dirname(target) !== parent ||
    !childPath.startsWith("velocast-audit-browser-") ||
    childPath.includes("..")
  )
    throw new Error(`audit.browser_cleanup_scope: ${target}`);
}

async function removeProfile(path: string): Promise<void> {
  ownedProfile(path);
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw new Error(`audit.browser_cleanup_failed: ${path}`, {
    cause: lastError,
  });
}

async function stopBrowser(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolveClose) =>
    child.once("close", () => resolveClose()),
  );
  child.kill();
  const graceful = await Promise.race([
    closed.then(() => true),
    new Promise<false>((resolveTimeout) =>
      setTimeout(() => resolveTimeout(false), 1_000),
    ),
  ]);
  if (!graceful) {
    child.kill("SIGKILL");
    await Promise.race([
      closed,
      new Promise<void>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error("audit.browser_close_timeout: browser did not exit"),
            ),
          2_000,
        ),
      ),
    ]);
  }
}

export async function launchCdpBrowser(
  url: string,
  options: BrowserCdpOptions = {},
): Promise<CdpBrowser> {
  const executable = resolveAuditBrowser(options.executable);
  const profile = await mkdtemp(join(tmpdir(), "velocast-audit-browser-"));
  const arguments_ = [
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    url,
  ];
  if (options.headless !== false) arguments_.unshift("--headless=new");
  const child = spawn(executable, arguments_, {
    stdio: "ignore",
    windowsHide: true,
  });
  let spawnFailure: Error | undefined;
  child.once("error", (error) => {
    spawnFailure = new Error(`audit.browser_spawn_failed: ${error.message}`, {
      cause: error,
    });
  });
  let socket: WebSocket | undefined;
  try {
    const endpoint = await waitForEndpoint(
      profile,
      child,
      options.timeoutMs ?? 15_000,
      () => spawnFailure,
    );
    const targets = (await (
      await fetch(`${endpoint}/json/list`)
    ).json()) as Array<{
      type: string;
      webSocketDebuggerUrl: string;
    }>;
    const target = targets.find((item) => item.type === "page");
    if (!target)
      throw new Error("audit.browser_target_missing: no page target");
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolveOpen, reject) => {
      const timeout = setTimeout(
        () =>
          reject(
            new Error(
              "audit.browser_socket_timeout: DevTools socket did not open",
            ),
          ),
        options.timeoutMs ?? 15_000,
      );
      socket!.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          resolveOpen();
        },
        { once: true },
      );
      socket!.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          reject(new Error("audit.browser_socket_failed"));
        },
        { once: true },
      );
    });
    let requestId = 0;
    const pending = new Map<number, PendingRequest>();
    const rejectPending = (error: Error) => {
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    };
    socket.addEventListener("close", () =>
      rejectPending(
        new Error("audit.browser_socket_closed: DevTools connection closed"),
      ),
    );
    socket.addEventListener("error", () =>
      rejectPending(
        new Error("audit.browser_socket_failed: DevTools connection failed"),
      ),
    );
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        error?: { message?: string };
        result?: unknown;
      };
      if (message.id === undefined) return;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error)
        request.reject(
          new Error(message.error.message ?? "CDP request failed"),
        );
      else request.resolve(message.result);
    });
    const call = <T>(method: string, params: Record<string, unknown> = {}) =>
      new Promise<T>((resolve, reject) => {
        const id = ++requestId;
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`audit.browser_request_timeout: ${method}`));
        }, options.timeoutMs ?? 15_000);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timeout);
            resolve(value as T);
          },
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        });
        socket!.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async <T>(expression: string): Promise<T> => {
      const response = await call<{
        exceptionDetails?: {
          text?: string;
          exception?: { description?: string };
        };
        result: { value?: T };
      }>("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (response.exceptionDetails)
        throw new Error(
          `audit.page_error: ${(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "evaluation failed").replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g, "[audit-runtime]").slice(0, 16384)}`,
        );
      return response.result.value as T;
    };
    await call("Runtime.enable");
    await call("Page.enable");
    let closed = false;
    return {
      executable,
      call,
      evaluate,
      async close() {
        if (closed) return;
        closed = true;
        socket?.close();
        rejectPending(new Error("audit.browser_closed: browser was closed"));
        await stopBrowser(child);
        await removeProfile(profile);
      },
    };
  } catch (error) {
    socket?.close();
    await stopBrowser(child).catch(() => {});
    await removeProfile(profile);
    throw error;
  }
}
