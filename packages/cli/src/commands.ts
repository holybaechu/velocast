import { getInvocationCwd } from "./paths.js";
import { withMediaRuntimeContext } from "./media-runtime.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "@velocast/core";
export { defineConfig } from "@velocast/core";
import { buildDoctorReport, type DoctorProbeInput } from "./doctor.js";
import type {
  RendererRuntime,
  RendererRuntimeResolver,
} from "./renderer-binary.js";
import { RendererRuntimeAcquisition } from "./renderer-runtime.js";
import {
  probeAvailableRuntimeForDoctor,
  type probeHostForDoctor,
} from "./doctor-host.js";
import { runRenderer } from "./renderer-process.js";
import { withServeCommand } from "./serve-command.js";
import { resolveCliOutputPath, type InvocationPathOptions } from "./paths.js";
import { resolveCompositionRenderSource } from "./render-source.js";
import { createInputSnapshot, type InputSnapshot } from "./input-snapshot.js";
import { executeSourceJob } from "./source-adapter.js";
import type { renderSourceOutput } from "./source-output.js";
import {
  createVideoFrameHttp,
  type VideoFrameHttp,
} from "./video-frame-http.js";
import { probeRendererCapabilities } from "./renderer-capabilities.js";
import {
  parseOutputFrame,
  parseOutputRange,
  requireOutputApi,
} from "./output-request.js";
import {
  failedOutputResult,
  outputError,
  OutputFailureError,
  printOutputResult,
  readOutputResult,
  type OutputResult,
} from "./output-result.js";
import { ArtifactResolver } from "./artifact-resolver.js";
import { installedVelocastVersions } from "./package-versions.js";
import {
  buildCaptureProbeCommandJobFromSource,
  buildCompositionRenderCommandJobFromSource,
  buildUrlRenderCommandJob,
  type ProbeCaptureCommandOptions,
  type RenderCommandOptions,
  type RustRenderJob,
} from "./render-command-job.js";

export {
  resolveCliInputPropsPath,
  resolveCliOutputPath,
  resolveCliReportPath,
} from "./paths.js";
export type { InvocationPathOptions } from "./paths.js";
export type { DoctorProbeInput, DoctorReport } from "./doctor.js";
export {
  nativeRendererPlatforms,
  rendererExecutableNameForPlatform,
  resolveNativeRendererPlatform,
} from "./native-platform.js";
export type {
  NativeRendererPlatform,
  RequiredGpuBackendDescriptor,
  RequiredGpuBackendName,
} from "./native-platform.js";
export { RendererRuntimeResolver } from "./renderer-binary.js";
export { RendererRuntimeAcquisition } from "./renderer-runtime.js";
export type {
  AcquiredRendererRuntime,
  RendererRuntimeAcquisitionOptions,
} from "./renderer-runtime.js";
export {
  ArtifactResolver,
  detectReleaseTarget,
  verifyExecutableArchitecture,
  verifyRuntimeDirectory,
} from "./artifact-resolver.js";
export {
  availableReleaseTargets,
  loadReleaseManifest,
  releaseManifestPath,
  validateReleaseManifest,
} from "./release-manifest.js";
export type {
  ReleaseArtifact,
  ReleaseTarget,
  ReleaseTargetId,
  VelocastReleaseManifest,
} from "./release-manifest.js";
export type {
  RendererRuntime,
  RendererRuntimeResolveBinaryOptions,
  ResolveRendererBinaryOptions,
} from "./renderer-binary.js";
export type {
  ProbeCaptureCommandOptions,
  RenderCommandOptions,
} from "./render-command-job.js";

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
} from "./renderer-options.js";

export {
  extractKnownRendererError,
  extractRendererSuccessWarning,
} from "./renderer-output.js";

export { waitForRendererProcess } from "./renderer-process.js";
export { withServeCommand } from "./serve-command.js";
export type {
  ServeCommandDependencies,
  ServeProcess,
  ServeProcessExit,
} from "./serve-command.js";
export { cleanupRenderOutputOnFailure } from "./render-output-cleanup.js";
export {
  auditCommand,
  auditComposition,
  validateAuditAssertions,
} from "./agent-audit.js";
export type {
  AgentAuditIssue,
  AgentAuditOptions,
  AgentAuditReport,
  AuditAssertions,
  AuditSelectorAssertion,
} from "./agent-audit.js";
export { analyzeMusic, analyzeMusicCommand } from "./music-analysis.js";
export type { MusicAnalysis } from "./music-analysis.js";
export {
  importTimedText,
  importTranscriptCommand,
  validateTimedTextCues,
} from "./timestamps.js";
export type { TimedTextCue, TimedTextDocument } from "./timestamps.js";
export { installProjectSkill, installSkillCommand } from "./skill-install.js";
export { TEMPLATE_CATALOG, templatesCommand } from "./template-catalog.js";

export interface DoctorOptions {
  json?: boolean;
}

export interface DoctorDependencies {
  write?: (value: string) => void;
  probe?: () => DoctorProbeInput;
  probeHost?: typeof probeHostForDoctor;
  artifactResolver?: Pick<ArtifactResolver, "inspect">;
  runtimeAcquisition?: Pick<RendererRuntimeAcquisition, "inspect">;
}

export async function doctorCommand(
  options: DoctorOptions,
  dependencies: DoctorDependencies = {},
): Promise<void> {
  const write =
    dependencies.write !== undefined
      ? dependencies.write
      : (value: string) => {
          process.stdout.write(value);
        };
  const probe =
    dependencies.probe ?? (() => probeAvailableRuntimeForDoctor(dependencies));
  const report = buildDoctorReport(probe());
  if (options.json) {
    write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  writeDoctorText(report, write);
}

export interface SetupOptions {
  json?: boolean;
}

export interface SetupDependencies {
  write?: (value: string) => void;
  artifactResolver?: ArtifactResolver;
}

export async function setupCommand(
  options: SetupOptions = {},
  dependencies: SetupDependencies = {},
): Promise<void> {
  const write =
    dependencies.write ?? ((value: string) => process.stdout.write(value));
  const resolver = dependencies.artifactResolver ?? new ArtifactResolver();
  const runtime = await resolver.setup();
  const result = {
    target: runtime.targetId,
    source: runtime.source,
    artifactDir: runtime.artifactDir,
    rendererBinary: runtime.rendererBinary,
    sha256: runtime.artifact.sha256,
  };
  if (options.json) {
    write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  write(`Velocast ${result.target} runtime ready (${result.source})\n`);
  write(`Artifact: ${result.artifactDir}\n`);
  write(`SHA-256: ${result.sha256}\n`);
}

export async function versionsCommand(
  options: SetupOptions = {},
  dependencies: SetupDependencies = {},
): Promise<void> {
  const write =
    dependencies.write ?? ((value: string) => process.stdout.write(value));
  const resolver = dependencies.artifactResolver ?? new ArtifactResolver();
  const manifest = resolver.releaseManifest();
  const targetId = resolver.targetId();
  const target = manifest.targets[targetId];
  const runtime = resolver.inspect();
  const result = {
    product: manifest.productVersion,
    package: manifest.packageVersion,
    nativeRenderer: manifest.nativeRendererVersion,
    protocol: manifest.protocolVersion,
    electron: manifest.electronVersion,
    chromium: manifest.chromiumVersion,
    channel: manifest.releaseChannel,
    target: targetId,
    artifact: target.artifact?.sha256 ?? null,
    artifactStatus:
      target.artifact === null ? "blocked" : runtime ? "verified" : "not-setup",
    validationStatus: target.validatedCandidate
      ? "validated"
      : target.requirements.validationStatus,
    distributionStatus:
      target.artifact !== null
        ? "installable"
        : target.validatedCandidate
          ? "validated-unpublished"
          : "blocked",
    validatedCandidate: target.validatedCandidate
      ? {
          sha256: target.validatedCandidate.sha256,
          sourceCommit: target.validatedCandidate.sourceCommit,
          signed: target.validatedCandidate.signed,
        }
      : null,
    blocker: target.blocker,
    installedPackages: installedVelocastVersions(),
  };
  if (options.json) {
    write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  write(`Velocast package: ${result.package}\n`);
  write(`Native renderer: ${result.nativeRenderer}\n`);
  write(`Protocol: ${result.protocol}\n`);
  write(`Electron: ${result.electron}\n`);
  write(`Chromium: ${result.chromium}\n`);
  write(`Target: ${result.target} (${result.artifactStatus})\n`);
  write(`Validation: ${result.validationStatus}\n`);
  write(`Distribution: ${result.distributionStatus}\n`);
  if (result.blocker) {
    write(`Blocker: ${result.blocker}\n`);
  }
}

function writeDoctorText(
  report: ReturnType<typeof buildDoctorReport>,
  write: (value: string) => void,
): void {
  write(`Velocast doctor (${report.platform}/${report.arch})\n`);
  write(
    `Required GPU: ${report.requiredGpu.available ? "available" : "unavailable"}\n`,
  );
  if (report.requiredGpu.backend) {
    write(`Backend: ${report.requiredGpu.backend}\n`);
  }
  if (report.requiredGpu.candidateBackends?.length) {
    write(
      `Backend candidates: ${report.requiredGpu.candidateBackends.join(", ")}\n`,
    );
  }
  if (report.requiredGpu.reason) {
    write(`Reason: ${report.requiredGpu.reason}\n`);
  }
  if (report.requiredGpu.diagnostics?.length) {
    write("Diagnostics:\n");
    for (const diagnostic of report.requiredGpu.diagnostics) {
      const backend = diagnostic.backend ? `${diagnostic.backend} ` : "";
      write(`- ${backend}${diagnostic.code}: ${diagnostic.reason}\n`);
    }
  }
  write(
    `WebCodecs runtime: ${report.webCodecs.available ? "available" : "unavailable"}\n`,
  );
  if (report.webCodecs.reason) {
    write(`WebCodecs runtime reason: ${report.webCodecs.reason}\n`);
  }
}

export interface RendererRunDependencies {
  /** Source output transaction override. */
  renderSourceOutput?: typeof renderSourceOutput;
  executeNativeSourceJob?: typeof executeRendererJob;
  /** Preview output must correspond to the exact authored version being inspected. */
  expectedSourceVersion?: string;
  signal?: AbortSignal;
  createMediaService?: typeof createVideoFrameHttp;
  probeCapabilities?: typeof probeRendererCapabilities;
  onOutputResult?: (result: OutputResult) => void;
  runRenderer?: (
    binary: string,
    job: unknown,
    runtime?: RendererRuntime,
  ) => Promise<void>;
  resolveRendererBinary?: (configuredBinary?: string) => string;
  runtimeResolver?: RendererRuntimeResolver;
  runtimeAcquisition?: Pick<RendererRuntimeAcquisition, "acquire">;
  pathOptions?: InvocationPathOptions;
}

export type RenderRequest =
  | {
      kind: "inspect";
      config: Config;
      compositionId?: string;
      options?: InspectionCommandOptions;
    }
  | {
      kind: "frame";
      config: Config;
      compositionId: string;
      frame?: string | number;
      output: string;
      options?: InspectionCommandOptions;
    }
  | {
      kind: "composition";
      config: Config;
      compositionId: string;
      output: string;
      options?: RenderCommandOptions;
    }
  | {
      kind: "url";
      config: Config;
      url: string;
      selector: string;
      output: string;
      options?: RenderCommandOptions;
    }
  | {
      kind: "capture-probe";
      config: Config;
      compositionId: string;
      options?: ProbeCaptureCommandOptions;
    };

export interface InspectionCommandOptions {
  json?: boolean;
  inputPropsFile?: string;
}
export interface FrameCommandOptions extends InspectionCommandOptions {
  frame?: string | number;
}

interface PreparedRendererJob {
  config: Config;
  job: RustRenderJob;
  sourceKind?: "serve" | "entry";
  snapshotRoot?: string;
}

export async function executeRendererJob(
  request: RenderRequest,
  dependencies: RendererRunDependencies = {},
): Promise<void> {
  const env = dependencies.pathOptions?.env
    ? { ...process.env, ...dependencies.pathOptions.env }
    : { ...process.env };
  return withMediaRuntimeContext(
    {
      configuredBinary: request.config.renderer?.binary,
      cwd: getInvocationCwd(dependencies.pathOptions),
      env,
    },
    () => executeRendererJobInContext(request, dependencies),
  );
}

async function executeRendererJobInContext(
  request: RenderRequest,
  dependencies: RendererRunDependencies,
): Promise<void> {
  if (request.config.source !== undefined)
    return executeSourceJob(request, dependencies, executeRendererJob);
  const options = request.options ?? {};
  const wantsResult =
    dependencies.expectedSourceVersion !== undefined ||
    request.kind === "inspect" ||
    request.kind === "frame" ||
    ("json" in options && options.json === true) ||
    ("startFrame" in options && options.startFrame !== undefined) ||
    ("endFrame" in options && options.endFrame !== undefined);
  const json = "json" in options && options.json === true;
  let prepared: PreparedRendererJob | undefined;
  let snapshot: InputSnapshot | undefined;
  let media: VideoFrameHttp | undefined;
  let resultDirectory: string | undefined;
  let failureJob: Partial<RustRenderJob> = {
    operation:
      request.kind === "inspect"
        ? "inspect"
        : request.kind === "frame"
          ? "frame"
          : "render",
    composition_id:
      "compositionId" in request ? (request.compositionId ?? null) : null,
    ...(wantsResult ? { render_session: { sessionId: randomUUID() } } : {}),
  };
  const report = (result: OutputResult) =>
    dependencies.onOutputResult
      ? dependencies.onOutputResult(result)
      : printOutputResult(result, json);
  try {
    dependencies.signal?.throwIfAborted();
    if (
      dependencies.expectedSourceVersion !== undefined &&
      !/^[a-f0-9]{64}$/.test(dependencies.expectedSourceVersion)
    )
      throw new Error(
        "snapshot.invalid_version: expectedSourceVersion must be a snapshot SHA-256",
      );
    if (wantsResult) {
      if ("output" in request)
        failureJob.output = resolveCliOutputPath(
          request.output,
          dependencies.pathOptions,
        );
      if (request.kind === "frame")
        failureJob.output_frame = parseOutputFrame(request.frame);
      if (
        request.kind === "composition" &&
        request.options?.startFrame !== undefined &&
        request.options?.endFrame !== undefined
      )
        failureJob.output_range = {
          startFrame: parseOutputFrame(request.options.startFrame),
          endFrame: parseOutputFrame(request.options.endFrame),
        };
    }
    prepared = prepareRendererJob(request, dependencies.pathOptions);
    if (wantsResult) {
      prepared.job.render_session = failureJob.render_session;
      resultDirectory = mkdtempSync(join(tmpdir(), "velocast-output-result-"));
      prepared.job.result_path = join(resultDirectory, "result.json");
    }
    failureJob = prepared.job;
    ensureRenderJobDirectories(prepared.job);
    snapshot =
      prepared.snapshotRoot === undefined
        ? undefined
        : await createInputSnapshot({
            root: prepared.snapshotRoot,
            entryPath: fileURLToPath(prepared.job.serve_url),
            inputPropsPath: prepared.job.input_props_path,
            handleMediaRequest: (request, response, identity) => {
              if (!media)
                throw new Error(
                  "video.service_not_ready: media runtime has not been acquired",
                );
              return media.handle(request, response, identity);
            },
          });
    if (snapshot) {
      prepared.job.serve_url = snapshot.url;
      prepared.job.render_session = snapshot.session;
      prepared.job.input_props_path = snapshot.inputPropsPath;
    }
    if (
      dependencies.expectedSourceVersion !== undefined &&
      snapshot?.session.sourceVersion !== dependencies.expectedSourceVersion
    )
      throw new Error(
        "snapshot.version_mismatch: authored source changed; refresh preview before requesting output",
      );
    const acquisition =
      dependencies.runtimeAcquisition ??
      new RendererRuntimeAcquisition({
        cwd: dependencies.pathOptions?.cwd,
        env: dependencies.pathOptions?.env
          ? { ...process.env, ...dependencies.pathOptions.env }
          : process.env,
        runtimeResolver: dependencies.runtimeResolver,
        resolveRendererBinary: dependencies.resolveRendererBinary,
      });
    const runtime = await acquisition.acquire(prepared.config.renderer?.binary);
    dependencies.signal?.throwIfAborted();
    if (snapshot)
      media = (dependencies.createMediaService ?? createVideoFrameHttp)({
        directory: tmpdir(),
        env: runtime.env,
      });
    if (wantsResult)
      requireOutputApi(
        (dependencies.probeCapabilities ?? probeRendererCapabilities)(
          runtime.binary,
          runtime.env,
        ),
      );
    const run =
      dependencies.runRenderer ??
      ((binary: string, job: unknown) =>
        runRenderer(binary, job, {
          resolveProcessEnv: () => runtime.env,
          signal: dependencies.signal,
        }));
    // The renderer owns staging, rollback, and publication. A late process or
    // diagnostic failure must not delete its committed or restored output.
    const job = prepared.job;
    const runJob = () => run(runtime.binary, job, runtime);

    if (prepared.sourceKind === "serve") {
      await withServeCommand(prepared.config.serve, runJob);
    } else await runJob();
    if (wantsResult) {
      const result = readOutputResult(job.result_path!, job);
      if (result.status !== "success")
        throw new Error(`${result.error?.code}: ${result.error?.message}`);
      report(result);
    }
  } catch (error) {
    if (!wantsResult) throw error;
    let result = failedOutputResult(failureJob, error);
    if (prepared?.job.result_path) {
      try {
        result = {
          ...readOutputResult(prepared.job.result_path, prepared.job),
          status: "failure",
          error: outputError(error),
        };
      } catch {
        /* Keep the primary process/validation failure. */
      }
    }
    report(result);
    throw new OutputFailureError(result, error, json);
  } finally {
    // Native joins its workers before this promise settles. Never close the
    // shared frozen server/props when only the first worker has finished.
    try {
      await media?.close();
    } finally {
      await snapshot?.close();
      if (resultDirectory)
        rmSync(resultDirectory, { recursive: true, force: true });
    }
  }
}

function prepareRendererJob(
  request: RenderRequest,
  pathOptions: InvocationPathOptions = {},
): PreparedRendererJob {
  switch (request.kind) {
    case "inspect":
    case "frame": {
      const source = resolveCompositionRenderSource(
        request.config,
        pathOptions,
      );
      const output = resolveCliOutputPath(
        request.kind === "frame"
          ? request.output
          : ".velocast/tmp/inspection-unused.mp4",
        pathOptions,
      );
      if (request.kind === "frame" && extname(output).toLowerCase() !== ".png")
        throw new Error(
          "output.png_required: frame output must use a .png filename",
        );
      const job = buildCompositionRenderCommandJobFromSource(
        {
          ...request.config,
          renderer: {
            ...request.config.renderer,
            acceleration: "off",
            concurrency: 1,
            assembly: "reference",
          },
        },
        request.compositionId ?? "__inspection__",
        source.url,
        output,
        { inputPropsFile: request.options?.inputPropsFile },
        pathOptions,
      );
      job.operation = request.kind;
      if (request.kind === "inspect")
        job.composition_id = request.compositionId ?? null;
      else job.output_frame = parseOutputFrame(request.frame);
      return {
        config: request.config,
        job,
        sourceKind: source.kind,
        snapshotRoot: source.snapshotRoot,
      };
    }
    case "composition": {
      const source = resolveCompositionRenderSource(
        request.config,
        pathOptions,
      );
      const output = resolveCliOutputPath(request.output, pathOptions);
      const job = buildCompositionRenderCommandJobFromSource(
        request.config,
        request.compositionId,
        source.url,
        output,
        request.options ?? {},
        pathOptions,
      );
      const range = parseOutputRange(
        request.options?.startFrame,
        request.options?.endFrame,
      );
      if (range) job.output_range = range;
      return {
        config: request.config,
        job,
        sourceKind: source.kind,
        snapshotRoot: source.snapshotRoot,
      };
    }
    case "capture-probe": {
      const options = request.options ?? {};
      if (options.report === undefined) {
        throw new Error("--report is required for probe-capture");
      }
      const source = resolveCompositionRenderSource(
        request.config,
        pathOptions,
      );
      return {
        config: request.config,
        job: buildCaptureProbeCommandJobFromSource(
          request.config,
          request.compositionId,
          source.url,
          options,
          pathOptions,
        ),
        sourceKind: source.kind,
        snapshotRoot: source.snapshotRoot,
      };
    }
    case "url": {
      if (
        request.options?.startFrame !== undefined ||
        request.options?.endFrame !== undefined
      )
        throw new Error(
          "output.invalid_request: public ranges require a composition, not render-url",
        );
      if (request.config.renderer?.snapshotRoot !== undefined)
        throw new Error(
          "snapshot.requires_local_entry: render-url cannot use renderer.snapshotRoot; use a composition with a built local entry",
        );
      const output = resolveCliOutputPath(request.output, pathOptions);
      return {
        config: request.config,
        job: buildUrlRenderCommandJob(
          request.config,
          request.url,
          request.selector,
          output,
          request.options ?? {},
          pathOptions,
        ),
      };
    }
  }
}

export async function inspectCompositions(
  config: Config,
  compositionId: string | undefined,
  options: InspectionCommandOptions = {},
  dependencies: RendererRunDependencies = {},
): Promise<void> {
  await executeRendererJob(
    { kind: "inspect", config, compositionId, options },
    dependencies,
  );
}

export async function renderFrame(
  config: Config,
  compositionId: string,
  output: string,
  options: FrameCommandOptions = {},
  dependencies: RendererRunDependencies = {},
): Promise<void> {
  await executeRendererJob(
    {
      kind: "frame",
      config,
      compositionId,
      output,
      frame: options.frame,
      options,
    },
    dependencies,
  );
}

export async function renderComposition(
  config: Config,
  compositionId: string,
  output: string,
  options: RenderCommandOptions = {},
  dependencies: RendererRunDependencies = {},
): Promise<void> {
  await executeRendererJob(
    {
      kind: "composition",
      config,
      compositionId,
      output,
      options,
    },
    dependencies,
  );
}

export async function probeCapture(
  config: Config,
  compositionId: string,
  options: ProbeCaptureCommandOptions = {},
  dependencies: RendererRunDependencies = {},
): Promise<void> {
  await executeRendererJob(
    {
      kind: "capture-probe",
      config,
      compositionId,
      options,
    },
    dependencies,
  );
}

export async function renderUrl(
  config: Config,
  url: string,
  selector: string,
  output: string,
  options: RenderCommandOptions = {},
  dependencies: RendererRunDependencies = {},
): Promise<void> {
  await executeRendererJob(
    {
      kind: "url",
      config,
      url,
      selector,
      output,
      options,
    },
    dependencies,
  );
}

function ensureRenderJobDirectories(job: RustRenderJob): void {
  mkdirSync(dirname(job.output), { recursive: true });
  if (job.report_path) {
    mkdirSync(dirname(job.report_path), { recursive: true });
  }
  if (job.event_log_path) {
    mkdirSync(dirname(job.event_log_path), { recursive: true });
  }
}
