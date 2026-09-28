import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve } from "node:path";

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

/** Standard application bundles; explicit browser settings always take precedence. */
export function browserApplicationPaths(
  platform: NodeJS.Platform,
  home: string,
): string[] {
  if (platform === "win32") return [...WINDOWS_BROWSERS];
  if (platform !== "darwin") return [];
  return ["/Applications", posix.join(home, "Applications")].flatMap((root) => [
    posix.join(root, "Google Chrome.app/Contents/MacOS/Google Chrome"),
    posix.join(root, "Chromium.app/Contents/MacOS/Chromium"),
    posix.join(root, "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
  ]);
}

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
  const application = browserApplicationPaths(process.platform, homedir()).find(
    existsSync,
  );
  if (application) return application;
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

/** Stop only the process tree created by this launch, then join Node's close event. */
export async function stopBrowser(
  child: ChildProcess,
  gracefulShutdown?: () => Promise<unknown>,
): Promise<void> {
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  if (exited()) return;
  let onClose!: () => void;
  const closed = new Promise<void>((resolveClose) => {
    onClose = resolveClose;
    child.once("close", onClose);
  });
  try {
    if (gracefulShutdown) {
      // A CDP acknowledgement does not mean Chrome has finished shutdown. Keep
      // watching the process, and bound only this cooperative phase.
      void Promise.resolve()
        .then(gracefulShutdown)
        .catch(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          closed,
          new Promise<void>((done) => {
            timer = setTimeout(done, 2_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    if (!exited() && child.pid !== undefined) {
      if (process.platform === "win32") {
        await new Promise<void>((done, reject) => {
          const killer = spawn(
            "taskkill.exe",
            ["/pid", String(child.pid), "/t", "/f"],
            { stdio: "ignore", windowsHide: true },
          );
          let failure: Error | undefined;
          killer.once("error", (error) => {
            failure = error;
          });
          killer.once("close", (code) => {
            if (exited() || (code === 0 && !failure)) {
              done();
              return;
            }
            // The browser may already be gone while its libuv exit notification
            // is queued. A non-destructive existence check distinguishes that
            // race from an actual termination failure.
            try {
              process.kill(child.pid!, 0);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ESRCH") {
                done();
                return;
              }
            }
            reject(
              new Error(
                `audit.browser_termination_failed: taskkill for owned PID ${child.pid} exited ${code}`,
                { cause: failure },
              ),
            );
          });
        });
      } else {
        // Browser launches own their POSIX process group (detached: true).
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (!exited() && !child.kill("SIGKILL"))
            throw new Error(
              "audit.browser_termination_failed: could not terminate the owned browser",
              { cause: error },
            );
        }
      }
    }
    // Successful OS termination can precede Node's close event under load.
    // Reap it instead of treating a second arbitrary deadline as a failure.
    await closed;
  } finally {
    child.removeListener("close", onClose);
  }
}

/** Attempt every independent resource cleanup without replacing the original failure. */
export async function cleanupBrowserResources(
  actions: readonly (() => Promise<unknown>)[],
  primary?: { error: unknown },
): Promise<void> {
  const failures: unknown[] = [];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      failures.push(error);
    }
  }
  if (!failures.length) return;
  if (!primary && failures.length === 1) throw failures[0];
  const message = (error: unknown) =>
    error instanceof Error ? error.message : String(error);
  throw new AggregateError(
    primary ? [primary.error, ...failures] : failures,
    `${primary ? message(primary.error) + "\n" : ""}Browser cleanup failed: ${failures.map(message).join("; ")}`,
    primary ? { cause: primary.error } : undefined,
  );
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
    detached: process.platform !== "win32",
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
    let closePromise: Promise<void> | undefined;
    return {
      executable,
      call,
      evaluate,
      close() {
        return (closePromise ??= (async () => {
          try {
            await stopBrowser(child, () => call("Browser.close"));
          } finally {
            socket?.close();
            rejectPending(
              new Error("audit.browser_closed: browser was closed"),
            );
          }
          await removeProfile(profile);
        })());
      },
    };
  } catch (error) {
    socket?.close();
    await cleanupBrowserResources(
      [
        async () => {
          await stopBrowser(child);
          await removeProfile(profile);
        },
      ],
      { error },
    );
    throw error;
  }
}
