export type {
  SourceAdapter,
  SourceAdapterContext,
  PreparedSource,
} from "./source-adapter.js";
export type {
  CompositionDefinition,
  CompositionManifest,
  RenderContext,
  RenderSession,
  BrowserProtocol,
  FrameAdapter,
  FrameAdapterContext,
  FrameAdapterRegistrationOptions,
  VelocastGlobal,
  Config,
  RendererConcurrency,
  RendererAcceleration,
  RendererAssemblyMode,
} from "./types.js";
export type { BrowserProtocolOptions } from "./browser-protocol.js";
export { defineConfig } from "./config.js";
export {
  defineFrameComposition,
  defineProject,
  startVelocast,
} from "./project.js";
export type {
  FrameComposition,
  FrameCompositionOptions,
  FrameSource,
  FrameSourceContext,
  FrameSession,
  VelocastProject,
} from "./project.js";
export {
  installBrowserProtocol,
  registerFrameAdapter,
  getRenderableCompositions,
  velocastGlobal as Velocast,
} from "./browser-protocol.js";
export { defaultVelocastRuntime, VelocastRuntime } from "./runtime.js";
export { validateComposition } from "./validation.js";
export { BROWSER_PROTOCOL_VERSION } from "./generated/browser-contracts.js";
export type {
  FrameRange,
  SequenceTiming,
  SequenceFrame,
  TimeRounding,
} from "./time.js";
export {
  createFrameRange,
  containsFrame,
  resolveSequenceFrame,
  framesToSeconds,
  secondsToFrames,
  samplesToSeconds,
  secondsToSamples,
  framesToSamples,
  samplesToFrames,
} from "./time.js";
export type {
  EasingFunction,
  Extrapolation,
  InterpolationOptions,
} from "./interpolation.js";
export { interpolate } from "./interpolation.js";
export { cubicBezier, Easing } from "./easing.js";
export type { AudioClip, AudioPlan, AudioEnvelopePoint } from "./audio-plan.js";
export {
  evaluateAudioEnvelope,
  sliceAudioEnvelope,
  fadeAudioEnvelope,
  validateAudioPlan,
  normalizeAudioPlan,
  sliceAudioPlan,
  sliceAudioPlanByFrames,
} from "./audio-plan.js";
