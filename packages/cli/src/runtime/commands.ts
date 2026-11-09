import { buildDoctorReport, type DoctorProbeInput } from "./doctor.js";
import {
  probeAvailableRuntimeForDoctor,
  type probeHostForDoctor,
} from "./doctor-host.js";
import type { RendererRuntimeAcquisition } from "./renderer-runtime.js";
import { ArtifactResolver } from "./artifact-resolver.js";
import { installedVelocastVersions } from "./package-versions.js";

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
  from?: string;
  sha256?: string;
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
  if ((options.from === undefined) !== (options.sha256 === undefined))
    throw new Error(
      "setup.local_options: use --from <native.tar.gz> together with --sha256 <trusted-hash>",
    );
  const runtime =
    options.from === undefined
      ? await resolver.setup()
      : await resolver.installLocal(options.from, options.sha256!);
  const result = {
    target: runtime.targetId,
    source: runtime.source,
    artifactDir: runtime.artifactDir,
    rendererBinary: runtime.rendererBinary,
    sha256: runtime.artifact.sha256,
    trust:
      runtime.source === "local-install"
        ? "explicit-local"
        : "release-manifest",
  };
  if (options.json) {
    write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  write(`Velocast ${result.target} runtime ready (${result.source})\n`);
  write(`Artifact: ${result.artifactDir}\n`);
  write(`SHA-256: ${result.sha256}\n`);
  if (runtime.source === "local-install")
    write(
      "Installed from your trusted local archive; this does not certify a signed or published release.\n",
    );
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
      target.artifact === null
        ? "blocked"
        : runtime && runtime.source !== "local-install"
          ? "verified"
          : "not-setup",
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
    installedRuntime: runtime
      ? {
          source: runtime.source,
          artifactDir: runtime.artifactDir,
          sha256: runtime.artifact.sha256,
        }
      : null,
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
  if (result.installedRuntime) {
    write(`Installed runtime: ${result.installedRuntime.source}\n`);
    write(`Artifact: ${result.installedRuntime.artifactDir}\n`);
  }
  if (result.blocker) {
    write(`Blocker: ${result.blocker}\n`);
  }
}

function writeDoctorText(
  report: ReturnType<typeof buildDoctorReport>,
  write: (value: string) => void,
): void {
  write(`Velocast doctor (${report.platform}/${report.arch})\n`);
  write(`Renderer: ${report.webCodecs.available ? "ready" : "unavailable"}\n`);
  write(
    `Hardware-only encoding: ${report.requiredGpu.available ? "available" : "unavailable"}\n`,
  );
  if (report.requiredGpu.backend) {
    write(`Backend: ${report.requiredGpu.backend}\n`);
  }
  if (report.requiredGpu.candidateBackends?.length) {
    write(
      `Backend candidates: ${report.requiredGpu.candidateBackends.join(", ")}\n`,
    );
  }
  if (!report.webCodecs.available && report.requiredGpu.reason) {
    write(`Reason: ${report.requiredGpu.reason}\n`);
  }
  if (!report.webCodecs.available && report.requiredGpu.diagnostics?.length) {
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
