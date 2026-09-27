export {
  defineReactComposition,
  registerReactComposition,
} from "./composition.js";
export type {
  ReactCompositionOptions,
  ReactCompositionDefinitionOptions,
  ReactFont,
  ReactPreloadContext,
  ReactAudioContext,
} from "./composition.js";
export { startVelocast } from "@velocast/core";
export {
  useCurrentFrame,
  useVideoConfig,
  useInputProps,
} from "./frame-state.js";
export type { VideoConfig } from "./frame-state.js";
export { preloadImage } from "./resources.js";
export { useFrameResource } from "./frame-resources.js";
export type { FrameResourceLoader } from "./frame-resources.js";
export { VideoClip, VideoFrameProvider } from "./video-clip.js";
export { requestSnapshotVideoFrame } from "./snapshot-video-frame.js";
export type {
  VideoClipProps,
  VideoFrame,
  VideoFrameLoader,
  VideoFrameProviderProps,
} from "./video-clip.js";
export { Sequence } from "./sequence.js";
export type { SequenceProps } from "./sequence.js";
// Motion has one implementation and one numerical contract for every adapter.
export { interpolate, Easing, cubicBezier } from "@velocast/core";
export type {
  EasingFunction,
  InterpolationOptions,
  Extrapolation,
} from "@velocast/core";

export { createMediaTimeline } from "./media-timeline.js";
export type { MediaClip } from "./media-timeline.js";
