import { version as reactVersion } from "react";
import { VERSION } from "remotion-pinned";
import {
  defineReactComposition,
  registerReactComposition,
  VideoFrameProvider,
  requestSnapshotVideoFrame,
  type VideoFrameLoader,
  type ReactAudioContext,
  type ReactCompositionOptions,
} from "@velocast/react";
import type { ComponentType } from "react";
import { RemotionCompatibilityContext } from "./context.js";
import { waitForDelayHandles } from "./delay-handles.js";
import { assertRegisteredRoot } from "./root-declaration.js";
import {
  AudioDeclarationRuntime,
  AudioValidationBoundary,
  resolveAudioDeclaration,
  type RemotionAudioSource,
  type ResolvedAudioDeclaration,
} from "./audio.js";
export type {
  RemotionAudioDeclaration,
  RemotionAudioDescriptor,
  RemotionAudioSource,
  RemotionAudioTrack,
} from "./audio.js";

export * from "./remotion.js";
export { startVelocast } from "@velocast/react";
export interface RemotionCompositionOptions<Props extends object> extends Omit<
  ReactCompositionOptions<Props>,
  "durationFrames" | "audio"
> {
  readonly durationInFrames: number;
  /** Optional identity check binding this explicit manifest to unchanged registerRoot(). */
  readonly root?: ComponentType;
  readonly audio?: RemotionAudioSource<Props>;
  /** Defaults to the immutable snapshot decoder used by preview and native renders. */
  readonly getVideoFrame?: VideoFrameLoader;
}

/** Explicit host entry. Existing component files keep their bare remotion imports. */
export function registerRemotionComposition<Props extends object>(
  id: string,
  options: RemotionCompositionOptions<Props>,
) {
  return registerReactComposition(id, createReactOptions(id, options));
}

export interface DefinedRemotionCompositionOptions<
  Props extends object,
> extends Omit<RemotionCompositionOptions<Props>, "defaultProps"> {
  readonly id: string;
  /** A complete set of props for renders without an input-props file. */
  readonly defaultProps: Props;
}

/** An inert composition definition for startVelocast's project catalog. */
export function defineRemotionComposition<Props extends object>(
  options: DefinedRemotionCompositionOptions<Props>,
) {
  const { id, ...registrationOptions } = options;
  const reactOptions = createReactOptions(id, registrationOptions);
  return defineReactComposition({
    id,
    video: {
      width: reactOptions.width,
      height: reactOptions.height,
      fps: reactOptions.fps,
      durationFrames: reactOptions.durationFrames,
    },
    component: reactOptions.component,
    defaultProps: options.defaultProps,
    parseProps: reactOptions.parseProps,
    target: reactOptions.target,
    fonts: reactOptions.fonts,
    preload: reactOptions.preload,
    audio: reactOptions.audio,
  });
}

function createReactOptions<Props extends object>(
  id: string,
  options: RemotionCompositionOptions<Props>,
): ReactCompositionOptions<Props> {
  if (VERSION !== "4.0.244" || reactVersion !== "18.3.1")
    throw new Error(
      "VELOCAST_REMOTION_VERSION_MISMATCH: bridge requires Remotion 4.0.244 and one React 18.3.1 singleton",
    );
  const {
    component: Composition,
    durationInFrames,
    root,
    preload,
    audio,
    getVideoFrame = requestSnapshotVideoFrame,
    ...nativeOptions
  } = options;
  if (root) assertRegisteredRoot(root);
  const defaultProps = Object.freeze({ ...options.defaultProps });
  const config = Object.freeze({
    width: options.width,
    height: options.height,
    fps: options.fps,
    durationFrames: durationInFrames,
  });
  const audioRuntime = new AudioDeclarationRuntime();
  const context = Object.freeze({
    id,
    defaultProps,
    config,
    audio: audioRuntime,
  });
  let cachedProps: Readonly<Props> | undefined;
  let cachedAudio: ResolvedAudioDeclaration | undefined;
  const sameProps = (left: Readonly<Props>, right: Readonly<Props>) => {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key) =>
          Object.prototype.hasOwnProperty.call(right, key) &&
          Object.is(
            (left as Record<string, unknown>)[key],
            (right as Record<string, unknown>)[key],
          ),
      )
    );
  };
  const resolveAudio = async (audioContext: ReactAudioContext<Props>) => {
    if (
      cachedProps &&
      cachedAudio &&
      sameProps(cachedProps, audioContext.inputProps)
    )
      return cachedAudio;
    const declaration =
      typeof audio === "function" ? await audio(audioContext) : (audio ?? null);
    audioContext.signal.throwIfAborted();
    const resolved = resolveAudioDeclaration(declaration, config);
    cachedProps = audioContext.inputProps;
    cachedAudio = resolved;
    return resolved;
  };
  function CompatibilityComposition(props: Props) {
    return (
      <RemotionCompatibilityContext.Provider value={context}>
        <VideoFrameProvider getFrame={getVideoFrame}>
          <AudioValidationBoundary>
            <Composition {...props} />
          </AudioValidationBoundary>
        </VideoFrameProvider>
      </RemotionCompatibilityContext.Provider>
    );
  }
  return {
    ...nativeOptions,
    preload: async (preloadContext) => {
      await waitForDelayHandles(preloadContext.signal);
      const declaration = await resolveAudio({
        inputProps: preloadContext.inputProps,
        signal: preloadContext.signal,
        config,
      });
      audioRuntime.prepare(preloadContext.frame, declaration);
      await preload?.(preloadContext);
    },
    audio: async (audioContext) => (await resolveAudio(audioContext)).plan,
    defaultProps,
    durationFrames: durationInFrames,
    component: CompatibilityComposition,
  };
}
