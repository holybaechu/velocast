import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const REQUIRED_TARGET_IDS = [
  "win32-x64",
  "win32-arm64",
  "darwin-x64",
  "darwin-arm64",
  "linux-x64-gnu",
  "linux-arm64-gnu",
] as const;

export type ReleaseTargetId = (typeof REQUIRED_TARGET_IDS)[number];

export interface ReleaseArchive {
  name: string;
  url: string;
  format: string;
  size: number;
  sha256: string;
}

export interface ReleaseArtifact extends ReleaseArchive {
  format: "tar.gz";
  sourceCommit: string;
  renderer: string;
  root: string;
}

/** Immutable identity of a locally validated candidate. It deliberately has no
 * URL and is never installable through ArtifactResolver. */
export interface ValidatedReleaseCandidate {
  name: string;
  format: "tar.gz";
  size: number;
  sha256: string;
  sourceCommit: string;
  packageVersion: string;
  nativeRendererVersion: string;
  protocolVersion: number;
  renderer: string;
  root: string;
  signed: boolean;
  consumerEvidenceSha256: string;
  hostRequirementsSha256: string;
}

export interface ReleaseTarget {
  platform: NodeJS.Platform;
  arch: string;
  libc: "glibc" | null;
  rustTarget: string;
  toolchain: string;
  minimumHost: string;
  runner: string;
  backend: string;
  signing: string;
  runtimeFiles: string[];
  nativeFiles: string[];
  requirements: ReleaseTargetRequirements;
  validatedCandidate?: ValidatedReleaseCandidate;
  artifact: ReleaseArtifact | null;
  blocker: string | null;
}

export interface ReleaseTargetRequirements {
  validationStatus: "blocked" | "validated";
  minimumOsVersion: string | null;
  minimumGlibcVersion: string | null;
  gpuRequired: boolean;
  captureBackends: string[];
  conversionBackends: string[];
  encoderBackends: string[];
  softwareFallbackRequired: boolean;
  softwareFallbackImplemented: boolean;
}

export interface VelocastReleaseManifest {
  schema: "velocast-release-manifest-v1";
  artifactSchemaVersion: 1;
  releaseChannel: string;
  productVersion: string;
  packageVersion: string;
  nativeRendererVersion: string;
  protocolVersion: number;
  electronVersion: string;
  chromiumVersion: string;
  sourceCommit: string;
  distributionModel: "cli-download";
  targets: Record<ReleaseTargetId, ReleaseTarget>;
}

let cachedManifest:
  { path: string; manifest: VelocastReleaseManifest } | undefined;

export function loadReleaseManifest(
  path = releaseManifestPath(),
): VelocastReleaseManifest {
  if (cachedManifest?.path === path) {
    return cachedManifest.manifest;
  }
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const manifest = validateReleaseManifest(parsed);
  cachedManifest = { path, manifest };
  return manifest;
}

export function releaseManifestPath(): string {
  const override = process.env.VELOCAST_RELEASE_MANIFEST?.trim();
  if (override) {
    if (existsSync(override)) {
      return override;
    }
    throw new Error(
      `release.manifest_missing: VELOCAST_RELEASE_MANIFEST points to missing file ${override}`,
    );
  }
  const packaged = fileURLToPath(
    new URL("./release-manifest.json", import.meta.url),
  );
  if (existsSync(packaged)) {
    return packaged;
  }
  const workspace = fileURLToPath(
    new URL("../../../release/velocast-release.json", import.meta.url),
  );
  if (existsSync(workspace)) {
    return workspace;
  }
  throw new Error(
    "release.manifest_missing: reinstall the Velocast package; release-manifest.json is absent",
  );
}

export function availableReleaseTargets(
  manifest: VelocastReleaseManifest,
): ReleaseTargetId[] {
  return REQUIRED_TARGET_IDS.filter(
    (targetId) => manifest.targets[targetId].artifact !== null,
  );
}

export function validateReleaseManifest(
  value: unknown,
): VelocastReleaseManifest {
  if (!isRecord(value) || value.schema !== "velocast-release-manifest-v1") {
    throw new Error("release.manifest_invalid: unsupported manifest schema");
  }
  if (value.artifactSchemaVersion !== 1) {
    throw new Error("release.manifest_stale: unsupported artifact schema");
  }
  if (
    !isNonEmptyString(value.electronVersion) ||
    !isNonEmptyString(value.chromiumVersion)
  ) {
    throw new Error(
      "release.manifest_invalid: electronVersion and chromiumVersion are required",
    );
  }
  if (!isRecord(value.targets)) {
    throw new Error("release.manifest_invalid: targets must be an object");
  }
  for (const targetId of REQUIRED_TARGET_IDS) {
    validateTarget(targetId, value.targets[targetId], value);
  }
  for (const targetId of REQUIRED_TARGET_IDS) {
    const target = value.targets[targetId];
    if (
      isRecord(target) &&
      isRecord(target.artifact) &&
      target.artifact.sourceCommit !== value.sourceCommit
    )
      throw new Error(
        `release.manifest_invalid: ${targetId} artifact sourceCommit differs from manifest sourceCommit`,
      );
  }
  return value as unknown as VelocastReleaseManifest;
}

function validateTarget(
  targetId: ReleaseTargetId,
  value: unknown,
  release: Record<string, unknown>,
): void {
  if (!isRecord(value)) {
    throw new Error(`release.manifest_invalid: missing target ${targetId}`);
  }
  if (!Array.isArray(value.runtimeFiles) || value.runtimeFiles.length === 0) {
    throw new Error(
      `release.manifest_invalid: ${targetId} runtimeFiles must not be empty`,
    );
  }
  if (!value.runtimeFiles.includes("electron-runtime.json")) {
    throw new Error(
      `release.manifest_invalid: ${targetId} runtimeFiles must include electron-runtime.json`,
    );
  }
  if (!Array.isArray(value.nativeFiles) || value.nativeFiles.length === 0) {
    throw new Error(
      `release.manifest_invalid: ${targetId} nativeFiles must not be empty`,
    );
  }
  for (const nativeFile of value.nativeFiles) {
    if (!value.runtimeFiles.includes(nativeFile)) {
      throw new Error(
        `release.manifest_invalid: ${targetId} native file ${String(nativeFile)} is absent from runtimeFiles`,
      );
    }
  }
  validateRequirements(
    targetId,
    value.requirements,
    value.artifact !== null || value.validatedCandidate !== undefined,
  );
  const validatedCandidate = validateCandidate(
    targetId,
    value.validatedCandidate,
    value.requirements,
    release,
  );
  if (value.artifact !== null) {
    validateArchive(`${targetId} artifact`, value.artifact);
    if (!isRecord(value.artifact) || value.artifact.format !== "tar.gz") {
      throw new Error(
        `release.manifest_invalid: ${targetId} artifact format must be tar.gz`,
      );
    }
    for (const key of ["sourceCommit", "renderer", "root"] as const) {
      if (!isNonEmptyString(value.artifact[key])) {
        throw new Error(
          `release.manifest_invalid: ${targetId} artifact ${key} is required`,
        );
      }
    }
    if (validatedCandidate) {
      for (const key of [
        "name",
        "format",
        "size",
        "sha256",
        "sourceCommit",
        "renderer",
        "root",
      ] as const) {
        if (value.artifact[key] !== validatedCandidate[key])
          throw new Error(
            `release.manifest_invalid: ${targetId} artifact differs from validated candidate ${key}`,
          );
      }
    }
  }
}

function validateCandidate(
  targetId: ReleaseTargetId,
  value: unknown,
  requirements: unknown,
  release: Record<string, unknown>,
): ValidatedReleaseCandidate | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value))
    throw new Error(
      `release.manifest_invalid: ${targetId} validatedCandidate must be an object`,
    );
  if ("url" in value)
    throw new Error(
      `release.manifest_invalid: ${targetId} validatedCandidate must be URL-free`,
    );
  const allowed = new Set([
    "name",
    "format",
    "size",
    "sha256",
    "sourceCommit",
    "packageVersion",
    "nativeRendererVersion",
    "protocolVersion",
    "renderer",
    "root",
    "signed",
    "consumerEvidenceSha256",
    "hostRequirementsSha256",
  ]);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected)
    throw new Error(
      `release.manifest_invalid: ${targetId} validatedCandidate field ${unexpected} is not allowed`,
    );
  if (value.format !== "tar.gz")
    throw new Error(
      `release.manifest_invalid: ${targetId} validatedCandidate format must be tar.gz`,
    );
  for (const key of ["name", "renderer", "root"] as const)
    if (!isIdentityString(value[key]))
      throw new Error(
        `release.manifest_invalid: ${targetId} validatedCandidate ${key} is invalid`,
      );
  if (!Number.isSafeInteger(value.size) || Number(value.size) <= 0)
    throw new Error(
      `release.manifest_invalid: ${targetId} validatedCandidate size is invalid`,
    );
  for (const key of [
    "sha256",
    "consumerEvidenceSha256",
    "hostRequirementsSha256",
  ] as const)
    if (!isNonPlaceholderHex(value[key], 64))
      throw new Error(
        `release.manifest_invalid: ${targetId} validatedCandidate ${key} is invalid`,
      );
  if (!isNonPlaceholderHex(value.sourceCommit, 40))
    throw new Error(
      `release.manifest_invalid: ${targetId} validatedCandidate sourceCommit is invalid`,
    );
  if (
    release.sourceCommit !== null &&
    value.sourceCommit !== release.sourceCommit
  )
    throw new Error(
      `release.manifest_invalid: ${targetId} validatedCandidate sourceCommit differs from manifest`,
    );
  for (const key of ["packageVersion", "nativeRendererVersion"] as const)
    if (!isIdentityString(value[key]) || value[key] !== release[key])
      throw new Error(
        `release.manifest_invalid: ${targetId} validatedCandidate ${key} differs from manifest`,
      );
  if (
    !Number.isSafeInteger(value.protocolVersion) ||
    value.protocolVersion !== release.protocolVersion
  )
    throw new Error(
      `release.manifest_invalid: ${targetId} validatedCandidate protocolVersion differs from manifest`,
    );
  if (
    !isRecord(requirements) ||
    value.hostRequirementsSha256 !==
      validatedRequirementsSha256(
        requirements as unknown as ReleaseTargetRequirements,
      )
  )
    throw new Error(
      `release.manifest_invalid: ${targetId} validatedCandidate hostRequirementsSha256 differs from canonical requirements`,
    );
  if (typeof value.signed !== "boolean")
    throw new Error(
      `release.manifest_invalid: ${targetId} validatedCandidate signed is required`,
    );
  return value as unknown as ValidatedReleaseCandidate;
}

function validateRequirements(
  targetId: ReleaseTargetId,
  value: unknown,
  hasArtifact: boolean,
): void {
  if (!isRecord(value)) {
    throw new Error(
      `release.manifest_invalid: ${targetId} requirements missing`,
    );
  }
  if (
    value.validationStatus !== "blocked" &&
    value.validationStatus !== "validated"
  ) {
    throw new Error(
      `release.manifest_invalid: ${targetId} requirement validation status is invalid`,
    );
  }
  for (const key of [
    "captureBackends",
    "conversionBackends",
    "encoderBackends",
  ] as const) {
    if (
      !Array.isArray(value[key]) ||
      value[key].length === 0 ||
      value[key].some((entry) => !isNonEmptyString(entry))
    ) {
      throw new Error(
        `release.manifest_invalid: ${targetId} ${key} must not be empty`,
      );
    }
  }
  if (hasArtifact) {
    if (
      value.validationStatus !== "validated" ||
      !isNonEmptyString(value.minimumOsVersion) ||
      (targetId.startsWith("linux-") &&
        !isNonEmptyString(value.minimumGlibcVersion)) ||
      (value.softwareFallbackRequired === true &&
        value.softwareFallbackImplemented !== true)
    ) {
      throw new Error(
        `release.manifest_invalid: ${targetId} cannot record an installable artifact or validated candidate before host and backend requirements are validated`,
      );
    }
  }
}

function validateArchive(label: string, value: unknown): void {
  if (!isRecord(value)) {
    throw new Error(`release.manifest_invalid: ${label} archive is missing`);
  }
  for (const key of ["name", "url", "format"] as const) {
    if (!isNonEmptyString(value[key])) {
      throw new Error(`release.manifest_invalid: ${label} ${key} is required`);
    }
  }
  if (!Number.isSafeInteger(value.size) || Number(value.size) <= 0) {
    throw new Error(`release.manifest_invalid: ${label} size is invalid`);
  }
  if (
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  ) {
    throw new Error(`release.manifest_invalid: ${label} sha256 is invalid`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIdentityString(value: unknown): value is string {
  return (
    isNonEmptyString(value) &&
    !/[<>\0\r\n]/.test(value) &&
    !/^(placeholder|todo|pending)$/i.test(value.trim())
  );
}

function isNonPlaceholderHex(value: unknown, length: number): value is string {
  return (
    typeof value === "string" &&
    new RegExp(`^[a-f0-9]{${length}}$`).test(value) &&
    !/^0+$/.test(value)
  );
}

export function validatedRequirementsSha256(
  requirements: ReleaseTargetRequirements,
): string {
  const canonical = {
    validationStatus: requirements.validationStatus,
    minimumOsVersion: requirements.minimumOsVersion,
    minimumGlibcVersion: requirements.minimumGlibcVersion,
    gpuRequired: requirements.gpuRequired,
    captureBackends: requirements.captureBackends,
    conversionBackends: requirements.conversionBackends,
    encoderBackends: requirements.encoderBackends,
    softwareFallbackRequired: requirements.softwareFallbackRequired,
    softwareFallbackImplemented: requirements.softwareFallbackImplemented,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
