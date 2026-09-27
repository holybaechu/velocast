import type {
  CompositionManifest as WireCompositionManifest,
  RenderContext as WireRenderContext,
  RenderSession as WireRenderSession,
  RendererAcceleration,
  RendererAssemblyMode,
  RendererConcurrency,
} from "./generated/browser-contracts.js";
import type { AudioPlan } from "./audio-plan.js";
import type { SourceAdapter } from "./source-adapter.js";

export type { RendererAcceleration, RendererAssemblyMode, RendererConcurrency };

// Authoring accepts omitted optional values. The wire also accepts explicit null.
type AuthoringFields<T> = { [K in keyof T]: Exclude<T[K], null> };
export type CompositionManifest = AuthoringFields<WireCompositionManifest>;
export type CompositionDefinition = Omit<CompositionManifest, "id">;
export type RenderContext = AuthoringFields<WireRenderContext>;
export type RenderSession = WireRenderSession;

export interface FrameAdapterContext extends RenderContext {
  rootElement?: HTMLElement;
  /** Core supplies a signal for init/seek. Hooks must await their work and honor cancellation. */
  signal?: AbortSignal;
}

export interface FrameAdapter {
  id: string;
  init?(context: FrameAdapterContext): Promise<void> | void;
  getDurationFrames(): number;
  seekFrame(frame: number, context: FrameAdapterContext): Promise<void> | void;
  /** Resolved after init; positions use decoded/resampled sample frames, not packets. */
  getAudioPlan?(
    context: FrameAdapterContext,
  ): Promise<AudioPlan | null> | AudioPlan | null;
  destroy?(): Promise<void> | void;
}

export interface FrameAdapterRegistrationOptions extends Omit<
  CompositionDefinition,
  "durationFrames"
> {
  rootElement?: HTMLElement | string;
}

export interface BrowserProtocol {
  readonly protocolVersion: number;
  beginSession(session: RenderSession): Promise<void>;
  getSession(): RenderSession | undefined;
  /** Invalidates in-flight work; await destroy() before reusing a cancelled runtime. */
  cancelPending(): void;
  getCompositions(): Promise<CompositionManifest[]>;
  getDurationFrames(compositionId: string): Promise<number>;
  /** Resolve a validated plan using the same session and input props as rendering. */
  getAudioPlan?(
    compositionId: string,
    context?: RenderContext,
  ): Promise<AudioPlan | null>;
  seekFrame(
    compositionId: string,
    frame: number,
    context?: RenderContext,
  ): Promise<void>;
  /** Core runtimes retain these defaults until replaced or destroyed; per-seek props override them. */
  setInputProps(inputProps: unknown): Promise<void>;
  waitForReady?(): Promise<void>;
  destroy(): Promise<void>;
}

export interface VelocastGlobal {
  registerAdapter(
    compositionId: string,
    adapter: FrameAdapter,
    options: FrameAdapterRegistrationOptions,
  ): BrowserProtocol;
}

export interface Config {
  source?: SourceAdapter;
  entry?: string;
  serve?: {
    command?: string;
    url?: string;
    port?: number;
  };
  renderer?: {
    /** Optional immutable static-entry bundle root, resolved relative to the config file. */
    snapshotRoot?: string;
    binary?: "auto" | string;
    concurrency?: RendererConcurrency;
    codec?: string;
    pixelFormat?: string;
    bitrate?: string | number;
    acceleration?: RendererAcceleration;
    assembly?: RendererAssemblyMode;
    reportPath?: string;
    eventLogPath?: string;
    verifySegments?: boolean;
  };
}

declare global {
  interface Window {
    __velocast?: BrowserProtocol;
    Velocast?: VelocastGlobal;
  }
}
