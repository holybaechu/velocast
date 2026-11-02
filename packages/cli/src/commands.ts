export { defineConfig } from "@velocast/core";
export { verifyMediaCommand } from "./media/verify-command.js";
export type {
  VerifyMediaOptions,
  VerifyMediaDependencies,
} from "./media/verify-command.js";
export {
  resolveCliInputPropsPath,
  resolveCliOutputPath,
  resolveCliReportPath,
} from "./project/paths.js";
export type { InvocationPathOptions } from "./project/paths.js";
export type { DoctorProbeInput, DoctorReport } from "./runtime/doctor.js";
export {
  nativeRendererPlatforms,
  rendererExecutableNameForPlatform,
  resolveNativeRendererPlatform,
} from "./runtime/native-platform.js";
export type {
  NativeRendererPlatform,
  RequiredGpuBackendDescriptor,
  RequiredGpuBackendName,
} from "./runtime/native-platform.js";
export { RendererRuntimeResolver } from "./runtime/renderer-binary.js";
export { RendererRuntimeAcquisition } from "./runtime/renderer-runtime.js";
export type {
  AcquiredRendererRuntime,
  RendererRuntimeAcquisitionOptions,
} from "./runtime/renderer-runtime.js";
export {
  ArtifactResolver,
  detectReleaseTarget,
  verifyExecutableArchitecture,
  verifyRuntimeDirectory,
} from "./runtime/artifact-resolver.js";
export {
  availableReleaseTargets,
  loadReleaseManifest,
  releaseManifestPath,
  validateReleaseManifest,
} from "./runtime/release-manifest.js";
export type {
  ReleaseArtifact,
  ReleaseTarget,
  ReleaseTargetId,
  VelocastReleaseManifest,
} from "./runtime/release-manifest.js";
export type {
  RendererRuntime,
  RendererRuntimeResolveBinaryOptions,
  ResolveRendererBinaryOptions,
} from "./runtime/renderer-binary.js";
export type { RenderCommandOptions } from "./render/render-command-job.js";

export {
  parseCliAcceleration,
  parseCliAssemblyMode,
  parseCliBitrate,
  parseCliConcurrency,
  parseCliCodec,
  resolveRendererAudioCodec,
  resolveRendererAcceleration,
  resolveRendererAssemblyMode,
  resolveRendererBitrate,
  resolveRendererCodec,
  resolveRendererContainer,
  resolveRendererConcurrency,
  resolveRendererMediaBackend,
  resolveRendererPixelFormat,
  resolveRendererVideoProfile,
} from "./render/renderer-options.js";

export {
  extractKnownRendererError,
  extractRendererSuccessWarning,
} from "./render/renderer-output.js";

export { waitForRendererProcess } from "./render/renderer-process.js";
export { withServeCommand } from "./project/serve-command.js";
export type {
  ServeCommandDependencies,
  ServeProcess,
  ServeProcessExit,
} from "./project/serve-command.js";
export { cleanupRenderOutputOnFailure } from "./render/render-output-cleanup.js";
export {
  checkFramesCommand,
  checkComposition,
  validateFrameAssertions,
} from "./authoring/frame-check.js";
export type {
  FrameCheckIssue,
  FrameCheckOptions,
  FrameCheckReport,
  FrameAssertions,
  FrameSelectorAssertion,
} from "./authoring/frame-check.js";
export {
  TEMPLATE_CATALOG,
  templatesCommand,
} from "./authoring/template-catalog.js";

export {
  doctorCommand,
  setupCommand,
  versionsCommand,
} from "./runtime/commands.js";
export type {
  DoctorOptions,
  DoctorDependencies,
  SetupOptions,
  SetupDependencies,
} from "./runtime/commands.js";
export {
  executeRendererJob,
  inspectCompositions,
  renderFrame,
  renderComposition,
  renderUrl,
} from "./render/commands.js";
export type {
  RendererRunDependencies,
  RenderRequest,
  InspectionCommandOptions,
  FrameCommandOptions,
} from "./render/commands.js";
