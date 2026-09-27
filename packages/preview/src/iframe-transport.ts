import {
  BROWSER_PROTOCOL_VERSION,
  validateComposition,
  validateAudioPlan,
  type AudioPlan,
  type CompositionManifest,
} from "@velocast/core";
import type { PreviewSource, PreviewTransport } from "./types.js";
import { PreviewRpcClient } from "./rpc-client.js";
import type { ElementInspection } from "./element-inspection.js";
import {
  isRpcSession,
  loopbackOrigin,
  sameRpcSession,
  type RpcSession,
} from "./rpc-wire.js";

export interface PreviewSnapshot {
  readonly snapshotUrl: string;
  readonly session: RpcSession;
  readonly inputProps?: unknown;
}
export interface IframeConnectionOptions {
  readonly container: HTMLElement;
  readonly hostWindow?: Window;
  readonly timeoutMs?: number;
  readonly teardownTimeoutMs?: number;
  readonly onCleanupWarning?: (error: unknown) => void;
}
export interface IframePresentation {
  readonly frame: number;
  readonly compositionId: string;
  readonly session: RpcSession;
}
function cancelled(): Error {
  const error = new Error("preview.iframe_cancelled: source was replaced");
  error.name = "AbortError";
  return error;
}
function checkSnapshot(snapshot: PreviewSnapshot): PreviewSnapshot {
  if (!isRpcSession(snapshot.session))
    throw new Error("preview.snapshot_invalid: session identity is required");
  const url = new URL(snapshot.snapshotUrl);
  loopbackOrigin(url.origin);
  if (url.username || url.password)
    throw new Error(
      "preview.snapshot_invalid: credentialed URLs are not supported",
    );
  return Object.freeze({
    ...snapshot,
    snapshotUrl: url.href,
    session: Object.freeze({ ...snapshot.session }),
  });
}
function compositions(value: unknown): CompositionManifest[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("preview.compositions_empty: no registered compositions");
  return value.map((item) => validateComposition(item?.id, item));
}

/** One cross-origin browsing context. Removing it is the final abort boundary. */
export class IframePreviewConnection {
  readonly snapshot: PreviewSnapshot;
  readonly iframe: HTMLIFrameElement;
  private readonly host: Window;
  private rpc?: PreviewRpcClient;
  private available: CompositionManifest[] = [];
  private selected?: CompositionManifest;
  private audioPlan?: AudioPlan;
  private closed = false;
  private closing?: Promise<void>;
  constructor(
    snapshot: PreviewSnapshot,
    private readonly options: IframeConnectionOptions,
  ) {
    this.snapshot = checkSnapshot(snapshot);
    this.host =
      options.hostWindow ?? options.container.ownerDocument.defaultView!;
    loopbackOrigin(this.host.location.origin);
    this.iframe = options.container.ownerDocument.createElement("iframe");
    this.iframe.title = "Composition preview";
    this.iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
    this.iframe.referrerPolicy = "no-referrer";
    Object.assign(this.iframe.style, {
      border: "0",
      display: "block",
      width: "1200px",
      height: "630px",
      visibility: "hidden",
      transformOrigin: "0 0",
    });
  }
  async connect(signal?: AbortSignal): Promise<CompositionManifest[]> {
    if (this.closed) throw cancelled();
    if (this.rpc) return this.available;
    try {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(cancelled());
          return;
        }
        const cleanup = () => {
          clearTimeout(timer);
          this.iframe.removeEventListener("load", loaded);
          this.iframe.removeEventListener("error", failed);
          signal?.removeEventListener("abort", abort);
        };
        const loaded = () => {
          cleanup();
          resolve();
        };
        const failed = () => {
          cleanup();
          reject(
            new Error("preview.iframe_load_failed: snapshot did not load"),
          );
        };
        const abort = () => {
          cleanup();
          reject(cancelled());
        };
        const timer = setTimeout(failed, this.options.timeoutMs ?? 15000);
        this.iframe.addEventListener("load", loaded, { once: true });
        this.iframe.addEventListener("error", failed, { once: true });
        signal?.addEventListener("abort", abort, { once: true });
        this.iframe.src = this.snapshot.snapshotUrl;
        this.options.container.appendChild(this.iframe);
      });
      if (this.closed || signal?.aborted) throw cancelled();
      if (!this.iframe.contentWindow)
        throw new Error("preview.iframe_missing: browsing context unavailable");
      this.rpc = new PreviewRpcClient({
        host: this.host,
        target: this.iframe.contentWindow,
        targetOrigin: new URL(this.snapshot.snapshotUrl).origin,
        session: this.snapshot.session,
        timeoutMs: this.options.timeoutMs,
      });
      const result = await this.rpc.request<{
        protocolVersion: number;
        compositions: unknown;
      }>("connect", { inputProps: this.snapshot.inputProps }, signal);
      if (result.protocolVersion !== BROWSER_PROTOCOL_VERSION)
        throw new Error(
          `preview.protocol_mismatch: authoring protocol v${BROWSER_PROTOCOL_VERSION} is required`,
        );
      this.available = compositions(result.compositions);
      return this.available;
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }
  async initialize(
    compositionId: string,
    signal?: AbortSignal,
  ): Promise<PreviewSource> {
    await this.connect(signal);
    const composition = this.available.find(
      (item) => item.id === compositionId,
    );
    if (!composition)
      throw new Error(
        "preview.composition_missing: composition is not registered",
      );
    if (this.selected && this.selected.id !== compositionId)
      throw new Error("preview.composition_change: create a new connection");
    if (!this.selected) {
      this.iframe.width = String(composition.width);
      this.iframe.height = String(composition.height);
      this.iframe.style.width = `${composition.width}px`;
      this.iframe.style.height = `${composition.height}px`;
      this.iframe.getBoundingClientRect(); // flush host layout before cross-process viewport setup
      const result = await this.rpc!.request<{
        composition: CompositionManifest;
        audioPlan: AudioPlan | null;
      }>("initialize", { compositionId }, signal);
      const returned = validateComposition(
        result.composition?.id,
        result.composition,
      );
      if (JSON.stringify(returned) !== JSON.stringify(composition))
        throw new Error(
          "preview.composition_changed: metadata changed while initializing",
        );
      this.audioPlan =
        result.audioPlan === null
          ? undefined
          : validateAudioPlan(result.audioPlan);
      this.selected = composition;
    }
    return {
      session: this.snapshot.session,
      composition: this.selected,
      inputProps: this.snapshot.inputProps,
      ...(this.audioPlan ? { audioPlan: this.audioPlan } : {}),
    };
  }
  async seek(frame: number, signal?: AbortSignal): Promise<IframePresentation> {
    if (this.closed || !this.selected || !this.rpc)
      throw new Error("preview.iframe_not_ready: initialize first");
    const result = await this.rpc.request<{
      frame: number;
      compositionId: string;
    }>("seek", { frame }, signal);
    if (this.closed || signal?.aborted) throw cancelled();
    if (result.frame !== frame || result.compositionId !== this.selected.id)
      throw new Error(
        "preview.frame_mismatch: child acknowledged another frame",
      );
    return Object.freeze({ ...result, session: this.snapshot.session });
  }
  present(): void {
    if (!this.closed && this.selected) this.iframe.style.visibility = "visible";
  }
  inspect(selector: string, signal?: AbortSignal): Promise<ElementInspection> {
    if (this.closed || !this.selected || !this.rpc)
      return Promise.reject(
        new Error("preview.iframe_not_ready: initialize first"),
      );
    return this.rpc.request("inspect", { selector }, signal);
  }
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      try {
        if (this.rpc) {
          const abort = new AbortController();
          const timer = setTimeout(
            () => abort.abort(),
            this.options.teardownTimeoutMs ?? 1500,
          );
          try {
            await this.rpc.request("destroy", undefined, abort.signal);
          } finally {
            clearTimeout(timer);
          }
        }
      } catch (error) {
        (
          this.options.onCleanupWarning ??
          ((warning) => console.warn("preview.iframe_forced_discard", warning))
        )(error);
      } finally {
        this.rpc?.close();
        this.rpc = undefined;
        this.iframe.remove();
      }
    })();
    return this.closing;
  }
}

export interface IframeTransportOptions extends IframeConnectionOptions {
  /** Return only the immutable descriptor matching this already-issued session. */
  resolveSnapshot(source: PreviewSource): PreviewSnapshot;
}
export class IframePreviewTransport implements PreviewTransport<IframePresentation> {
  private connection?: IframePreviewConnection;
  constructor(private readonly options: IframeTransportOptions) {}
  async initialize(source: PreviewSource, signal: AbortSignal): Promise<void> {
    await this.dispose();
    signal.throwIfAborted();
    const snapshot = this.options.resolveSnapshot(source);
    if (!sameRpcSession(snapshot.session, source.session))
      throw new Error(
        "preview.snapshot_mismatch: resolver returned another source",
      );
    const connection = new IframePreviewConnection(snapshot, this.options);
    this.connection = connection;
    try {
      const actual = await connection.initialize(source.composition.id, signal);
      if (
        JSON.stringify(actual.composition) !==
          JSON.stringify(
            validateComposition(source.composition.id, source.composition),
          ) ||
        JSON.stringify(actual.audioPlan ?? null) !==
          JSON.stringify(source.audioPlan ?? null)
      )
        throw new Error(
          "preview.source_changed: composition or audio plan differs from discovery",
        );
    } catch (error) {
      await connection.dispose();
      if (this.connection === connection) this.connection = undefined;
      throw error;
    }
  }
  seekFrame(
    frame: number,
    source: PreviewSource,
    signal: AbortSignal,
  ): Promise<IframePresentation> {
    if (
      !this.connection ||
      !sameRpcSession(this.connection.snapshot.session, source.session)
    )
      return Promise.reject(
        new Error("preview.snapshot_mismatch: frame belongs to another source"),
      );
    return this.connection.seek(frame, signal);
  }
  present(frame: IframePresentation): void {
    if (
      this.connection &&
      sameRpcSession(frame.session, this.connection.snapshot.session)
    )
      this.connection.present();
  }
  get iframe(): HTMLIFrameElement | undefined {
    return this.connection?.iframe;
  }
  inspect(selector: string, signal?: AbortSignal): Promise<ElementInspection> {
    if (!this.connection)
      return Promise.reject(
        new Error("preview.iframe_not_ready: initialize first"),
      );
    return this.connection.inspect(selector, signal);
  }
  async dispose(): Promise<void> {
    const current = this.connection;
    this.connection = undefined;
    await current?.dispose();
  }
}
