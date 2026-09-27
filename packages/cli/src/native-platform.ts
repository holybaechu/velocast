export type RequiredGpuBackendName =
  | "h264_amf"
  | "h264_nvenc"
  | "h264_qsv"
  | "h264_mf"
  | "hevc_amf"
  | "hevc_nvenc"
  | "hevc_qsv"
  | "hevc_mf"
  | "av1_amf"
  | "av1_nvenc"
  | "av1_qsv"
  | "av1_mf";

export interface RequiredGpuBackendDescriptor {
  backend: RequiredGpuBackendName;
  ffmpegEncoder?: string;
  packetWriterImplemented?: boolean;
  unavailableReason?: string;
}

export interface NativeRendererPlatform {
  id: string;
  platform: NodeJS.Platform;
  arch: string;
  executableName: string;
  packageName?: string;
  workspacePackageDir?: string;
  libraryPathEnv?: "LD_LIBRARY_PATH";
  displaylessEnvVars?: string[];
  requiredGpuBackends: RequiredGpuBackendDescriptor[];
}

const windowsD3D11FfmpegEncoderNames = [
  "h264_amf",
  "h264_nvenc",
  "h264_qsv",
  "h264_mf",
  "hevc_amf",
  "hevc_nvenc",
  "hevc_qsv",
  "hevc_mf",
  "av1_amf",
  "av1_nvenc",
  "av1_qsv",
  "av1_mf",
] as const satisfies readonly RequiredGpuBackendName[];

const windowsD3D11RequiredGpuBackends: RequiredGpuBackendDescriptor[] =
  windowsD3D11FfmpegEncoderNames.map((encoder) => ({
    backend: encoder,
    ffmpegEncoder: encoder,
    packetWriterImplemented: true,
  }));

export const nativeRendererPlatforms: readonly NativeRendererPlatform[] = [
  ...(["x64", "arm64"] as const).flatMap((arch): NativeRendererPlatform[] => [
    {
      id: `linux-${arch}`,
      platform: "linux",
      arch,
      executableName: "velocast-renderer",
      packageName: `@velocast/renderer-linux-${arch}`,
      workspacePackageDir: `renderer-linux-${arch}`,
      libraryPathEnv: "LD_LIBRARY_PATH",
      displaylessEnvVars: ["DISPLAY", "WAYLAND_DISPLAY"],
      requiredGpuBackends: [],
    },
    {
      id: `darwin-${arch}`,
      platform: "darwin",
      arch,
      executableName: "velocast-renderer",
      packageName: `@velocast/renderer-darwin-${arch}`,
      workspacePackageDir: `renderer-darwin-${arch}`,
      requiredGpuBackends: [],
    },
    {
      id: `win32-${arch}`,
      platform: "win32",
      arch,
      executableName: "velocast-renderer.exe",
      packageName: `@velocast/renderer-win32-${arch}`,
      workspacePackageDir: `renderer-win32-${arch}`,
      requiredGpuBackends: windowsD3D11RequiredGpuBackends,
    },
  ]),
];

export function resolveNativeRendererPlatform(
  platform: NodeJS.Platform,
  arch: string,
): NativeRendererPlatform | undefined {
  return nativeRendererPlatforms.find(
    (candidate) => candidate.platform === platform && candidate.arch === arch,
  );
}

export function rendererExecutableNameForPlatform(
  platform: NodeJS.Platform,
  arch: string,
): string {
  return (
    resolveNativeRendererPlatform(platform, arch)?.executableName ??
    (platform === "win32" ? "velocast-renderer.exe" : "velocast-renderer")
  );
}
