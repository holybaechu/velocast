export type RequiredGpuBackendName = "webcodecs";

export interface RequiredGpuBackendDescriptor {
  backend: RequiredGpuBackendName;
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

const webCodecsBackends: RequiredGpuBackendDescriptor[] = [
  {
    backend: "webcodecs",
    packetWriterImplemented: true,
    unavailableReason:
      "WebCodecs hardwareAcceleration is a preference, not a hardware guarantee",
  },
];

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
      requiredGpuBackends: webCodecsBackends,
    },
    {
      id: `darwin-${arch}`,
      platform: "darwin",
      arch,
      executableName: "velocast-renderer",
      packageName: `@velocast/renderer-darwin-${arch}`,
      workspacePackageDir: `renderer-darwin-${arch}`,
      requiredGpuBackends: webCodecsBackends,
    },
    {
      id: `win32-${arch}`,
      platform: "win32",
      arch,
      executableName: "velocast-renderer.exe",
      packageName: `@velocast/renderer-win32-${arch}`,
      workspacePackageDir: `renderer-win32-${arch}`,
      requiredGpuBackends: webCodecsBackends,
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
