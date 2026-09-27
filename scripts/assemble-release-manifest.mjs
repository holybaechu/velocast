import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { validReleasePackageSet } from "./release-package-set.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const args = parseArgs(process.argv.slice(2));
const evidenceDir = resolve(required(args, "evidence-dir"));
const output = resolve(required(args, "output"));
const baseUrl = ensureSlash(required(args, "base-url"));
assertOutsideRepo(output);

const manifest = JSON.parse(
  readFileSync(join(repoRoot, "release", "velocast-release.json"), "utf8"),
);
const ids = Object.keys(manifest.targets).sort();
const selectedIds = selectTargets(args.targets, ids);
let commit;
for (const id of selectedIds) {
  const evidencePath = join(evidenceDir, `${id}.tar.gz.json`);
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  if (
    evidence.target !== id ||
    evidence.format !== "tar.gz" ||
    typeof evidence.name !== "string" ||
    basename(evidence.name) !== evidence.name ||
    !Number.isSafeInteger(evidence.size) ||
    evidence.size <= 0 ||
    typeof evidence.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(evidence.sha256) ||
    typeof evidence.sourceCommit !== "string" ||
    !/^[a-f0-9]{40}$/.test(evidence.sourceCommit) ||
    typeof evidence.renderer !== "string" ||
    !evidence.renderer.trim() ||
    /[<>\0\r\n]/.test(evidence.renderer) ||
    isAbsolute(evidence.renderer) ||
    relative(".", evidence.renderer).startsWith("..") ||
    typeof evidence.root !== "string" ||
    !evidence.root.trim() ||
    /[<>\0\r\n]/.test(evidence.root) ||
    isAbsolute(evidence.root) ||
    relative(".", evidence.root).startsWith("..")
  ) {
    throw new Error(`release.evidence_invalid: ${id}`);
  }
  if (evidence.unsigned !== false) {
    throw new Error(`release.signature_missing: ${id}`);
  }
  const packageAudit = JSON.parse(
    readFileSync(join(evidenceDir, `${id}-package-audit.json`), "utf8"),
  );
  if (
    packageAudit.status !== "PASS" ||
    !Array.isArray(packageAudit.packages) ||
    !validReleasePackageSet(packageAudit.packages, manifest.packageVersion)
  ) {
    throw new Error(`release.package_audit_missing: ${id}`);
  }
  const packageTarballs = packageAudit.packages.map((name) =>
    join(evidenceDir, `${id}-${name}`),
  );
  if (packageTarballs.some((path) => !existsSync(path))) {
    throw new Error(`release.package_artifact_missing: ${id}`);
  }
  execFileSync(
    process.execPath,
    [
      join(repoRoot, "scripts", "audit-package-tarballs.mjs"),
      ...packageTarballs,
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );
  const consumerPath = join(
    evidenceDir,
    `${id}-consumer-validation.json`,
  );
  const consumer = JSON.parse(readFileSync(consumerPath, "utf8"));
  const requiredScenarios = [
    "scriptsDisabled",
    "freshSetup",
    "cachedSetup",
    "offlineSetup",
    "concurrentSetup",
    "npmRender",
    "pnpmRender",
    "deterministicRepeat",
    "softwareFallback",
  ];
  if (
    consumer.status !== "PASS" ||
    consumer.target !== id ||
    consumer.frames !== 240 ||
    !["npm", "pnpm"].every((manager) =>
      consumer.packageManagers?.includes(manager),
    ) ||
    requiredScenarios.some(
      (scenario) => consumer.scenarios?.[scenario] !== true,
    )
  ) {
    throw new Error(`release.consumer_evidence_missing: ${id}`);
  }
  validateHostRequirements(id, consumer.hostRequirements);
  for (const manager of ["npm", "pnpm"]) {
    const video = join(evidenceDir, `${manager}-${id}.mp4`);
    const report = join(evidenceDir, `${manager}-${id}-report.json`);
    if (!existsSync(video) || !existsSync(report)) {
      throw new Error(`release.render_evidence_missing: ${manager}/${id}`);
    }
    const verifyArgs = [
      join(repoRoot, "scripts", "verify-consumer-render.py"),
      "--video",
      video,
      "--report",
      report,
      "--target",
      id,
    ];
    if (manager === "pnpm") {
      const repeat = join(evidenceDir, `pnpm-${id}-repeat.mp4`);
      if (!existsSync(repeat)) {
        throw new Error(`release.render_evidence_missing: repeat/${id}`);
      }
      verifyArgs.push("--compare", repeat);
    }
    execFileSync(pythonCommand(), verifyArgs, {
      cwd: repoRoot,
      stdio: "inherit",
    });
  }
  const archive = join(evidenceDir, evidence.name);
  if (
    statSync(archive).size !== evidence.size ||
    sha256File(archive) !== evidence.sha256
  ) {
    throw new Error(`release.evidence_corrupt: ${id}`);
  }
  commit ??= evidence.sourceCommit;
  if (commit !== evidence.sourceCommit) {
    throw new Error(
      "release.commit_mismatch: target artifacts came from different commits",
    );
  }
  const validated = manifest.targets[id].validatedCandidate;
  if (validated) {
    for (const key of [
      "name",
      "format",
      "size",
      "sha256",
      "sourceCommit",
      "renderer",
      "root",
    ]) {
      if (validated[key] !== evidence[key])
        throw new Error(
          `release.validated_candidate_mismatch: ${id}/${key}`,
        );
    }
    if (validated.signed !== (evidence.unsigned === false))
      throw new Error(`release.validated_candidate_mismatch: ${id}/signed`);
    if (
      validated.packageVersion !== manifest.packageVersion ||
      validated.nativeRendererVersion !== manifest.nativeRendererVersion ||
      validated.protocolVersion !== manifest.protocolVersion
    )
      throw new Error(
        `release.validated_candidate_mismatch: ${id}/release-versions`,
      );
    if (validated.consumerEvidenceSha256 !== sha256File(consumerPath))
      throw new Error(
        `release.validated_candidate_mismatch: ${id}/consumerEvidenceSha256`,
      );
    if (
      validated.hostRequirementsSha256 !==
      requirementsSha256(consumer.hostRequirements)
    )
      throw new Error(
        `release.validated_candidate_mismatch: ${id}/hostRequirementsSha256`,
      );
  }
  manifest.targets[id].artifact = {
    name: evidence.name,
    url: new URL(basename(evidence.name), baseUrl).toString(),
    format: evidence.format,
    size: evidence.size,
    sha256: evidence.sha256,
    sourceCommit: evidence.sourceCommit,
    renderer: evidence.renderer,
    root: evidence.root,
  };
  manifest.targets[id].requirements = consumer.hostRequirements;
  manifest.targets[id].blocker = null;
}
manifest.sourceCommit = commit;
manifest.releaseChannel = "dry-run";
writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({ output, sourceCommit: commit, targets: selectedIds })}\n`,
);

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]?.replace(/^--/, "");
    const value = values[index + 1];
    if (key && value) {
      if (key === "target") (result.targets ??= []).push(value);
      else result[key] = value;
    }
  }
  return result;
}

function selectTargets(values, ids) {
  if (!values?.length) return ids;
  const selected = [
    ...new Set(values.flatMap((value) => value.split(",")).filter(Boolean)),
  ].sort();
  if (!selected.length || selected.some((id) => !ids.includes(id)))
    throw new Error(
      `release.target_invalid: select from ${ids.join(", ")}`,
    );
  return selected;
}

function required(args, key) {
  if (!args[key]) throw new Error(`missing --${key}`);
  return args[key];
}

function ensureSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function assertOutsideRepo(path) {
  const rel = relative(repoRoot, path);
  if (!rel.startsWith("..") && !isAbsolute(rel)) {
    throw new Error(
      "release.output_invalid: assembled manifests must be outside tracked source",
    );
  }
}

function sha256File(path) {
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

function validateHostRequirements(id, requirements) {
  if (
    requirements?.validationStatus !== "validated" ||
    !requirements.minimumOsVersion ||
    (id.startsWith("linux-") && !requirements.minimumGlibcVersion) ||
    !Array.isArray(requirements.captureBackends) ||
    requirements.captureBackends.length === 0 ||
    !Array.isArray(requirements.conversionBackends) ||
    requirements.conversionBackends.length === 0 ||
    !Array.isArray(requirements.encoderBackends) ||
    requirements.encoderBackends.length === 0
  ) {
    throw new Error(`release.host_requirements_missing: ${id}`);
  }
}

function requirementsSha256(requirements) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        validationStatus: requirements.validationStatus,
        minimumOsVersion: requirements.minimumOsVersion,
        minimumGlibcVersion: requirements.minimumGlibcVersion,
        gpuRequired: requirements.gpuRequired,
        captureBackends: requirements.captureBackends,
        conversionBackends: requirements.conversionBackends,
        encoderBackends: requirements.encoderBackends,
        softwareFallbackRequired: requirements.softwareFallbackRequired,
        softwareFallbackImplemented: requirements.softwareFallbackImplemented,
      }),
    )
    .digest("hex");
}

function pythonCommand() {
  return process.platform === "win32" ? "python.exe" : "python3";
}
