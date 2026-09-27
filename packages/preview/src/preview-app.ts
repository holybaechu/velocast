import type { AudioPlan, CompositionManifest } from "@velocast/core";
import { PreviewController } from "./controller.js";
import {
  IframePreviewConnection,
  IframePreviewTransport,
  type IframePresentation,
  type PreviewSnapshot,
} from "./iframe-transport.js";
import {
  HttpPreviewApi,
  type PreviewApi,
  type PreviewOutputRequest,
  type PreviewSessionDescriptor,
} from "./preview-api.js";
import type { AudioPlanClock, PreviewSource, PreviewState } from "./types.js";
import { prepareWebAudioClock } from "./web-audio-clock.js";
import { SourceRefreshGate } from "./source-refresh.js";
import type { ElementInspection } from "./element-inspection.js";

export interface PreviewAppOptions {
  readonly root: HTMLElement;
  readonly api?: PreviewApi;
  readonly window?: Window;
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`preview.ui_missing: ${selector}`);
  return element;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function frameText(frame: number, composition: CompositionManifest): string {
  const seconds = frame / composition.fps;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return `${minutes}:${remainder.toFixed(3).padStart(6, "0")}`;
}

function outputLabel(value: unknown): { label: string; href?: string } {
  if (value && typeof value === "object") {
    const result = value as Record<string, unknown>;
    if (typeof result.url === "string")
      return { label: result.url, href: result.url };
    if (typeof result.outputPath === "string")
      return { label: result.outputPath };
  }
  return { label: JSON.stringify(value, null, 2) ?? "Output complete" };
}

/** Browser UI over the immutable project-session and iframe RPC contracts. */
export class PreviewApp {
  private readonly view: Window;
  private readonly api: PreviewApi;
  private readonly stage: HTMLElement;
  private readonly transport: IframePreviewTransport;
  private readonly controller: PreviewController<IframePresentation>;
  private readonly composition: HTMLSelectElement;
  private readonly play: HTMLButtonElement;
  private readonly seek: HTMLInputElement;
  private readonly rangeStart: HTMLInputElement;
  private readonly rangeEnd: HTMLInputElement;
  private readonly refresh: HTMLButtonElement;
  private readonly frameOutput: HTMLButtonElement;
  private readonly rangeOutput: HTMLButtonElement;
  private readonly frameReadout: HTMLElement;
  private readonly status: HTMLElement;
  private readonly sourceVersion: HTMLElement;
  private readonly error: HTMLElement;
  private readonly output: HTMLElement;
  private readonly resize?: ResizeObserver;
  private snapshot?: PreviewSessionDescriptor;
  private compositions: CompositionManifest[] = [];
  private operation?: AbortController;
  private outputOperation?: AbortController;
  private outputEpoch = 0;
  private disposed = false;
  private readonly lifetime = new AbortController();
  private readonly refreshGate = new SourceRefreshGate();
  private refreshTimer?: number;
  private inspection?: {
    value: ElementInspection;
    frame: number;
    sourceVersion: string;
  };
  private readonly outline: HTMLDivElement;
  private readonly loads = new Set<Promise<boolean>>();
  private preparedAudio?: { sessionId: string; clock: AudioPlanClock };

  constructor(private readonly options: PreviewAppOptions) {
    this.view = options.window ?? options.root.ownerDocument.defaultView!;
    this.api =
      options.api ?? new HttpPreviewApi({ baseUrl: this.view.location.href });
    options.root.classList.add("preview-app");
    options.root.innerHTML = `
      <header class="app-header">
        <div>
          <p class="eyebrow">Velocast / live source</p>
          <h1>Frame room</h1>
        </div>
        <div class="source-block">
          <span>Source version</span>
          <code data-source-version>not loaded</code>
        </div>
      </header>
      <main class="workspace">
        <section class="monitor" aria-label="Composition preview">
          <div class="monitor-topline">
            <label>Composition <select data-composition aria-label="Composition"></select></label>
            <span class="status" data-status role="status">Connecting</span>
          </div>
          <div class="viewport" data-stage>
            <div class="empty-state">Preparing the authored frame…</div>
          </div>
          <div class="transport">
            <button class="play" data-play type="button" disabled>Play</button>
            <label class="scrubber">
              <span class="sr-only">Current frame</span>
              <input data-seek type="range" min="0" max="0" value="0" disabled>
            </label>
            <output class="frame-readout" data-frame>F 0000&nbsp;&nbsp;0:00.000</output>
          </div>
        </section>
        <aside class="console" aria-label="Preview controls">
          <section>
            <div class="section-title"><span>Playback window</span><small>end exclusive</small></div>
            <div class="range-fields">
              <label>In <input data-range-start type="number" min="0" step="1" value="0"></label>
              <label>Out <input data-range-end type="number" min="1" step="1" value="1"></label>
            </div>
            <button class="secondary" data-apply-range type="button">Apply range</button>
          </section>
          <section>
            <div class="section-title"><span>Source</span><small data-refresh-mode>follows completed builds</small></div>
            <button class="refresh" data-refresh type="button">Refresh source</button>
          </section>
          <section>
            <div class="section-title"><span>Inspect element</span><small>selected frame</small></div>
            <label class="inspection-selector">CSS selector <input data-selector placeholder="#headline" value="h1" aria-label="Element selector"></label>
            <button class="secondary" data-inspect type="button">Inspect</button>
            <pre class="inspection-result" data-inspection aria-live="polite">Inspect text, layout and styles without changing the composition.</pre>
          </section>
          <section>
            <div class="section-title"><span>Output</span><small>pinned version</small></div>
            <div class="output-actions">
              <button data-output-frame type="button">Frame PNG</button>
              <button data-output-range type="button">Range video</button>
            </div>
            <div class="output-result" data-output aria-live="polite">No output requested.</div>
          </section>
          <div class="error" data-error role="alert" hidden></div>
        </aside>
      </main>`;
    this.stage = required(options.root, "[data-stage]");
    this.outline = options.root.ownerDocument.createElement("div");
    this.outline.className = "element-outline";
    this.outline.hidden = true;
    this.outline.setAttribute("aria-hidden", "true");
    this.stage.appendChild(this.outline);
    this.composition = required(options.root, "[data-composition]");
    this.play = required(options.root, "[data-play]");
    this.seek = required(options.root, "[data-seek]");
    this.rangeStart = required(options.root, "[data-range-start]");
    this.rangeEnd = required(options.root, "[data-range-end]");
    this.refresh = required(options.root, "[data-refresh]");
    this.frameOutput = required(options.root, "[data-output-frame]");
    this.rangeOutput = required(options.root, "[data-output-range]");
    this.frameReadout = required(options.root, "[data-frame]");
    this.status = required(options.root, "[data-status]");
    this.sourceVersion = required(options.root, "[data-source-version]");
    this.error = required(options.root, "[data-error]");
    this.output = required(options.root, "[data-output]");
    this.transport = new IframePreviewTransport({
      container: this.stage,
      hostWindow: this.view,
      resolveSnapshot: (source) => this.snapshotFor(source),
      onCleanupWarning: (warning) => this.showError(asError(warning)),
    });
    this.controller = new PreviewController({
      transport: this.transport,
      scheduler: {
        now: () => this.view.performance.now(),
        schedule: (callback) => {
          const id = this.view.requestAnimationFrame(callback);
          return () => this.view.cancelAnimationFrame(id);
        },
      },
      prepareAudio: (plan, source, signal) => {
        if (this.preparedAudio?.sessionId === source.session.sessionId) {
          const { clock } = this.preparedAudio;
          this.preparedAudio = undefined;
          return Promise.resolve(clock);
        }
        return this.prepareSourceAudio(plan, this.snapshotFor(source), signal);
      },
    });
    this.controller.subscribe((state) => this.render(state));
    this.bindEvents();
    const Resize = globalThis.ResizeObserver;
    if (Resize) {
      this.resize = new Resize(() => this.fitIframe());
      this.resize.observe(this.stage);
    }
  }

  async start(): Promise<void> {
    await this.load(false);
    this.scheduleRefresh();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort();
    this.view.clearTimeout(this.refreshTimer);
    this.operation?.abort();
    this.outputOperation?.abort();
    this.resize?.disconnect();
    await this.controller.dispose();
    await Promise.allSettled([...this.loads]);
  }

  private bindEvents(): void {
    this.play.addEventListener("click", () => {
      const state = this.controller.getState();
      void this.action(
        state.playing ? this.controller.pause() : this.controller.play(),
      );
    });
    this.seek.addEventListener("input", () => this.updateFrameReadout());
    this.seek.addEventListener("change", () => {
      void this.action(this.controller.seek(Number(this.seek.value)));
    });
    required(this.options.root, "[data-apply-range]").addEventListener(
      "click",
      () => {
        void this.action(
          this.controller.setPlaybackRange({
            start: Number(this.rangeStart.value),
            end: Number(this.rangeEnd.value),
          }),
        );
      },
    );
    this.refresh.addEventListener("click", () => void this.load(true));
    required(this.options.root, "[data-inspect]").addEventListener(
      "click",
      () => {
        void this.action(this.inspectSelectedElement());
      },
    );
    this.composition.addEventListener(
      "change",
      () => void this.selectComposition(this.composition.value),
    );
    this.frameOutput.addEventListener(
      "click",
      () => void this.requestOutput("frame"),
    );
    this.rangeOutput.addEventListener(
      "click",
      () => void this.requestOutput("range"),
    );
    this.view.addEventListener("keydown", (event) => {
      if (
        event.code !== "Space" ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLSelectElement ||
        event.target instanceof HTMLButtonElement
      )
        return;
      event.preventDefault();
      this.play.click();
    });
  }

  private load(refresh: boolean, automatic = false): Promise<boolean> {
    const work = this.loadSource(refresh, automatic);
    this.loads.add(work);
    void work.then(
      () => this.loads.delete(work),
      () => this.loads.delete(work),
    );
    return work;
  }

  private async loadSource(
    refresh: boolean,
    automatic: boolean,
  ): Promise<boolean> {
    if (this.disposed) return false;
    const prior = this.snapshot?.session.sourceVersion;
    if (refresh && !prior) return false;
    if (refresh) this.cancelOutput("Output cancelled by source refresh.");
    this.operation?.abort();
    const operation = new AbortController();
    this.operation = operation;
    this.clearError();
    this.status.textContent = refresh ? "Refreshing source" : "Opening session";
    this.setBusy(true);
    let candidate: PreviewSessionDescriptor | undefined;
    let committed = false;
    let audio: AudioPlanClock | undefined;
    let handoffSession: string | undefined;
    const staged =
      this.snapshot?.stagedRefresh === true &&
      this.api.prepareRefresh &&
      this.api.commitRefresh &&
      this.api.discardRefresh;
    try {
      const next = refresh
        ? await (staged
            ? this.api.prepareRefresh!(prior!, operation.signal)
            : this.api.refresh(prior!, operation.signal))
        : await this.api.getSession(operation.signal);
      if (refresh && staged) candidate = next;
      const previousState = this.controller.getState();
      const preferred = previousState.source?.composition.id;
      const discovered = await this.discover(
        next,
        preferred,
        operation.signal,
        previousState.presentedFrame ?? previousState.requestedFrame ?? 0,
      );
      operation.signal.throwIfAborted();
      if (discovered.source.audioPlan)
        audio = await this.prepareSourceAudio(
          discovered.source.audioPlan,
          next,
          operation.signal,
        );
      operation.signal.throwIfAborted();
      if (candidate) {
        await this.controller.pause();
        await this.api.commitRefresh!(
          prior!,
          candidate.session.sessionId,
          operation.signal,
        );
        committed = true;
      }
      this.snapshot = next;
      required(this.options.root, "[data-refresh-mode]").textContent =
        next.autoRefresh === false || !next.sourceRevision
          ? "manual refresh"
          : "follows completed builds";
      this.compositions = discovered.compositions;
      this.populateCompositions(discovered.source.composition.id);
      if (audio) {
        handoffSession = next.session.sessionId;
        this.preparedAudio = { sessionId: handoffSession, clock: audio };
        audio = undefined;
      }
      await this.controller.refresh(discovered.source);
      operation.signal.throwIfAborted();
      if (
        refresh &&
        previousState.range &&
        preferred === discovered.source.composition.id
      ) {
        const end = Math.min(
          previousState.range.end,
          discovered.source.composition.durationFrames,
        );
        const start = Math.min(previousState.range.start, end - 1);
        await this.controller.setPlaybackRange({ start, end });
        operation.signal.throwIfAborted();
      }
      if (automatic && previousState.playing) await this.controller.play();
      return true;
    } catch (error) {
      if (candidate && !committed) {
        try {
          await this.api.discardRefresh!(
            prior!,
            candidate.session.sessionId,
            AbortSignal.timeout(3000),
          );
        } catch {
          /* Shutdown or another client may already have discarded it. */
        }
      }
      if (
        refresh &&
        !this.disposed &&
        asError(error).message.includes("snapshot.version_mismatch")
      ) {
        // Another preview tab may already have committed the new source.
        return this.load(false, automatic);
      }
      if (!isAbort(error)) this.showError(asError(error));
      return false;
    } finally {
      if (audio) await audio.dispose();
      if (handoffSession && this.preparedAudio?.sessionId === handoffSession) {
        const unused = this.preparedAudio.clock;
        this.preparedAudio = undefined;
        await unused.dispose();
      }
      if (this.operation === operation) {
        this.operation = undefined;
        this.setBusy(false);
      }
    }
  }

  private prepareSourceAudio(
    plan: AudioPlan,
    snapshot: PreviewSnapshot,
    signal: AbortSignal,
  ): Promise<AudioPlanClock> {
    return prepareWebAudioClock(plan, {
      signal,
      loadBuffer: async (source, context, loadSignal) => {
        const url = new URL(source, snapshot.snapshotUrl);
        if (
          url.origin !== new URL(snapshot.snapshotUrl).origin ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error(
            "preview.audio_source: audio must belong to the immutable project snapshot",
          );
        const response = await this.view.fetch(url, {
          signal: loadSignal,
          credentials: "omit",
          redirect: "error",
        });
        if (!response.ok)
          throw new Error(`preview.audio_http_${response.status}: ${source}`);
        const length = Number(response.headers.get("content-length"));
        if (
          !Number.isSafeInteger(length) ||
          length <= 0 ||
          length > 256 * 1024 * 1024
        )
          throw new Error(
            "preview.audio_limit: encoded audio exceeds the snapshot byte limit",
          );
        const bytes = await response.arrayBuffer();
        loadSignal.throwIfAborted();
        if (bytes.byteLength !== length)
          throw new Error("preview.audio_length: incomplete snapshot audio");
        return context.decodeAudioData(bytes);
      },
    });
  }

  private scheduleRefresh(): void {
    if (this.disposed || !this.api.changes) return;
    this.refreshTimer = this.view.setTimeout(() => {
      void this.pollSource();
    }, 750);
  }

  private async pollSource(): Promise<void> {
    try {
      if (
        this.disposed ||
        this.operation ||
        this.outputOperation ||
        !this.snapshot
      )
        return;
      if (this.snapshot.autoRefresh === false || !this.snapshot.sourceRevision)
        return;
      const change = await this.api.changes!(this.lifetime.signal);
      if (
        change.enabled &&
        this.refreshGate.observe(this.snapshot.sourceRevision, change.revision)
      ) {
        if (!(await this.load(true, true)))
          this.refreshGate.reject(change.revision);
      }
    } catch (error) {
      // A build may temporarily remove the entry tree. Keep presenting the frozen source.
      if (!this.disposed && !isAbort(error))
        this.status.textContent = "Waiting for a completed build";
    } finally {
      this.scheduleRefresh();
    }
  }

  private async inspectSelectedElement(): Promise<void> {
    if (this.operation || this.disposed) return;
    await this.controller.pause();
    const state = this.controller.getState();
    if (!state.source || state.presentedFrame === undefined) return;
    const selector = required<HTMLInputElement>(
      this.options.root,
      "[data-selector]",
    ).value;
    const value = await this.transport.inspect(selector, this.lifetime.signal);
    if (
      this.disposed ||
      this.controller.getState().source?.session.sourceVersion !==
        state.source.session.sourceVersion
    )
      return;
    this.inspection = {
      value,
      frame: state.presentedFrame,
      sourceVersion: state.source.session.sourceVersion,
    };
    required(this.options.root, "[data-inspection]").textContent =
      JSON.stringify(
        {
          frame: state.presentedFrame,
          seconds: state.presentedFrame / state.source.composition.fps,
          ...value,
        },
        null,
        2,
      );
    this.fitIframe();
  }

  private async selectComposition(compositionId: string): Promise<void> {
    if (!this.snapshot) return;
    this.cancelOutput("Output cancelled by composition change.");
    this.operation?.abort();
    const operation = new AbortController();
    this.operation = operation;
    this.setBusy(true);
    try {
      const discovered = await this.discover(
        this.snapshot,
        compositionId,
        operation.signal,
      );
      await this.controller.refresh(discovered.source, 0);
    } catch (error) {
      if (!isAbort(error)) this.showError(asError(error));
    } finally {
      if (this.operation === operation) {
        this.operation = undefined;
        this.setBusy(false);
      }
    }
  }

  private async discover(
    snapshot: PreviewSessionDescriptor,
    preferred: string | undefined,
    signal: AbortSignal,
    frame = 0,
  ): Promise<{ source: PreviewSource; compositions: CompositionManifest[] }> {
    const connection = new IframePreviewConnection(snapshot, {
      container: this.stage,
      hostWindow: this.view,
    });
    try {
      const available = await connection.connect(signal);
      const selected =
        available.find((item) => item.id === preferred) ?? available[0]!;
      const source = await connection.initialize(selected.id, signal);
      await connection.seek(
        Math.max(0, Math.min(frame, selected.durationFrames - 1)),
        signal,
      );
      return { source, compositions: available };
    } finally {
      await connection.dispose();
    }
  }

  private snapshotFor(source: PreviewSource): PreviewSnapshot {
    if (
      !this.snapshot ||
      this.snapshot.session.sessionId !== source.session.sessionId ||
      this.snapshot.session.sourceVersion !== source.session.sourceVersion
    )
      throw new Error("preview.snapshot_mismatch: source is no longer current");
    return this.snapshot;
  }

  private async requestOutput(kind: "frame" | "range"): Promise<void> {
    const state = this.controller.getState();
    if (!state.source || state.presentedFrame === undefined) return;
    this.outputOperation?.abort();
    const operation = new AbortController();
    this.outputOperation = operation;
    const epoch = ++this.outputEpoch;
    const expected = state.source.session.sourceVersion;
    const base = {
      compositionId: state.source.composition.id,
      expectedSourceVersion: expected,
    };
    const request: PreviewOutputRequest =
      kind === "frame"
        ? { ...base, frame: state.presentedFrame }
        : { ...base, range: state.range! };
    this.output.textContent =
      kind === "frame" ? "Rendering frame…" : "Rendering range…";
    this.frameOutput.disabled = true;
    this.rangeOutput.disabled = true;
    try {
      const result = await this.api.output(request, operation.signal);
      if (
        epoch !== this.outputEpoch ||
        this.controller.getState().source?.session.sourceVersion !== expected
      )
        return;
      const shown = outputLabel(result);
      this.output.replaceChildren();
      const node = shown.href
        ? Object.assign(this.options.root.ownerDocument.createElement("a"), {
            href: shown.href,
            textContent: shown.label,
            target: "_blank",
            rel: "noreferrer",
          })
        : Object.assign(this.options.root.ownerDocument.createElement("code"), {
            textContent: shown.label,
          });
      this.output.append(node);
    } catch (error) {
      if (!isAbort(error)) this.showError(asError(error));
    } finally {
      if (this.outputOperation === operation) {
        this.outputOperation = undefined;
        this.render(this.controller.getState());
      }
    }
  }

  private cancelOutput(message: string): void {
    if (!this.outputOperation) return;
    ++this.outputEpoch;
    this.outputOperation.abort();
    this.outputOperation = undefined;
    this.output.textContent = message;
    this.render(this.controller.getState());
  }

  private async action(action: Promise<void>): Promise<void> {
    this.clearError();
    try {
      await action;
    } catch (error) {
      if (!isAbort(error)) this.showError(asError(error));
    }
  }

  private render(state: PreviewState<IframePresentation>): void {
    if (
      this.inspection &&
      (this.inspection.frame !== state.presentedFrame ||
        this.inspection.sourceVersion !== state.source?.session.sourceVersion)
    ) {
      this.inspection = undefined;
      this.outline.hidden = true;
    }
    const source = state.source;
    const ready = !!source && state.presentedFrame !== undefined;
    if (state.frame && ready) this.transport.present(state.frame);
    required<HTMLElement>(this.stage, ".empty-state").hidden = ready;
    this.status.textContent =
      state.phase === "error"
        ? "Needs attention"
        : state.phase === "playing"
          ? "Playing"
          : state.phase === "ready"
            ? state.ended
              ? "Range complete"
              : "Frame ready"
            : state.phase === "seeking"
              ? "Seeking"
              : state.phase === "loading"
                ? "Loading source"
                : state.phase;
    this.play.textContent = state.playing ? "Pause" : "Play";
    this.play.disabled = !ready || state.phase === "error";
    this.seek.disabled = !source;
    if (source) {
      const max = source.composition.durationFrames - 1;
      this.seek.max = String(max);
      this.seek.value = String(
        state.requestedFrame ?? state.presentedFrame ?? 0,
      );
      this.rangeStart.max = String(max);
      this.rangeEnd.max = String(source.composition.durationFrames);
      this.rangeStart.value = String(state.range?.start ?? 0);
      this.rangeEnd.value = String(
        state.range?.end ?? source.composition.durationFrames,
      );
      this.sourceVersion.textContent = source.session.sourceVersion.slice(
        0,
        16,
      );
      this.sourceVersion.title = source.session.sourceVersion;
    }
    this.frameOutput.disabled = !ready || !!this.outputOperation;
    this.rangeOutput.disabled = !ready || !!this.outputOperation;
    if (state.error) this.showError(state.error);
    this.updateFrameReadout();
    this.fitIframe();
  }

  private updateFrameReadout(): void {
    const composition = this.controller.getState().source?.composition;
    if (!composition) return;
    const frame = Number(this.seek.value);
    this.frameReadout.textContent = `F ${String(frame).padStart(4, "0")}  ${frameText(frame, composition)}`;
  }

  private populateCompositions(selected: string): void {
    this.composition.replaceChildren(
      ...this.compositions.map((composition) =>
        Object.assign(this.options.root.ownerDocument.createElement("option"), {
          value: composition.id,
          textContent: composition.id,
          selected: composition.id === selected,
        }),
      ),
    );
  }

  private fitIframe(): void {
    const iframe = this.transport.iframe;
    const source = this.controller.getState().source;
    if (!iframe || !source) return;
    const scale = Math.min(
      this.stage.clientWidth / source.composition.width,
      this.stage.clientHeight / source.composition.height,
    );
    Object.assign(iframe.style, {
      position: "absolute",
      left: "50%",
      top: "50%",
      transformOrigin: "center",
      transform: `translate(-50%, -50%) scale(${Math.max(0.01, scale)})`,
    });
    if (this.inspection) {
      const { x, y, width, height } = this.inspection.value.bounds;
      const actualScale = Math.max(0.01, scale);
      this.outline.hidden = false;
      Object.assign(this.outline.style, {
        left: `${(this.stage.clientWidth - source.composition.width * actualScale) / 2 + x * actualScale}px`,
        top: `${(this.stage.clientHeight - source.composition.height * actualScale) / 2 + y * actualScale}px`,
        width: `${width * actualScale}px`,
        height: `${height * actualScale}px`,
      });
    }
  }

  private setBusy(busy: boolean): void {
    this.refresh.disabled = busy;
    this.composition.disabled = busy;
  }

  private clearError(): void {
    this.error.hidden = true;
    this.error.textContent = "";
  }

  private showError(error: Error): void {
    this.error.hidden = false;
    this.error.textContent = error.message;
  }
}
