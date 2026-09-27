import type {
  AudioPlan,
  CompositionManifest,
  FrameRange,
  RenderSession,
} from "@velocast/core";

/** Prepared, paused clock over the shared audio plan's composition sample timeline. */
export interface AudioPlanClock {
  readonly sampleRate: number;
  readonly durationSamples: number;
  currentSample(): number;
  play(sample?: number): Promise<void>;
  pause(): void;
  seek(sample: number): void;
  dispose(): Promise<void>;
}

export interface PreviewSource {
  readonly session: RenderSession & { readonly sourceVersion: string };
  readonly composition: CompositionManifest;
  /** Caller-owned immutable inputs; a source refresh supplies a new version. */
  readonly inputProps?: unknown;
  readonly audioPlan?: AudioPlan;
}

/** dispose must join any abandoned work before a new initialize may proceed. */
export interface PreviewTransport<Frame> {
  initialize(source: PreviewSource, signal: AbortSignal): Promise<void>;
  seekFrame(
    frame: number,
    source: PreviewSource,
    signal: AbortSignal,
  ): Promise<Frame>;
  dispose(): Promise<void>;
}

export interface PreviewState<Frame> {
  readonly phase:
    "idle" | "loading" | "seeking" | "ready" | "playing" | "error" | "disposed";
  readonly source?: PreviewSource;
  readonly requestedFrame?: number;
  readonly presentedFrame?: number;
  readonly frame?: Frame;
  readonly error?: Error;
  readonly range?: FrameRange;
  readonly playing?: boolean;
  readonly ended?: boolean;
}

export interface PreviewScheduler {
  /** Monotonic milliseconds; ignored for media time when an audio clock exists. */
  now(): number;
  /** Queue one asynchronous callback; return its cancellation function. */
  schedule(callback: () => void): () => void;
}

export interface PreviewControllerOptions<Frame> {
  readonly transport: PreviewTransport<Frame>;
  readonly prepareAudio?: (
    plan: AudioPlan,
    source: PreviewSource,
    signal: AbortSignal,
  ) => Promise<AudioPlanClock>;
  readonly scheduler?: PreviewScheduler;
}
