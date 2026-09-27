import { Component, Suspense, type ComponentType, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import {
  defineFrameComposition,
  registerFrameAdapter,
  type AudioPlan,
  type BrowserProtocol,
  type FrameAdapter,
  type FrameComposition,
} from "@velocast/core";
import { FrameStore, FrameView, type VideoConfig } from "./frame-state.js";
import { abortable, throwIfAborted } from "./resources.js";
import { FrameResourceContext, FrameResourceScope } from "./frame-resources.js";

export interface ReactFont {
  readonly family: string;
  /** FontFace source, for example url('/fonts/korean.woff2'). */
  readonly source: string;
  readonly descriptors?: FontFaceDescriptors;
}

export interface ReactPreloadContext<Props extends object> {
  readonly frame: number;
  readonly inputProps: Readonly<Props>;
  readonly signal: AbortSignal;
}

export interface ReactAudioContext<Props extends object> {
  readonly inputProps: Readonly<Props>;
  readonly signal: AbortSignal;
  readonly config: VideoConfig;
}

export interface ReactCompositionOptions<
  Props extends object,
> extends VideoConfig {
  readonly component: ComponentType<Props>;
  /** Shallow defaults: supplied own properties (including undefined) override defaults. */
  readonly defaultProps?: Partial<Props>;
  /** Validates merged defaults and supplied props before rendering. */
  readonly parseProps?: (inputProps: Readonly<Partial<Props>>) => Props;
  /** Existing empty mount element; omitted creates an owned capture root. */
  readonly target?: string;
  /** Owned FontFaces are loaded before any component layout effect and removed on destroy. */
  readonly fonts?: readonly ReactFont[];
  /** Runs before every frame commit, including same-frame props updates. */
  readonly preload?: (
    context: ReactPreloadContext<Props>,
  ) => void | Promise<void>;
  /** One composition-wide sample plan, independent of the requested output range. */
  readonly audio?:
    | AudioPlan
    | ((
        context: ReactAudioContext<Props>,
      ) => AudioPlan | null | Promise<AudioPlan | null>);
}

type ReactPropResolution<Props extends object> =
  Record<never, never> extends Props
    ? {
        readonly defaultProps?: Props;
        readonly parseProps?: (inputProps: Readonly<Partial<Props>>) => Props;
      }
    : | {
          readonly defaultProps: Props;
          readonly parseProps?: (inputProps: Readonly<Partial<Props>>) => Props;
        }
      | {
          readonly defaultProps?: Partial<Props>;
          readonly parseProps: (inputProps: Readonly<Partial<Props>>) => Props;
        };

/** Pure authoring definition. Required props need complete defaults or a parser. */
export type ReactCompositionDefinitionOptions<Props extends object> = {
  readonly id: string;
  readonly video: VideoConfig;
} & Omit<
  ReactCompositionOptions<Props>,
  keyof VideoConfig | "defaultProps" | "parseProps"
> &
  ReactPropResolution<Props>;

class FrameBoundary extends Component<
  { onError: (error: Error) => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    this.props.onError(error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

let nextRoot = 0;

/** The definition does not mount React or publish a browser global. */
export function defineReactComposition<Props extends object>(
  options: ReactCompositionDefinitionOptions<Props>,
): FrameComposition {
  const { id, video, defaultProps, parseProps, ...reactOptions } = options;
  const config = Object.freeze({ ...video });
  const sourceOptions = Object.freeze({
    ...reactOptions,
    fonts: reactOptions.fonts?.map((font) => Object.freeze({ ...font })),
  });
  const rootId = `velocast-react-${Array.from(id, (character) =>
    character.codePointAt(0)!.toString(16),
  ).join("-")}`;
  const target = options.target ?? `#${rootId}`;
  return defineFrameComposition<Props>({
    id,
    video: { ...config, target },
    defaultProps: (defaultProps ?? {}) as Props,
    parseProps: parseProps
      ? (inputProps: unknown) =>
          parseProps(inputProps as Readonly<Partial<Props>>)
      : undefined,
    rootElement: target,
    source: {
      async open(context) {
        const adapter = createReactFrameAdapter(
          { ...sourceOptions, ...config },
          rootId,
        );
        try {
          await adapter.init?.(context);
        } catch (error) {
          await adapter.destroy?.();
          throw error;
        }
        return {
          seekFrame: (frame, seekContext) =>
            adapter.seekFrame(frame, seekContext),
          getAudioPlan: adapter.getAudioPlan
            ? (audioContext) => adapter.getAudioPlan!(audioContext)
            : undefined,
          dispose: () => adapter.destroy?.(),
        };
      },
    },
  });
}

export function registerReactComposition<Props extends object>(
  id: string,
  options: ReactCompositionOptions<Props>,
): BrowserProtocol {
  const rootId = `velocast-react-${++nextRoot}`;
  return registerFrameAdapter(id, createReactFrameAdapter(options, rootId), {
    width: options.width,
    height: options.height,
    fps: options.fps,
    target: options.target ?? `#${rootId}`,
    rootElement: options.target ?? `#${rootId}`,
  });
}

function createReactFrameAdapter<Props extends object>(
  options: ReactCompositionOptions<Props>,
  rootId: string,
): FrameAdapter {
  const target = options.target ?? `#${rootId}`;
  const config: VideoConfig = Object.freeze({
    width: options.width,
    height: options.height,
    fps: options.fps,
    durationFrames: options.durationFrames,
  });
  let container: HTMLElement | undefined;
  let reactRoot: Root | undefined;
  let previousStyle: string | null = null;
  let fonts: FontFace[] = [];
  let epoch = 0;
  let revision = 0;
  let committedRevision = -1;
  let renderError: Error | undefined;
  let poisoned = false;
  let store: FrameStore | undefined;
  const onCommit = (value: number) => {
    committedRevision = value;
  };
  const onError = (error: Error) => {
    renderError = error;
  };
  const resolveInputProps = (supplied: unknown): Readonly<Props> => {
    if (
      supplied !== undefined &&
      (typeof supplied !== "object" ||
        supplied === null ||
        Array.isArray(supplied))
    )
      throw new Error(
        "VELOCAST_REACT_INVALID_PROPS: inputProps must be an object or omitted",
      );
    const merged = {
      ...options.defaultProps,
      ...supplied,
    } as Readonly<Partial<Props>>;
    const resolved = options.parseProps ? options.parseProps(merged) : merged;
    if (
      typeof resolved !== "object" ||
      resolved === null ||
      Array.isArray(resolved)
    )
      throw new Error(
        "VELOCAST_REACT_INVALID_PROPS: parseProps must return an object",
      );
    return Object.freeze(resolved) as Readonly<Props>;
  };

  const releaseMount = () => {
    try {
      if (reactRoot) flushSync(() => reactRoot!.unmount());
    } finally {
      reactRoot = undefined;
      store?.clear();
      store = undefined;
      if (container) {
        if (!options.target) container.remove();
        else if (previousStyle === null) container.removeAttribute("style");
        else container.setAttribute("style", previousStyle);
      }
      container = undefined;
      for (const font of fonts) document.fonts.delete(font);
      fonts = [];
      renderError = undefined;
    }
  };

  return {
    id: "react",
    getDurationFrames: () => config.durationFrames,
    async getAudioPlan(context) {
      if (!reactRoot || poisoned)
        throw new Error(
          "VELOCAST_REACT_NOT_READY: destroy before retrying a failed composition",
        );
      const generation = epoch;
      const signal = context.signal ?? new AbortController().signal;
      signal.throwIfAborted();
      const inputProps = resolveInputProps(context.inputProps);
      const plan =
        typeof options.audio === "function"
          ? await options.audio({ inputProps, signal, config })
          : (options.audio ?? null);
      signal.throwIfAborted();
      if (generation !== epoch)
        throw new Error(
          "VELOCAST_REACT_STALE_FRAME: audio belongs to a destroyed mount",
        );
      return plan;
    },
    async init(context) {
      try {
        throwIfAborted(context.signal);
        const generation = ++epoch;
        poisoned = false;
        renderError = undefined;
        if (options.fonts?.length) {
          fonts = options.fonts.map(
            (font) => new FontFace(font.family, font.source, font.descriptors),
          );
          try {
            await abortable(
              Promise.all(fonts.map((font) => font.load())),
              context.signal,
            );
          } catch (cause) {
            throwIfAborted(context.signal);
            throw new Error(
              "VELOCAST_REACT_FONT_LOAD_FAILED: declared font did not load",
              { cause },
            );
          }
          throwIfAborted(context.signal);
          if (generation !== epoch)
            throw new Error("VELOCAST_REACT_STALE_MOUNT: mount was replaced");
          for (const font of fonts) document.fonts.add(font);
        }
        if (!options.target && document.getElementById(rootId))
          throw new Error(
            "VELOCAST_REACT_TARGET_COLLISION: generated capture root already exists",
          );
        container = options.target
          ? (document.querySelector<HTMLElement>(options.target) ?? undefined)
          : document.createElement("div");
        if (!container)
          throw new Error(`VELOCAST_REACT_TARGET_MISSING: ${target}`);
        if (container.childNodes.length) {
          container = undefined;
          throw new Error(
            "VELOCAST_REACT_TARGET_NOT_EMPTY: use an empty composition mount element",
          );
        }
        previousStyle = container.getAttribute("style");
        container.style.width = `${config.width}px`;
        container.style.height = `${config.height}px`;
        if (!options.target) {
          container.id = rootId;
          document.body.appendChild(container);
        }
        reactRoot = createRoot(container);
        store = new FrameStore({
          revision: 0,
          frame: 0,
          inputProps: {},
          config,
        });
        committedRevision = -1;
      } catch (error) {
        releaseMount();
        throw error;
      }
    },
    async seekFrame(frame, context) {
      if (!reactRoot || !store || poisoned)
        throw new Error(
          "VELOCAST_REACT_NOT_READY: destroy before retrying a failed composition",
        );
      const generation = epoch;
      const signal = context.signal ?? new AbortController().signal;
      signal.throwIfAborted();
      const inputProps = resolveInputProps(context.inputProps);
      await options.preload?.({ frame, inputProps, signal });
      signal.throwIfAborted();
      if (generation !== epoch)
        throw new Error(
          "VELOCAST_REACT_STALE_FRAME: frame belongs to a destroyed mount",
        );
      const nextRevision = ++revision;
      const resources = new FrameResourceScope(signal);
      try {
        flushSync(() => {
          store!.update({
            revision: nextRevision,
            frame,
            inputProps,
            config,
          });
          reactRoot!.render(
            <FrameBoundary onError={onError}>
              <Suspense fallback={null}>
                <FrameResourceContext.Provider value={resources}>
                  <FrameView
                    store={store!}
                    component={options.component}
                    onCommit={onCommit}
                  />
                </FrameResourceContext.Provider>
              </Suspense>
            </FrameBoundary>,
          );
        });
        if (renderError) throw renderError;
        if (committedRevision !== nextRevision)
          throw new Error(
            "VELOCAST_REACT_FRAME_NOT_COMMITTED: preload asynchronous resources before rendering",
          );
        await resources.wait();
        if (renderError) throw renderError;
        signal.throwIfAborted();
      } catch (cause) {
        resources.cancel(cause);
        try {
          await resources.wait();
        } catch {
          /* Keep the original frame failure after all jobs join. */
        }
        poisoned = true;
        throwIfAborted(signal);
        throw new Error(
          `VELOCAST_REACT_COMMIT_FAILED: React frame did not commit: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
      }
    },
    destroy() {
      ++epoch;
      releaseMount();
    },
  };
}
