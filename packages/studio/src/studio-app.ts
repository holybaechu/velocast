import {
  normalizeAudioPlan,
  type AudioPlan,
  type CompositionManifest,
  type CodeEdit,
  type CodeSource,
  type StudioClientState,
  type StudioClientCommand,
} from "@velocast/core";
import { StudioController } from "./controller.js";
import {
  IframeStudioConnection,
  IframeStudioTransport,
  type IframePresentation,
  type StudioSnapshot,
} from "./iframe-transport.js";
import {
  HttpStudioApi,
  type StudioApi,
  type StudioOutputRequest,
  type StudioSessionDescriptor,
} from "./studio-api.js";
import type { AudioPlanClock, StudioSource, StudioState } from "./types.js";
import { prepareWebAudioClock } from "./web-audio-clock.js";
import { SourceRefreshGate } from "./source-refresh.js";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Download,
  ExternalLink,
  Film,
  Image,
  Pause,
  Play,
  Plug,
  RefreshCw,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  X,
} from "lucide";
import { icon } from "./studio-icons.js";
import { CodeEditor } from "./code-editor.js";
import { StudioClientConnection } from "./studio-client.js";

export interface StudioAppOptions {
  readonly root: HTMLElement;
  readonly api?: StudioApi;
  readonly window?: Window;
}

const inspectorTabs = ["properties", "export"] as const;
type InspectorTab = (typeof inspectorTabs)[number];
type SourceLoadResult = "loaded" | "failed" | "retry";

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`studio.ui_missing: ${selector}`);
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

function outputLabel(
  value: unknown,
  image: boolean,
): { label: string; href?: string } {
  if (value && typeof value === "object") {
    const result = value as Record<string, unknown>;
    if (typeof result.url === "string")
      return {
        label: image ? "Open image" : "Open video",
        href: result.url,
      };
  }
  return { label: image ? "Image ready" : "Video ready" };
}

/** Browser UI over the immutable project-session and iframe RPC contracts. */
export class StudioApp {
  private readonly view: Window;
  private readonly api: StudioApi;
  private readonly stage: HTMLElement;
  private readonly transport: IframeStudioTransport;
  private readonly controller: StudioController<IframePresentation>;
  private readonly composition: HTMLSelectElement;
  private readonly play: HTMLButtonElement;
  private readonly seek: HTMLInputElement;
  private readonly exactFrame: HTMLInputElement;
  private readonly codeStatus: HTMLElement;
  private readonly cancelOutputButton: HTMLButtonElement;
  private readonly rangeStart: HTMLInputElement;
  private readonly rangeEnd: HTMLInputElement;
  private readonly refresh: HTMLButtonElement;
  private readonly frameOutput: HTMLButtonElement;
  private readonly videoOutput: HTMLButtonElement;
  private readonly rangeOutput: HTMLButtonElement;
  private readonly frameReadout: HTMLElement;
  private readonly status: HTMLElement;
  private codeEditor?: CodeEditor;
  private codeSource?: CodeSource;
  private codeReadEpoch = 0;
  private readonly codeFailures = new Map<
    string,
    { revision?: string; message: string; error: Error }
  >();
  private codeMessage?: string;
  private codeError = false;
  private readonly error: HTMLElement;
  private readonly output: HTMLElement;
  private readonly resize?: ResizeObserver;
  private snapshot?: StudioSessionDescriptor;
  private compositions: CompositionManifest[] = [];
  private readonly compositionItems = new Map<string, HTMLButtonElement>();
  private playingIcon?: boolean;
  private audioSummary?: { source: StudioSource; audible: boolean };
  private operation?: AbortController;
  private outputOperation?: AbortController;
  private outputEpoch = 0;
  private outputWork?: Promise<void>;
  private editOperation?: AbortController;
  private outputCancelMessage?: string;
  private disposed = false;
  private readonly lifetime = new AbortController();
  private readonly refreshGate = new SourceRefreshGate();
  private refreshTimer?: number;
  private readonly loads = new Set<Promise<SourceLoadResult>>();
  private readonly editWorks = new Set<Promise<void>>();
  private preparedAudio?: { sessionId: string; clock: AudioPlanClock };
  private client?: StudioClientConnection;

  constructor(private readonly options: StudioAppOptions) {
    this.view = options.window ?? options.root.ownerDocument.defaultView!;
    this.api =
      options.api ?? new HttpStudioApi({ baseUrl: this.view.location.href });
    options.root.classList.add("studio-app");
    options.root.innerHTML = `
      <header class="app-header">
        <h1 aria-label="Velocast Studio">${icon(Clapperboard)} Velocast Studio</h1>
        <div class="code-actions" data-code-actions hidden></div>
        <details class="agent-connection" data-agent-connection>
          <summary data-agent-summary>${icon(Plug)} Connect agent</summary>
          <div class="agent-connection-content">
            <p>Add this MCP server to your agent. Keep Studio open.</p>
            <pre data-agent-config>Open to load connection settings.</pre>
            <p class="help-text" data-agent-client></p>
            <p class="help-text" data-agent-status role="status"></p>
          </div>
        </details>
        <button class="primary" data-show-export type="button">${icon(Download)} Export</button>
      </header>
      <main class="workspace">
        <nav class="library" aria-label="Compositions">
          <div class="panel-heading">Compositions <span data-composition-count></span></div>
          <div class="composition-list" data-composition-list></div>
          <div class="code-media" data-code-media hidden></div>
        </nav>
        <section class="monitor" aria-label="Composition viewer">
          <div class="monitor-topline">
            <strong class="selected-composition" data-selected-composition>No composition</strong>
            <label class="composition-picker"><span class="sr-only">Composition</span><select data-composition aria-label="Composition"></select></label>
            <span class="composition-info" data-composition-info></span>
          </div>
          <div class="viewport" data-stage><div class="empty-state">Opening composition…</div><div class="code-canvas" data-code-canvas hidden></div></div>
        </section>
        <section class="timeline" aria-label="Playback timeline">
          <label class="scrubber"><span class="sr-only">Current frame</span><input data-seek type="range" min="0" max="0" value="0" disabled></label>
          <div class="transport">
            <div class="frame-navigation" role="group" aria-label="Playback">
              <button data-previous-frame type="button" aria-label="Previous frame" title="Previous frame (Left arrow)">${icon(ChevronLeft)}</button>
              <button class="play" data-play type="button" aria-label="Play" title="Play (Space)" disabled>${icon(Play)}</button>
              <button data-next-frame type="button" aria-label="Next frame" title="Next frame (Right arrow)">${icon(ChevronRight)}</button>
            </div>
            <label class="exact-frame">Frame <input data-exact-frame type="number" min="0" step="1" value="0" disabled></label>
            <output class="frame-readout" data-frame>F 0000&nbsp;&nbsp;0:00.000</output>
            <details class="playback-options" data-playback-options>
              <summary class="icon-summary" title="Playback options" aria-label="Playback options">${icon(SlidersHorizontal)}</summary>
              <div class="playback-content">
                <div class="section-title">Playback options <small>Session only</small></div>
                <div class="range-fields" role="group" aria-label="Playback range">
                  <label>In <input data-range-start type="number" min="0" step="1" value="0" title="Inclusive start frame"></label>
                  <label>Out <input data-range-end type="number" min="1" step="1" value="1" title="Exclusive end frame"></label>
                  <button data-apply-range type="button">Apply range</button>
                </div>
                <div class="advanced-frame-navigation">
                  <button data-first-frame type="button" title="First frame (Home)">${icon(SkipBack)} First frame</button>
                  <button data-last-frame type="button" title="Last frame (End)">${icon(SkipForward)} Last frame</button>
                </div>
                <p class="help-text">Out is the first excluded frame. Video export uses the full composition.</p>
              </div>
            </details>
          </div>
          <div class="code-timeline" data-code-timeline hidden></div>
        </section>
        <aside class="inspector" aria-label="Composition settings">
          <div class="inspector-tabs" role="tablist" aria-label="Inspector">
            <button id="studio-tab-properties" data-inspector-tab="properties" role="tab" aria-controls="studio-panel-properties" aria-selected="true" type="button">${icon(SlidersHorizontal)} Properties</button>
            <button id="studio-tab-export" data-inspector-tab="export" role="tab" aria-controls="studio-panel-export" aria-selected="false" tabindex="-1" type="button">${icon(Download)} Export</button>
          </div>
          <div class="inspector-content">
            <section class="inspector-panel" id="studio-panel-properties" data-inspector-panel="properties" role="tabpanel" aria-labelledby="studio-tab-properties">
              <div data-code-inspector hidden></div>
              <p class="code-status" data-code-status role="status">Edit this composition in your source editor.</p>
            </section>
            <section class="inspector-panel" id="studio-panel-export" data-inspector-panel="export" role="tabpanel" aria-labelledby="studio-tab-export" hidden>
              <h2>Export video</h2>
              <p class="help-text" data-export-info>The complete composition, including audio.</p>
              <p class="help-text" data-code-export-state role="status" hidden></p>
              <button class="primary export-video" data-output-video type="button">${icon(Download)} Render video</button>
              <button class="frame-export" data-output-frame type="button">${icon(Image)} Save current frame</button>
              <div class="output-result" data-output aria-live="polite">No exports yet.</div>
              <button data-cancel-output type="button" hidden>${icon(X)} Cancel</button>
              <details class="disclosure" data-export-options>
                <summary>${icon(SlidersHorizontal)} Advanced ${icon(ChevronDown)}</summary>
                <p class="help-text">Export only the range set in Playback options.</p>
                <button data-output-range type="button">${icon(Film)} Render range</button>
              </details>
            </section>
          </div>
          <div class="error" data-error role="alert" hidden></div>
        </aside>
      </main>
      <footer class="statusbar"><span data-status role="status">Connecting</span><span data-refresh-mode>Auto refresh</span><button data-refresh type="button" aria-label="Refresh source" title="Refresh source">${icon(RefreshCw)}</button></footer>`;
    this.stage = required(options.root, "[data-stage]");
    this.composition = required(options.root, "[data-composition]");
    this.play = required(options.root, "[data-play]");
    this.seek = required(options.root, "[data-seek]");
    this.exactFrame = required(options.root, "[data-exact-frame]");
    this.codeStatus = required(options.root, "[data-code-status]");
    this.cancelOutputButton = required(options.root, "[data-cancel-output]");
    this.rangeStart = required(options.root, "[data-range-start]");
    this.rangeEnd = required(options.root, "[data-range-end]");
    this.refresh = required(options.root, "[data-refresh]");
    this.frameOutput = required(options.root, "[data-output-frame]");
    this.videoOutput = required(options.root, "[data-output-video]");
    this.rangeOutput = required(options.root, "[data-output-range]");
    this.frameReadout = required(options.root, "[data-frame]");
    this.status = required(options.root, "[data-status]");
    this.error = required(options.root, "[data-error]");
    this.output = required(options.root, "[data-output]");
    this.transport = new IframeStudioTransport({
      container: this.stage,
      hostWindow: this.view,
      resolveSnapshot: (source) => this.snapshotFor(source),
      onCleanupWarning: (warning) => this.showError(asError(warning)),
    });
    this.controller = new StudioController({
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
    this.selectInspector("properties");
    const Resize = globalThis.ResizeObserver;
    if (Resize) {
      this.resize = new Resize(() => this.fitIframe());
      this.resize.observe(this.stage);
    }
  }

  async start(): Promise<void> {
    if (this.api.heartbeat && this.api.disconnect && !this.client) {
      this.client = new StudioClientConnection({
        api: {
          heartbeat: this.api.heartbeat.bind(this.api),
          disconnect: this.api.disconnect.bind(this.api),
        },
        getState: () => this.clientState(),
        control: (command) => this.controlClient(command),
        status: (connected, error) => {
          required(this.options.root, "[data-agent-status]").textContent =
            connected
              ? "This tab is available to connected agents."
              : `Studio connection interrupted; reconnecting… ${error ?? ""}`;
          required(this.options.root, "[data-agent-summary]").innerHTML =
            `${icon(Plug)} ${connected ? "Connect agent" : "Agent offline"}`;
        },
      });
      this.options.root.setAttribute("data-client-id", this.client.clientId);
      required(this.options.root, "[data-agent-client]").textContent =
        `Tab: ${this.client.clientId}`;
      this.client.start();
    }
    await this.load(false);
    this.scheduleRefresh();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const disconnected = this.client?.dispose();
    this.lifetime.abort();
    this.view.clearTimeout(this.refreshTimer);
    this.operation?.abort();
    this.outputOperation?.abort();
    this.editOperation?.abort();
    this.resize?.disconnect();
    this.codeEditor?.dispose();
    await this.controller.dispose();
    await Promise.allSettled([...this.loads]);
    await Promise.allSettled([...this.editWorks]);
    await this.outputWork;
    await disconnected;
  }

  private bindEvents(): void {
    required<HTMLDetailsElement>(
      this.options.root,
      "[data-agent-connection]",
    ).addEventListener("toggle", (event) => {
      if ((event.currentTarget as HTMLDetailsElement).open)
        void this.showAgentConnection();
    });
    required(this.options.root, "[data-show-export]").addEventListener(
      "click",
      () => this.selectInspector("export", true),
    );
    for (const [index, name] of inspectorTabs.entries()) {
      const tab = required<HTMLButtonElement>(
        this.options.root,
        `[data-inspector-tab="${name}"]`,
      );
      tab.addEventListener("click", () => this.selectInspector(name));
      tab.addEventListener("keydown", (event) => {
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? inspectorTabs.length - 1
              : event.key === "ArrowLeft"
                ? (index + inspectorTabs.length - 1) % inspectorTabs.length
                : event.key === "ArrowRight"
                  ? (index + 1) % inspectorTabs.length
                  : undefined;
        if (next !== undefined) {
          event.preventDefault();
          this.selectInspector(inspectorTabs[next]!, true);
        }
      });
    }
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
    this.exactFrame.addEventListener("change", () => {
      this.commitExactFrame();
    });
    this.exactFrame.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.commitExactFrame();
      }
    });
    for (const direction of ["first", "previous", "next", "last"] as const)
      required(this.options.root, `[data-${direction}-frame]`).addEventListener(
        "click",
        () => {
          void this.action(this.navigateFrame(direction));
        },
      );
    this.cancelOutputButton.addEventListener(
      "click",
      () => void this.cancelOutput("Output cancelled.", false),
    );
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
    this.composition.addEventListener(
      "change",
      () => void this.selectComposition(this.composition.value),
    );
    this.frameOutput.addEventListener(
      "click",
      () => void this.requestOutput("frame"),
    );
    this.videoOutput.addEventListener(
      "click",
      () => void this.requestOutput("video"),
    );
    this.rangeOutput.addEventListener(
      "click",
      () => void this.requestOutput("range"),
    );
    this.view.addEventListener(
      "keydown",
      (event) => {
        const target = event.target as HTMLElement | null;
        if (
          this.codeEditor &&
          (event.ctrlKey || event.metaKey) &&
          !event.altKey &&
          !target?.isContentEditable &&
          !["INPUT", "SELECT", "TEXTAREA"].includes(target?.tagName ?? "") &&
          ["z", "y"].includes(event.key?.toLowerCase())
        ) {
          event.preventDefault();
          const action =
            event.shiftKey || event.key.toLowerCase() === "y" ? "redo" : "undo";
          if (this.codeEditor?.canChangeHistory(action))
            this.trackEdit(this.changeCodeHistory(action));
          return;
        }
        if (
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          target?.isContentEditable ||
          ["INPUT", "SELECT", "BUTTON", "TEXTAREA", "SUMMARY"].includes(
            target?.tagName ?? "",
          )
        )
          return;
        const navigation = {
          ArrowLeft: "previous",
          ArrowRight: "next",
          Home: "first",
          End: "last",
        } as const;
        if (event.code === "Space") {
          event.preventDefault();
          this.play.click();
        } else if (Object.hasOwn(navigation, event.code)) {
          event.preventDefault();
          void this.action(
            this.navigateFrame(
              navigation[event.code as keyof typeof navigation],
            ),
          );
        }
      },
      { signal: this.lifetime.signal },
    );
  }

  private selectInspector(selected: InspectorTab, focus = false): void {
    for (const name of inspectorTabs) {
      const tab = required<HTMLButtonElement>(
        this.options.root,
        `[data-inspector-tab="${name}"]`,
      );
      tab.setAttribute("aria-selected", String(name === selected));
      tab.tabIndex = name === selected ? 0 : -1;
      required<HTMLElement>(
        this.options.root,
        `[data-inspector-panel="${name}"]`,
      ).hidden = name !== selected;
      if (focus && name === selected) tab.focus();
    }
  }

  private load(refresh: boolean, automatic = false): Promise<SourceLoadResult> {
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
  ): Promise<SourceLoadResult> {
    if (this.disposed) return "failed";
    const prior = this.snapshot?.session.sourceVersion;
    if (refresh && !prior) return "failed";
    if (refresh) await this.cancelOutput("Output cancelled by source refresh.");
    if (this.disposed) return "failed";
    this.operation?.abort();
    const operation = new AbortController();
    this.operation = operation;
    this.clearError();
    this.status.textContent = refresh ? "Refreshing source" : "Opening session";
    this.setBusy(true);
    let candidate: StudioSessionDescriptor | undefined;
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
      if (
        refresh &&
        this.codeSource?.enabled &&
        next.codeRevisions?.[this.codeSource.compositionId] !== undefined &&
        next.codeRevisions[this.codeSource.compositionId] !==
          this.codeSource.revision
      ) {
        if (candidate)
          await this.api.discardRefresh!(
            prior!,
            candidate.session.sessionId,
            operation.signal,
          );
        candidate = undefined;
        return "retry";
      }
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
      await this.refreshCode();
      return "loaded";
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
        // Another studio tab may already have committed the new source.
        return this.load(false, automatic);
      }
      if (
        refresh &&
        /studio\.(refresh_busy|output_busy|build_in_progress)/.test(
          asError(error).message,
        )
      ) {
        this.status.textContent = "Waiting for active work to finish";
        return "retry";
      }
      if (this.codeSource?.enabled && !isAbort(error)) {
        this.recordCodeFailure(
          asError(error),
          "Saved source could not be displayed. Fix the source error and refresh.",
        );
      }
      if (!isAbort(error)) this.showError(asError(error));
      return "failed";
    } finally {
      if (audio) await audio.dispose();
      if (handoffSession && this.preparedAudio?.sessionId === handoffSession) {
        const unused = this.preparedAudio.clock;
        this.preparedAudio = undefined;
        await unused.dispose();
      }
      if (this.operation === operation) {
        this.operation = undefined;
        const failure =
          this.codeSource &&
          this.codeFailures.get(this.codeSource.compositionId);
        if (this.codeError && failure) this.showError(failure.error);
        this.setBusy(false);
      }
    }
  }

  private prepareSourceAudio(
    plan: AudioPlan,
    snapshot: StudioSnapshot,
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
            "studio.audio_source: audio must belong to the immutable project snapshot",
          );
        const response = await this.view.fetch(url, {
          signal: loadSignal,
          credentials: "omit",
          redirect: "error",
        });
        if (!response.ok)
          throw new Error(`studio.audio_http_${response.status}: ${source}`);
        const length = Number(response.headers.get("content-length"));
        if (
          !Number.isSafeInteger(length) ||
          length <= 0 ||
          length > 256 * 1024 * 1024
        )
          throw new Error(
            "studio.audio_limit: encoded audio exceeds the snapshot byte limit",
          );
        const bytes = await response.arrayBuffer();
        loadSignal.throwIfAborted();
        if (bytes.byteLength !== length)
          throw new Error("studio.audio_length: incomplete snapshot audio");
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

  private navigateFrame(
    direction: "first" | "previous" | "next" | "last",
  ): Promise<void> {
    const state = this.controller.getState();
    if (!state.source || this.operation) return Promise.resolve();
    const frame = state.requestedFrame ?? state.presentedFrame ?? 0;
    const start = state.range?.start ?? 0;
    const end =
      (state.range?.end ?? state.source.composition.durationFrames) - 1;
    return this.controller.seek(
      direction === "first"
        ? start
        : direction === "last"
          ? end
          : frame + (direction === "previous" ? -1 : 1),
    );
  }

  private commitExactFrame(): void {
    const state = this.controller.getState();
    if (!state.source || this.operation || this.disposed) return;
    const frame = Number(this.exactFrame.value);
    if (
      state.phase !== "error" &&
      frame === (state.requestedFrame ?? state.presentedFrame)
    )
      return;
    void this.action(this.controller.seek(frame));
  }

  private renderProperties(): void {
    if (this.codeSource?.enabled) {
      this.renderCodeProperties();
      return;
    }
    this.codeEditor?.dispose();
    this.codeEditor = undefined;
    this.options.root.setAttribute("data-code-editor", "false");
    for (const part of ["inspector", "timeline", "media", "actions", "canvas"])
      required<HTMLElement>(this.options.root, `[data-code-${part}]`).hidden =
        true;
    this.codeStatus.textContent =
      "Edit this composition in your source editor.";
  }

  private renderCode(): void {
    const state = this.controller.getState();
    if (this.codeSource?.enabled && this.codeEditor && state.source) {
      this.codeEditor.update(
        this.codeSource,
        state.source.composition,
        state.presentedFrame ?? 0,
        !!this.operation ||
          !!this.editOperation ||
          (this.codeReceiptMissing() && !this.codeSource.syntaxError) ||
          !!state.playing,
        state.source.session.sourceVersion,
      );
      if (this.codeReceiptMissing()) {
        const discard = required<HTMLElement>(
          this.options.root,
          "[data-code-inspector]",
        ).querySelector<HTMLButtonElement>("[data-code-discard]");
        if (discard)
          discard.disabled = !!this.operation || !!this.editOperation;
      }
      return;
    }
  }

  private renderCodeProperties(): void {
    this.options.root.setAttribute("data-code-editor", "true");
    for (const part of ["inspector", "timeline", "media", "actions", "canvas"])
      required<HTMLElement>(this.options.root, `[data-code-${part}]`).hidden =
        part === "canvas" && (!!this.codePending || this.codeError);
    if (!this.codeEditor)
      this.codeEditor = new CodeEditor({
        inspector: required(this.options.root, "[data-code-inspector]"),
        timeline: required(this.options.root, "[data-code-timeline]"),
        canvas: required(this.options.root, "[data-code-canvas]"),
        media: required(this.options.root, "[data-code-media]"),
        actions: required(this.options.root, "[data-code-actions]"),
        save: (edits, revision) =>
          this.trackEdit(this.saveCode(edits, revision)),
        history: (action) => this.trackEdit(this.changeCodeHistory(action)),
        recover: () => this.trackEdit(this.recoverCode()),
        seek: (frame) => {
          void this.action(this.seekLayerFrame(frame));
        },
        draft: () => {
          this.syncCodeState();
          this.renderProperties();
          this.render(this.controller.getState());
        },
        select: () => {
          this.selectInspector("properties");
          this.client?.changed();
        },
        inspect: async (id, signal) => {
          const inspected = await this.transport.inspect(
            `[data-velocast-layer="${CSS.escape(id)}"]`,
            signal,
          );
          if (
            inspected.styles.display === "none" ||
            Number(inspected.styles.opacity) === 0
          )
            return { x: 0, y: 0, width: 0, height: 0 };
          return inspected.bounds;
        },
      });
    this.refresh.disabled = !!this.operation || !!this.editOperation;
    this.composition.disabled = this.refresh.disabled;
    for (const button of this.compositionItems.values())
      button.disabled = this.composition.disabled;
    this.renderCode();
    this.codeStatus.textContent = this.editOperation
      ? "Saving source…"
      : this.codeEditor.hasDraft
        ? "Unsaved source changes"
        : (this.codeMessage ?? "Saved and displayed");
  }

  private codeOutputBlocked(): boolean {
    return (
      this.codeError ||
      (!!this.codeSource?.enabled &&
        (!!this.codeEditor?.hasDraft ||
          !!this.codeEditor?.conflicted ||
          !!this.editOperation ||
          !!this.codePending ||
          this.controller.getState().phase === "error"))
    );
  }

  private codeReceipt(): string | undefined {
    const displayed = this.controller.getState().source;
    if (
      !displayed ||
      this.snapshot?.session.sessionId !== displayed.session.sessionId ||
      this.snapshot.session.sourceVersion !== displayed.session.sourceVersion
    )
      return undefined;
    return this.snapshot.codeRevisions?.[displayed.composition.id];
  }

  private codeReceiptMissing(): boolean {
    return !!this.codeSource?.enabled && !this.codeReceipt();
  }

  private get codePending(): boolean {
    const displayed = this.controller.getState().source;
    return (
      !!this.codeSource?.enabled &&
      (this.codeSource.compositionId !== displayed?.composition.id ||
        this.codeSource.revision !== this.codeReceipt())
    );
  }

  private recordCodeFailure(error: Error, message: string): void {
    if (this.codeSource?.enabled)
      this.codeFailures.set(this.codeSource.compositionId, {
        revision: this.codeSource.revision,
        message,
        error,
      });
    this.codeError = true;
    this.codeMessage = message;
  }

  private syncCodeState(): void {
    const source = this.codeSource;
    const hadError = this.codeError;
    if (!source?.enabled) {
      this.codeError = false;
      this.codeMessage = undefined;
      return;
    }
    const failure = this.codeFailures.get(source.compositionId);
    if (source.recoveryRequired) {
      this.codeError = true;
      this.codeMessage =
        "A source edit was interrupted. Recover it before editing or exporting.";
    } else if (source.syntaxError) {
      this.codeError = true;
      this.codeMessage =
        "Fix the source syntax error in your editor or use Undo.";
      this.showError(new Error(source.syntaxError));
    } else if (this.codeReceiptMissing()) {
      this.codeError = false;
      this.codeMessage =
        "Link source builds with studioSourcePlugin in vite.config, then rebuild to enable source editing and export.";
    } else if (
      failure &&
      failure.revision === source.revision &&
      this.codeEditor?.hasDraft
    ) {
      this.codeError = true;
      this.codeMessage = failure.message;
      this.showError(failure.error);
    } else if (!this.codePending) {
      this.codeFailures.delete(source.compositionId);
      this.codeError = false;
      this.codeMessage = "Saved and displayed";
    } else if (failure && failure.revision === source.revision) {
      this.codeError = true;
      this.codeMessage = failure.message;
      this.showError(failure.error);
    } else {
      this.codeError = false;
      this.codeMessage = "Saved source changed; waiting for completed build";
    }
    if (hadError && !this.codeError) this.clearError();
  }

  private async refreshCode(): Promise<void> {
    const displayed = this.controller.getState().source;
    if (!this.api.getCode || !displayed || this.disposed) return;
    const epoch = ++this.codeReadEpoch;
    try {
      const source = await this.api.getCode(
        displayed.composition.id,
        this.lifetime.signal,
      );
      if (
        epoch !== this.codeReadEpoch ||
        this.disposed ||
        this.controller.getState().source !== displayed
      )
        return;
      this.codeSource = source;
      this.syncCodeState();
      this.renderProperties();
      this.render(this.controller.getState());
    } catch (error) {
      if (epoch === this.codeReadEpoch && !this.disposed && !isAbort(error)) {
        this.recordCodeFailure(
          asError(error),
          "Cannot read the source. Fix the error in your source editor.",
        );
        this.showError(asError(error));
        this.renderProperties();
        this.render(this.controller.getState());
      }
    }
  }

  private saveCode(edits: CodeEdit[], revision: string): Promise<void> {
    if (!this.api.saveCode) return Promise.resolve();
    return this.mutateCode((guard, signal) =>
      this.api.saveCode!(
        { ...guard, expectedRevision: revision, edits },
        signal,
      ),
    );
  }

  private changeCodeHistory(action: "undo" | "redo"): Promise<void> {
    if (!this.api.changeCodeHistory || !this.codeSource?.revision)
      return Promise.resolve();
    const expectedRevision = this.codeSource.revision;
    return this.mutateCode(
      (guard, signal) =>
        this.api.changeCodeHistory!(
          { ...guard, expectedRevision, action },
          signal,
        ),
      "history",
    );
  }

  private async mutateCode(
    apply: (
      guard: {
        compositionId: string;
        expectedSourceVersion: string;
      },
      signal: AbortSignal,
    ) => Promise<CodeSource>,
    action: "edit" | "history" | "recover" = "edit",
  ): Promise<void> {
    const displayed = this.controller.getState().source;
    if (
      !displayed ||
      !this.codeSource?.enabled ||
      (action === "edit" &&
        (this.codeReceiptMissing() || this.codeSource.syntaxError)) ||
      (action !== "recover" && this.codeSource.recoveryRequired) ||
      (action === "recover" && this.codeEditor?.hasDraft) ||
      this.operation ||
      this.editOperation ||
      this.disposed
    )
      return;
    const operation = new AbortController();
    this.editOperation = operation;
    this.clearError();
    this.renderProperties();
    this.render(this.controller.getState());
    try {
      await this.cancelOutput("Output cancelled before saving source.");
      operation.signal.throwIfAborted();
      const source = await apply(
        {
          compositionId: displayed.composition.id,
          expectedSourceVersion: displayed.session.sourceVersion,
        },
        operation.signal,
      );
      this.codeSource = source;
      this.codeEditor?.accept(source);
      this.syncCodeState();
      if (this.codePending) {
        const result = await this.load(true);
        if (result === "failed") {
          this.codeError = true;
        }
      }
    } catch (error) {
      if (!isAbort(error)) {
        this.recordCodeFailure(
          asError(error),
          "Source was not saved. Review the error and reload if it changed elsewhere.",
        );
        this.showError(asError(error));
        await this.refreshCode();
      }
    } finally {
      if (this.editOperation === operation) this.editOperation = undefined;
      this.renderProperties();
      this.render(this.controller.getState());
    }
  }

  private recoverCode(): Promise<void> {
    if (!this.api.recoverCode || !this.codeSource?.recoveryRequired)
      return Promise.resolve();
    return this.mutateCode(
      ({ compositionId, expectedSourceVersion }, signal) =>
        this.api.recoverCode!({ compositionId, expectedSourceVersion }, signal),
      "recover",
    );
  }

  private async seekLayerFrame(frame: number): Promise<void> {
    await this.controller.pause();
    const state = this.controller.getState();
    if (!state.source) return;
    if (state.range && (frame < state.range.start || frame >= state.range.end))
      await this.controller.setPlaybackRange({
        start: 0,
        end: state.source.composition.durationFrames,
      });
    await this.controller.seek(frame);
  }

  private trackEdit(work: Promise<void>): void {
    this.editWorks.add(work);
    void work.then(
      () => this.editWorks.delete(work),
      () => this.editWorks.delete(work),
    );
  }

  private async pollSource(): Promise<void> {
    const snapshot = this.snapshot;
    const source = this.controller.getState().source;
    const current = () =>
      !this.disposed &&
      !this.operation &&
      !this.outputOperation &&
      !this.editOperation &&
      this.snapshot === snapshot &&
      this.controller.getState().source === source;
    try {
      if (!current() || !snapshot) return;
      await this.refreshCode();
      if (!current()) return;
      if (snapshot.autoRefresh === false || !snapshot.sourceRevision) return;
      const change = await this.api.changes!(this.lifetime.signal);
      if (!current()) return;
      if (
        change.enabled &&
        this.refreshGate.observe(snapshot.sourceRevision, change.revision)
      ) {
        if ((await this.load(true, true)) === "failed")
          this.refreshGate.reject(change.revision);
      }
    } catch (error) {
      // A build may temporarily remove the entry tree. Keep presenting the frozen source.
      if (current() && !isAbort(error))
        this.status.textContent = "Waiting for a completed build";
    } finally {
      this.scheduleRefresh();
    }
  }

  private async selectComposition(compositionId: string): Promise<void> {
    if (!this.snapshot) return;
    if (this.codeEditor?.hasDraft) {
      this.composition.value =
        this.controller.getState().source?.composition.id ?? "";
      this.showError(
        new Error(
          "Save or discard your source changes before switching compositions.",
        ),
      );
      return;
    }
    await this.cancelOutput("Output cancelled by composition change.");
    if (this.disposed) return;
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
      this.codeMessage = undefined;
      await this.refreshCode();
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
    snapshot: StudioSessionDescriptor,
    preferred: string | undefined,
    signal: AbortSignal,
    frame = 0,
  ): Promise<{ source: StudioSource; compositions: CompositionManifest[] }> {
    const connection = new IframeStudioConnection(snapshot, {
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

  private snapshotFor(source: StudioSource): StudioSnapshot {
    if (
      !this.snapshot ||
      this.snapshot.session.sessionId !== source.session.sessionId ||
      this.snapshot.session.sourceVersion !== source.session.sourceVersion
    )
      throw new Error("studio.snapshot_mismatch: source is no longer current");
    return this.snapshot;
  }

  private requestOutput(kind: "frame" | "range" | "video"): Promise<void> {
    if (this.outputWork) return this.outputWork;
    const work = this.runOutput(kind);
    this.outputWork = work;
    const finished = () => {
      if (this.outputWork === work) this.outputWork = undefined;
    };
    void work.then(finished, finished);
    return work;
  }

  private async runOutput(kind: "frame" | "range" | "video"): Promise<void> {
    const state = this.controller.getState();
    if (
      !state.source ||
      state.presentedFrame === undefined ||
      this.codeOutputBlocked()
    )
      return;
    this.outputOperation?.abort();
    const operation = new AbortController();
    this.outputOperation = operation;
    this.outputCancelMessage = undefined;
    const epoch = ++this.outputEpoch;
    const expected = state.source.session.sourceVersion;
    const base = {
      compositionId: state.source.composition.id,
      expectedSourceVersion: expected,
    };
    const request: StudioOutputRequest =
      kind === "frame"
        ? { ...base, frame: state.presentedFrame }
        : {
            ...base,
            range:
              kind === "video"
                ? { start: 0, end: state.source.composition.durationFrames }
                : state.range!,
          };
    this.output.textContent =
      kind === "frame" ? "Rendering image…" : "Rendering video…";
    this.frameOutput.disabled = true;
    this.videoOutput.disabled = true;
    this.rangeOutput.disabled = true;
    this.cancelOutputButton.hidden = false;
    this.cancelOutputButton.disabled = false;
    try {
      const result = await this.api.output(request, operation.signal, (job) => {
        if (epoch === this.outputEpoch)
          this.output.textContent =
            job.status === "cancelling"
              ? "Cancelling…"
              : kind === "frame"
                ? "Rendering image…"
                : "Rendering video…";
      });
      if (
        this.disposed ||
        epoch !== this.outputEpoch ||
        this.controller.getState().source?.session.sourceVersion !== expected
      ) {
        if (!this.disposed)
          this.output.textContent = "Output completed for the previous source.";
        return;
      }
      const shown = outputLabel(result, kind === "frame");
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
      if (shown.href) node.innerHTML = `${icon(ExternalLink)} ${shown.label}`;
      this.output.append(node);
    } catch (error) {
      if (isAbort(error))
        this.output.textContent =
          this.outputCancelMessage ?? "Output cancelled.";
      else {
        this.output.textContent = "Export failed. See the error below.";
        this.showError(asError(error));
      }
    } finally {
      if (this.outputOperation === operation) {
        this.outputOperation = undefined;
        this.cancelOutputButton.hidden = true;
        this.render(this.controller.getState());
      }
    }
  }

  private async cancelOutput(
    message: string,
    suppressResult = true,
  ): Promise<void> {
    if (!this.outputOperation) return;
    this.outputCancelMessage = message;
    if (suppressResult) ++this.outputEpoch;
    this.outputOperation.abort();
    this.output.textContent = "Cancelling output; waiting for job cleanup…";
    this.cancelOutputButton.disabled = true;
    await this.outputWork;
  }

  private async action(action: Promise<void>): Promise<void> {
    this.clearError();
    try {
      await action;
    } catch (error) {
      if (!isAbort(error)) this.showError(asError(error));
    }
  }

  private render(state: StudioState<IframePresentation>): void {
    const source = state.source;
    for (const [id, button] of this.compositionItems) {
      button.disabled = this.composition.disabled;
      button.setAttribute(
        "aria-pressed",
        String(id === source?.composition.id),
      );
    }
    const ready = !!source && state.presentedFrame !== undefined;
    if (state.frame && ready) this.transport.present(state.frame);
    required<HTMLElement>(this.stage, ".empty-state").hidden = ready;
    this.status.textContent = this.operation
      ? "Loading source"
      : state.phase === "error"
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
    if (this.playingIcon !== state.playing) {
      this.play.innerHTML = icon(state.playing ? Pause : Play);
      this.play.setAttribute("aria-label", state.playing ? "Pause" : "Play");
      this.play.title = state.playing ? "Pause (Space)" : "Play (Space)";
      this.playingIcon = state.playing;
    }
    this.play.disabled = !ready || state.phase === "error" || !!this.operation;
    this.seek.disabled = !source || !!this.operation;
    this.exactFrame.disabled = !source || !!this.operation;
    if (source) {
      if (this.audioSummary?.source !== source)
        this.audioSummary = {
          source,
          audible:
            !!source.audioPlan &&
            normalizeAudioPlan(source.audioPlan).clips.length > 0,
        };
      const min = state.range?.start ?? 0;
      const max = (state.range?.end ?? source.composition.durationFrames) - 1;
      this.seek.min = String(min);
      this.seek.max = String(max);
      this.seek.value = String(
        state.requestedFrame ?? state.presentedFrame ?? 0,
      );
      this.exactFrame.min = String(min);
      this.exactFrame.max = String(max);
      this.exactFrame.value = this.seek.value;
      this.rangeStart.max = String(source.composition.durationFrames - 1);
      this.rangeEnd.max = String(source.composition.durationFrames);
      this.rangeStart.value = String(state.range?.start ?? 0);
      this.rangeEnd.value = String(
        state.range?.end ?? source.composition.durationFrames,
      );
      if (!this.operation) this.composition.value = source.composition.id;
      required(this.options.root, "[data-selected-composition]").textContent =
        source.composition.id;
      required(this.options.root, "[data-composition-info]").textContent =
        `${source.composition.width} × ${source.composition.height} · ${source.composition.fps} fps · ${(source.composition.durationFrames / source.composition.fps).toFixed(1)}s`;
      required(this.options.root, "[data-export-info]").textContent =
        `${source.composition.width} × ${source.composition.height} · ${(source.composition.durationFrames / source.composition.fps).toFixed(1)} seconds · complete video${this.audioSummary.audible ? " with audio" : ""}`;
    }
    for (const direction of ["first", "previous", "next", "last"] as const)
      required<HTMLButtonElement>(
        this.options.root,
        `[data-${direction}-frame]`,
      ).disabled = !ready || !!this.operation;
    const outputReady = ready && ["ready", "playing"].includes(state.phase);
    this.frameOutput.disabled =
      !outputReady ||
      !!this.outputOperation ||
      !!this.operation ||
      !!this.editOperation ||
      this.codeOutputBlocked();
    this.rangeOutput.disabled =
      !outputReady ||
      !!this.outputOperation ||
      !!this.operation ||
      !!this.editOperation ||
      this.codeOutputBlocked();
    this.videoOutput.disabled = this.rangeOutput.disabled;
    const codeExportState = required<HTMLElement>(
      this.options.root,
      "[data-code-export-state]",
    );
    codeExportState.hidden = !this.codeOutputBlocked();
    codeExportState.textContent = this.codeReceiptMissing()
      ? "Link source builds with studioSourcePlugin in vite.config, then rebuild before exporting."
      : this.codeEditor?.hasDraft
        ? "Save or discard source changes before exporting."
        : this.codeError || state.phase === "error"
          ? "Fix the source error before exporting."
          : "Waiting for the saved source to appear in the viewer.";
    if (state.error) this.showError(state.error);
    this.updateFrameReadout();
    this.renderCode();
    this.fitIframe();
    this.client?.changed();
  }

  private clientState(): Omit<StudioClientState, "revision"> {
    const state = this.controller.getState();
    const error =
      (this.error.hidden ? undefined : this.error.textContent || undefined) ??
      (this.codeError ? this.codeMessage : undefined);
    return {
      sourceVersion: state.source?.session.sourceVersion ?? "",
      compositions: this.compositions.map(
        ({ id, width, height, fps, durationFrames }) => ({
          id,
          width,
          height,
          fps,
          durationFrames,
        }),
      ),
      compositionId: state.source?.composition.id,
      frame: state.presentedFrame,
      selectedElementId: this.codeEditor?.selection,
      sourceRevision:
        this.codeReceipt() ??
        (this.snapshot?.session.sourceVersion ===
        state.source?.session.sourceVersion
          ? this.snapshot?.sourceRevision
          : undefined),
      dirty: !!this.codeEditor?.hasDraft,
      ready:
        !!state.source &&
        state.presentedFrame !== undefined &&
        ["ready", "playing"].includes(state.phase) &&
        !this.operation &&
        !this.editOperation,
      exportReady: !this.videoOutput.disabled && !!state.source,
      playing: !!state.playing,
      error: error?.slice(0, 4000),
    };
  }

  private async controlClient(
    command: StudioClientCommand,
  ): Promise<import("@velocast/core").StudioElementInspection | void> {
    const state = this.clientState();
    if (
      (!state.ready && !(command.action === "pause" && state.playing)) ||
      this.disposed
    )
      throw new Error(
        "studio.client_not_ready: Wait for the current operation to finish.",
      );
    if (command.action === "play" || command.action === "pause") {
      await (command.action === "play"
        ? this.controller.play()
        : this.controller.pause());
      const current = this.clientState();
      if (
        !current.ready ||
        current.sourceVersion !== state.sourceVersion ||
        current.playing !== (command.action === "play")
      )
        throw new Error(
          current.error ??
            "studio.client_interrupted: Playback did not reach the requested state.",
        );
    } else if (command.action === "seek") {
      const composition = this.controller.getState().source!.composition;
      if (command.frame >= composition.durationFrames)
        throw new Error(
          `studio.frame_invalid: Frame must be within [0, ${composition.durationFrames}).`,
        );
      await this.seekLayerFrame(command.frame);
      const current = this.clientState();
      if (
        !current.ready ||
        current.sourceVersion !== state.sourceVersion ||
        current.compositionId !== state.compositionId ||
        current.frame !== command.frame
      )
        throw new Error(
          "studio.client_interrupted: The requested frame was not presented. Read the current state and retry.",
        );
    } else if (command.action === "inspect") {
      if (
        state.playing ||
        state.dirty ||
        !state.exportReady ||
        this.codePending
      )
        throw new Error(
          "studio.inspect_not_ready: Pause, resolve drafts and wait for the saved build before inspection.",
        );
      const inspected = await this.transport.inspect(
        `[data-velocast-layer="${CSS.escape(command.elementId)}"]`,
        this.lifetime.signal,
      );
      if (inspected.matchCount !== 1)
        throw new Error(
          "studio.inspect_ambiguous: The Layer ID must identify exactly one rendered element.",
        );
      const current = this.clientState();
      if (JSON.stringify(current) !== JSON.stringify(state))
        throw new Error(
          "studio.inspect_stale: The displayed frame changed during inspection; read context and retry.",
        );
      return inspected;
    } else if (command.action === "select") {
      if (!this.codeEditor)
        throw new Error(
          "studio.source_unavailable: This composition has no inspectable source elements.",
        );
      this.codeEditor.selectElement(command.elementId);
    } else if (command.action === "composition") {
      if (state.dirty)
        throw new Error(
          "studio.client_dirty: Save or discard this tab's edits before switching compositions.",
        );
      if (!this.compositions.some(({ id }) => id === command.compositionId))
        throw new Error(
          `studio.composition_missing: No composition named ${command.compositionId}`,
        );
      await this.selectComposition(command.compositionId);
      const current = this.clientState();
      if (
        !current.ready ||
        current.sourceVersion !== state.sourceVersion ||
        current.compositionId !== command.compositionId
      )
        throw new Error(
          current.error ??
            "studio.client_interrupted: The requested composition was not loaded. Read the current state and retry.",
        );
    }
  }

  private async showAgentConnection(): Promise<void> {
    const config = required(this.options.root, "[data-agent-config]");
    if (!this.api.agentConnection) {
      config.textContent =
        "Agent connections require the Velocast Studio server.";
      return;
    }
    try {
      const connection = await this.api.agentConnection(this.lifetime.signal);
      config.textContent = JSON.stringify(
        { mcpServers: { velocast: connection } },
        null,
        2,
      );
    } catch (error) {
      if (!this.disposed) config.textContent = asError(error).message;
    }
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
    this.compositionItems.clear();
    required(this.options.root, "[data-composition-count]").textContent =
      String(this.compositions.length);
    required(this.options.root, "[data-composition-list]").replaceChildren(
      ...this.compositions.map((composition) => {
        const button = this.options.root.ownerDocument.createElement("button");
        button.type = "button";
        button.className = "composition-item";
        button.title = `${composition.id} · ${composition.width} × ${composition.height} · ${composition.durationFrames} frames`;
        button.setAttribute(
          "aria-pressed",
          String(composition.id === selected),
        );
        const title = this.options.root.ownerDocument.createElement("span");
        title.textContent = composition.id;
        const detail = this.options.root.ownerDocument.createElement("small");
        detail.textContent = `${(composition.durationFrames / composition.fps).toFixed(1)}s · ${composition.fps} fps`;
        const mark = this.options.root.ownerDocument.createElement("span");
        mark.className = "composition-icon";
        mark.innerHTML = icon(Film);
        button.append(mark, title, detail);
        button.addEventListener("click", () => {
          if (this.composition.disabled) return;
          this.composition.value = composition.id;
          void this.selectComposition(composition.id);
        });
        this.compositionItems.set(composition.id, button);
        return button;
      }),
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
    const actualScale = Math.max(0.01, scale);
    this.codeEditor?.fit(
      source.composition.width,
      source.composition.height,
      actualScale,
      (this.stage.clientWidth - source.composition.width * actualScale) / 2,
      (this.stage.clientHeight - source.composition.height * actualScale) / 2,
    );
  }

  private setBusy(busy: boolean): void {
    this.refresh.disabled = busy || !!this.editOperation;
    this.composition.disabled = busy || !!this.editOperation;
    this.renderProperties();
    this.render(this.controller.getState());
  }

  private clearError(): void {
    this.error.hidden = true;
    this.error.textContent = "";
    this.client?.changed();
  }

  private showError(error: Error): void {
    this.error.hidden = false;
    this.error.textContent = error.message;
    this.client?.changed();
  }
}
