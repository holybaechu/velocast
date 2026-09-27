import { validateAudioPlan, type AudioPlan } from "./audio-plan.js";
import { BROWSER_PROTOCOL_VERSION } from "./generated/browser-contracts.js";
import { requestCancelled, withAbort } from "./internal/cancellation.js";
import {
  defineProject,
  resolveProps,
  snapshotProps,
  type FrameComposition,
  type FrameSession,
  type FrameSourceContext,
  type VelocastProject,
} from "./project.js";
import {
  isNonEmptyString,
  isObjectRecord,
  isPositiveSafeInteger,
} from "./internal/validation.js";
import type {
  BrowserProtocol,
  CompositionManifest,
  FrameAdapter,
  FrameAdapterContext,
  FrameAdapterRegistrationOptions,
  RenderContext,
  RenderSession,
  VelocastGlobal,
} from "./types.js";
import {
  validateCompositionMetadata,
  validateComposition,
  type CompositionMetadata,
} from "./validation.js";

export interface BrowserProtocolOptions {
  setInputProps?(
    inputProps: unknown,
    signal?: AbortSignal,
  ): Promise<void> | void;
  waitForReady?(signal?: AbortSignal): Promise<void> | void;
}

type AdapterRecord = {
  compositionId: string;
  adapter: FrameAdapter;
  metadata: CompositionMetadata;
  rootElement?: FrameAdapterRegistrationOptions["rootElement"];
};

export class VelocastRuntime {
  private readonly adapters = new Map<string, AdapterRecord>();
  private readonly initializedAdapters = new Set<string>();
  private protocolOptions: BrowserProtocolOptions = {};
  private protocolTargetWindow: Window | undefined;
  private inputProps: unknown;
  private renderSession: RenderSession | undefined;
  private readonly pendingOperations = new Map<
    Promise<unknown>,
    AbortController
  >();
  private cancelled = false;
  private teardown: Promise<void> | undefined;
  private protocol: BrowserProtocol | undefined;
  private project: VelocastProject | undefined;
  private projectPrepared = false;

  readonly global: VelocastGlobal = {
    registerAdapter: (compositionId, adapter, options) =>
      this.registerFrameAdapter(compositionId, adapter, options),
  };

  getRenderableCompositions(): CompositionManifest[] {
    if (this.project && !this.projectPrepared) {
      throw stableError(
        "VELOCAST_PROJECT_UNPREPARED",
        "await protocol.getCompositions() or protocol.setInputProps() before reading the prepared catalog",
      );
    }
    return [...this.adapters.values()].map((record) =>
      this.manifestForRecord(record),
    );
  }

  installBrowserProtocol(
    options: BrowserProtocolOptions = {},
    targetWindow: Window = window,
  ): BrowserProtocol {
    this.protocolOptions = { ...options };
    this.protocolTargetWindow = targetWindow;

    if (this.protocol) {
      this.configureReadiness(this.protocol);
      targetWindow.__velocast = this.protocol;
      targetWindow.Velocast = this.global;
      return this.protocol;
    }

    const protocol: BrowserProtocol = {
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      beginSession: async (session) => {
        await this.runOperation(async () => {
          if (
            !session ||
            typeof session.sessionId !== "string" ||
            !session.sessionId.trim() ||
            (session.sourceVersion != null &&
              (typeof session.sourceVersion !== "string" ||
                !session.sourceVersion.trim()))
          ) {
            throw stableError(
              "VELOCAST_SESSION_INVALID",
              "sessionId and any sourceVersion must be non-empty strings",
            );
          }
          if (this.renderSession && !sameSession(this.renderSession, session)) {
            throw stableError(
              "VELOCAST_SESSION_MISMATCH",
              "destroy the previous session before binding another input version",
            );
          }
          this.renderSession = Object.freeze({
            sessionId: session.sessionId,
            ...(session.sourceVersion == null
              ? {}
              : { sourceVersion: session.sourceVersion }),
          });
        });
      },
      getSession: () => this.renderSession && { ...this.renderSession },
      cancelPending: () => this.cancelPending(),
      getCompositions: () =>
        this.runOperation(async (signal) => {
          await this.ensureProjectPrepared(signal);
          return this.getRenderableCompositions();
        }),
      getDurationFrames: (compositionId) =>
        this.runOperation(async (signal) => {
          await this.ensureProjectPrepared(signal);
          return this.getValidatedDurationFrames(
            this.getAdapterRecord(compositionId),
          );
        }),
      getAudioPlan: (compositionId, context) =>
        this.runOperation((signal) =>
          this.getAudioPlan(compositionId, context, signal),
        ),
      seekFrame: async (compositionId, frame, context) => {
        await this.runOperation((signal) =>
          this.seekFrame(compositionId, frame, context, signal),
        );
      },
      destroy: async () => {
        await this.destroyAdapters();
      },
      setInputProps: async (inputProps) => {
        const nextInputProps = this.project
          ? snapshotProps(inputProps)
          : inputProps;
        await this.runOperation(async (signal) => {
          await this.protocolOptions.setInputProps?.(nextInputProps, signal);
          signal.throwIfAborted();
          if (this.project) await this.prepareProject(nextInputProps, signal);
          else this.inputProps = nextInputProps;
        });
      },
    };

    this.configureReadiness(protocol);

    this.protocol = protocol;
    targetWindow.__velocast = protocol;
    targetWindow.Velocast = this.global;
    return protocol;
  }

  private configureReadiness(protocol: BrowserProtocol): void {
    if (!this.protocolOptions.waitForReady) {
      delete protocol.waitForReady;
      return;
    }
    protocol.waitForReady = () =>
      this.runOperation(async (signal) => {
        await this.protocolOptions.waitForReady?.(signal);
        signal.throwIfAborted();
      });
  }

  registerFrameAdapter(
    compositionId: string,
    adapter: FrameAdapter,
    options: FrameAdapterRegistrationOptions,
  ): BrowserProtocol {
    this.assertCatalogMutable();
    validateCompositionId(compositionId);
    validateAdapter(adapter);
    if (this.adapters.has(compositionId)) {
      throw stableError(
        "VELOCAST_DUPLICATE_COMPOSITION",
        `composition ${compositionId} is already registered`,
      );
    }

    this.adapters.set(compositionId, {
      compositionId,
      adapter,
      metadata: normalizeMetadata(compositionId, options),
      rootElement: options.rootElement,
    });

    return this.installBrowserProtocol(
      this.protocolOptions,
      this.protocolTargetWindow ?? window,
    );
  }

  clearFrameAdaptersForTest(): void {
    this.cancelPending();
    this.pendingOperations.clear();
    this.cancelled = false;
    this.teardown = undefined;
    this.adapters.clear();
    this.initializedAdapters.clear();
    this.protocolOptions = {};
    this.protocolTargetWindow = undefined;
    this.inputProps = undefined;
    this.renderSession = undefined;
    this.protocol = undefined;
    this.project = undefined;
    this.projectPrepared = false;
  }

  /** Validate the entire catalog before publishing it or installing the browser protocol. */
  startProject(
    project: VelocastProject | readonly FrameComposition[],
    options: BrowserProtocolOptions = {},
    targetWindow: Window = window,
  ): BrowserProtocol {
    this.assertCatalogMutable();
    const validated = defineProject(
      Array.isArray(project)
        ? project
        : (project as VelocastProject).compositions,
    );
    if (this.project || this.adapters.size)
      throw stableError(
        "VELOCAST_PROJECT_ALREADY_STARTED",
        "a runtime can start one project; use a separate runtime for another catalog",
      );
    this.project = validated;
    return this.installBrowserProtocol(options, targetWindow);
  }

  private assertCatalogMutable(): void {
    if (
      this.renderSession ||
      this.pendingOperations.size ||
      this.initializedAdapters.size ||
      this.teardown
    ) {
      throw stableError(
        "VELOCAST_CATALOG_BOUND",
        "register compositions before binding or opening a render session",
      );
    }
    if (this.project)
      throw stableError(
        "VELOCAST_CATALOG_BOUND",
        "the project catalog is immutable after startup",
      );
  }

  private async ensureProjectPrepared(signal: AbortSignal): Promise<void> {
    if (this.project && !this.projectPrepared)
      await this.prepareProject(this.inputProps, signal);
  }

  private async prepareContext(
    context: RenderContext | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    if (
      this.project &&
      context &&
      Object.prototype.hasOwnProperty.call(context, "inputProps") &&
      !sameProps(snapshotProps(context.inputProps), this.inputProps)
    ) {
      await this.prepareProject(context.inputProps, signal);
    } else {
      await this.ensureProjectPrepared(signal);
    }
  }

  private async prepareProject(
    inputProps: unknown,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.project) return;
    const snapshot = snapshotProps(inputProps);
    if (this.projectPrepared && sameProps(snapshot, this.inputProps)) return;
    const records: AdapterRecord[] = [];
    for (const composition of this.project.compositions) {
      const props = resolveProps(composition, snapshot);
      const video = composition.resolveVideo
        ? await composition.resolveVideo(props, { signal })
        : composition.video!;
      signal.throwIfAborted();
      records.push(this.sourceRecord(composition, props, video));
    }
    // All metadata and props are valid before the previous snapshot is released.
    await this.releaseAdapters();
    signal.throwIfAborted();
    this.adapters.clear();
    for (const record of records)
      this.adapters.set(record.compositionId, record);
    this.inputProps = snapshot;
    this.projectPrepared = true;
  }

  private sourceRecord(
    composition: FrameComposition,
    props: unknown,
    video: import("./types.js").CompositionDefinition,
  ): AdapterRecord {
    const manifest = validateComposition(composition.id, video);
    let session: FrameSession | undefined;
    const sourceContext = (
      context: FrameAdapterContext,
    ): FrameSourceContext => ({
      ...context,
      inputProps: props,
      signal: context.signal!,
    });
    return {
      compositionId: composition.id,
      metadata: normalizeMetadata(composition.id, manifest),
      rootElement: composition.rootElement ?? manifest.target,
      adapter: {
        id: composition.id,
        getDurationFrames: () => manifest.durationFrames,
        init: async (context) => {
          session = await composition.source.open(sourceContext(context));
          if (!session || typeof session.seekFrame !== "function") {
            try {
              if (typeof session?.dispose === "function")
                await session.dispose();
              session = undefined;
            } catch (error) {
              this.cancelled = true;
              throw stableError(
                "VELOCAST_DESTROY_FAILED",
                `Invalid frame session failed during cleanup: ${errorMessage(error)}`,
              );
            }
            throw stableError(
              "VELOCAST_INVALID_SOURCE",
              "source.open must return a frame session",
            );
          }
        },
        seekFrame: (frame, context) =>
          session!.seekFrame(frame, sourceContext(context)),
        getAudioPlan: (context) =>
          session!.getAudioPlan?.(sourceContext(context)) ?? null,
        destroy: async () => {
          await session?.dispose?.();
          session = undefined;
        },
      },
    };
  }

  private getAdapterRecord(compositionId: string): AdapterRecord {
    const record = this.adapters.get(compositionId);
    if (!record) {
      throw stableError(
        "VELOCAST_COMPOSITION_NOT_FOUND",
        `No adapter was registered for composition "${compositionId}".`,
      );
    }

    return record;
  }

  private getValidatedDurationFrames(record: AdapterRecord): number {
    try {
      const durationFrames = record.adapter.getDurationFrames();
      if (!isPositiveSafeInteger(durationFrames)) {
        throw stableError(
          "VELOCAST_INVALID_DURATION",
          `Adapter "${record.compositionId}" returned an invalid duration.`,
        );
      }

      return durationFrames;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("VELOCAST_INVALID_DURATION:")
      ) {
        throw error;
      }

      throw stableError(
        "VELOCAST_INVALID_DURATION",
        `Adapter "${record.compositionId}" failed to provide duration: ${errorMessage(error)}`,
      );
    }
  }

  private manifestForRecord(record: AdapterRecord): CompositionManifest {
    const durationFrames = this.getValidatedDurationFrames(record);
    const manifest: CompositionManifest = {
      id: record.compositionId,
      ...record.metadata,
      durationFrames,
    };

    return manifest;
  }

  private contextForRecord(
    record: AdapterRecord,
    context: RenderContext | undefined,
  ): FrameAdapterContext {
    const manifest = this.manifestForRecord(record);
    return {
      compositionId: record.compositionId,
      width: manifest.width,
      height: manifest.height,
      fps: manifest.fps,
      durationFrames: manifest.durationFrames,
      target: manifest.target,
      inputProps:
        context && Object.prototype.hasOwnProperty.call(context, "inputProps")
          ? context.inputProps
          : this.inputProps,
      renderSession: this.renderSession,
      rootElement: this.resolveRootElement(record.rootElement),
    };
  }

  private async seekFrame(
    compositionId: string,
    frame: number,
    context: RenderContext | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    this.assertSession(context);
    await this.prepareContext(context, signal);
    const record = this.getAdapterRecord(compositionId);
    const normalizedInputFrame =
      typeof frame === "number" && Number.isFinite(frame)
        ? Math.floor(frame)
        : frame;

    try {
      const adapterContext = this.contextForRecord(record, context);
      adapterContext.signal = signal;
      const normalizedFrame = normalizeFrame(
        frame,
        adapterContext.durationFrames,
      );
      await this.initializeAdapter(record, adapterContext, signal);
      await record.adapter.seekFrame(normalizedFrame, adapterContext);
      signal.throwIfAborted();
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw stableError(
        "VELOCAST_SEEK_FAILED",
        `Adapter "${compositionId}" failed while seeking frame ${normalizedInputFrame}: ${errorMessage(error)}`,
      );
    }
  }

  private assertSession(context: RenderContext | undefined): void {
    if (
      this.renderSession &&
      (!context?.renderSession ||
        !sameSession(this.renderSession, context.renderSession))
    ) {
      throw stableError(
        "VELOCAST_SESSION_MISMATCH",
        "request does not belong to the pinned session/source version",
      );
    }
  }

  private async initializeAdapter(
    record: AdapterRecord,
    context: FrameAdapterContext,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.initializedAdapters.has(record.compositionId)) {
      await record.adapter.init?.(context);
      signal.throwIfAborted();
      this.initializedAdapters.add(record.compositionId);
      context.rootElement = this.resolveRootElement(record.rootElement);
    }
  }

  private async getAudioPlan(
    compositionId: string,
    context: RenderContext | undefined,
    signal: AbortSignal,
  ): Promise<AudioPlan | null> {
    this.assertSession(context);
    await this.prepareContext(context, signal);
    const record = this.getAdapterRecord(compositionId);
    try {
      const adapterContext = this.contextForRecord(record, context);
      adapterContext.signal = signal;
      await this.initializeAdapter(record, adapterContext, signal);
      const plan = await record.adapter.getAudioPlan?.(adapterContext);
      signal.throwIfAborted();
      return plan == null ? null : validateAudioPlan(plan);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw stableError(
        "VELOCAST_AUDIO_PLAN_FAILED",
        `Adapter "${compositionId}" failed to resolve audio: ${errorMessage(error)}`,
      );
    }
  }

  private cancelPending(): void {
    this.cancelled = true;
    for (const controller of this.pendingOperations.values()) {
      controller.abort(requestCancelled());
    }
  }

  private runOperation<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.cancelled)
      return Promise.reject(
        stableError(
          "VELOCAST_RUNTIME_CANCELLED",
          "await destroy() or reload the page before another request",
        ),
      );
    if (this.pendingOperations.size)
      return Promise.reject(
        stableError(
          "VELOCAST_RUNTIME_BUSY",
          "another browser operation is still running",
        ),
      );
    const controller = new AbortController();
    const work = Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      })
      .finally(() => this.pendingOperations.delete(work));
    this.pendingOperations.set(work, controller);
    return withAbort(work, controller.signal);
  }

  private destroyAdapters(): Promise<void> {
    if (this.teardown) return this.teardown;
    this.cancelPending();
    let cleaned = false;
    this.teardown = (async () => {
      // Cancellation returns promptly, but old hooks must settle before cleanup
      // and a new mount; otherwise a late old mount could mutate the new frame.
      await Promise.allSettled([...this.pendingOperations.keys()]);
      await this.releaseAdapters();
      this.renderSession = undefined;
      this.projectPrepared = false;
      cleaned = true;
    })().finally(() => {
      this.teardown = undefined;
      this.cancelled = !cleaned;
    });
    return this.teardown;
  }

  private async releaseAdapters(): Promise<void> {
    let destroyFailure: Error | undefined;

    for (const record of this.adapters.values()) {
      try {
        await record.adapter.destroy?.();
      } catch (error) {
        if (!destroyFailure) {
          destroyFailure = stableError(
            "VELOCAST_DESTROY_FAILED",
            `Adapter "${record.adapter.id}" for composition "${record.compositionId}" failed during destroy: ${errorMessage(error)}`,
          );
        }
      }
    }

    this.initializedAdapters.clear();

    this.inputProps = undefined;
    if (destroyFailure) {
      this.cancelled = true;
      throw destroyFailure;
    }
  }

  private resolveRootElement(
    rootElement: HTMLElement | string | undefined,
  ): HTMLElement | undefined {
    if (rootElement === undefined) {
      return undefined;
    }
    if (typeof rootElement !== "string") {
      return rootElement;
    }

    const ownerDocument = this.protocolTargetWindow?.document ?? document;
    return ownerDocument.querySelector<HTMLElement>(rootElement) ?? undefined;
  }
}

export const defaultVelocastRuntime = new VelocastRuntime();

function sameSession(left: RenderSession, right: RenderSession): boolean {
  return (
    left.sessionId === right.sessionId &&
    (left.sourceVersion ?? undefined) === (right.sourceVersion ?? undefined)
  );
}

function sameProps(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object")
    return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        sameProps(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
        ),
    )
  );
}

function stableError(code: string, message: string): Error {
  return new Error(`${code}: ${message}`);
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/^VELOCAST_[A-Z_]+:\s*/, "")
    .replace(/^Adapter ".*" failed to provide duration:\s*/, "");
}

function validateCompositionId(
  compositionId: unknown,
): asserts compositionId is string {
  if (!isNonEmptyString(compositionId)) {
    throw stableError(
      "VELOCAST_INVALID_COMPOSITION",
      "composition id must be a non-empty string",
    );
  }
}

function validateAdapter(adapter: unknown): asserts adapter is FrameAdapter {
  if (!isObjectRecord(adapter)) {
    throw stableError("VELOCAST_INVALID_ADAPTER", "adapter must be an object");
  }

  const candidate = adapter as Partial<FrameAdapter>;
  if (!isNonEmptyString(candidate.id)) {
    throw stableError(
      "VELOCAST_INVALID_ADAPTER",
      "adapter id must be a non-empty string",
    );
  }
  if (typeof candidate.getDurationFrames !== "function") {
    throw stableError(
      "VELOCAST_INVALID_ADAPTER",
      "adapter getDurationFrames must be a function",
    );
  }
  if (typeof candidate.seekFrame !== "function") {
    throw stableError(
      "VELOCAST_INVALID_ADAPTER",
      "adapter seekFrame must be a function",
    );
  }
}

function normalizeMetadata(
  compositionId: string,
  options: FrameAdapterRegistrationOptions,
): CompositionMetadata {
  try {
    return validateCompositionMetadata(compositionId, options);
  } catch (error) {
    throw stableError("VELOCAST_INVALID_COMPOSITION", errorMessage(error));
  }
}

function normalizeFrame(frame: number, durationFrames: number): number {
  if (typeof frame !== "number" || !Number.isFinite(frame)) {
    throw stableError(
      "VELOCAST_INVALID_FRAME",
      "frame must be a finite number",
    );
  }

  const floored = Math.floor(frame);
  return Math.min(Math.max(floored, 0), durationFrames - 1);
}
