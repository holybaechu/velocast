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
import { isObjectRecord } from "./internal/validation.js";
import {
  RendererRuntimeResolver,
  type ResolveRendererBinaryOptions,
} from "./renderer-binary.js";
import {
  extractRendererEventFailure,
  extractRendererEventSuccessWarning,
  parseRendererEventLog,
} from "./renderer-events.js";
import {
  extractKnownRendererError,
  extractRendererReportSuccessWarning,
  extractRendererSuccessWarning,
} from "./renderer-output.js";
import {
  createAdapterSettlement,
  createRendererLifecycleState,
  reduceRendererLifecycle,
  type LifecycleEffect,
  type LifecycleEvent,
  type LifecycleOutcome,
  type RendererLifecycleState,
  type TerminationCause,
} from "./renderer-lifecycle.js";

export type RendererProcessStream = {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off?(event: "data", listener: (chunk: Buffer | string) => void): unknown;
};

export type RendererProcess = {
  pid?: number;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  stdout?: RendererProcessStream | null;
  stderr?: RendererProcessStream | null;
  kill?(signal?: NodeJS.Signals): boolean;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(
    event: "exit",
    listener: (code: number | null, signal?: NodeJS.Signals | null) => void,
  ): unknown;
  on(
    event: "close",
    listener: (code: number | null, signal?: NodeJS.Signals | null) => void,
  ): unknown;
  off?(event: "error", listener: (error: Error) => void): unknown;
  off?(
    event: "exit" | "close",
    listener: (code: number | null, signal?: NodeJS.Signals | null) => void,
  ): unknown;
};

export interface WaitForRendererProcessOptions {
  maxOutputBytes?: number;
  stdioCloseGraceMs?: number;
  writeWarning?: (message: string) => void;
  scanOutputMessages?: boolean;
  includeOutputTailOnError?: boolean;
}

export interface RunRendererSpawnOptions {
  env: NodeJS.ProcessEnv;
  stdio: ["ignore", "pipe", "pipe"];
  windowsHide: true;
  detached: boolean;
}

export interface RendererTerminationContext {
  cause: TerminationCause;
  escalate: (error?: unknown) => void;
}

export interface RunRendererOptions {
  resolveProcessEnv?: (
    options: ResolveRendererBinaryOptions,
  ) => NodeJS.ProcessEnv;
  spawnRenderer?: (
    binary: string,
    args: string[],
    options: RunRendererSpawnOptions,
  ) => RendererProcess;
  waitForProcess?: (
    child: RendererProcess,
    options?: WaitForRendererProcessOptions,
  ) => Promise<void>;
  runtimeResolver?: RendererRuntimeResolver;
  waitOptions?: WaitForRendererProcessOptions;
  signal?: AbortSignal;
  timeoutMs?: number;
  customProcessProtocol?: "required" | "bypassed";
  terminationGraceMs?: number;
  terminateProcess?: (
    child: RendererProcess,
    context: RendererTerminationContext,
  ) => Promise<void> | void;
  readEventProtocol?: (
    eventLogPath: string,
    signal: AbortSignal,
  ) => Promise<unknown> | unknown;
  cleanupEventProtocol?: (
    eventProtocol: RendererEventProtocol,
  ) => Promise<void> | void;
  scheduleTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearScheduledTimeout?: (handle: unknown) => void;
}

const defaultRendererOutputBufferBytes = 1024 * 1024;
const minimumRendererMessageScanTailChars = 512;

export class RendererCancelledError extends Error {
  constructor(message = "renderer execution was cancelled") {
    super(message);
    this.name = "RendererCancelledError";
  }
}

export class RendererTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`renderer execution timed out after ${timeoutMs}ms`);
    this.name = "RendererTimeoutError";
  }
}

export async function waitForRendererProcess(
  child: RendererProcess,
  options: WaitForRendererProcessOptions = {},
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const output = new RendererOutputBuffer(
      resolveRendererOutputBufferBytes(options.maxOutputBytes),
      options.scanOutputMessages !== false,
      options.includeOutputTailOnError !== false,
    );
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let settled = false;
    let closeGraceTimer: ReturnType<typeof setTimeout> | undefined;

    const clearCloseGraceTimer = () => {
      if (closeGraceTimer !== undefined) {
        clearTimeout(closeGraceTimer);
        closeGraceTimer = undefined;
      }
    };

    const appendOutput = (chunk: Buffer | string) => {
      output.append(chunk);
    };
    const onStdoutData = (chunk: Buffer | string) => appendOutput(chunk);
    const onStderrData = (chunk: Buffer | string) => appendOutput(chunk);
    const removeListeners = () => {
      child.stdout?.off?.("data", onStdoutData);
      child.stderr?.off?.("data", onStderrData);
      child.off?.("error", rejectOnce);
      child.off?.("exit", onExit);
      child.off?.("close", onClose);
    };

    const rejectOnce = (error: Error) => {
      if (settled) {
        return;
      }
      clearCloseGraceTimer();
      removeListeners();
      settled = true;
      reject(error);
    };

    const settleFromExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ) => {
      if (settled) {
        return;
      }
      clearCloseGraceTimer();
      removeListeners();
      settled = true;
      if (code === 0) {
        const warning = output.warning();
        if (warning) {
          const writeWarning =
            options.writeWarning ??
            ((message: string) => {
              process.stderr.write(message);
            });
          writeWarning(`Renderer warning: ${warning}\n`);
        }
        resolve();
        return;
      }

      reject(
        new Error(output.error() ?? formatRendererExitError(code, signal)),
      );
    };

    const onExit = (
      code: number | null,
      signal: NodeJS.Signals | null = null,
    ) => {
      exitCode = code;
      exitSignal = signal;
      const graceMs = resolveRendererStdioCloseGraceMs(
        options.stdioCloseGraceMs,
      );
      closeGraceTimer = setTimeout(() => {
        settleFromExit(exitCode, exitSignal);
      }, graceMs);
    };
    const onClose = (
      code: number | null,
      signal: NodeJS.Signals | null = null,
    ) => {
      const finalCode = code ?? exitCode;
      const finalSignal = signal ?? exitSignal;
      settleFromExit(finalCode, finalSignal);
    };

    child.stdout?.on("data", onStdoutData);
    child.stderr?.on("data", onStderrData);
    child.on("error", rejectOnce);
    child.on("exit", onExit);
    child.on("close", onClose);
  });
}

function formatRendererExitError(
  code: number | null,
  signal: NodeJS.Signals | null,
): string {
  if (code !== null) {
    return `renderer exited with code ${code}`;
  }

  if (signal !== null) {
    return `renderer exited after receiving ${signal}`;
  }

  return "renderer exited without an exit code or signal";
}

function resolveRendererOutputBufferBytes(value: number | undefined): number {
  if (value === undefined) {
    return defaultRendererOutputBufferBytes;
  }

  return Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : defaultRendererOutputBufferBytes;
}

function resolveRendererStdioCloseGraceMs(value: number | undefined): number {
  if (value === undefined) {
    return 2_000;
  }

  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 2_000;
}

class RendererOutputBuffer {
  private chunks: Buffer[] = [];
  private byteLength = 0;
  private messageScanText = "";
  private detectedError: string | undefined;
  private detectedWarning: string | undefined;

  constructor(
    private readonly maxBytes: number,
    private readonly scanMessages: boolean,
    private readonly includeOutputTailOnError: boolean,
  ) {}

  append(chunk: Buffer | string): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.chunks.push(buffer);
    this.byteLength += buffer.byteLength;

    if (this.scanMessages) {
      this.rememberKnownMessagesFromChunk(buffer.toString("utf8"));
    }
    this.trim();
  }

  error(): string | undefined {
    if (this.detectedError) {
      return this.detectedError;
    }

    const retainedText = this.text();
    return (
      (this.scanMessages
        ? extractKnownRendererError(retainedText)
        : undefined) ?? this.unknownErrorTail(retainedText)
    );
  }

  warning(): string | undefined {
    if (!this.scanMessages) {
      return undefined;
    }
    return this.detectedWarning ?? extractRendererSuccessWarning(this.text());
  }

  private rememberKnownMessages(output: string): void {
    this.detectedWarning =
      extractRendererSuccessWarning(output) ?? this.detectedWarning;
    this.detectedError =
      extractKnownRendererError(output) ?? this.detectedError;
  }

  private rememberKnownMessagesFromChunk(output: string): void {
    this.rememberKnownMessages(output);
    this.messageScanText += output;
    const scanTailChars = Math.max(
      this.maxBytes,
      minimumRendererMessageScanTailChars,
    );
    if (this.messageScanText.length > scanTailChars) {
      this.messageScanText = this.messageScanText.slice(-scanTailChars);
    }
    this.rememberKnownMessages(this.messageScanText);
  }

  private text(): string {
    return Buffer.concat(this.chunks, this.byteLength).toString("utf8");
  }

  private unknownErrorTail(output: string): string | undefined {
    if (!this.includeOutputTailOnError) {
      return undefined;
    }

    const text = output.trim();
    if (!text) {
      return undefined;
    }

    return text
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .slice(-12)
      .join("\n");
  }

  private trim(): void {
    while (this.byteLength > this.maxBytes && this.chunks.length > 0) {
      const overflow = this.byteLength - this.maxBytes;
      const first = this.chunks[0]!;
      if (overflow >= first.byteLength) {
        this.chunks.shift();
        this.byteLength -= first.byteLength;
        continue;
      }

      this.chunks[0] = first.subarray(overflow);
      this.byteLength -= overflow;
      return;
    }
  }
}

export async function runRenderer(
  binary: string,
  job: unknown,
  options: RunRendererOptions = {},
): Promise<void> {
  const eventProtocol = prepareRendererEventProtocol(job);
  const rendererJob = eventProtocol.job;
  const runtimeResolver =
    options.runtimeResolver ?? new RendererRuntimeResolver();
  const resolveProcessEnv =
    options.resolveProcessEnv ??
    ((resolveOptions: ResolveRendererBinaryOptions) =>
      runtimeResolver.resolveProcessEnv(resolveOptions.rendererBinary));
  const spawnRenderer = options.spawnRenderer ?? spawn;
  const waitForProcess = options.waitForProcess ?? waitForRendererProcess;
  const usesDefaultWaitForProcess = options.waitForProcess === undefined;
  let cancellationPath: string | undefined;
  let ownsCancellationMarker = false;
  let signalCancellation: (() => void) | undefined;
  let terminationPending: Promise<void> | undefined;
  const cleanupProtocol = async () => {
    // The lifecycle may request protocol cleanup while termination is pending.
    // Keep the fence (and its containing private directory) until the tree settles.
    if (terminationPending) {
      try {
        await terminationPending;
      } catch (error) {
        if (!rendererProcessHasExited(child)) throw error;
      }
    }
    if (signalCancellation)
      options.signal?.removeEventListener("abort", signalCancellation);
    try {
      await (
        options.cleanupEventProtocol ?? cleanupTemporaryRendererEventProtocol
      )(eventProtocol);
    } finally {
      // Explicit event logs survive. Only the per-process marker created here is ours.
      if (ownsCancellationMarker && cancellationPath)
        rmSync(cancellationPath, { force: true });
    }
  };
  if (options.signal?.aborted) {
    return runStartupFailureLifecycle(
      rendererCancellationError(options.signal.reason),
      cleanupProtocol,
      usesDefaultWaitForProcess,
      rendererJob,
      options.waitOptions?.writeWarning,
    );
  }
  let child: RendererProcess;
  try {
    child = spawnRenderer(binary, ["--job-json", JSON.stringify(rendererJob)], {
      env: resolveProcessEnv({ rendererBinary: binary }),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
  } catch (error) {
    return runStartupFailureLifecycle(
      error,
      cleanupProtocol,
      usesDefaultWaitForProcess,
      rendererJob,
      options.waitOptions?.writeWarning,
    );
  }

  const publishCancellation = (): boolean => {
    if (
      rendererProcessHasExited(child) ||
      !Number.isSafeInteger(child.pid) ||
      child.pid! <= 0
    )
      return false;
    cancellationPath ??= `${eventProtocol.eventLogPath}.${child.pid}.cancel`;
    if (ownsCancellationMarker) return true;
    try {
      writeFileSync(cancellationPath, "", { flag: "wx" });
      ownsCancellationMarker = true;
      return true;
    } catch (error) {
      // Never overwrite or later remove another owner's preexisting file.
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return true;
      (
        options.waitOptions?.writeWarning ??
        ((message) => process.stderr.write(message))
      )(
        `Renderer warning: cooperative cancellation marker unavailable; using process termination: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return false;
    }
  };
  if (options.terminateProcess === undefined) {
    signalCancellation = () => {
      publishCancellation();
    };
    options.signal?.addEventListener("abort", signalCancellation, {
      once: true,
    });
    if (options.signal?.aborted) signalCancellation();
  }

  const bufferedWarnings: string[] = [];
  const waitOptions = usesDefaultWaitForProcess
    ? {
        ...options.waitOptions,
        scanOutputMessages: false,
        includeOutputTailOnError: false,
        writeWarning: (message: string) => {
          bufferedWarnings.push(message);
        },
      }
    : options.waitOptions;
  const readProtocol = async (signal: AbortSignal) => {
    if (signal.aborted) {
      throw signal.reason;
    }
    const evidence = await (options.readEventProtocol ?? readRendererEvents)(
      eventProtocol.eventLogPath,
      signal,
    );
    if (signal.aborted) {
      throw signal.reason;
    }
    if (options.readEventProtocol === undefined) {
      const events = evidence as ReturnType<typeof readRendererEvents>;
      const eventFailure = extractRendererEventFailure(events);
      if (eventFailure) {
        throw new Error(eventFailure);
      }
    }
    return evidence;
  };
  const terminate =
    options.terminateProcess ??
    ((
      rendererProcess: RendererProcess,
      context: RendererTerminationContext,
    ) => {
      terminationPending = (async () => {
        if (publishCancellation())
          await waitForCooperativeExit(
            rendererProcess,
            options.terminationGraceMs,
          );
        await terminateRendererProcess(
          rendererProcess,
          context,
          options.terminationGraceMs,
        );
      })();
      return terminationPending;
    });

  const owner = new RendererLifecycleOwner({
    child,
    adapter: usesDefaultWaitForProcess ? "built-in" : "custom",
    protocol: usesDefaultWaitForProcess
      ? "required"
      : (options.customProcessProtocol ?? "bypassed"),
    waitForProcess: () => waitForProcess(child, waitOptions),
    readProtocol,
    cleanupProtocol,
    terminateProcess: terminate,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    scheduleTimeout: options.scheduleTimeout,
    clearScheduledTimeout: options.clearScheduledTimeout,
    mapFinalOutcome: (outcome, state) => {
      finishRendererOutcome(
        outcome,
        state,
        usesDefaultWaitForProcess,
        rendererJob,
        options.waitOptions?.writeWarning,
        bufferedWarnings,
      );
    },
  });
  await owner.run();
}

interface RendererLifecycleOwnerOptions {
  child?: RendererProcess;
  adapter: "built-in" | "custom";
  protocol: "required" | "bypassed";
  waitForProcess: () => Promise<void>;
  readProtocol: (signal: AbortSignal) => Promise<unknown>;
  cleanupProtocol: () => Promise<void> | void;
  terminateProcess: (
    child: RendererProcess,
    context: RendererTerminationContext,
  ) => Promise<void> | void;
  signal?: AbortSignal;
  timeoutMs?: number;
  scheduleTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearScheduledTimeout?: (handle: unknown) => void;
  mapFinalOutcome: (
    outcome: LifecycleOutcome,
    state: RendererLifecycleState,
  ) => void;
}

class RendererLifecycleOwner {
  private state = createRendererLifecycleState();
  private readonly completion: Promise<void>;
  private resolveCompletion!: () => void;
  private rejectCompletion!: (error: unknown) => void;
  private timeoutHandle: unknown;
  private completionSettled = false;
  private protocolDrainController: AbortController | undefined;

  constructor(private readonly options: RendererLifecycleOwnerOptions) {
    this.completion = new Promise<void>((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
  }

  run(): Promise<void> {
    const child = this.options.child;
    if (child === undefined) {
      throw new Error("renderer lifecycle cannot run without a process");
    }
    child.on("exit", this.onProcessExit);
    const signal = this.options.signal;
    if (signal?.aborted) {
      this.dispatch({
        type: "abort",
        error: rendererCancellationError(signal.reason),
      });
    } else {
      signal?.addEventListener("abort", this.onAbort, { once: true });
    }
    if (this.options.timeoutMs !== undefined) {
      const timeoutMs = resolveRendererTimeoutMs(this.options.timeoutMs);
      const schedule =
        this.options.scheduleTimeout ??
        ((callback: () => void, delayMs: number) =>
          setTimeout(callback, delayMs));
      this.timeoutHandle = schedule(() => {
        this.dispatch({
          type: "timeout",
          error: new RendererTimeoutError(timeoutMs),
        });
      }, timeoutMs);
    }

    let adapterPromise: Promise<void>;
    try {
      adapterPromise = this.options.waitForProcess();
    } catch (error) {
      adapterPromise = Promise.reject(error);
    }
    void adapterPromise.then(
      (result) => {
        this.dispatch({
          type: "adapter-settled",
          settlement: createAdapterSettlement({
            adapter: this.options.adapter,
            protocol: this.options.protocol,
            status: "fulfilled",
            result,
            process: this.state.process,
          }),
        });
      },
      (error: unknown) => {
        this.dispatch({
          type: "adapter-settled",
          settlement: createAdapterSettlement({
            adapter: this.options.adapter,
            protocol: this.options.protocol,
            status: "rejected",
            error,
            process: this.state.process,
          }),
        });
      },
    );
    return this.completion;
  }

  failStartup(error: unknown): Promise<void> {
    this.dispatch({ type: "startup-failed", error });
    return this.completion;
  }

  private readonly onAbort = () => {
    this.dispatch({
      type: "abort",
      error: rendererCancellationError(this.options.signal?.reason),
    });
  };

  private readonly onProcessExit = (
    code: number | null,
    signal: NodeJS.Signals | null = null,
  ) => {
    this.dispatch({
      type: "process-exit",
      disposition: { status: "exited", code, signal },
    });
  };

  private dispatch(event: LifecycleEvent): void {
    const reduced = reduceRendererLifecycle(this.state, event);
    this.state = reduced.state;
    for (const effect of reduced.effects) {
      this.execute(effect);
    }
  }

  private execute(effect: LifecycleEffect): void {
    switch (effect.type) {
      case "drain-protocol": {
        this.protocolDrainController = new AbortController();
        const protocolController = this.protocolDrainController;
        void Promise.resolve()
          .then(() => this.options.readProtocol(protocolController.signal))
          .then(
            (result) => {
              this.releaseProtocolDrain(protocolController);
              this.dispatch({
                type: "protocol-result",
                result: { status: "fulfilled", result },
              });
            },
            (error: unknown) => {
              this.releaseProtocolDrain(protocolController);
              this.dispatch({
                type: "protocol-result",
                result: { status: "rejected", error },
              });
            },
          );
        return;
      }
      case "stop-protocol-drain":
        this.protocolDrainController?.abort(
          new Error("renderer protocol drain stopped by lifecycle decision"),
        );
        return;
      case "terminate-process": {
        const child = this.options.child;
        if (child === undefined) {
          this.dispatch({
            type: "termination-complete",
            error: new Error("renderer process was not started"),
          });
          return;
        }
        void Promise.resolve()
          .then(() =>
            this.options.terminateProcess(child, {
              cause: effect.cause,
              escalate: (
                error = new Error("renderer termination escalated"),
              ) => {
                this.dispatch({ type: "escalation", error });
              },
            }),
          )
          .then(
            () => this.dispatch({ type: "termination-complete" }),
            (error: unknown) =>
              this.dispatch({ type: "termination-complete", error }),
          );
        return;
      }
      case "cleanup":
        void Promise.resolve()
          .then(this.options.cleanupProtocol)
          .then(
            () => this.dispatch({ type: "cleanup-complete" }),
            (error: unknown) =>
              this.dispatch({ type: "cleanup-complete", error }),
          );
        return;
      case "finalize":
        this.finalize(effect.outcome);
        return;
      case "diagnostic":
        return;
    }
  }

  private finalize(outcome: LifecycleOutcome): void {
    if (this.completionSettled) {
      return;
    }
    this.completionSettled = true;
    this.protocolDrainController?.abort(
      new Error("renderer lifecycle finalized"),
    );
    this.protocolDrainController = undefined;
    this.options.signal?.removeEventListener("abort", this.onAbort);
    this.options.child?.off?.("exit", this.onProcessExit);
    if (this.timeoutHandle !== undefined) {
      const clear =
        this.options.clearScheduledTimeout ??
        ((handle: unknown) =>
          clearTimeout(handle as ReturnType<typeof setTimeout>));
      clear(this.timeoutHandle);
      this.timeoutHandle = undefined;
    }
    try {
      this.options.mapFinalOutcome(outcome, this.state);
      this.resolveCompletion();
    } catch (error) {
      this.rejectCompletion(error);
    }
  }

  private releaseProtocolDrain(controller: AbortController): void {
    if (this.protocolDrainController === controller) {
      this.protocolDrainController = undefined;
    }
  }
}

export interface RendererEventProtocol {
  job: unknown;
  eventLogPath: string;
  temporaryDirectory?: string;
}

async function runStartupFailureLifecycle(
  primaryError: unknown,
  cleanupProtocol: () => Promise<void> | void,
  usesDefaultWaitForProcess: boolean,
  rendererJob: unknown,
  configuredWarningWriter: ((message: string) => void) | undefined,
): Promise<void> {
  const owner = new RendererLifecycleOwner({
    adapter: usesDefaultWaitForProcess ? "built-in" : "custom",
    protocol: usesDefaultWaitForProcess ? "required" : "bypassed",
    waitForProcess: async () => {},
    readProtocol: async () => [],
    cleanupProtocol,
    terminateProcess: async () => {},
    mapFinalOutcome: (outcome, state) =>
      finishRendererOutcome(
        outcome,
        state,
        usesDefaultWaitForProcess,
        rendererJob,
        configuredWarningWriter,
        [],
      ),
  });
  await owner.failStartup(primaryError);
}

function finishRendererOutcome(
  outcome: LifecycleOutcome,
  state: RendererLifecycleState,
  usesDefaultWaitForProcess: boolean,
  rendererJob: unknown,
  configuredWarningWriter: ((message: string) => void) | undefined,
  bufferedWarnings: readonly string[],
): void {
  if (outcome.status === "rejected") {
    if (outcome.diagnostics.length > 0) {
      throw errorWithLifecycleDiagnostics(outcome.error, outcome.diagnostics);
    }
    throw outcome.error;
  }
  if (outcome.diagnostics.length > 0) {
    throw errorWithLifecycleDiagnostics(
      new Error("renderer completed but lifecycle cleanup failed"),
      outcome.diagnostics,
    );
  }
  if (!usesDefaultWaitForProcess) {
    return;
  }

  const writeWarning =
    configuredWarningWriter ??
    ((message: string) => {
      process.stderr.write(message);
    });
  const protocolEvidence =
    state.protocolResult?.status === "fulfilled"
      ? state.protocolResult.result
      : undefined;
  const events = Array.isArray(protocolEvidence)
    ? (protocolEvidence as ReturnType<typeof readRendererEvents>)
    : [];
  const reportWarning = readRendererReportSuccessWarning(rendererJob);
  if (reportWarning) {
    writeWarning(`Renderer warning: ${reportWarning}\n`);
    return;
  }

  const eventWarning = extractRendererEventSuccessWarning(events);
  if (eventWarning) {
    writeWarning(`Renderer warning: ${eventWarning}\n`);
    return;
  }
  for (const warning of bufferedWarnings) {
    writeWarning(warning);
  }
}

function rendererCancellationError(reason: unknown): RendererCancelledError {
  const detail =
    reason instanceof Error
      ? reason.message
      : typeof reason === "string"
        ? reason
        : undefined;
  return new RendererCancelledError(
    detail ? `renderer execution was cancelled: ${detail}` : undefined,
  );
}

function resolveRendererTimeoutMs(timeoutMs: number): number {
  return Number.isFinite(timeoutMs) && timeoutMs >= 0
    ? Math.floor(timeoutMs)
    : 0;
}

function errorWithLifecycleDiagnostics(
  primaryError: unknown,
  diagnostics: readonly unknown[],
): Error {
  return new Error(
    [
      errorMessage(primaryError),
      "Secondary renderer lifecycle diagnostics:",
      ...diagnostics.map((diagnostic) => `- ${errorMessage(diagnostic)}`),
    ].join("\n"),
    { cause: primaryError },
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function terminateRendererProcess(
  child: RendererProcess,
  context: RendererTerminationContext,
  configuredGraceMs: number | undefined,
): Promise<void> {
  if (rendererProcessHasExited(child)) {
    return;
  }
  if (process.platform === "win32" && child.pid !== undefined) {
    const pid = child.pid;
    await new Promise<void>((resolve, reject) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      let launchError: Error | undefined;
      killer.once("error", (error) => {
        launchError = error;
      });
      killer.once("close", (code) => {
        if (rendererProcessHasExited(child) || (code === 0 && !launchError)) {
          resolve();
          return;
        }
        // Windows can observe the process disappearing before libuv delivers
        // the renderer's exit event. Inspect only our PID, without a signal;
        // permission failures do not establish that the process is gone.
        try {
          process.kill(pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            resolve();
            return;
          }
        }
        reject(
          launchError ?? new Error(`taskkill exited with code ${code ?? -1}`),
        );
      });
    });
    return;
  }

  const graceMs =
    configuredGraceMs !== undefined &&
    Number.isFinite(configuredGraceMs) &&
    configuredGraceMs >= 0
      ? Math.floor(configuredGraceMs)
      : 1_000;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let escalationTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      if (escalationTimer !== undefined) {
        clearTimeout(escalationTimer);
        escalationTimer = undefined;
      }
      child.off?.("exit", onExit);
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    const onExit = () => finish();
    child.on("exit", onExit);
    try {
      signalRendererProcess(child, "SIGTERM");
    } catch (error) {
      finish(error);
      return;
    }
    escalationTimer = setTimeout(() => {
      context.escalate();
      try {
        signalRendererProcess(child, "SIGKILL");
      } catch (error) {
        if (!rendererProcessHasExited(child)) {
          finish(error);
        }
      }
    }, graceMs);
    escalationTimer.unref();
  });
}

/** Give the native publication fence a short chance before slower platform tree-kill. */
async function waitForCooperativeExit(
  child: RendererProcess,
  configuredGraceMs?: number,
): Promise<void> {
  if (rendererProcessHasExited(child)) return;
  const grace =
    configuredGraceMs !== undefined &&
    Number.isFinite(configuredGraceMs) &&
    configuredGraceMs >= 0
      ? Math.floor(configuredGraceMs)
      : 500;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      child.off?.("exit", finish);
      child.off?.("close", finish);
      resolve();
    };
    const timer = setTimeout(finish, grace);
    child.on("exit", finish);
    child.on("close", finish);
    if (rendererProcessHasExited(child)) finish();
  });
}

function signalRendererProcess(
  child: RendererProcess,
  signal: "SIGTERM" | "SIGKILL",
): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through when the renderer is not a process-group leader.
    }
  }
  if (child.kill === undefined) {
    throw new Error("renderer process does not expose a termination method");
  }
  child.kill(signal);
}

function rendererProcessHasExited(child: RendererProcess): boolean {
  return child.exitCode != null || child.signalCode != null;
}

function prepareRendererEventProtocol(job: unknown): RendererEventProtocol {
  const explicitEventLogPath = rendererEventLogPath(job);
  if (explicitEventLogPath) {
    return { job, eventLogPath: explicitEventLogPath };
  }

  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "velocast-renderer-events-"),
  );
  const eventLogPath = join(temporaryDirectory, "events.jsonl");
  return {
    job: { ...(isObjectRecord(job) ? job : {}), event_log_path: eventLogPath },
    eventLogPath,
    temporaryDirectory,
  };
}

function cleanupTemporaryRendererEventProtocol(
  eventProtocol: RendererEventProtocol,
): void {
  if (eventProtocol.temporaryDirectory === undefined) {
    return;
  }

  rmSync(eventProtocol.temporaryDirectory, { recursive: true, force: true });
}

function readRendererEvents(eventLogPath: string) {
  if (!existsSync(eventLogPath)) {
    return [];
  }
  return parseRendererEventLog(readFileSync(eventLogPath, "utf8"));
}

function rendererEventLogPath(job: unknown): string | undefined {
  if (!isObjectRecord(job)) {
    return undefined;
  }
  const eventLogPath = job.event_log_path;
  return typeof eventLogPath === "string" && eventLogPath.trim()
    ? eventLogPath
    : undefined;
}

function readRendererReportSuccessWarning(job: unknown): string | undefined {
  const reportPath = rendererReportPath(job);
  if (!reportPath) {
    return undefined;
  }

  try {
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as unknown;
    return extractRendererReportSuccessWarning(report);
  } catch {
    return undefined;
  }
}

function rendererReportPath(job: unknown): string | undefined {
  if (!isObjectRecord(job)) {
    return undefined;
  }
  const reportPath = job.report_path;
  return typeof reportPath === "string" && reportPath.trim()
    ? reportPath
    : undefined;
}
