import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, release as osRelease } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { extract } from "tar";
import {
  availableReleaseTargets,
  loadReleaseManifest,
  type ReleaseArtifact,
  type ReleaseTarget,
  type ReleaseTargetId,
  type VelocastReleaseManifest,
} from "./release-manifest.js";
import { assertCompatibleVelocastVersions } from "./package-versions.js";

const CACHE_DIR_ENV = "VELOCAST_CACHE_DIR";
const MIRROR_ENV = "VELOCAST_ARTIFACT_BASE_URL";
const OFFLINE_ENV = "VELOCAST_OFFLINE";
const LOCAL_ARTIFACT_ENV = "VELOCAST_ARTIFACT_DIR";
const LOCAL_ARTIFACT_MANIFEST_SHA_ENV = "VELOCAST_ARTIFACT_MANIFEST_SHA256";
const LOCK_TIMEOUT_MS = 30_000;
const STALE_LOCK_MS = 10 * 60_000;

export interface ArtifactResolverOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  manifest?: VelocastReleaseManifest;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  lockStat?: typeof statSync;
}

export interface ResolvedReleaseRuntime {
  targetId: ReleaseTargetId;
  artifactDir: string;
  rendererBinary: string;
  source: "cache" | "download" | "local-override";
  artifact: ReleaseArtifact;
}

interface ArtifactFileRecord {
  path: string;
  size: number;
  sha256: string;
}

interface ArtifactInventory {
  schema: "velocast-native-artifact-v1";
  target: ReleaseTargetId;
  sourceCommit: string;
  packageVersion: string;
  nativeRendererVersion: string;
  protocolVersion: number;
  files: ArtifactFileRecord[];
}

export class ArtifactResolver {
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly manifest: VelocastReleaseManifest;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly lockStat: typeof statSync;

  constructor(options: ArtifactResolverOptions = {}) {
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.manifest = options.manifest ?? loadReleaseManifest();
    assertCompatibleVelocastVersions(this.manifest);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.lockStat = options.lockStat ?? statSync;
  }

  releaseManifest(): VelocastReleaseManifest {
    return this.manifest;
  }

  targetId(): ReleaseTargetId {
    return detectReleaseTarget(
      this.platform,
      this.arch,
      this.env,
      availableReleaseTargets(this.manifest),
    );
  }

  async setup(): Promise<ResolvedReleaseRuntime> {
    const targetId = this.targetId();
    const target = this.manifest.targets[targetId];
    const artifact = requireReleasedArtifact(this.manifest, targetId);
    verifyHostRequirements(targetId, target, this.env);
    const localOverride = this.env[LOCAL_ARTIFACT_ENV]?.trim();
    if (localOverride) {
      return this.resolveLocalOverride(
        targetId,
        target,
        artifact,
        localOverride,
      );
    }

    const destination = this.cacheArtifactDir(targetId, artifact.sha256);
    const cached = this.verifyCachedRuntime(
      targetId,
      target,
      artifact,
      destination,
    );
    if (cached) {
      return cached;
    }
    if (this.env[OFFLINE_ENV] === "1") {
      throw new Error(
        `artifact.offline_missing: no verified ${targetId} artifact is cached; unset ${OFFLINE_ENV} and run velocast setup`,
      );
    }

    const lockDir = `${destination}.lock`;
    mkdirSync(dirname(destination), { recursive: true });
    await this.acquireLock(lockDir);
    try {
      const afterLock = this.verifyCachedRuntime(
        targetId,
        target,
        artifact,
        destination,
      );
      if (afterLock) {
        return afterLock;
      }
      return await this.downloadAndPromote(
        targetId,
        target,
        artifact,
        destination,
      );
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }
  }

  inspect(): ResolvedReleaseRuntime | undefined {
    const targetId = this.targetId();
    const target = this.manifest.targets[targetId];
    const artifact = target.artifact;
    if (artifact === null) {
      return undefined;
    }
    verifyHostRequirements(targetId, target, this.env);
    const localOverride = this.env[LOCAL_ARTIFACT_ENV]?.trim();
    if (localOverride) {
      return this.resolveLocalOverride(
        targetId,
        target,
        artifact,
        localOverride,
        false,
      );
    }
    return this.verifyCachedRuntime(
      targetId,
      target,
      artifact,
      this.cacheArtifactDir(targetId, artifact.sha256),
      false,
    );
  }

  private resolveLocalOverride(
    targetId: ReleaseTargetId,
    target: ReleaseTarget,
    artifact: ReleaseArtifact,
    path: string,
    prepare = true,
  ): ResolvedReleaseRuntime {
    const artifactDir = resolve(path);
    const expectedManifestSha =
      this.env[LOCAL_ARTIFACT_MANIFEST_SHA_ENV]?.trim();
    if (!expectedManifestSha || !/^[a-f0-9]{64}$/.test(expectedManifestSha)) {
      throw new Error(
        `artifact.local_override_invalid: ${LOCAL_ARTIFACT_MANIFEST_SHA_ENV} must contain the trusted artifact-manifest.json SHA-256`,
      );
    }
    const manifestPath = join(artifactDir, "artifact-manifest.json");
    if (
      !existsSync(manifestPath) ||
      sha256File(manifestPath) !== expectedManifestSha
    ) {
      throw new Error(
        "artifact.local_override_invalid: artifact-manifest.json does not match the trusted SHA-256",
      );
    }
    (prepare ? verifyRuntimeDirectory : verifyRuntimeDirectoryContents)(
      artifactDir,
      targetId,
      target,
      artifact,
      this.manifest,
    );
    return {
      targetId,
      artifactDir,
      rendererBinary: join(artifactDir, artifact.renderer),
      source: "local-override",
      artifact,
    };
  }

  private verifyCachedRuntime(
    targetId: ReleaseTargetId,
    target: ReleaseTarget,
    artifact: ReleaseArtifact,
    artifactDir: string,
    prepare = true,
  ): ResolvedReleaseRuntime | undefined {
    if (!existsSync(artifactDir)) {
      return undefined;
    }
    try {
      (prepare ? verifyRuntimeDirectory : verifyRuntimeDirectoryContents)(
        artifactDir,
        targetId,
        target,
        artifact,
        this.manifest,
      );
      return {
        targetId,
        artifactDir,
        rendererBinary: join(artifactDir, artifact.renderer),
        source: "cache",
        artifact,
      };
    } catch {
      if (prepare) rmSync(artifactDir, { recursive: true, force: true });
      return undefined;
    }
  }

  private cacheArtifactDir(targetId: ReleaseTargetId, sha256: string): string {
    const cacheRoot = resolve(
      this.env[CACHE_DIR_ENV]?.trim() || join(homedir(), ".cache", "velocast"),
    );
    return join(
      cacheRoot,
      `artifact-schema-${this.manifest.artifactSchemaVersion}`,
      this.manifest.nativeRendererVersion,
      targetId,
      sha256,
    );
  }

  private async downloadAndPromote(
    targetId: ReleaseTargetId,
    target: ReleaseTarget,
    artifact: ReleaseArtifact,
    destination: string,
  ): Promise<ResolvedReleaseRuntime> {
    mkdirSync(dirname(destination), { recursive: true });
    const archive = `${destination}.partial-${process.pid}`;
    const staging = `${destination}.staging-${process.pid}`;
    rmSync(archive, { force: true });
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    try {
      const url = artifactUrl(artifact, this.env[MIRROR_ENV]);
      if (new URL(url).protocol === "file:") {
        await pipeline(
          createReadStream(fileURLToPath(url)),
          createWriteStream(archive, { flags: "wx" }),
        );
      } else {
        const proxyUrl =
          this.env.VELOCAST_HTTPS_PROXY?.trim() ||
          this.env.HTTPS_PROXY?.trim() ||
          this.env.https_proxy?.trim();
        let closeProxy: (() => Promise<void>) | undefined;
        try {
          let response;
          if (proxyUrl && this.fetchImpl === globalThis.fetch) {
            const { fetch: proxyFetch, ProxyAgent } = await import("undici");
            const proxy = new ProxyAgent(proxyUrl);
            closeProxy = () => proxy.close();
            response = await proxyFetch(url, { dispatcher: proxy });
          } else {
            response = await this.fetchImpl(url);
          }
          if (!response.ok || response.body === null) {
            throw new Error(
              `artifact.download_failed: ${url} returned HTTP ${response.status}; check HTTPS_PROXY or set ${MIRROR_ENV}`,
            );
          }
          await pipeline(
            Readable.fromWeb(response.body as never),
            createWriteStream(archive, { flags: "wx" }),
          );
        } finally {
          await closeProxy?.();
        }
      }
      verifyArchiveFile(archive, artifact);
      await extract({
        file: archive,
        cwd: staging,
        gzip: true,
        preservePaths: false,
        strict: true,
      });
      const root = resolveContainedPath(staging, artifact.root);
      verifyRuntimeDirectory(root, targetId, target, artifact, this.manifest);
      renameSync(root, destination);
      if (root !== staging) {
        rmSync(staging, { recursive: true, force: true });
      }
      return {
        targetId,
        artifactDir: destination,
        rendererBinary: join(destination, artifact.renderer),
        source: "download",
        artifact,
      };
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    } finally {
      rmSync(archive, { force: true });
    }
  }

  private async acquireLock(lockDir: string): Promise<void> {
    const started = this.now();
    while (true) {
      try {
        mkdirSync(lockDir);
        return;
      } catch (error) {
        if (!isAlreadyExists(error)) {
          throw error;
        }
        let lockAge: number | undefined;
        try {
          lockAge = this.now() - this.lockStat(lockDir).mtimeMs;
        } catch (statError) {
          if (!isNotFound(statError)) throw statError;
        }
        if (lockAge !== undefined && lockAge > STALE_LOCK_MS) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
        if (this.now() - started >= LOCK_TIMEOUT_MS) {
          throw new Error(
            `artifact.setup_locked: another setup owns ${lockDir}; wait or remove the lock after confirming no setup is running`,
            { cause: error },
          );
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
    }
  }
}

export function detectReleaseTarget(
  platform: NodeJS.Platform,
  arch: string,
  env: NodeJS.ProcessEnv = process.env,
  availableTargets: ReleaseTargetId[] = [],
): ReleaseTargetId {
  if (platform === "linux" && detectLinuxLibc(env) !== "glibc") {
    throw unsupportedTargetError(`${platform}-${arch}-musl`, availableTargets);
  }
  const id = `${platform}-${arch}${platform === "linux" ? "-gnu" : ""}`;
  if ((RELEASE_TARGET_SET as Set<string>).has(id)) {
    return id as ReleaseTargetId;
  }
  throw unsupportedTargetError(id, availableTargets);
}

const RELEASE_TARGET_SET = new Set<string>([
  "win32-x64",
  "win32-arm64",
  "darwin-x64",
  "darwin-arm64",
  "linux-x64-gnu",
  "linux-arm64-gnu",
]);

function detectLinuxLibc(env: NodeJS.ProcessEnv): "glibc" | "musl" {
  const override = env.VELOCAST_TEST_LIBC?.trim();
  if (override === "glibc" || override === "musl") {
    return override;
  }
  const report = process.report?.getReport() as
    { header?: { glibcVersionRuntime?: string } } | undefined;
  return report?.header?.glibcVersionRuntime ? "glibc" : "musl";
}

function detectGlibcVersion(env: NodeJS.ProcessEnv): string | undefined {
  const override = env.VELOCAST_TEST_GLIBC_VERSION?.trim();
  if (override) return override;
  const report = process.report?.getReport() as
    { header?: { glibcVersionRuntime?: string } } | undefined;
  return report?.header?.glibcVersionRuntime;
}

function requireReleasedArtifact(
  manifest: VelocastReleaseManifest,
  targetId: ReleaseTargetId,
): ReleaseArtifact {
  const target = manifest.targets[targetId];
  if (target.artifact !== null) {
    return target.artifact;
  }
  const available = availableReleaseTargets(manifest);
  const suffix = available.length ? available.join(", ") : "none";
  throw new Error(
    `artifact.target_unavailable: ${targetId} has no verified release artifact (${target.blocker ?? "blocked"}). Available targets: ${suffix}`,
  );
}

function unsupportedTargetError(
  target: string,
  availableTargets: ReleaseTargetId[],
): Error {
  return new Error(
    `artifact.unsupported_target: ${target} is unsupported. Available targets: ${availableTargets.length ? availableTargets.join(", ") : "none"}`,
  );
}

function verifyHostRequirements(
  targetId: ReleaseTargetId,
  target: ReleaseTarget,
  env: NodeJS.ProcessEnv,
): void {
  const requirements = target.requirements;
  if (requirements.validationStatus !== "validated") {
    throw new Error(
      `artifact.requirements_unvalidated: ${targetId} host/backend requirements are not validated`,
    );
  }
  const minimumOs = requirements.minimumOsVersion;
  const actualOs = hostOsVersion(target.platform, env);
  if (!minimumOs || compareVersions(actualOs, minimumOs) < 0) {
    throw new Error(
      `artifact.host_incompatible: ${targetId} requires OS ${minimumOs ?? "validated baseline"} or newer; current ${actualOs}`,
    );
  }
  if (target.platform === "linux") {
    const actualGlibc = detectGlibcVersion(env);
    const minimumGlibc = requirements.minimumGlibcVersion;
    if (
      !actualGlibc ||
      !minimumGlibc ||
      compareVersions(actualGlibc, minimumGlibc) < 0
    ) {
      throw new Error(
        `artifact.host_incompatible: ${targetId} requires glibc ${minimumGlibc ?? "validated baseline"} or newer; current ${actualGlibc ?? "unknown"}`,
      );
    }
  }
}

function hostOsVersion(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string {
  const override = env.VELOCAST_TEST_OS_VERSION?.trim();
  if (override) return override;
  if (platform === "darwin" && process.platform === "darwin") {
    return execFileSync("sw_vers", ["-productVersion"], {
      encoding: "utf8",
    }).trim();
  }
  return osRelease();
}

function compareVersions(left: string, right: string): number {
  const leftParts = left
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(Number);
  const rightParts = right
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(Number);
  for (
    let index = 0;
    index < Math.max(leftParts.length, rightParts.length);
    index += 1
  ) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function artifactUrl(artifact: ReleaseArtifact, mirror?: string): string {
  if (!mirror?.trim()) {
    return artifact.url;
  }
  return new URL(
    basename(new URL(artifact.url).pathname),
    ensureTrailingSlash(mirror),
  ).toString();
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function verifyArchiveFile(path: string, artifact: ReleaseArtifact): void {
  const size = statSync(path).size;
  if (size !== artifact.size) {
    throw new Error(
      `artifact.size_mismatch: expected ${artifact.size} bytes but received ${size}; remove ${path} and retry setup`,
    );
  }
  const digest = sha256File(path);
  if (digest !== artifact.sha256) {
    throw new Error(
      `artifact.checksum_mismatch: expected ${artifact.sha256} but received ${digest}; remove ${path} and retry setup`,
    );
  }
}

export function verifyRuntimeDirectory(
  artifactDir: string,
  targetId: ReleaseTargetId,
  target: ReleaseTarget,
  artifact: ReleaseArtifact,
  release: VelocastReleaseManifest,
): void {
  verifyRuntimeDirectoryContents(
    artifactDir,
    targetId,
    target,
    artifact,
    release,
  );
  if (target.platform !== "win32") {
    chmodSync(resolveContainedPath(artifactDir, artifact.renderer), 0o755);
  }
}

function verifyRuntimeDirectoryContents(
  artifactDir: string,
  targetId: ReleaseTargetId,
  target: ReleaseTarget,
  artifact: ReleaseArtifact,
  release: VelocastReleaseManifest,
): void {
  const inventoryPath = resolveContainedPath(
    artifactDir,
    "artifact-manifest.json",
  );
  if (!existsSync(inventoryPath)) {
    throw new Error(
      "artifact.runtime_invalid: artifact-manifest.json is missing",
    );
  }
  const inventory = JSON.parse(
    readFileSync(inventoryPath, "utf8"),
  ) as ArtifactInventory;
  if (
    inventory.schema !== "velocast-native-artifact-v1" ||
    inventory.target !== targetId ||
    inventory.sourceCommit !== artifact.sourceCommit ||
    inventory.packageVersion !== release.packageVersion ||
    inventory.nativeRendererVersion !== release.nativeRendererVersion ||
    inventory.protocolVersion !== release.protocolVersion ||
    !Array.isArray(inventory.files)
  ) {
    throw new Error(
      `artifact.compatibility_mismatch: ${targetId} artifact versions or source commit do not match the release manifest`,
    );
  }
  const records = new Map(inventory.files.map((file) => [file.path, file]));
  for (const required of ["artifact-manifest.json", ...target.runtimeFiles]) {
    const path = resolveContainedPath(artifactDir, required);
    if (!existsSync(path)) {
      throw new Error(`artifact.runtime_missing: ${required} is absent`);
    }
    if (required === "artifact-manifest.json") {
      continue;
    }
    const record = records.get(required);
    if (!record || !/^[a-f0-9]{64}$/.test(record.sha256)) {
      throw new Error(
        `artifact.runtime_invalid: checksum inventory is missing ${required}`,
      );
    }
    const actualSize = statSync(path).size;
    const actualSha256 = sha256File(path);
    if (actualSize !== record.size || actualSha256 !== record.sha256) {
      throw new Error(
        `artifact.runtime_corrupt: ${required} failed verification`,
      );
    }
  }
  for (const nativeFile of target.nativeFiles) {
    verifyExecutableArchitecture(
      resolveContainedPath(artifactDir, nativeFile),
      target.arch,
    );
  }
  const renderer = resolveContainedPath(artifactDir, artifact.renderer);
  if (!existsSync(renderer) || !statSync(renderer).isFile()) {
    throw new Error(`artifact.runtime_missing: ${artifact.renderer} is absent`);
  }
}

export function verifyExecutableArchitecture(
  path: string,
  expectedArch: string,
): void {
  const bytes = readFileSync(path).subarray(0, 4096);
  const actual = executableArchitecture(bytes);
  if (actual !== expectedArch) {
    throw new Error(
      `artifact.wrong_architecture: ${path} is ${actual ?? "unknown"}, expected ${expectedArch}`,
    );
  }
}

function executableArchitecture(bytes: Buffer): "x64" | "arm64" | undefined {
  if (
    bytes.length >= 64 &&
    bytes[0] === 0x7f &&
    bytes.toString("ascii", 1, 4) === "ELF"
  ) {
    const machine = bytes.readUInt16LE(18);
    return machine === 0x3e ? "x64" : machine === 0xb7 ? "arm64" : undefined;
  }
  if (bytes.length >= 64 && bytes.toString("ascii", 0, 2) === "MZ") {
    const offset = bytes.readUInt32LE(0x3c);
    if (
      offset + 6 <= bytes.length &&
      bytes.toString("ascii", offset, offset + 4) === "PE\0\0"
    ) {
      const machine = bytes.readUInt16LE(offset + 4);
      return machine === 0x8664
        ? "x64"
        : machine === 0xaa64
          ? "arm64"
          : undefined;
    }
  }
  if (bytes.length >= 8) {
    const magic = bytes.readUInt32LE(0);
    if (magic === 0xfeedfacf) {
      const cpu = bytes.readUInt32LE(4);
      return cpu === 0x01000007
        ? "x64"
        : cpu === 0x0100000c
          ? "arm64"
          : undefined;
    }
  }
  return undefined;
}

function resolveContainedPath(root: string, child: string): string {
  const path = resolve(root, child);
  const rel = relative(resolve(root), path);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `artifact.path_invalid: ${child} escapes the artifact root`,
    );
  }
  return path;
}

function sha256File(path: string): string {
  const hash = createHash("sha256");
  const handle = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    while ((bytesRead = readSync(handle, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(handle);
  }
  return hash.digest("hex");
}

function isAlreadyExists(error: unknown): boolean {
  return isErrorCode(error, "EEXIST");
}

function isNotFound(error: unknown): boolean {
  return isErrorCode(error, "ENOENT");
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
