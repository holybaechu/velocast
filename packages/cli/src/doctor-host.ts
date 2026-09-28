import { existsSync, statSync } from "node:fs";
import type {
  DoctorProbeInput,
  DoctorRequiredGpuBackendProbe,
} from "./doctor.js";
import { resolveNativeRendererPlatform } from "./native-platform.js";
import {
  RendererRuntimeResolver,
  type ResolveRendererBinaryOptions,
} from "./renderer-binary.js";
import type { ArtifactResolver } from "./artifact-resolver.js";
import {
  probeRendererCapabilities,
  type RendererCapabilitySpawn,
  type RendererCapabilitySupport,
} from "./renderer-capabilities.js";
import { RendererRuntimeAcquisition } from "./renderer-runtime.js";
import { OUTPUT_API_VERSION } from "./generated/renderer-contracts.js";

export function probeAvailableRuntimeForDoctor(
  options: {
    probeHost?: typeof probeHostForDoctor;
    artifactResolver?: Pick<ArtifactResolver, "inspect">;
    runtimeAcquisition?: Pick<RendererRuntimeAcquisition, "inspect">;
  } = {},
): DoctorProbeInput {
  const probeHost = options.probeHost ?? probeHostForDoctor;
  // The host probe uses the same candidate selection as acquisition. Keep its
  // readiness errors (including missing Electron) even when a local runtime cannot launch.
  const localProbe =
    options.runtimeAcquisition === undefined ? probeHost() : undefined;
  if (localProbe?.rendererBinary !== undefined) return localProbe;
  const acquisition =
    options.runtimeAcquisition ??
    new RendererRuntimeAcquisition({
      artifactResolver: options.artifactResolver,
      // Discovery already established that no local runtime is available.
      resolveRendererBinary: () => undefined,
    });
  const runtime = acquisition.inspect();
  if (runtime === undefined) return localProbe ?? probeHost();
  const env = {
    ...runtime.env,
    VELOCAST_RENDERER_BINARY: runtime.binary,
  };
  return probeHost({ env, resolveRendererProcessEnv: () => env });
}

export type ProbeHostForDoctorOptions = Pick<
  ResolveRendererBinaryOptions,
  "arch" | "cwd" | "env" | "fallbackTargetDirs" | "platform"
> & {
  rendererCapabilities?: RendererCapabilitySupport;
  runtimeResolver?: RendererRuntimeResolver;
  resolveRendererProcessEnv?: (
    options: ResolveRendererBinaryOptions,
  ) => NodeJS.ProcessEnv;
  spawnRendererCapabilities?: RendererCapabilitySpawn;
};
export type {
  RendererCapabilitySupport,
  RendererCapabilitySpawn,
  RendererCapabilitySpawnOptions,
  RendererCapabilitySpawnResult,
} from "./renderer-capabilities.js";

export function probeHostForDoctor(
  options: ProbeHostForDoctorOptions = {},
): DoctorProbeInput {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const nativePlatform = resolveNativeRendererPlatform(platform, arch);
  const resolver =
    options.runtimeResolver ??
    new RendererRuntimeResolver({ ...options, env, platform, arch });
  let rendererBinary: string | undefined;
  let capabilities = options.rendererCapabilities;
  let reason: string | undefined;
  try {
    rendererBinary = resolver.resolveBinary();
    const probeEnv = options.resolveRendererProcessEnv
      ? options.resolveRendererProcessEnv({ ...options, rendererBinary })
      : resolver.inspectProcessEnv(rendererBinary);
    for (const key of [
      "VELOCAST_ELECTRON_BINARY",
      "VELOCAST_ELECTRON_HOST_SCRIPT",
    ]) {
      const file = probeEnv[key];
      if (!file || !existsSync(file) || !statSync(file).isFile())
        throw new Error(
          `runtime.electron_missing: ${key} must name an installed runtime file`,
        );
    }
    capabilities ??= probeRendererCapabilities(
      rendererBinary,
      probeEnv,
      options.spawnRendererCapabilities,
    );
    if (
      !capabilities.available ||
      capabilities.outputApiVersion !== OUTPUT_API_VERSION
    )
      throw new Error(
        capabilities.reason ??
          "renderer.electron_unsupported: rebuild or install the current Electron renderer",
      );
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  const browserAvailable = rendererBinary !== undefined && reason === undefined;
  const gpuBackends: DoctorRequiredGpuBackendProbe[] = (
    nativePlatform?.requiredGpuBackends ?? []
  ).map((backend) => ({
    backend: backend.backend,
    available: false,
    packetWriterAvailable: false,
    unavailableCode: "backend.unavailable",
    reason:
      "WebCodecs does not provide a verifiable hardware-only guarantee; use acceleration auto or off and a logical codec",
  }));
  return {
    platform,
    arch,
    rendererBinary,
    browserRuntime: {
      host: "electron",
      available: browserAvailable,
      gpuCaptureSupported: platform === "win32",
      ...(reason ? { reason } : {}),
    },
    requiredGpuPrerequisites: nativePlatform
      ? []
      : [
          {
            available: false,
            reason: "native renderer platform is not registered",
            code: "platform.target_unavailable",
          },
        ],
    requiredGpuBackends: gpuBackends,
    displayVariablesUnset: (nativePlatform?.displaylessEnvVars ?? []).every(
      (name) => !env[name]?.trim(),
    ),
    webCodecsAvailable:
      browserAvailable && capabilities?.videoEncoderBackend === "webcodecs",
    requiredGpuPacketWriterAvailable: gpuBackends.some(
      (backend) => backend.packetWriterAvailable,
    ),
  };
}
