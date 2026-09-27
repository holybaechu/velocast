import {
  forwardRef,
  useCallback,
  useContext,
  useImperativeHandle,
  useRef,
  type CSSProperties,
} from "react";
import {
  Sequence as NativeSequence,
  useCurrentFrame as useNativeFrame,
  useVideoConfig as useNativeConfig,
  useInputProps,
  useFrameResource,
} from "@velocast/react";
import type { ImgProps, SequenceProps, VideoConfig } from "remotion-pinned";
import { AbsoluteFill as PinnedAbsoluteFill } from "remotion-pinned";
import { RemotionSequenceContext, useCompatibilityContext } from "./context.js";
export { Audio, Audio as Html5Audio } from "./audio.js";
export { delayRender, continueRender, cancelRender } from "./delay-handles.js";
export { Composition, registerRoot } from "./root-declaration.js";

// Exact upstream utility/DOM implementations; no approximation or source rewrite.
// The dependency alias prevents a consumer's bare-remotion alias recursing here.
export {
  AbsoluteFill,
  interpolate,
  interpolateColors,
  Easing,
  staticFile,
  getInputProps,
  VERSION,
  spring,
  measureSpring,
  random,
} from "remotion-pinned";
export type { ImgProps, VideoConfig } from "remotion-pinned";

export function useCurrentFrame(): number {
  useCompatibilityContext();
  return useNativeFrame();
}

export function useVideoConfig(): VideoConfig {
  const context = useCompatibilityContext();
  const { durationFrames, ...config } = useNativeConfig();
  const props = useInputProps();
  return {
    ...config,
    durationInFrames: durationFrames,
    id: context.id,
    defaultProps: context.defaultProps,
    props: { ...props },
    defaultCodec: null,
  };
}

function unsupported(feature: string): never {
  throw new Error(
    `VELOCAST_REMOTION_UNSUPPORTED: ${feature} is not supported by this Remotion 4.0.244 bridge slice`,
  );
}

function decodeImage(
  image: HTMLImageElement,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (typeof image.decode !== "function")
    throw new Error(
      "VELOCAST_REMOTION_IMAGE_DECODE_UNAVAILABLE: HTMLImageElement.decode is required",
    );
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    // Observe both outcomes even after abort; a browser decoder has no cancel API.
    Promise.resolve()
      .then(() => image.decode())
      .then(
        () => {
          cleanup();
          if (signal.aborted) reject(signal.reason);
          else resolve();
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
  });
}

export const Img = forwardRef<HTMLImageElement, Omit<ImgProps, "ref">>(
  function Img(props, ref) {
    useCompatibilityContext();
    const image = useRef<HTMLImageElement>(null);
    const {
      src,
      maxRetries,
      pauseWhenLoading,
      delayRenderRetries,
      delayRenderTimeoutInMilliseconds,
      onImageFrame,
      ...attributes
    } = props;
    useImperativeHandle(ref, () => image.current!, []);
    const prepare = useCallback(
      async (signal: AbortSignal) => {
        const node = image.current;
        if (!node)
          throw new Error(
            "VELOCAST_REMOTION_IMAGE_MISSING: image did not mount",
          );
        await decodeImage(node, signal);
        if (image.current !== node || node.getAttribute("src") !== src)
          throw new Error(
            "VELOCAST_REMOTION_IMAGE_STALE: image source changed after frame commit",
          );
      },
      [src],
    );
    useFrameResource(prepare);
    if (typeof src !== "string" || !src)
      throw new Error('No "src" prop was passed to <Img>.');
    const advanced = {
      maxRetries,
      pauseWhenLoading,
      delayRenderRetries,
      delayRenderTimeoutInMilliseconds,
      onImageFrame,
    };
    for (const [name, value] of Object.entries(advanced))
      if (value !== undefined) unsupported(`Img.${name}`);
    return <img {...attributes} ref={image} src={src} />;
  },
);

export const Sequence = forwardRef<HTMLDivElement, SequenceProps>(
  function Sequence(props, ref) {
    useCompatibilityContext();
    const ancestors = useContext(RemotionSequenceContext);
    const sequenceProps = props as SequenceProps & {
      readonly style?: CSSProperties;
      readonly className?: string;
      readonly premountFor?: number;
    };
    const {
      from = 0,
      durationInFrames,
      children,
      layout = "absolute-fill",
      style,
      className,
      width,
      height,
      premountFor,
      name,
      showInTimeline,
      _remotionInternalLoopDisplay,
      _remotionInternalPremountDisplay,
      _remotionInternalStack,
      _remotionInternalIsPremounting,
    } = sequenceProps;
    const unsupportedProps = {
      width,
      height,
      premountFor,
      name,
      showInTimeline,
      _remotionInternalLoopDisplay,
      _remotionInternalPremountDisplay,
      _remotionInternalStack,
      _remotionInternalIsPremounting,
    };
    for (const [key, value] of Object.entries(unsupportedProps))
      if (value !== undefined) unsupported(`Sequence.${key}`);
    if (!Number.isSafeInteger(from))
      throw new RangeError(
        "VELOCAST_REMOTION_SEQUENCE_INVALID: from must be a safe integer",
      );
    const config = useNativeConfig();
    const duration =
      durationInFrames ?? Math.max(0, config.durationFrames - from);
    if (!Number.isSafeInteger(duration) || duration < 0)
      throw new RangeError(
        "VELOCAST_REMOTION_SEQUENCE_INVALID: durationInFrames must be a nonnegative safe integer",
      );
    const scope = Object.freeze([
      ...ancestors,
      { from, durationFrames: duration },
    ]);
    const content =
      layout === "none" ? (
        children
      ) : layout === "absolute-fill" ? (
        <PinnedAbsoluteFill ref={ref} style={style} className={className}>
          {children}
        </PinnedAbsoluteFill>
      ) : (
        unsupported(`Sequence.layout=${String(layout)}`)
      );
    if (
      layout === "none" &&
      (ref !== null || style !== undefined || className !== undefined)
    )
      unsupported("Sequence layout=none ref/style/className");
    return (
      <NativeSequence from={from} durationFrames={duration}>
        <RemotionSequenceContext.Provider value={scope}>
          {content}
        </RemotionSequenceContext.Provider>
      </NativeSequence>
    );
  },
);

export { Video, OffthreadVideo, Html5Video } from "./video.js";
export type { RemotionVideoProps } from "./video.js";

export { Series, Loop } from "./timeline.js";
export type { SeriesSequenceProps, LoopProps } from "./timeline.js";
