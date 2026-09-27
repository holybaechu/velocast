/** The browser side of the supported Remotion render-entry profiles. */
export interface UpstreamRemotionBridgeOptions {
  readonly profile?: "legacy-4" | "modern-4";
  readonly composition: {
    readonly id: string;
    readonly width: number;
    readonly height: number;
    readonly fps: number;
    readonly durationInFrames: number;
    readonly defaultCodec?: string | null;
    readonly defaultOutName?: string | null;
    readonly defaultVideoImageFormat?: string | null;
    readonly defaultPixelFormat?: string | null;
    readonly defaultProResProfile?: string | null;
    readonly defaultSampleRate?: number | null;
    /** Produced by NoReactInternals.serializeJSONWithDate().serializedString. */
    readonly serializedResolvedPropsWithCustomSchema: string;
  };
  readonly inputProps: unknown;
  /** Produced by NoReactInternals.serializeJSONWithDate().serializedString. */
  readonly serializedInputPropsWithCustomSchema: string;
  readonly mediaProxyPort: number;
  readonly timeoutInMilliseconds: number;
  readonly protocolVersion: number;
}

/**
 * Inject immediately before the upstream bundle.js script in a copy of its HTML.
 * Keep this function self-contained: its source is serialized into that page.
 */
function installUpstreamRemotionBridge(
  options: UpstreamRemotionBridgeOptions,
): void {
  type BrowserWindow = Window & {
    process?: { env?: Record<string, string> };
    remotion_puppeteerTimeout?: number;
    remotion_inputProps?: string;
    remotion_initialFrame?: number;
    remotion_attempt?: number;
    remotion_proxyPort?: number;
    remotion_audioEnabled?: boolean;
    remotion_videoEnabled?: boolean;
    remotion_isMainTab?: boolean;
    remotion_mediaCacheSizeInBytes?: number | null;
    remotion_initialMemoryAvailable?: number;
    remotion_sampleRate?: number;
    remotion_logLevel?: string;
    remotion_broadcastChannel?: BroadcastChannel;
    remotion_renderReady?: boolean;
    remotion_cancelledError?: string;
    remotion_delayRenderTimeouts?: Record<string, { label: string | null }>;
    remotion_setBundleMode?: (mode: unknown) => void;
    remotion_setFrame?: (
      frame: number,
      compositionId: string,
      attempt: number,
    ) => void;
  };
  const page = window as BrowserWindow;
  const composition = options.composition;
  const manifest = Object.freeze({
    id: composition.id,
    width: composition.width,
    height: composition.height,
    fps: composition.fps,
    durationFrames: composition.durationInFrames,
    target: "#remotion-canvas",
  });
  const propsSnapshot = JSON.stringify(options.inputProps ?? {});
  let session: { sessionId: string; sourceVersion?: string } | undefined;
  let generation = 0;
  let destroyed = false;
  let selected = false;
  let selecting: Promise<void> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let lastSeekGeneration = 0;
  let browserError: string | undefined;

  // Remotion reads these values at module evaluation, before it mounts React.
  page.process ??= {};
  page.process.env ??= {};
  page.process.env.NODE_ENV = "production";
  page.remotion_puppeteerTimeout = options.timeoutInMilliseconds;
  page.remotion_inputProps = options.serializedInputPropsWithCustomSchema;
  page.remotion_initialFrame = 0;
  page.remotion_attempt = 1;
  page.remotion_proxyPort = options.mediaProxyPort;
  page.remotion_audioEnabled = true;
  page.remotion_videoEnabled = true;
  page.remotion_renderReady = false;
  if (options.profile === "modern-4") {
    page.remotion_isMainTab = true;
    page.remotion_mediaCacheSizeInBytes = null;
    page.remotion_initialMemoryAvailable = 512 * 1024 * 1024;
    page.remotion_sampleRate = composition.defaultSampleRate ?? 48_000;
    page.remotion_logLevel = "warn";
    if (typeof BroadcastChannel === "function") {
      page.remotion_broadcastChannel = new BroadcastChannel(
        "remotion-video-frame-extraction",
      );
    }
  }

  const describeError = (error: unknown): string =>
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  window.addEventListener("error", (event) => {
    browserError ??= describeError(event.error ?? event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    browserError ??= describeError(event.reason);
  });

  const check = (expectedGeneration: number, startedAt: number): void => {
    if (destroyed)
      throw new Error("VELOCAST_DESTROYED: Remotion bridge was destroyed");
    if (generation !== expectedGeneration) {
      throw new Error("VELOCAST_CANCELLED: Remotion operation was cancelled");
    }
    if (page.remotion_cancelledError !== undefined) {
      throw new Error(`REMOTION_CANCELLED: ${page.remotion_cancelledError}`);
    }
    if (browserError !== undefined) {
      throw new Error(`REMOTION_BROWSER_ERROR: ${browserError}`);
    }
    if (Date.now() - startedAt > options.timeoutInMilliseconds) {
      const handles = Object.values(page.remotion_delayRenderTimeouts ?? {})
        .map((handle) => handle.label ?? "unlabeled")
        .join(", ");
      throw new Error(
        `REMOTION_TIMEOUT: Timed out after ${options.timeoutInMilliseconds}ms` +
          (handles ? `; open delayRender handles: ${handles}` : ""),
      );
    }
  };

  const poll = async (
    predicate: () => boolean,
    expectedGeneration: number,
    startedAt: number,
  ): Promise<void> => {
    for (;;) {
      check(expectedGeneration, startedAt);
      if (predicate()) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 8));
    }
  };

  const bounded = async <T>(
    pending: Promise<T>,
    expectedGeneration: number,
    startedAt: number,
  ): Promise<T> => {
    check(expectedGeneration, startedAt);
    let interval: ReturnType<typeof setInterval> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          interval = setInterval(() => {
            try {
              check(expectedGeneration, startedAt);
            } catch (error) {
              reject(error);
            }
          }, 8);
        }),
      ]);
    } finally {
      if (interval !== undefined) clearInterval(interval);
      check(expectedGeneration, startedAt);
    }
  };

  const paint = async (
    expectedGeneration: number,
    startedAt: number,
  ): Promise<void> => {
    await bounded(
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      expectedGeneration,
      startedAt,
    );
    await bounded(
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      expectedGeneration,
      startedAt,
    );
  };

  const ready = async (
    expectedGeneration: number,
    startedAt: number,
  ): Promise<void> => {
    await poll(
      () => page.remotion_renderReady === true,
      expectedGeneration,
      startedAt,
    );
    if (document.fonts) {
      await bounded(document.fonts.ready, expectedGeneration, startedAt);
    }
    await paint(expectedGeneration, startedAt);
    // A delayed effect can call delayRender() during the paint cycle.
    await poll(
      () => page.remotion_renderReady === true,
      expectedGeneration,
      startedAt,
    );
  };

  const select = async (
    expectedGeneration: number,
    startedAt: number,
  ): Promise<void> => {
    if (selected) return;
    if (!selecting) {
      selecting = (async () => {
        await poll(
          () => typeof page.remotion_setBundleMode === "function",
          expectedGeneration,
          startedAt,
        );
        check(expectedGeneration, startedAt);
        page.remotion_setBundleMode!({
          type: "composition",
          compositionName: composition.id,
          serializedResolvedPropsWithSchema:
            composition.serializedResolvedPropsWithCustomSchema,
          compositionDurationInFrames: composition.durationInFrames,
          compositionFps: composition.fps,
          compositionHeight: composition.height,
          compositionWidth: composition.width,
          compositionDefaultCodec: composition.defaultCodec ?? null,
          ...(options.profile === "modern-4"
            ? {
                compositionDefaultOutName: composition.defaultOutName ?? null,
                compositionDefaultVideoImageFormat:
                  composition.defaultVideoImageFormat ?? null,
                compositionDefaultPixelFormat:
                  composition.defaultPixelFormat ?? null,
                compositionDefaultProResProfile:
                  composition.defaultProResProfile ?? null,
                compositionDefaultSampleRate:
                  composition.defaultSampleRate ?? null,
              }
            : {}),
        });
        await ready(expectedGeneration, startedAt);
        await poll(
          () => typeof page.remotion_setFrame === "function",
          expectedGeneration,
          startedAt,
        );
        if (!document.getElementById("remotion-canvas")) {
          throw new Error(
            "REMOTION_CANVAS_MISSING: Upstream composition did not mount",
          );
        }
        selected = true;
      })().catch((error: unknown) => {
        selecting = undefined;
        throw error;
      });
    }
    await selecting;
    check(expectedGeneration, startedAt);
  };

  const run = <T>(
    operation: (expectedGeneration: number, startedAt: number) => Promise<T>,
  ): Promise<T> => {
    const expectedGeneration = generation;
    const startedAt = Date.now();
    const result = queue.then(async () => {
      check(expectedGeneration, startedAt);
      return operation(expectedGeneration, startedAt);
    });
    queue = result.catch(() => undefined);
    return result;
  };

  const validateComposition = (id: string): void => {
    if (id !== composition.id) {
      throw new Error(`VELOCAST_COMPOSITION_NOT_FOUND: ${id}`);
    }
  };
  const validateProps = (props: unknown): void => {
    if (JSON.stringify(props ?? {}) !== propsSnapshot) {
      throw new Error(
        "VELOCAST_INPUT_PROPS_MISMATCH: Remotion props are fixed for this bundle",
      );
    }
  };
  const validateContext = (
    context:
      | {
          inputProps?: unknown;
          renderSession?: {
            sessionId: string;
            sourceVersion?: string | null;
          } | null;
        }
      | undefined,
  ): void => {
    if (
      session &&
      (!context?.renderSession ||
        context.renderSession.sessionId !== session.sessionId ||
        (context.renderSession.sourceVersion ?? undefined) !==
          session.sourceVersion)
    ) {
      throw new Error("VELOCAST_SESSION_MISMATCH: Render session changed");
    }
    if (
      context &&
      Object.prototype.hasOwnProperty.call(context, "inputProps")
    ) {
      validateProps(context.inputProps);
    }
  };

  page.__velocast = {
    protocolVersion: options.protocolVersion,
    beginSession: (next) =>
      run(async () => {
        if (
          !next ||
          typeof next.sessionId !== "string" ||
          !next.sessionId.trim() ||
          (next.sourceVersion != null &&
            (typeof next.sourceVersion !== "string" ||
              !next.sourceVersion.trim()))
        ) {
          throw new Error(
            "VELOCAST_SESSION_INVALID: sessionId and sourceVersion must be non-empty",
          );
        }
        if (
          session &&
          (session.sessionId !== next.sessionId ||
            session.sourceVersion !== (next.sourceVersion ?? undefined))
        ) {
          throw new Error("VELOCAST_SESSION_MISMATCH: Render session changed");
        }
        session ??= Object.freeze({
          sessionId: next.sessionId,
          ...(next.sourceVersion == null
            ? {}
            : { sourceVersion: next.sourceVersion }),
        });
      }),
    getSession: () => session && { ...session },
    cancelPending: () => {
      generation++;
    },
    getCompositions: () =>
      run(async (expectedGeneration, startedAt) => {
        await select(expectedGeneration, startedAt);
        return [{ ...manifest }];
      }),
    getDurationFrames: (id) =>
      run(async (expectedGeneration, startedAt) => {
        validateComposition(id);
        await select(expectedGeneration, startedAt);
        return composition.durationInFrames;
      }),
    getAudioPlan: (id, context) =>
      run(async () => {
        validateComposition(id);
        validateContext(context);
        return null;
      }),
    seekFrame: (id, frame, context) =>
      run(async (expectedGeneration, startedAt) => {
        validateComposition(id);
        validateContext(context);
        if (!Number.isFinite(frame))
          throw new Error("VELOCAST_INVALID_FRAME: frame must be finite");
        await select(expectedGeneration, startedAt);
        await ready(expectedGeneration, startedAt);
        check(expectedGeneration, startedAt);
        const selectedFrame = Math.max(
          0,
          Math.min(composition.durationInFrames - 1, Math.floor(frame)),
        );
        page.remotion_setFrame!(selectedFrame, composition.id, 1);
        await ready(expectedGeneration, startedAt);
        check(expectedGeneration, startedAt);
        lastSeekGeneration = expectedGeneration;
      }),
    setInputProps: (props) =>
      run(async () => {
        validateProps(props);
      }),
    waitForReady: () =>
      run(async (expectedGeneration, startedAt) => {
        await select(expectedGeneration, startedAt);
        await ready(expectedGeneration, startedAt);
        if (lastSeekGeneration !== expectedGeneration) {
          throw new Error("VELOCAST_CANCELLED: Last seek was invalidated");
        }
      }),
    destroy: async () => {
      generation++;
      destroyed = true;
      await queue;
      page.remotion_broadcastChannel?.close();
    },
  };
}

/** A self-contained inline script for the original Remotion bundle HTML. */
export function createUpstreamRemotionBridgeScript(
  options: UpstreamRemotionBridgeOptions,
): string {
  if (
    !options.composition.id ||
    !Number.isSafeInteger(options.composition.durationInFrames) ||
    options.composition.durationInFrames < 1 ||
    !Number.isSafeInteger(options.mediaProxyPort) ||
    options.mediaProxyPort < 1 ||
    !Number.isSafeInteger(options.timeoutInMilliseconds) ||
    options.timeoutInMilliseconds < 1
  ) {
    throw new Error("Invalid upstream Remotion bridge options");
  }
  // Escape `<` so user props cannot terminate the containing inline script tag.
  const serializedOptions = JSON.stringify(options).replace(/</g, "\\u003c");
  return `(${installUpstreamRemotionBridge.toString()})(${serializedOptions});`;
}
