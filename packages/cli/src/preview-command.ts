import { spawn } from "node:child_process";
import type { Config } from "@velocast/core";
import { getInvocationCwd } from "./paths.js";
import { terminateRendererProcess } from "./renderer-process.js";
import {
  createPreviewServer,
  type PreviewServerDependencies,
  type PreviewServerOptions,
} from "./preview-server.js";

export interface PreviewCommandOptions extends Omit<
  PreviewServerOptions,
  "port"
> {
  port?: number | string;
  json?: boolean;
  /** Explicit trusted project build/watch command, never accepted from HTTP clients. */
  watchCommand?: string;
}
export interface PreviewCommandDependencies extends PreviewServerDependencies {
  createServer?: typeof createPreviewServer;
  write?: (message: string) => void;
}

export async function previewCommand(
  config: Config,
  options: PreviewCommandOptions = {},
  dependencies: PreviewCommandDependencies = {},
): Promise<void> {
  if (config.source !== undefined)
    throw new Error(
      "preview.source_unsupported: source adapter preview is not available yet; use compositions, inspect, frame or render with this config",
    );
  const port =
    options.port === undefined
      ? 0
      : typeof options.port === "string" && /^\d+$/.test(options.port)
        ? Number(options.port)
        : options.port;
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535
  )
    throw new Error("preview.invalid_port: port must be 0..65535");
  if (
    options.watchCommand !== undefined &&
    (typeof options.watchCommand !== "string" ||
      !options.watchCommand.trim() ||
      options.watchCommand.includes("\0"))
  )
    throw new Error(
      "preview.invalid_watch_command: expected a nonempty trusted command",
    );
  const stopped = new AbortController();
  const stop = () => stopped.abort();
  const signal = options.signal
    ? AbortSignal.any([options.signal, stopped.signal])
    : stopped.signal;
  const done = new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let watch: ReturnType<typeof spawn> | undefined;
  let watchFailure: Error | undefined;
  let watchExit: Promise<void> | undefined;
  let server: Awaited<ReturnType<typeof createPreviewServer>> | undefined;
  try {
    signal.throwIfAborted();
    if (options.watchCommand) {
      watch = spawn(options.watchCommand, {
        shell: true,
        windowsHide: true,
        detached: process.platform !== "win32",
        cwd: getInvocationCwd(options.pathOptions ?? dependencies.pathOptions),
        stdio: ["ignore", "pipe", "pipe"],
      });
      watch.stdout?.on("data", (chunk) => process.stderr.write(chunk));
      watch.stderr?.on("data", (chunk) => process.stderr.write(chunk));
      watchExit = new Promise<void>((resolve) => {
        watch!.once("error", (error) => {
          watchFailure = error;
          stop();
        });
        watch!.once("close", (code) => {
          if (!signal.aborted) {
            watchFailure = new Error(
              `preview.watch_exited: build watcher exited ${code}; a persistent watch command is required`,
            );
            stop();
          }
          resolve();
        });
      });
    }
    server = await (dependencies.createServer ?? createPreviewServer)(
      config,
      { ...options, port, signal },
      dependencies,
    );
    const write =
      dependencies.write ?? ((message) => process.stdout.write(message));
    write(
      options.json
        ? JSON.stringify({
            status: "ready",
            url: server.url,
            ...server.session(),
          }) + "\n"
        : `Preview: ${server.url}\n${options.autoRefresh === false ? "Refresh source after rebuilding." : "Successful source changes refresh automatically; the selected frame is kept."} Ctrl+C stops the session.\n`,
    );
    await done;
    if (watchFailure) throw watchFailure;
  } finally {
    stopped.abort();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    try {
      await server?.close();
    } finally {
      if (watch) {
        await terminateRendererProcess(
          watch,
          { cause: "abort", escalate: () => {} },
          1000,
        );
        await watchExit;
      }
    }
  }
}
