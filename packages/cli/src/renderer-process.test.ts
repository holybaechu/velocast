import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { RendererRuntimeResolver } from "./renderer-binary.js";
import {
  runRenderer,
  terminateRendererProcess,
  waitForRendererProcess,
  type RendererProcess,
  type RunRendererSpawnOptions,
} from "./renderer-process.js";

describe("runRenderer", () => {
  it("spawns the renderer with serialized job JSON and renderer process env", async () => {
    const child = createRendererProcess();
    const spawnCalls: Array<{
      binary: string;
      args: string[];
      options: RunRendererSpawnOptions;
    }> = [];
    const waitedChildren: RendererProcess[] = [];

    await runRenderer(
      "/opt/velocast/velocast-renderer",
      { mode: "composition", composition_id: "hero" },
      {
        resolveProcessEnv: (options) => {
          expect(options.rendererBinary).toBe(
            "/opt/velocast/velocast-renderer",
          );
          return { VELOCAST_RENDERER_TEST: "1" };
        },
        spawnRenderer: (binary, args, options) => {
          spawnCalls.push({ binary, args, options });
          return child;
        },
        waitForProcess: async (rendererProcess) => {
          waitedChildren.push(rendererProcess);
        },
      },
    );

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.binary).toBe("/opt/velocast/velocast-renderer");
    expect(spawnCalls[0]?.options).toEqual({
      env: { VELOCAST_RENDERER_TEST: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    expect(spawnCalls[0]?.args[0]).toBe("--job-json");
    const job = JSON.parse(spawnCalls[0]?.args[1] ?? "{}") as {
      mode?: string;
      composition_id?: string;
      event_log_path?: string;
    };
    expect(job.mode).toBe("composition");
    expect(job.composition_id).toBe("hero");
    expect(job.event_log_path).toMatch(/events\.jsonl$/);
    expect(waitedChildren).toEqual([child]);
  });

  it("uses a memoized runtime resolver to prepare renderer process env", async () => {
    const child = createRendererProcess();
    const spawnCalls: RunRendererSpawnOptions[] = [];

    await runRenderer(
      "/opt/velocast/velocast-renderer",
      { mode: "composition", composition_id: "hero" },
      {
        runtimeResolver: new RendererRuntimeResolver({
          env: {
            VELOCAST_RUNTIME_RESOLVER_TEST: "1",
            VELOCAST_ELECTRON_BINARY: process.execPath,
            VELOCAST_ELECTRON_HOST_SCRIPT: fileURLToPath(
              new URL("./bin.ts", import.meta.url),
            ),
          },
          spawnRendererCapabilities: () => ({
            status: 0,
            stdout: JSON.stringify({
              outputApiVersion: 1,
              browserHosts: ["electron"],
              defaultBrowserHost: "electron",
              electronHostProtocolVersion: 3,
              supportedMediaBackends: ["webcodecs", "native"],
              videoEncoderBackend: "webcodecs",
              mediaRuntime: "mediabunny",
              hardwareAccelerationGuarantee: false,
            }),
            stderr: "",
          }),
        }),
        spawnRenderer: (_binary, _args, options) => {
          spawnCalls.push(options);
          return child;
        },
        waitForProcess: async () => {},
      },
    );

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.env.VELOCAST_RUNTIME_RESOLVER_TEST).toBe("1");
  });

  describe("custom waitForProcess compatibility", () => {
    it("lets custom fulfillment own completion without waiting for process exit", async () => {
      const child = createRendererProcess();
      let eventLogPath: string | undefined;
      let settleAdapter: (() => void) | undefined;
      const adapter = new Promise<void>((resolve) => {
        settleAdapter = resolve;
      });
      const result = runRenderer(
        "/opt/velocast/velocast-renderer",
        { mode: "composition" },
        {
          resolveProcessEnv: () => ({}),
          spawnRenderer: (_binary, args) => {
            const rendererJob = JSON.parse(args[1] ?? "{}") as {
              event_log_path: string;
            };
            eventLogPath = rendererJob.event_log_path;
            writeFileSync(
              rendererJob.event_log_path,
              `${JSON.stringify({ event: "renderer_failed", error: "must be bypassed" })}\n`,
            );
            return child;
          },
          waitForProcess: () => adapter,
        },
      );

      expect(eventLogPath).toBeDefined();
      expect(existsSync(dirname(eventLogPath!))).toBe(true);
      settleAdapter!();

      await expect(result).resolves.toBeUndefined();
      expect(existsSync(dirname(eventLogPath!))).toBe(false);
    });

    it("preserves custom rejection identity and bypasses renderer events", async () => {
      const child = createRendererProcess();
      const adapterError = new Error("custom adapter rejected");
      const kill = vi.fn();
      const readEventProtocol = vi.fn();
      const terminateProcess = vi.fn();
      Object.assign(child, { kill });
      let eventLogPath: string | undefined;

      const result = runRenderer(
        "/opt/velocast/velocast-renderer",
        { mode: "composition" },
        {
          resolveProcessEnv: () => ({}),
          spawnRenderer: (_binary, args) => {
            const rendererJob = JSON.parse(args[1] ?? "{}") as {
              event_log_path: string;
            };
            eventLogPath = rendererJob.event_log_path;
            writeFileSync(
              rendererJob.event_log_path,
              `${JSON.stringify({ event: "renderer_failed", error: "protocol error must not replace adapter error" })}\n`,
            );
            return child;
          },
          waitForProcess: async () => {
            throw adapterError;
          },
          readEventProtocol,
          terminateProcess,
        },
      );

      await expect(result).rejects.toBe(adapterError);
      expect(kill).not.toHaveBeenCalled();
      expect(readEventProtocol).not.toHaveBeenCalled();
      expect(terminateProcess).not.toHaveBeenCalled();
      expect(eventLogPath).toBeDefined();
      expect(existsSync(dirname(eventLogPath!))).toBe(false);

      child.emit("close", 1);
      expect(kill).not.toHaveBeenCalled();
    });

    it("forwards wait options unchanged to the custom adapter", async () => {
      const child = createRendererProcess();
      const writeWarning = vi.fn();
      const waitOptions = {
        maxOutputBytes: 17,
        stdioCloseGraceMs: 23,
        writeWarning,
        scanOutputMessages: false,
        includeOutputTailOnError: false,
      };
      const observedOptions: unknown[] = [];

      await runRenderer(
        "/opt/velocast/velocast-renderer",
        { mode: "composition" },
        {
          resolveProcessEnv: () => ({}),
          spawnRenderer: () => child,
          waitForProcess: async (_rendererProcess, options) => {
            observedOptions.push(options);
          },
          waitOptions,
        },
      );

      expect(observedOptions).toEqual([waitOptions]);
    });

    it.each(["fulfilled", "rejected"] as const)(
      "waits for required protocol after custom %s settlement",
      async (status) => {
        const child = createRendererProcess();
        const adapter = deferred<void>();
        const protocol = deferred<unknown>();
        const adapterError = new Error("required custom adapter rejected");
        const readEventProtocol = vi.fn(() => protocol.promise);
        const result = runRenderer(
          "/opt/velocast/velocast-renderer",
          { mode: "composition" },
          {
            resolveProcessEnv: () => ({}),
            spawnRenderer: () => child,
            waitForProcess: () => adapter.promise,
            customProcessProtocol: "required",
            readEventProtocol,
          },
        );
        let callerSettlements = 0;
        void result.then(
          () => {
            callerSettlements += 1;
          },
          () => {
            callerSettlements += 1;
          },
        );

        if (status === "fulfilled") {
          adapter.resolve();
        } else {
          adapter.reject(adapterError);
        }
        await flushMicrotasks();
        expect(readEventProtocol).toHaveBeenCalledTimes(1);
        expect(callerSettlements).toBe(0);

        protocol.resolve([]);
        if (status === "fulfilled") {
          await expect(result).resolves.toBeUndefined();
        } else {
          await expect(result).rejects.toBe(adapterError);
        }
        expect(callerSettlements).toBe(1);
      },
    );

    it("makes abort decisive, terminates once, and ignores late adapter settlement", async () => {
      const child = createRendererProcess();
      const adapter = deferred<void>();
      const termination = deferred<void>();
      const controller = new AbortController();
      const terminateProcess = vi.fn(() => termination.promise);
      const readEventProtocol = vi.fn();
      const result = runRenderer(
        "/opt/velocast/velocast-renderer",
        { mode: "composition" },
        {
          resolveProcessEnv: () => ({}),
          spawnRenderer: () => child,
          waitForProcess: () => adapter.promise,
          signal: controller.signal,
          terminateProcess,
          readEventProtocol,
        },
      );

      controller.abort(new Error("controlled abort"));
      adapter.resolve();
      await flushMicrotasks();
      expect(terminateProcess).toHaveBeenCalledTimes(1);
      expect(readEventProtocol).not.toHaveBeenCalled();

      termination.resolve();
      await expect(result).rejects.toThrow(
        "renderer execution was cancelled: controlled abort",
      );
      expect(child.listenerCount("exit")).toBe(0);
    });

    it("keeps process exit authoritative over a later abort", async () => {
      const child = createRendererProcess();
      const adapter = deferred<void>();
      const adapterError = new Error("adapter observed failed exit");
      const controller = new AbortController();
      const terminateProcess = vi.fn();
      const result = runRenderer(
        "/opt/velocast/velocast-renderer",
        { mode: "composition" },
        {
          resolveProcessEnv: () => ({}),
          spawnRenderer: () => child,
          waitForProcess: () => adapter.promise,
          signal: controller.signal,
          terminateProcess,
        },
      );

      child.emit("exit", 9);
      controller.abort(new Error("too late"));
      adapter.reject(adapterError);

      await expect(result).rejects.toBe(adapterError);
      expect(terminateProcess).not.toHaveBeenCalled();
    });

    it("allows explicit timeout and escalation after bypass rejection", async () => {
      const child = createRendererProcess();
      const adapter = deferred<void>();
      const cleanup = deferred<void>();
      const adapterError = new Error("adapter rejected before timeout");
      let fireTimeout: (() => void) | undefined;
      const clearScheduledTimeout = vi.fn();
      const terminateProcess = vi.fn(async (_rendererProcess, context) => {
        context.escalate(new Error("controlled escalation"));
      });
      const result = runRenderer(
        "/opt/velocast/velocast-renderer",
        { mode: "composition", event_log_path: "explicit-events.jsonl" },
        {
          resolveProcessEnv: () => ({}),
          spawnRenderer: () => child,
          waitForProcess: () => adapter.promise,
          timeoutMs: 50,
          scheduleTimeout: (callback) => {
            fireTimeout = callback;
            return "timeout-handle";
          },
          clearScheduledTimeout,
          cleanupEventProtocol: () => cleanup.promise,
          terminateProcess,
        },
      );

      adapter.reject(adapterError);
      await flushMicrotasks();
      expect(terminateProcess).not.toHaveBeenCalled();
      fireTimeout!();
      await flushMicrotasks();
      expect(terminateProcess).toHaveBeenCalledTimes(1);

      cleanup.resolve();
      await expect(result).rejects.toBe(adapterError);
      expect(clearScheduledTimeout).toHaveBeenCalledWith("timeout-handle");
      expect(child.listenerCount("exit")).toBe(0);
    });

    it("keeps abort primary when a required protocol result arrives late", async () => {
      const child = createRendererProcess();
      const protocol = deferred<unknown>();
      const termination = deferred<void>();
      const controller = new AbortController();
      const result = runRenderer(
        "/opt/velocast/velocast-renderer",
        { mode: "composition" },
        {
          resolveProcessEnv: () => ({}),
          spawnRenderer: () => child,
          waitForProcess: async () => {},
          customProcessProtocol: "required",
          readEventProtocol: () => protocol.promise,
          signal: controller.signal,
          terminateProcess: () => termination.promise,
        },
      );

      await flushMicrotasks();
      controller.abort(new Error("abort beat protocol"));
      protocol.resolve([]);
      termination.resolve();

      await expect(result).rejects.toThrow(
        "renderer execution was cancelled: abort beat protocol",
      );
    });

    it("cancels and releases an in-flight required protocol drain", async () => {
      const child = createRendererProcess();
      const termination = deferred<void>();
      const controller = new AbortController();
      let protocolSignal: AbortSignal | undefined;
      let protocolReleases = 0;
      const readEventProtocol = vi.fn(
        (_eventLogPath: string, signal: AbortSignal) => {
          protocolSignal = signal;
          return new Promise<unknown>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                protocolReleases += 1;
                reject(signal.reason);
              },
              { once: true },
            );
          });
        },
      );
      const result = runRenderer(
        "/opt/velocast/velocast-renderer",
        { mode: "composition" },
        {
          resolveProcessEnv: () => ({}),
          spawnRenderer: () => child,
          waitForProcess: async () => {},
          customProcessProtocol: "required",
          readEventProtocol,
          signal: controller.signal,
          terminateProcess: () => termination.promise,
        },
      );

      await flushMicrotasks();
      expect(readEventProtocol).toHaveBeenCalledTimes(1);
      expect(protocolSignal?.aborted).toBe(false);

      controller.abort(new Error("release protocol"));
      await flushMicrotasks();
      expect(protocolSignal?.aborted).toBe(true);
      expect(protocolReleases).toBe(1);

      termination.resolve();
      await expect(result).rejects.toThrow(
        "renderer execution was cancelled: release protocol",
      );
      expect(child.listenerCount("exit")).toBe(0);
    });

    it("releases abort ownership after one caller-visible settlement", async () => {
      const child = createRendererProcess();
      const controller = new AbortController();
      const terminateProcess = vi.fn();
      const result = runRenderer(
        "/opt/velocast/velocast-renderer",
        { mode: "composition" },
        {
          resolveProcessEnv: () => ({}),
          spawnRenderer: () => child,
          waitForProcess: async () => {},
          signal: controller.signal,
          terminateProcess,
        },
      );
      let callerSettlements = 0;
      void result.then(() => {
        callerSettlements += 1;
      });

      await result;
      controller.abort(new Error("after finalization"));
      child.emit("exit", 1);
      await flushMicrotasks();

      expect(callerSettlements).toBe(1);
      expect(terminateProcess).not.toHaveBeenCalled();
      expect(child.listenerCount("exit")).toBe(0);
    });

    it("keeps adapter rejection primary and reports cleanup failure secondarily", async () => {
      const child = createRendererProcess();
      const adapterError = new Error("adapter primary");
      const cleanupError = new Error("cleanup secondary");
      const result = runRenderer(
        "/opt/velocast/velocast-renderer",
        { mode: "composition", event_log_path: "explicit-events.jsonl" },
        {
          resolveProcessEnv: () => ({}),
          spawnRenderer: () => child,
          waitForProcess: async () => {
            throw adapterError;
          },
          cleanupEventProtocol: () => {
            throw cleanupError;
          },
        },
      );

      await expect(result).rejects.toMatchObject({
        message:
          "adapter primary\nSecondary renderer lifecycle diagnostics:\n- cleanup secondary",
        cause: adapterError,
      });
    });

    it("keeps abort primary and reports termination failure secondarily", async () => {
      const child = createRendererProcess();
      const adapter = deferred<void>();
      const controller = new AbortController();
      const terminationError = new Error("termination secondary");
      const result = runRenderer(
        "/opt/velocast/velocast-renderer",
        { mode: "composition" },
        {
          resolveProcessEnv: () => ({}),
          spawnRenderer: () => child,
          waitForProcess: () => adapter.promise,
          signal: controller.signal,
          terminateProcess: async () => {
            throw terminationError;
          },
        },
      );

      controller.abort(new Error("abort primary"));

      await expect(result).rejects.toMatchObject({
        message:
          "renderer execution was cancelled: abort primary\nSecondary renderer lifecycle diagnostics:\n- termination secondary",
      });
      adapter.resolve();
      await flushMicrotasks();
    });
  });

  it("surfaces renderer_failed JSONL events instead of scraping stderr", async () => {
    const child = createRendererProcess();
    let eventLogPath: string | undefined;

    const result = runRenderer(
      "/opt/velocast/velocast-renderer",
      { mode: "composition", composition_id: "hero" },
      {
        resolveProcessEnv: () => ({}),
        spawnRenderer: (_binary, args) => {
          const job = JSON.parse(args[1] ?? "{}") as {
            event_log_path?: string;
          };
          eventLogPath = job.event_log_path;
          expect(eventLogPath).toMatch(/events\.jsonl$/);
          writeFileSync(
            eventLogPath!,
            `${JSON.stringify({ event: "renderer_started", mode: "composition", output: "renders/hero.mp4" })}\n${JSON.stringify({ event: "renderer_failed", error: "structured Electron load failure" })}\n`,
          );
          return child;
        },
      },
    );

    child.stderr.end(
      "Error: electron.host_error: unstructured stderr should be ignored\n",
    );
    child.emit("close", 1);

    await expect(result).rejects.toThrow("structured Electron load failure");
    expect(eventLogPath).toBeDefined();
    expect(existsSync(dirname(eventLogPath!))).toBe(false);
  });

  it("preserves nonzero built-in process exit when no protocol result exists", async () => {
    const child = createRendererProcess();
    const result = runRenderer(
      "/opt/velocast/velocast-renderer",
      { mode: "composition" },
      {
        resolveProcessEnv: () => ({}),
        spawnRenderer: () => child,
      },
    );

    child.emit("close", 7);

    await expect(result).rejects.toThrow("renderer exited with code 7");
  });

  it("emits success warnings from renderer_finished JSONL events", async () => {
    const child = createRendererProcess();
    const warnings: string[] = [];

    const result = runRenderer(
      "/opt/velocast/velocast-renderer",
      { mode: "composition", composition_id: "hero" },
      {
        resolveProcessEnv: () => ({}),
        spawnRenderer: (_binary, args) => {
          const job = JSON.parse(args[1] ?? "{}") as {
            event_log_path?: string;
          };
          writeFileSync(
            job.event_log_path!,
            `${JSON.stringify({ event: "renderer_finished", frames_rendered: 3, frames_encoded: 3, fallback_used: false, cpu_readback_frames: 2 })}\n`,
          );
          return child;
        },
        waitOptions: {
          writeWarning: (message) => warnings.push(message),
        },
      },
    );

    child.stderr.end("renderer completed using CPU readback for 99 frame(s)\n");
    child.emit("close", 0);

    await expect(result).resolves.toBeUndefined();
    expect(warnings).toEqual([
      "Renderer warning: renderer completed using CPU readback for 2 frame(s)\n",
    ]);
  });

  it("cleans up temporary renderer event logs when spawn setup throws", async () => {
    let eventLogPath: string | undefined;

    await expect(
      runRenderer(
        "/opt/velocast/velocast-renderer",
        { mode: "composition", composition_id: "hero" },
        {
          resolveProcessEnv: () => ({}),
          spawnRenderer: (_binary, args) => {
            const job = JSON.parse(args[1] ?? "{}") as {
              event_log_path?: string;
            };
            eventLogPath = job.event_log_path;
            throw new Error("spawn failed before process start");
          },
        },
      ),
    ).rejects.toThrow("spawn failed before process start");

    expect(eventLogPath).toBeDefined();
    expect(existsSync(dirname(eventLogPath!))).toBe(false);
  });

  it("routes pre-abort through one lifecycle cleanup without spawning", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancel before spawn"));
    const spawnRenderer = vi.fn();
    const cleanupEventProtocol = vi.fn();

    const result = runRenderer(
      "/opt/velocast/velocast-renderer",
      { mode: "composition", event_log_path: "explicit-events.jsonl" },
      {
        resolveProcessEnv: () => ({}),
        spawnRenderer,
        signal: controller.signal,
        cleanupEventProtocol,
      },
    );

    await expect(result).rejects.toThrow(
      "renderer execution was cancelled: cancel before spawn",
    );
    expect(spawnRenderer).not.toHaveBeenCalled();
    expect(cleanupEventProtocol).toHaveBeenCalledTimes(1);
  });

  it("routes spawn failure through one lifecycle cleanup and finalization", async () => {
    const spawnError = new Error("controlled spawn failure");
    const cleanupEventProtocol = vi.fn();

    const result = runRenderer(
      "/opt/velocast/velocast-renderer",
      { mode: "composition", event_log_path: "explicit-events.jsonl" },
      {
        resolveProcessEnv: () => ({}),
        spawnRenderer: () => {
          throw spawnError;
        },
        cleanupEventProtocol,
      },
    );

    await expect(result).rejects.toBe(spawnError);
    expect(cleanupEventProtocol).toHaveBeenCalledTimes(1);
  });

  it("preserves explicit renderer event log paths", async () => {
    const child = createRendererProcess();
    const eventLogPath = join(
      mkdtempSync(join(tmpdir(), "velocast-renderer-events-explicit-")),
      "explicit.jsonl",
    );

    const result = runRenderer(
      "/opt/velocast/velocast-renderer",
      { mode: "composition", event_log_path: eventLogPath },
      {
        resolveProcessEnv: () => ({}),
        spawnRenderer: (_binary, args) => {
          const job = JSON.parse(args[1] ?? "{}") as {
            event_log_path?: string;
          };
          expect(job.event_log_path).toBe(eventLogPath);
          writeFileSync(
            eventLogPath,
            `${JSON.stringify({ event: "renderer_finished", frames_rendered: 1, frames_encoded: 1, fallback_used: false, cpu_readback_frames: 0 })}\n`,
          );
          return child;
        },
      },
    );

    child.emit("close", 0);

    await expect(result).resolves.toBeUndefined();
    expect(readFileSync(eventLogPath, "utf8")).toContain("renderer_finished");
  });

  it("prefers renderer report fallback diagnostics over generic stderr warnings", async () => {
    const child = createRendererProcess();
    const reportPath = join(
      mkdtempSync(join(tmpdir(), "velocast-renderer-report-")),
      "report.json",
    );
    writeFileSync(
      reportPath,
      JSON.stringify({
        fallback_used: true,
        fallback_reason:
          "hardware encoder unavailable: accelerated rendering is required, but no compatible GPU backend is available on this platform.",
        backend_diagnostics: [
          {
            backend: "webcodecs",
            available: false,
            unavailable_code: "platform.device_unavailable",
            unavailable_reason:
              "platform.device_unavailable: WebCodecs codec unavailable",
          },
        ],
      }),
    );
    const warnings: string[] = [];

    const result = runRenderer(
      "/opt/velocast/velocast-renderer",
      { mode: "composition", report_path: reportPath },
      {
        resolveProcessEnv: () => ({}),
        spawnRenderer: () => child,
        waitOptions: {
          writeWarning: (message) => warnings.push(message),
        },
      },
    );

    child.stderr.end(
      "hardware encoder unavailable; falling back to software BGRA stdin\n",
    );
    child.emit("close", 0);

    await expect(result).resolves.toBeUndefined();
    expect(warnings).toEqual([
      [
        "Renderer warning: renderer completed using fallback path: hardware encoder unavailable: accelerated rendering is required, but no compatible GPU backend is available on this platform.",
        "Backend diagnostics: webcodecs unavailable: platform.device_unavailable: WebCodecs codec unavailable\n",
      ].join("\n"),
    ]);
  });
});

describe("waitForRendererProcess", () => {
  it("emits renderer success warnings through the configured writer", async () => {
    const child = createRendererProcess();
    const warnings: string[] = [];
    const result = waitForRendererProcess(child, {
      writeWarning: (message) => warnings.push(message),
    });

    child.stderr.end("renderer completed using CPU readback for 3 frame(s)\n");
    child.emit("close", 0);

    await expect(result).resolves.toBeUndefined();
    expect(warnings).toEqual([
      "Renderer warning: renderer completed using CPU readback for 3 frame(s)\n",
    ]);
  });

  it("keeps success warnings that appear before the retained output tail", async () => {
    const child = createRendererProcess();
    const warnings: string[] = [];
    const result = waitForRendererProcess(child, {
      maxOutputBytes: 64,
      writeWarning: (message) => warnings.push(message),
    });

    child.stderr.write(
      "renderer completed using CPU readback for 3 frame(s)\n",
    );
    child.stderr.end("x".repeat(1_000));
    child.emit("close", 0);

    await expect(result).resolves.toBeUndefined();
    expect(warnings).toEqual([
      "Renderer warning: renderer completed using CPU readback for 3 frame(s)\n",
    ]);
  });

  it("keeps renderer warning priority consistent while buffering output", async () => {
    const child = createRendererProcess();
    const warnings: string[] = [];
    const result = waitForRendererProcess(child, {
      maxOutputBytes: 64,
      writeWarning: (message) => warnings.push(message),
    });

    child.stderr.write(
      "renderer completed using CPU readback for 3 frame(s)\n",
    );
    child.stderr.write("x".repeat(1_000));
    child.stderr.end(
      "hardware encoder unavailable; falling back to software BGRA stdin\n",
    );
    child.emit("close", 0);

    await expect(result).resolves.toBeUndefined();
    expect(warnings).toEqual([
      "Renderer warning: hardware encoder unavailable; falling back to software BGRA stdin\n",
    ]);
  });

  it("waits for renderer stdio close before parsing the error tail", async () => {
    const child = createRendererProcess();
    const result = waitForRendererProcess(child);

    child.emit("exit", 1);
    child.stderr.write("x".repeat(200_000));
    child.stderr.end(
      "Error: frame 0 timed out waiting for accelerated paint\n",
    );

    await Promise.resolve();
    child.emit("close", 1);

    await expect(result).rejects.toThrow(
      "frame 0 timed out waiting for accelerated paint",
    );
  });

  it("does not wait forever when Electron children keep renderer stdio open after exit", async () => {
    const child = createRendererProcess();
    const result = waitForRendererProcess(child, { stdioCloseGraceMs: 0 });

    child.emit("exit", 0);

    await expect(result).resolves.toBeUndefined();
  });

  it("uses retained output when stdio stays open after a renderer error exit", async () => {
    const child = createRendererProcess();
    const result = waitForRendererProcess(child, { stdioCloseGraceMs: 0 });

    child.stderr.write(
      "Error: frame 0 timed out waiting for accelerated paint\n",
    );
    child.emit("exit", 1);

    await expect(result).rejects.toThrow(
      "frame 0 timed out waiting for accelerated paint",
    );
  });

  it("surfaces unknown renderer stderr when no known error pattern matches", async () => {
    const child = createRendererProcess();
    const result = waitForRendererProcess(child);

    child.stderr.end("__filename is not defined in ES module scope\n");
    child.emit("close", 1);

    await expect(result).rejects.toThrow(
      "__filename is not defined in ES module scope",
    );
  });

  it("keeps known renderer errors that appear before the retained output tail", async () => {
    const child = createRendererProcess();
    const result = waitForRendererProcess(child, {
      maxOutputBytes: 64,
    });

    child.stderr.write(
      "Error: electron.host_error: ERR_CONNECTION_REFUSED (http://127.0.0.1:4545/)\n",
    );
    child.stderr.end("x".repeat(1_000));
    child.emit("close", 1);

    await expect(result).rejects.toThrow(
      "electron.host_error: ERR_CONNECTION_REFUSED (http://127.0.0.1:4545/)",
    );
  });

  it("does not concatenate the full renderer output on every chunk", async () => {
    const child = createRendererProcess();
    const concatSpy = vi.spyOn(Buffer, "concat");
    const result = waitForRendererProcess(child, {
      maxOutputBytes: 64,
    });

    try {
      for (let index = 0; index < 20; index += 1) {
        child.stderr.write(`chunk-${index}:${"x".repeat(256)}\n`);
      }
      child.emit("close", 0);

      await expect(result).resolves.toBeUndefined();
      expect(concatSpy.mock.calls.length).toBeLessThanOrEqual(1);
    } finally {
      concatSpy.mockRestore();
    }
  });

  it("does not concatenate retained output when a known warning was already detected", async () => {
    const child = createRendererProcess();
    const concatSpy = vi.spyOn(Buffer, "concat");
    const warnings: string[] = [];
    const result = waitForRendererProcess(child, {
      maxOutputBytes: 64,
      writeWarning: (message) => warnings.push(message),
    });

    try {
      child.stderr.write(
        "renderer completed using CPU readback for 3 frame(s)\n",
      );
      child.stderr.end("x".repeat(1_000));
      child.emit("close", 0);

      await expect(result).resolves.toBeUndefined();
      expect(warnings).toEqual([
        "Renderer warning: renderer completed using CPU readback for 3 frame(s)\n",
      ]);
      expect(concatSpy).not.toHaveBeenCalled();
    } finally {
      concatSpy.mockRestore();
    }
  });

  it("does not concatenate retained output when a known error was already detected", async () => {
    const child = createRendererProcess();
    const concatSpy = vi.spyOn(Buffer, "concat");
    const result = waitForRendererProcess(child, {
      maxOutputBytes: 64,
    });

    try {
      child.stderr.write(
        "Error: electron.host_error: ERR_CONNECTION_REFUSED (http://127.0.0.1:4545/)\n",
      );
      child.stderr.end("x".repeat(1_000));
      child.emit("close", 1);

      await expect(result).rejects.toThrow(
        "electron.host_error: ERR_CONNECTION_REFUSED (http://127.0.0.1:4545/)",
      );
      expect(concatSpy).not.toHaveBeenCalled();
    } finally {
      concatSpy.mockRestore();
    }
  });

  it("reports renderer termination signals explicitly", async () => {
    const child = createRendererProcess();
    const result = waitForRendererProcess(child);

    child.emit("exit", null, "SIGTERM");
    child.emit("close", null, "SIGTERM");

    await expect(result).rejects.toThrow(
      "renderer exited after receiving SIGTERM",
    );
  });

  it("releases process and stream listeners after settlement", async () => {
    const child = createRendererProcess();
    const result = waitForRendererProcess(child);

    child.emit("close", 0);
    await result;

    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("close")).toBe(0);
    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.stderr.listenerCount("data")).toBe(0);
  });
});

describe("terminateRendererProcess", () => {
  it("escalates only from an explicit termination effect and releases fake time", async () => {
    vi.useFakeTimers();
    const child = createRendererProcess();
    const kill = vi.fn();
    Object.assign(child, { kill });
    const escalate = vi.fn();

    try {
      const result = terminateRendererProcess(
        child,
        { cause: "abort", escalate },
        25,
      );
      expect(kill).toHaveBeenCalledWith("SIGTERM");

      await vi.advanceTimersByTimeAsync(25);
      expect(escalate).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledWith("SIGKILL");

      child.emit("exit", null, "SIGKILL");
      await result;
      expect(child.listenerCount("exit")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

function createRendererProcess(): EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) {
    await Promise.resolve();
  }
}
