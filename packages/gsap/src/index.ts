import {
  defineFrameComposition,
  registerFrameAdapter,
  type BrowserProtocol,
  type CompositionDefinition,
  type FrameComposition,
  type FrameAdapter,
  type FrameAdapterRegistrationOptions,
  type FrameSourceContext,
} from "@velocast/core";
export { startVelocast } from "@velocast/core";

export type GsapTimeline = {
  duration(): number;
  /** Includes repeats and repeat delays; may be infinite for an unbounded repeat. */
  totalDuration?(): number;
  totalTime(timeSeconds: number, suppressEvents?: boolean): unknown;
  paused?(): boolean;
  pause(): unknown;
  revert?(): unknown;
  kill?(): unknown;
};

export interface GsapAdapterOptions {
  compositionId: string;
  fps: number;
  durationFrames?: number;
}

export interface GsapTimelineRegistrationOptions extends FrameAdapterRegistrationOptions {
  durationFrames?: number;
}

/** A pure composition definition. A fresh timeline is made for each opened frame session. */
export interface GsapCompositionOptions<Props = unknown> {
  id: string;
  video: CompositionDefinition;
  createTimeline(
    context: FrameSourceContext<Props>,
  ): GsapTimeline | Promise<GsapTimeline>;
  defaultProps?: Props;
  parseProps?: (input: unknown) => Props;
  rootElement?: HTMLElement | string;
}

// Retained only so existing callers that omit option values do not
// change output in a patch release. New registrations must state their authored
// dimensions and frame rate explicitly; remove these in a versioned API change.
const LEGACY_DEFAULT_FPS = 30;
const LEGACY_DEFAULT_WIDTH = 1920;
const LEGACY_DEFAULT_HEIGHT = 1080;

function error(code: string, message: string): Error {
  return new Error(`${code}: ${message}`);
}

function assertTimeline(value: unknown): asserts value is GsapTimeline {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw error(
      "VELOCAST_GSAP_INVALID_TIMELINE",
      "registered value must be a GSAP timeline",
    );
  }

  const candidate = value as Partial<GsapTimeline>;
  if (
    typeof candidate.duration !== "function" ||
    (candidate.totalDuration !== undefined &&
      typeof candidate.totalDuration !== "function") ||
    typeof candidate.totalTime !== "function" ||
    typeof candidate.pause !== "function" ||
    (candidate.paused !== undefined &&
      typeof candidate.paused !== "function") ||
    (candidate.kill !== undefined && typeof candidate.kill !== "function") ||
    (candidate.revert !== undefined && typeof candidate.revert !== "function")
  ) {
    throw error(
      "VELOCAST_GSAP_INVALID_TIMELINE",
      "registered value must expose duration(), totalTime(), pause(), and optional paused(), revert(), kill()",
    );
  }
}

function validateFps(fps: unknown): number {
  if (typeof fps !== "number" || !Number.isSafeInteger(fps) || fps <= 0) {
    throw error(
      "VELOCAST_GSAP_INVALID_OPTIONS",
      "fps must be a positive integer",
    );
  }

  return fps;
}

function validateDimension(value: unknown, key: "width" | "height"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw error(
      "VELOCAST_GSAP_INVALID_OPTIONS",
      `${key} must be a positive integer`,
    );
  }

  return value;
}

function validateTarget(target: unknown): string | undefined {
  if (target === undefined) {
    return undefined;
  }

  if (typeof target !== "string" || !target.trim()) {
    throw error(
      "VELOCAST_GSAP_INVALID_OPTIONS",
      "target must be a non-empty string",
    );
  }

  return target.trim();
}

function validateDurationFrames(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw error(
      "VELOCAST_GSAP_INVALID_OPTIONS",
      "durationFrames must be a positive integer",
    );
  }

  return value;
}

function resolveDurationFrames(
  timeline: GsapTimeline,
  fps: number,
  durationFramesOverride: number | undefined,
): number {
  if (durationFramesOverride !== undefined) {
    return durationFramesOverride;
  }

  // GSAP's duration() excludes repetitions. totalDuration() covers the full
  // timeline, including repeatDelay, when that method is available.
  const durationSeconds = timeline.totalDuration?.() ?? timeline.duration();
  if (
    typeof durationSeconds !== "number" ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    throw error(
      "VELOCAST_GSAP_INVALID_TIMELINE",
      "timeline total duration must be finite and positive; provide durationFrames for an infinite timeline",
    );
  }

  const durationFrames = Math.ceil(durationSeconds * fps);
  if (!Number.isSafeInteger(durationFrames) || durationFrames <= 0) {
    throw error(
      "VELOCAST_GSAP_INVALID_TIMELINE",
      "timeline duration must resolve to a positive frame count",
    );
  }

  return durationFrames;
}

function ensurePaused(timeline: GsapTimeline): void {
  if (timeline.paused === undefined || timeline.paused() === false) {
    timeline.pause();
  }
}

function restoreTimeline(timeline: GsapTimeline): void {
  // revert() also removes GSAP's inline styles, so a later session starts from
  // the authored DOM state. Older timeline duck types can still use kill().
  if (timeline.revert) {
    timeline.revert();
  } else {
    timeline.kill?.();
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw (
      signal.reason ??
      error("VELOCAST_GSAP_CANCELLED", "frame session cancelled")
    );
  }
}

function validateRegistrationOptionsShape(
  options: GsapTimelineRegistrationOptions | undefined,
): GsapTimelineRegistrationOptions | undefined {
  if (options === undefined) {
    return undefined;
  }

  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options)
  ) {
    throw error(
      "VELOCAST_GSAP_INVALID_OPTIONS",
      "options must be an object when provided",
    );
  }

  return options;
}

function validateAdapterOptionsShape(
  options: GsapAdapterOptions | undefined,
): GsapAdapterOptions {
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options)
  ) {
    throw error("VELOCAST_GSAP_INVALID_OPTIONS", "options must be an object");
  }

  return options;
}

function resolveRegistrationOptions(
  compositionId: string,
  options: GsapTimelineRegistrationOptions | undefined,
): GsapTimelineRegistrationOptions {
  const normalizedOptions = validateRegistrationOptionsShape(options);
  const fps = validateFps(normalizedOptions?.fps ?? LEGACY_DEFAULT_FPS);
  const width = validateDimension(
    normalizedOptions?.width ?? LEGACY_DEFAULT_WIDTH,
    "width",
  );
  const height = validateDimension(
    normalizedOptions?.height ?? LEGACY_DEFAULT_HEIGHT,
    "height",
  );
  const target =
    validateTarget(normalizedOptions?.target) ?? `#${compositionId}`;

  return {
    ...normalizedOptions,
    fps,
    width,
    height,
    target,
  };
}

export function createGsapFrameAdapter(
  timeline: unknown,
  options: GsapAdapterOptions,
): FrameAdapter {
  assertTimeline(timeline);
  const normalizedOptions = validateAdapterOptionsShape(options);

  const fps = validateFps(normalizedOptions.fps);
  const durationFrames = resolveDurationFrames(
    timeline,
    fps,
    validateDurationFrames(normalizedOptions.durationFrames),
  );
  ensurePaused(timeline);

  return {
    id: "gsap",
    init() {
      ensurePaused(timeline);
    },
    getDurationFrames() {
      return durationFrames;
    },
    seekFrame(frame) {
      timeline.totalTime(frame / fps, false);
    },
  };
}

/**
 * Define a GSAP composition without creating a timeline or touching the DOM.
 *
 * `video.durationFrames` is required because the catalog is available before
 * the timeline factory runs. Seeking suppresses GSAP callbacks, including on
 * reverse and repeated seeks; render callbacks belong in `createTimeline` or
 * frame-dependent code instead of timeline events.
 */
export function defineGsapComposition<Props = unknown>(
  options: GsapCompositionOptions<Props>,
): FrameComposition {
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options)
  ) {
    throw error("VELOCAST_GSAP_INVALID_OPTIONS", "options must be an object");
  }
  if (typeof options.createTimeline !== "function") {
    throw error(
      "VELOCAST_GSAP_INVALID_OPTIONS",
      "createTimeline must be a function",
    );
  }
  if (typeof options.video !== "object" || options.video === null) {
    throw error("VELOCAST_GSAP_INVALID_OPTIONS", "video must be an object");
  }
  const fps = validateFps(options.video.fps);
  const createTimeline = options.createTimeline;
  validateDimension(options.video.width, "width");
  validateDimension(options.video.height, "height");
  if (validateDurationFrames(options.video.durationFrames) === undefined) {
    throw error(
      "VELOCAST_GSAP_INVALID_OPTIONS",
      "video.durationFrames is required",
    );
  }

  return defineFrameComposition<Props>({
    id: options.id,
    video: options.video,
    defaultProps: options.defaultProps,
    parseProps: options.parseProps,
    rootElement: options.rootElement,
    source: {
      async open(context) {
        throwIfAborted(context.signal);
        const timeline = await createTimeline(context);
        assertTimeline(timeline);
        if (context.signal.aborted) {
          restoreTimeline(timeline);
          throwIfAborted(context.signal);
        }
        ensurePaused(timeline);
        let disposed = false;

        return {
          seekFrame(frame, seekContext) {
            throwIfAborted(seekContext.signal);
            if (disposed) {
              throw error(
                "VELOCAST_GSAP_DISPOSED",
                "frame session is disposed",
              );
            }
            timeline.totalTime(frame / fps, true);
          },
          dispose() {
            if (disposed) return;
            disposed = true;
            restoreTimeline(timeline);
          },
        };
      },
    },
  });
}

/**
 * Register a timeline with explicit authored dimensions and frame rate.
 *
 * Omitting `options` retains the legacy 1920x1080 at 30fps behavior for
 * compatibility only. New callers should always pass `width`, `height`, and
 * `fps`; omission may be removed in a future versioned API change.
 */
export function registerGsapTimeline(
  compositionId: string,
  timeline: unknown,
  options?: GsapTimelineRegistrationOptions,
): BrowserProtocol {
  const registrationOptions = resolveRegistrationOptions(
    compositionId,
    options,
  );
  const adapter = createGsapFrameAdapter(timeline, {
    compositionId,
    fps: registrationOptions.fps,
    durationFrames: registrationOptions.durationFrames,
  });

  return registerFrameAdapter(compositionId, adapter, registrationOptions);
}
