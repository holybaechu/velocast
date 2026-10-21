import { spawn } from "node:child_process";
import type { Config } from "@velocast/core";
import { getInvocationCwd } from "../project/paths.js";
import { terminateRendererProcess } from "../render/renderer-process.js";
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
  process.once("disconnect", stop);
  // An owning parent can disconnect while the CLI is still loading its config.
  if (process.send && !process.connected) stop();
  let watch: ReturnType<typeof spawn> | undefined;
  let watchFailure: Error | undefined;
  let watchExit: Promise<void> | undefined;
  let server: Awaited<ReturnType<typeof createPreviewServer>> | undefined;
  const failures: unknown[] = [];
  try {
    signal.throwIfAborted();
    if (process.send && process.env.VELOCAST_PREVIEW_GATE_CLI) {
      // The external consumer gate must join cleanup once native work is possible.
      await new Promise<void>((done, reject) => {
        process.send!(
          { type: "velocast.preview.starting" },
          (error: Error | null) => (error ? reject(error) : done()),
        );
      });
      signal.throwIfAborted();
    }
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
  } catch (error) {
    failures.push(error);
  } finally {
    stopped.abort();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    process.removeListener("disconnect", stop);
    try {
      await server?.close();
    } catch (error) {
      failures.push(error);
    }
    if (watch) {
      try {
        await terminateRendererProcess(
          watch,
          { cause: "abort", escalate: () => {} },
          1000,
        );
        await watchExit;
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      failures
        .map((error) =>
          error instanceof Error ? error.message : String(error),
        )
        .join("\n"),
      { cause: failures[0] },
    );
}
