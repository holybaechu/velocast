import {
  createFrameRange,
  framesToSeconds,
  framesToSamples,
  samplesToFrames,
  secondsToFrames,
  validateAudioPlan,
  type FrameRange,
} from "@velocast/core";
import type {
  AudioPlanClock,
  PreviewControllerOptions,
  PreviewSource,
  PreviewState,
} from "./types.js";

function cancelled(): Error {
  const error = new Error("preview.cancelled: request was superseded");
  error.name = "AbortError";
  return error;
}
export class PreviewError extends Error {
  constructor(
    readonly code: string,
    cause: unknown,
    readonly cleanupError?: unknown,
  ) {
    super(
      `${code}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "PreviewError";
  }
}
function failure(code: string, cause: unknown): PreviewError {
  return new PreviewError(code, cause);
}
function waitForAudio(work: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(cancelled());
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      () => {
        cleanup();
        resolve();
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}
function snapshotSource(source: PreviewSource): PreviewSource {
  if (
    !source?.session?.sessionId?.trim() ||
    !source.session.sourceVersion?.trim()
  )
    throw new Error("sessionId and sourceVersion are required");
  const composition = source.composition;
  if (!composition?.id?.trim()) throw new Error("composition id is required");
  createFrameRange(0, composition.durationFrames);
  framesToSeconds(0, composition.fps);
  if (
    composition.durationFrames < 1 ||
    !Number.isSafeInteger(composition.width) ||
    composition.width < 1 ||
    !Number.isSafeInteger(composition.height) ||
    composition.height < 1
  )
    throw new Error("composition must have positive dimensions and duration");
  return Object.freeze({
    ...source,
    session: Object.freeze({ ...source.session }),
    composition: Object.freeze({ ...composition }),
    ...(source.audioPlan !== undefined
      ? { audioPlan: validateAudioPlan(source.audioPlan) }
      : {}),
  });
}
function clipFrame(
  frame: number,
  source: PreviewSource,
  range?: FrameRange,
): number {
  if (!Number.isSafeInteger(frame))
    throw new RangeError("frame must be a safe integer");
  return Math.min(
    Math.max(frame, range?.start ?? 0),
    (range?.end ?? source.composition.durationFrames) - 1,
  );
}
interface PendingRequest {
  epoch: number;
  resolve: () => void;
  reject: (error: Error) => void;
}
interface FrameIntent extends PendingRequest {
  kind: "frame";
  revision: number;
  source: PreviewSource;
  frame: number;
  mode: "seek" | "tick";
}
interface ErrorIntent extends PendingRequest {
  kind: "error";
  error: PreviewError;
}
type Intent = FrameIntent | ErrorIntent;

/** One awaited transport operation, a single latest-intent slot, and no stale publication. */
export class PreviewController<Frame> {
  private state: PreviewState<Frame> = Object.freeze({ phase: "idle" });
  private readonly listeners = new Set<(state: PreviewState<Frame>) => void>();
  private desiredSource?: PreviewSource;
  private revision = 0;
  private initializedRevision = 0;
  private epoch = 0;
  private pending?: Intent;
  private active?: AbortController;
  private pump?: Promise<void>;
  private disposed = false;
  private disposal?: Promise<void>;
  private transportDirty = false;
  private audio?: AudioPlanClock;
  private range?: FrameRange;
  private wantsPlayback = false;
  private ended = false;
  private cancelTick?: () => void;
  private tickToken?: object;
  private anchor?: { frame: number; time: number };
  private lastTime?: number;

  constructor(private readonly options: PreviewControllerOptions<Frame>) {}
  getState(): PreviewState<Frame> {
    return this.state;
  }
  subscribe(listener: (state: PreviewState<Frame>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  refresh(
    source: PreviewSource,
    frame = this.state.requestedFrame ?? this.state.presentedFrame ?? 0,
  ): Promise<void> {
    if (this.disposed)
      return Promise.reject(
        new Error("preview.disposed: controller is closed"),
      );
    let next: PreviewSource;
    try {
      next = snapshotSource(source);
      frame = clipFrame(frame, next);
    } catch (cause) {
      return this.invalid("preview.invalid_source", cause);
    }
    this.desiredSource = next;
    this.range = Object.freeze(
      createFrameRange(0, next.composition.durationFrames),
    );
    this.ended = false;
    ++this.revision;
    return this.enqueue(this.desiredSource, frame, "loading");
  }
  seek(frame: number): Promise<void> {
    if (this.disposed)
      return Promise.reject(
        new Error("preview.disposed: controller is closed"),
      );
    if (!this.desiredSource)
      return this.invalid(
        "preview.no_source",
        new Error("refresh a source before seeking"),
      );
    try {
      frame = clipFrame(frame, this.desiredSource, this.range);
    } catch (cause) {
      return this.invalid("preview.invalid_frame", cause);
    }
    this.ended = false;
    return this.enqueue(this.desiredSource, frame, "seeking");
  }
  setPlaybackRange(range: FrameRange): Promise<void> {
    if (this.disposed)
      return Promise.reject(
        new Error("preview.disposed: controller is closed"),
      );
    if (!this.desiredSource)
      return this.invalid(
        "preview.no_source",
        new Error("refresh a source first"),
      );
    try {
      const checked = createFrameRange(range.start, range.end);
      const limited = createFrameRange(
        Math.max(0, checked.start),
        Math.min(this.desiredSource.composition.durationFrames, checked.end),
      );
      if (limited.start === limited.end)
        throw new Error("playback range must contain a frame");
      this.range = Object.freeze(limited);
    } catch (cause) {
      return this.invalid("preview.invalid_range", cause);
    }
    return this.seek(
      this.state.requestedFrame ??
        this.state.presentedFrame ??
        this.range.start,
    );
  }
  play(): Promise<void> {
    if (this.disposed)
      return Promise.reject(
        new Error("preview.disposed: controller is closed"),
      );
    if (!this.desiredSource)
      return this.invalid(
        "preview.no_source",
        new Error("refresh a source first"),
      );
    if (!this.options.scheduler)
      return this.invalid(
        "preview.scheduler_unavailable",
        new Error("playback requires an injected scheduler"),
      );
    if (this.wantsPlayback && this.state.phase === "playing")
      return Promise.resolve();
    const frame = clipFrame(
      this.ended
        ? this.range!.start
        : (this.state.requestedFrame ?? this.state.presentedFrame ?? 0),
      this.desiredSource,
      this.range,
    );
    this.wantsPlayback = true;
    this.ended = false;
    return this.enqueue(this.desiredSource, frame, "seeking");
  }
  pause(): Promise<void> {
    if (this.disposed)
      return Promise.reject(
        new Error("preview.disposed: controller is closed"),
      );
    if (!this.wantsPlayback) {
      try {
        this.stopTick();
        this.audio?.pause();
      } catch (cause) {
        return this.invalid("preview.pause_failed", cause);
      }
      return (async () => {
        await this.pump;
        if (this.state.phase === "error") throw this.state.error;
      })();
    }
    let position: { frame: number; atEnd: boolean };
    try {
      position = this.playbackPosition();
    } catch (cause) {
      return this.invalid("preview.clock_failed", cause);
    }
    this.wantsPlayback = false;
    this.ended = position.atEnd;
    return this.enqueue(this.desiredSource!, position.frame, "seeking");
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.wantsPlayback = false;
    const immediateErrors: unknown[] = [];
    try {
      this.stopTick();
    } catch (error) {
      immediateErrors.push(error);
    }
    try {
      this.audio?.pause();
    } catch (error) {
      immediateErrors.push(error);
    }
    this.invalidate();
    this.disposal = (async () => {
      await this.pump;
      try {
        await this.cleanup();
        if (immediateErrors.length)
          throw new AggregateError(
            immediateErrors,
            "preview immediate stop failed",
          );
        this.publish({ phase: "disposed" });
        this.listeners.clear();
      } catch (cause) {
        const error = failure("preview.dispose_failed", cause);
        this.disposal = undefined;
        this.publish({ ...this.state, phase: "error", error });
        throw error;
      }
    })();
    return this.disposal;
  }

  private invalid(code: string, cause: unknown): Promise<void> {
    this.invalidate();
    this.initializedRevision = 0;
    this.wantsPlayback = false;
    let error = failure(code, cause);
    // Stop sound immediately, but serialize cleanup behind the old seek. A
    // replacement request must not initialize while that cleanup is pending.
    const stopErrors: unknown[] = [];
    try {
      this.stopTick();
    } catch (cleanupError) {
      stopErrors.push(cleanupError);
    }
    try {
      this.audio?.pause();
    } catch (cleanupError) {
      stopErrors.push(cleanupError);
    }
    if (stopErrors.length)
      error = new PreviewError(
        code,
        cause,
        new AggregateError(stopErrors, "preview immediate stop failed"),
      );
    const promise = new Promise<void>((resolve, reject) => {
      this.pending = {
        kind: "error",
        epoch: this.epoch,
        error,
        resolve,
        reject,
      };
    });
    this.publish({ ...this.state, phase: "error", playing: false, error });
    if (!this.pump && !this.disposed && this.pending) this.startPump();
    return promise;
  }
  private invalidate(): void {
    ++this.epoch;
    this.active?.abort(cancelled());
    this.pending?.reject(cancelled());
    this.pending = undefined;
  }
  private enqueue(
    source: PreviewSource,
    frame: number,
    phase: "loading" | "seeking",
    mode: "seek" | "tick" = "seek",
  ): Promise<void> {
    this.invalidate();
    try {
      this.stopTick();
      if (mode === "seek") this.audio?.pause();
    } catch (cause) {
      return this.invalid("preview.pause_failed", cause);
    }
    const promise = new Promise<void>((resolve, reject) => {
      this.pending = {
        kind: "frame",
        epoch: this.epoch,
        revision: this.revision,
        source,
        frame,
        mode,
        resolve,
        reject,
      };
    });
    this.publish({
      phase: mode === "tick" && this.wantsPlayback ? "playing" : phase,
      source,
      requestedFrame: frame,
      range: this.range,
      playing: this.wantsPlayback,
      ended: this.ended,
      error: undefined,
    });
    if (!this.pump && !this.disposed && this.pending) this.startPump();
    return promise;
  }
  private startPump(): void {
    this.pump = this.drain().finally(() => {
      this.pump = undefined;
      if (this.pending && !this.disposed) this.startPump();
    });
  }
  private current(intent: Intent, signal: AbortSignal): void {
    if (this.disposed || intent.epoch !== this.epoch) throw cancelled();
    signal.throwIfAborted();
  }
  private async drain(): Promise<void> {
    while (this.pending && !this.disposed) {
      const intent = this.pending;
      this.pending = undefined;
      const operation = new AbortController();
      this.active = operation;
      if (intent.kind === "error") {
        const error = await this.cleanupAfterError(intent.error);
        if (this.active === operation) this.active = undefined;
        if (intent.epoch === this.epoch && !this.disposed)
          this.publish({ ...this.state, phase: "error", error });
        intent.reject(error);
        if (this.active === operation) this.active = undefined;
        continue;
      }
      try {
        if (this.initializedRevision !== intent.revision) {
          await this.cleanup();
          this.current(intent, operation.signal);
          this.transportDirty = true;
          await this.options.transport.initialize(
            intent.source,
            operation.signal,
          );
          this.current(intent, operation.signal);
          if (intent.source.audioPlan) {
            if (!this.options.prepareAudio)
              throw new Error(
                "preview.audio_unavailable: audio plan requires a prepared clock",
              );
            this.audio = await this.options.prepareAudio(
              intent.source.audioPlan,
              intent.source,
              operation.signal,
            );
            this.current(intent, operation.signal);
            if (
              this.audio.sampleRate !== intent.source.audioPlan.sampleRate ||
              this.audio.durationSamples !==
                intent.source.audioPlan.durationSamples
            )
              throw new Error(
                "preview.audio_mismatch: clock must represent the shared plan",
              );
          }
          this.initializedRevision = intent.revision;
        }
        const result = await this.options.transport.seekFrame(
          intent.frame,
          intent.source,
          operation.signal,
        );
        this.current(intent, operation.signal);
        if (intent.mode === "seek")
          this.audio?.seek(
            framesToSamples(
              intent.frame,
              intent.source.composition.fps,
              this.audio.sampleRate,
              "round",
            ),
          );
        if (this.wantsPlayback && intent.mode === "seek") {
          if (this.audio) {
            const end = framesToSamples(
              this.range!.end,
              intent.source.composition.fps,
              this.audio.sampleRate,
              "round",
            );
            if (end > this.audio.durationSamples)
              throw new Error(
                "preview.audio_duration_mismatch: audio plan must cover playback range",
              );
            await waitForAudio(this.audio.play(), operation.signal);
            this.current(intent, operation.signal);
          } else this.anchor = { frame: intent.frame, time: this.readTime() };
        }
        // A ready subscriber may synchronously issue another command. The
        // completed operation must no longer receive that command's abort.
        if (this.active === operation) this.active = undefined;
        this.publish({
          phase: this.wantsPlayback ? "playing" : "ready",
          source: intent.source,
          requestedFrame: intent.frame,
          presentedFrame: intent.frame,
          frame: result,
          range: this.range,
          playing: this.wantsPlayback,
          ended: this.ended,
        });
        if (intent.epoch === this.epoch && this.wantsPlayback)
          this.scheduleNext();
        intent.resolve();
      } catch (cause) {
        this.initializedRevision = 0;
        const stale =
          operation.signal.aborted ||
          intent.epoch !== this.epoch ||
          this.disposed;
        const error = stale
          ? cancelled()
          : await this.cleanupAfterError(
              failure("preview.request_failed", cause),
            );
        if (this.active === operation) this.active = undefined;
        if (!stale && intent.epoch === this.epoch && !this.disposed)
          this.publish({
            phase: "error",
            source: intent.source,
            requestedFrame: intent.frame,
            error,
            playing: false,
          });
        intent.reject(error);
      } finally {
        if (this.active === operation) this.active = undefined;
      }
    }
  }
  private async cleanupAfterError(error: PreviewError): Promise<PreviewError> {
    this.wantsPlayback = false;
    const errors: unknown[] = error.cleanupError ? [error.cleanupError] : [];
    try {
      this.stopTick();
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
    try {
      await this.cleanup();
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
    return errors.length
      ? new PreviewError(
          error.code,
          error.cause,
          new AggregateError(errors, "preview cleanup failed"),
        )
      : error;
  }
  private stopTick(): void {
    const cancel = this.cancelTick;
    this.cancelTick = undefined;
    this.tickToken = undefined;
    cancel?.();
  }
  private readTime(): number {
    const now = this.options.scheduler!.now();
    if (
      !Number.isFinite(now) ||
      (this.lastTime !== undefined && now < this.lastTime)
    )
      throw new Error(
        "preview.clock_invalid: scheduler time must be finite and monotonic",
      );
    this.lastTime = now;
    return now;
  }
  private playbackPosition(): { frame: number; atEnd: boolean } {
    const source = this.desiredSource!;
    const range = this.range!;
    // During a refresh/explicit seek the old clock may still be closing. The
    // selected new-source frame, not that old clock's cursor, owns pause.
    if (this.state.phase !== "playing")
      return {
        frame: clipFrame(
          this.state.requestedFrame ?? this.state.presentedFrame ?? range.start,
          source,
          range,
        ),
        atEnd: this.ended,
      };
    let frame: number;
    let atEnd: boolean;
    if (this.audio) {
      const sample = this.audio.currentSample();
      if (
        !Number.isSafeInteger(sample) ||
        sample < 0 ||
        sample > this.audio.durationSamples
      )
        throw new Error(
          "preview.audio_clock_invalid: sample position is outside its plan",
        );
      frame = samplesToFrames(
        sample,
        this.audio.sampleRate,
        source.composition.fps,
        "floor",
      );
      atEnd =
        sample >=
        framesToSamples(
          range.end,
          source.composition.fps,
          this.audio.sampleRate,
          "round",
        );
    } else if (this.anchor) {
      frame =
        this.anchor.frame +
        secondsToFrames(
          (this.readTime() - this.anchor.time) / 1000,
          source.composition.fps,
          "floor",
        );
      atEnd = frame >= range.end;
    } else {
      frame = this.state.requestedFrame ?? range.start;
      atEnd = false;
    }
    return {
      frame: atEnd ? range.end - 1 : clipFrame(frame, source, range),
      atEnd,
    };
  }
  private scheduleNext(): void {
    if (
      !this.wantsPlayback ||
      this.disposed ||
      this.cancelTick ||
      !this.options.scheduler
    )
      return;
    const epoch = this.epoch;
    const token = {};
    this.tickToken = token;
    this.cancelTick = this.options.scheduler.schedule(() => {
      // A cancelled callback can race a newer source's scheduled callback.
      // It must not clear the newer callback's cancellation handle.
      if (this.tickToken !== token) return;
      this.tickToken = undefined;
      this.cancelTick = undefined;
      if (this.disposed || !this.wantsPlayback || epoch !== this.epoch) return;
      try {
        const position = this.playbackPosition();
        if (epoch !== this.epoch) return;
        if (position.atEnd) {
          this.wantsPlayback = false;
          this.ended = true;
          this.audio?.pause();
        }
        if (position.frame === this.state.presentedFrame) {
          if (position.atEnd)
            this.publish({
              ...this.state,
              phase: "ready",
              playing: false,
              ended: true,
            });
          else this.scheduleNext();
          return;
        }
        // A new scheduler callback is queued only after this seek settles, so
        // slow transport drops intermediate frames rather than building a queue.
        void this.enqueue(
          this.desiredSource!,
          position.frame,
          "seeking",
          "tick",
        ).catch(() => {});
      } catch (cause) {
        void this.invalid("preview.clock_failed", cause).catch(() => {});
      }
    });
  }
  private async cleanup(): Promise<void> {
    this.initializedRevision = 0;
    const errors: unknown[] = [];
    if (this.audio) {
      try {
        this.audio.pause();
      } catch (error) {
        errors.push(error);
      }
      try {
        await this.audio.dispose();
        this.audio = undefined;
      } catch (error) {
        errors.push(error);
      }
    }
    if (this.transportDirty) {
      try {
        await this.options.transport.dispose();
        this.transportDirty = false;
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(errors, "preview cleanup failed");
  }
  private publish(state: PreviewState<Frame>): void {
    this.state = Object.freeze(state);
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch (error) {
        console.error("preview.observer_failed", error);
      }
    }
  }
}
