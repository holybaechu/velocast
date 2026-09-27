import type { AudioPlan } from "./audio-plan.js";
import type { BrowserProtocolOptions } from "./runtime.js";
import { defaultVelocastRuntime } from "./runtime.js";
import type {
  BrowserProtocol,
  CompositionDefinition,
  FrameAdapterContext,
} from "./types.js";
import { validateComposition } from "./validation.js";

export interface FrameSourceContext<
  Props = unknown,
> extends FrameAdapterContext {
  signal: AbortSignal;
  inputProps: Props;
}

export interface FrameSession<Props = unknown> {
  seekFrame(
    frame: number,
    context: FrameSourceContext<Props>,
  ): Promise<void> | void;
  getAudioPlan?(
    context: FrameSourceContext<Props>,
  ): Promise<AudioPlan | null> | AudioPlan | null;
  dispose?(): Promise<void> | void;
}

export interface FrameSource<Props = unknown> {
  open(
    context: FrameSourceContext<Props>,
  ): Promise<FrameSession<Props>> | FrameSession<Props>;
}

interface FrameCompositionBase<Props> {
  id: string;
  source: FrameSource<Props>;
  defaultProps?: Props;
  parseProps?(inputProps: unknown): Props;
  rootElement?: HTMLElement | string;
}

type VideoResolver<Props> = (
  inputProps: Props,
  context: { signal: AbortSignal },
) => Promise<CompositionDefinition> | CompositionDefinition;

export type FrameCompositionOptions<Props = unknown> =
  FrameCompositionBase<Props> &
    (
      | { video: CompositionDefinition; resolveVideo?: VideoResolver<Props> }
      /** Resolve metadata once for the frozen input snapshot, before opening a source. */
      | { video?: CompositionDefinition; resolveVideo: VideoResolver<Props> }
    );

/** A pure definition; source work begins only when the runtime requests a frame or audio. */
export type FrameComposition = Readonly<FrameCompositionOptions<unknown>>;

export interface VelocastProject {
  readonly compositions: readonly FrameComposition[];
}

export function defineFrameComposition<Props = unknown>(
  options: FrameCompositionOptions<Props> & { video: CompositionDefinition },
): FrameComposition & { readonly video: CompositionDefinition };
export function defineFrameComposition<Props = unknown>(
  options: FrameCompositionOptions<Props>,
): FrameComposition;
export function defineFrameComposition<Props = unknown>(
  options: FrameCompositionOptions<Props>,
): FrameComposition {
  validateDefinition(options);
  if (!options.source || typeof options.source.open !== "function") {
    throw new Error("VELOCAST_INVALID_SOURCE: source.open must be a function");
  }
  const source = options.source;
  const open = source.open;
  const resolveVideo = options.resolveVideo;
  return Object.freeze({
    ...options,
    video:
      options.video === undefined
        ? undefined
        : Object.freeze({ ...options.video }),
    defaultProps: snapshotProps(options.defaultProps),
    source: Object.freeze({
      open: (context: FrameSourceContext<unknown>) =>
        open.call(source, context as FrameSourceContext<Props>) as
          FrameSession<unknown> | Promise<FrameSession<unknown>>,
    }),
    resolveVideo:
      resolveVideo &&
      ((props: unknown, context: { signal: AbortSignal }) =>
        resolveVideo(props as Props, context)),
  }) as FrameComposition;
}

function validateDefinition<Props>(
  options: FrameCompositionOptions<Props>,
): void {
  if (typeof options.id !== "string" || !options.id.trim())
    throw new Error(
      "VELOCAST_INVALID_COMPOSITION: composition id must be a non-empty string",
    );
  if (
    options.resolveVideo !== undefined &&
    typeof options.resolveVideo !== "function"
  )
    throw new Error(
      "VELOCAST_INVALID_COMPOSITION: resolveVideo must be a function",
    );
  if (options.video !== undefined)
    validateComposition(options.id, options.video);
  else if (!options.resolveVideo)
    throw new Error(
      "VELOCAST_INVALID_COMPOSITION: define video or resolveVideo",
    );
}

export function defineProject(
  compositions: readonly FrameComposition[],
): VelocastProject {
  const ids = new Set<string>();
  for (const composition of compositions) {
    validateDefinition(composition);
    if (!composition.source || typeof composition.source.open !== "function") {
      throw new Error(
        "VELOCAST_INVALID_SOURCE: source.open must be a function",
      );
    }
    if (ids.has(composition.id))
      throw new Error(
        `VELOCAST_DUPLICATE_COMPOSITION: composition ${composition.id} is already registered`,
      );
    ids.add(composition.id);
  }
  return Object.freeze({
    compositions: Object.freeze(
      compositions.map((composition) => defineFrameComposition(composition)),
    ),
  });
}

export function startVelocast(
  project: VelocastProject | readonly FrameComposition[],
  options: BrowserProtocolOptions = {},
): BrowserProtocol {
  return defaultVelocastRuntime.startProject(project, options);
}

/** Props cross the browser protocol as JSON. Reject values that cannot be snapshotted faithfully. */
export function snapshotProps<T>(value: T): T {
  if (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  )
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(snapshotProps)) as T;
  if (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, snapshotProps(item)]),
      ),
    ) as T;
  }
  throw new Error(
    "VELOCAST_INVALID_INPUT_PROPS: props must contain only JSON values",
  );
}

export function resolveProps(
  composition: FrameComposition,
  inputProps: unknown,
): unknown {
  const defaults = composition.defaultProps;
  const combined =
    inputProps === undefined
      ? defaults
      : isRecord(defaults) && isRecord(inputProps)
        ? { ...defaults, ...inputProps }
        : inputProps;
  return snapshotProps(
    composition.parseProps
      ? composition.parseProps(snapshotProps(combined))
      : combined,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
