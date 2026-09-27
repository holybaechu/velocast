import { spawnSync } from "node:child_process";
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
  ffmpegEncoders?: FfmpegEncoderSupport;
  rendererCapabilities?: RendererCapabilitySupport;
  runtimeResolver?: RendererRuntimeResolver;
  resolveRendererProcessEnv?: (
    options: ResolveRendererBinaryOptions,
  ) => NodeJS.ProcessEnv;
  spawnRendererCapabilities?: RendererCapabilitySpawn;
};
export interface FfmpegEncoderSupport {
  ffmpegPresent: boolean;
  encoders?: Record<string, boolean>;
}
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
  let probeEnv = env;
  let capabilities = options.rendererCapabilities;
  let reason: string | undefined;
  try {
    rendererBinary = resolver.resolveBinary();
    probeEnv = options.resolveRendererProcessEnv
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
  const encoderNames = [
    ...new Set([
      "libx264",
      "png",
      ...(nativePlatform?.requiredGpuBackends
        .map((item) => item.ffmpegEncoder)
        .filter((item): item is string => !!item) ?? []),
    ]),
  ];
  const ffmpeg =
    options.ffmpegEncoders ?? probeFfmpegEncoders(encoderNames, probeEnv);
  const linked = capabilities?.d3d11FfmpegEncoder;
  const gpuBackends: DoctorRequiredGpuBackendProbe[] = (
    nativePlatform?.requiredGpuBackends ?? []
  ).map((backend) => {
    const available =
      browserAvailable &&
      linked?.compiled === true &&
      linked.encoders?.[backend.ffmpegEncoder ?? backend.backend] === true;
    return {
      backend: backend.backend,
      available,
      packetWriterAvailable:
        available && backend.packetWriterImplemented === true,
      ...(available
        ? {}
        : {
            unavailableCode: "backend.unavailable" as const,
            reason:
              linked?.compiled !== true
                ? "renderer binary did not report Windows D3D11 FFmpeg support"
                : `Linked FFmpeg encoder ${backend.ffmpegEncoder ?? backend.backend} unavailable`,
          }),
    };
  });
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
    ffmpegPresent: ffmpeg.ffmpegPresent,
    softwareFallbackAvailable:
      browserAvailable &&
      ffmpeg.ffmpegPresent &&
      ffmpeg.encoders?.libx264 !== false,
    requiredGpuPacketWriterAvailable: gpuBackends.some(
      (backend) => backend.packetWriterAvailable,
    ),
  };
}

function probeFfmpegEncoders(
  encoderNames: string[],
  env: NodeJS.ProcessEnv,
): FfmpegEncoderSupport {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], {
    env,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    timeout: 5000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return { ffmpegPresent: false };
  return parseFfmpegEncoderSupport(
    `${result.stdout}\n${result.stderr}`,
    encoderNames,
  );
}

export function parseFfmpegEncoderSupport(
  output: string,
  encoderNames: string[] = ["libx264", "png"],
): FfmpegEncoderSupport {
  const found = new Set(
    output.split(/\r?\n/).flatMap((line) => {
      const match = /^\s*[A-Z.]{6}\s+(\S+)(?:\s|$)/i.exec(line);
      return match?.[1] ? [match[1]] : [];
    }),
  );
  return {
    ffmpegPresent: true,
    encoders: Object.fromEntries(
      encoderNames.map((encoder) => [encoder, found.has(encoder)]),
    ),
  };
}
