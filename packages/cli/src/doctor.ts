import {
  RENDERER_BACKEND_DIAGNOSTIC_CODES,
  type RendererBackendDiagnosticCode,
} from "./generated/renderer-contracts.js";
import type { RequiredGpuBackendName } from "./native-platform.js";

export {
  RENDERER_BACKEND_DIAGNOSTIC_CODES,
  type RendererBackendDiagnosticCode,
} from "./generated/renderer-contracts.js";

export const DOCTOR_REQUIRED_GPU_DIAGNOSTIC_CODES = [
  ...RENDERER_BACKEND_DIAGNOSTIC_CODES,
  "renderer.binary_unavailable",
  "runtime.electron_invalid",
] as const;

export type DoctorRequiredGpuDiagnosticCode =
  (typeof DOCTOR_REQUIRED_GPU_DIAGNOSTIC_CODES)[number];

export interface DoctorGpuPrerequisite {
  available: boolean;
  reason: string;
  code?: DoctorRequiredGpuDiagnosticCode;
}

export interface DoctorRequiredGpuBackendProbe {
  backend: RequiredGpuBackendName;
  available: boolean;
  reason?: string;
  unavailableCode?: RendererBackendDiagnosticCode;
  packetWriterAvailable?: boolean;
}

export interface DoctorRequiredGpuDiagnostic {
  kind: "renderer" | "runtime" | "prerequisite" | "backend";
  code: DoctorRequiredGpuDiagnosticCode;
  reason: string;
  backend?: RequiredGpuBackendName;
}

export interface DoctorProbeInput {
  platform: NodeJS.Platform;
  arch: string;
  rendererBinary?: string;
  browserRuntime?: {
    host: "electron";
    available: boolean;
    gpuCaptureSupported: boolean;
    reason?: string;
  };
  requiredGpuPrerequisites?: DoctorGpuPrerequisite[];
  requiredGpuBackends?: DoctorRequiredGpuBackendProbe[];
  displayVariablesUnset?: boolean;
  ffmpegPresent: boolean;
  softwareFallbackAvailable: boolean;
  requiredGpuPacketWriterAvailable?: boolean;
}

export interface DoctorReport {
  platform: NodeJS.Platform;
  arch: string;
  rendererBinary?: string;
  requiredGpu: {
    available: boolean;
    backend?: RequiredGpuBackendName;
    candidateBackends?: RequiredGpuBackendName[];
    reason?: string;
    diagnostics?: DoctorRequiredGpuDiagnostic[];
  };
  softwareFallback: {
    available: boolean;
    reason?: string;
  };
}

export function buildDoctorReport(input: DoctorProbeInput): DoctorReport {
  const requiredGpu = requiredGpuStatus(input);
  return {
    platform: input.platform,
    arch: input.arch,
    rendererBinary: input.rendererBinary,
    requiredGpu,
    softwareFallback:
      input.softwareFallbackAvailable &&
      !!input.rendererBinary &&
      input.browserRuntime?.available === true
        ? { available: true }
        : { available: false, reason: "software fallback unavailable" },
  };
}

function requiredGpuStatus(
  input: DoctorProbeInput,
): DoctorReport["requiredGpu"] {
  if (!input.rendererBinary) {
    const reason = "renderer binary unavailable";
    return {
      available: false,
      reason,
      diagnostics: [
        {
          kind: "renderer",
          code: "renderer.binary_unavailable",
          reason,
        },
      ],
    };
  }
  if (input.browserRuntime?.available !== true) {
    const reason =
      input.browserRuntime?.reason ?? "Electron runtime files missing";
    return {
      available: false,
      reason,
      diagnostics: [
        { kind: "runtime", code: "runtime.electron_invalid", reason },
      ],
    };
  }
  if (
    input.browserRuntime?.host === "electron" &&
    !input.browserRuntime.gpuCaptureSupported
  ) {
    const reason =
      "Electron native GPU capture is currently implemented on Windows; software capture is available on this platform";
    return {
      available: false,
      reason,
      diagnostics: [{ kind: "backend", code: "backend.unavailable", reason }],
    };
  }
  const requiredGpuPrerequisites = input.requiredGpuPrerequisites ?? [];
  const failedPrerequisites = requiredGpuPrerequisites.filter(
    (prerequisite) => !prerequisite.available,
  );
  if (failedPrerequisites.length > 0) {
    return {
      available: false,
      reason: failedPrerequisites
        .map((prerequisite) => prerequisite.reason)
        .join("; "),
      diagnostics: failedPrerequisites.map(prerequisiteDiagnostic),
    };
  }

  const requiredGpuBackends = input.requiredGpuBackends ?? [];
  const completeBackends = requiredGpuBackends.filter((candidate) => {
    return candidate.available && candidate.packetWriterAvailable !== false;
  });
  if (completeBackends.length === 1) {
    return { available: true, backend: completeBackends[0]!.backend };
  }
  if (completeBackends.length > 1) {
    return {
      available: true,
      candidateBackends: completeBackends.map((candidate) => candidate.backend),
    };
  }

  const backend = requiredGpuBackends.find((candidate) => candidate.available);
  if (!backend) {
    const reasons = requiredGpuBackends
      .map((candidate) =>
        candidate.reason
          ? `${candidate.backend}: ${candidate.reason}`
          : `${candidate.backend}: unavailable`,
      )
      .join("; ");
    return {
      available: false,
      reason:
        reasons ||
        `no required GPU backend available for ${input.platform}/${input.arch}`,
      diagnostics: backendDiagnostics(requiredGpuBackends),
    };
  }

  if (backend.packetWriterAvailable === false) {
    const reason = "required GPU packet writer unavailable";
    return {
      available: false,
      backend: backend.backend,
      reason,
      diagnostics: [
        {
          kind: "backend",
          backend: backend.backend,
          code: "backend.unavailable",
          reason,
        },
      ],
    };
  }
  return { available: false, backend: backend.backend };
}

function prerequisiteDiagnostic(
  prerequisite: DoctorGpuPrerequisite,
): DoctorRequiredGpuDiagnostic {
  return {
    kind: "prerequisite",
    code: prerequisite.code ?? "platform.target_unavailable",
    reason: prerequisite.reason,
  };
}

function backendDiagnostics(
  backends: DoctorRequiredGpuBackendProbe[],
): DoctorRequiredGpuDiagnostic[] {
  return backends.map((backend) => {
    const reason = backend.reason ?? `${backend.backend} unavailable`;
    return {
      kind: "backend",
      backend: backend.backend,
      code: backend.unavailableCode ?? "backend.unavailable",
      reason,
    };
  });
}
