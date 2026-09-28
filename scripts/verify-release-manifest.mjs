import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { windowsCandidateState } from "./windows-candidate-state.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(repoRoot, "release", "velocast-release.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const windowsCandidate = JSON.parse(
  await readFile(
    join(repoRoot, "release", "windows-runtime-candidate.json"),
    "utf8",
  ),
);
const requiredTargets = [
  "win32-x64",
  "win32-arm64",
  "darwin-x64",
  "darwin-arm64",
  "linux-x64-gnu",
  "linux-arm64-gnu",
];

assert(manifest.schema === "velocast-release-manifest-v1", "invalid schema");
assert(manifest.artifactSchemaVersion === 1, "invalid artifact schema");
assert(
  /^\d+\.\d+\.\d+$/.test(manifest.electronVersion),
  "invalid Electron version",
);
assert(
  /^\d+\.\d+\.\d+\.\d+$/.test(manifest.chromiumVersion),
  "invalid Chromium version",
);
assert(manifest.cefVersion === undefined, "CEF version must be retired");
assert(
  manifest.distributionModel === "cli-download",
  "invalid distribution model",
);
assert(
  JSON.stringify(Object.keys(manifest.targets).sort()) ===
    JSON.stringify([...requiredTargets].sort()),
  "manifest must contain exactly the six required targets",
);

for (const id of requiredTargets) {
  const target = manifest.targets[id];
  assert(target && typeof target === "object", `${id} is missing`);
  assert(target.runtimeFiles?.length > 0, `${id} runtime inventory is empty`);
  assert(
    !target.runtimeFiles.some((path) =>
      /(^|\/)(ffmpeg|ffprobe)(\.exe)?$|^(avcodec|avformat|avutil|swresample)-\d+\.dll$|^native-licenses\//i.test(path),
    ),
    `${id} declares a retired external media binary or native dependency`,
  );
  assert(
    target.nativeFiles?.length > 0,
    `${id} native file inventory is empty`,
  );
  for (const file of target.nativeFiles) {
    assert(
      target.runtimeFiles.includes(file),
      `${id} native file is not in runtime inventory: ${file}`,
    );
  }
  validateCandidate(id, target.validatedCandidate, target);
  validateRequirements(
    id,
    target.requirements,
    target.artifact !== null || target.validatedCandidate !== undefined,
  );
  assert(target.cefArchive === undefined, `${id} CEF archive must be retired`);
  if (target.artifact === null) {
    assert(target.blocker?.trim(), `${id} needs an explicit blocker`);
    continue;
  }
  validateArchive(target.artifact, `${id} artifact`);
  assert(target.artifact.format === "tar.gz", `${id} artifact must be tar.gz`);
  assert(
    target.artifact.sourceCommit === manifest.sourceCommit,
    `${id} artifact commit is incompatible`,
  );
  assert(!target.blocker, `${id} cannot have both an artifact and blocker`);
}

function validateCandidate(id, candidate, target) {
  if (candidate === undefined) return;
  assert(
    candidate && typeof candidate === "object" && !Array.isArray(candidate),
    `${id} validated candidate must be an object`,
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
  assert(
    !Object.keys(candidate).some((key) => !allowed.has(key)),
    `${id} validated candidate has an unsupported field or URL`,
  );
  assert(candidate.format === "tar.gz", `${id} candidate must be tar.gz`);
  assert(
    Number.isSafeInteger(candidate.size) && candidate.size > 0,
    `${id} candidate size is invalid`,
  );
  for (const key of [
    "sha256",
    "consumerEvidenceSha256",
    "hostRequirementsSha256",
  ])
    assert(
      typeof candidate[key] === "string" &&
        /^[a-f0-9]{64}$/.test(candidate[key]) &&
        !/^0+$/.test(candidate[key]),
      `${id} candidate ${key} is invalid`,
    );
  assert(
    typeof candidate.sourceCommit === "string" &&
      /^[a-f0-9]{40}$/.test(candidate.sourceCommit) &&
      !/^0+$/.test(candidate.sourceCommit),
    `${id} candidate source commit is invalid`,
  );
  assert(
    manifest.sourceCommit === null ||
      candidate.sourceCommit === manifest.sourceCommit,
    `${id} candidate source commit differs from manifest`,
  );
  for (const key of ["packageVersion", "nativeRendererVersion"])
    assert(
      candidate[key] === manifest[key],
      `${id} candidate ${key} differs from manifest`,
    );
  assert(
    candidate.protocolVersion === manifest.protocolVersion,
    `${id} candidate protocolVersion differs from manifest`,
  );
  assert(
    candidate.hostRequirementsSha256 ===
      requirementsSha256(target.requirements),
    `${id} candidate requirements hash differs`,
  );
  for (const key of ["name", "renderer", "root"])
    assert(
      typeof candidate[key] === "string" &&
        candidate[key].trim() &&
        !/[<>\0\r\n]/.test(candidate[key]),
      `${id} candidate ${key} is invalid`,
    );
  assert(
    typeof candidate.signed === "boolean",
    `${id} candidate signed missing`,
  );
  assert(
    target.requirements?.validationStatus === "validated",
    `${id} candidate requirements are not validated`,
  );
  if (target.artifact)
    for (const key of [
      "name",
      "format",
      "size",
      "sha256",
      "sourceCommit",
      "renderer",
      "root",
    ])
      assert(
        target.artifact[key] === candidate[key],
        `${id} artifact differs from candidate ${key}`,
      );
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

validateWindowsCandidate(manifest.targets["win32-x64"], windowsCandidate);

function validateRequirements(id, requirements, advertised) {
  assert(
    requirements && typeof requirements === "object",
    `${id} requirements missing`,
  );
  for (const key of [
    "captureBackends",
    "conversionBackends",
    "encoderBackends",
  ]) {
    assert(requirements[key]?.length > 0, `${id} ${key} is empty`);
  }
  if (advertised) {
    assert(
      requirements.validationStatus === "validated",
      `${id} requirements are unvalidated`,
    );
    assert(requirements.minimumOsVersion, `${id} minimum OS is missing`);
    if (id.startsWith("linux-")) {
      assert(
        requirements.minimumGlibcVersion,
        `${id} glibc baseline is missing`,
      );
    }
    if (requirements.softwareFallbackRequired) {
      assert(
        requirements.softwareFallbackImplemented,
        `${id} software fallback is missing`,
      );
    }
  }
}

function validateWindowsCandidate(target, candidate) {
  // This declaration records the private validation milestone, not publication.
  // Public artifacts are independently checked above and must not rewrite it.
  const expectedState = windowsCandidateState(
    target.artifact === null
      ? target
      : {
          ...target,
          artifact: null,
          requirements: {
            ...target.requirements,
            validationStatus:
              target.validatedCandidate === undefined ? "blocked" : "validated",
          },
        },
  );
  assert(
    candidate.schema === "velocast-windows-runtime-candidate-declaration-v1",
    "invalid Windows candidate declaration schema",
  );
  assert(
    candidate.status === expectedState.status,
    "Windows candidate status differs from acceptance evidence",
  );
  assert(candidate.target === "win32-x64", "Windows candidate target mismatch");
  assert(
    JSON.stringify(candidate.releaseState) ===
      JSON.stringify(expectedState.releaseState),
    "Windows candidate release state differs from acceptance evidence",
  );
  assert(
    JSON.stringify(candidate.validatedCandidate) ===
      JSON.stringify(expectedState.validatedCandidate),
    "Windows candidate identity differs from release manifest",
  );
  if (candidate.status === "validated-unpublished") {
    assert(
      candidate.inventory?.path,
      "validated Windows candidate inventory is missing",
    );
    const inventoryPath = resolve(repoRoot, candidate.inventory.path);
    const inventoryRelative = relative(repoRoot, inventoryPath);
    assert(
      !inventoryRelative.startsWith("..") && !isAbsolute(inventoryRelative),
      "validated Windows candidate inventory path escapes the repository",
    );
    const inventoryBytes = readFileSync(inventoryPath);
    assert(
      createHash("sha256").update(inventoryBytes).digest("hex") ===
        candidate.inventory.sha256,
      "validated Windows candidate inventory hash differs",
    );
    const inventory = JSON.parse(inventoryBytes);
    assert(
      inventory.browserHost === "electron" &&
        inventory.electronVersion === manifest.electronVersion &&
        inventory.sourceCommit === target.validatedCandidate.sourceCommit,
      "validated Windows candidate Electron provenance differs from release manifest",
    );
    assert(
      JSON.stringify(candidate.provenance) ===
        JSON.stringify({
          browserHost: inventory.browserHost,
          electronVersion: inventory.electronVersion,
          sourceCommit: inventory.sourceCommit,
        }),
      "validated Windows candidate provenance differs from inventory",
    );
    assert(
      JSON.stringify(candidate.runtimeFiles) ===
        JSON.stringify(
          [
            ...inventory.files.map((file) => file.path),
            "electron-runtime.json",
          ].sort((left, right) => left.localeCompare(right)),
        ),
      "validated Windows candidate runtime files differ from inventory",
    );
    assert(
      JSON.stringify(candidate.nativeFiles) ===
        JSON.stringify(
          inventory.files
            .map((file) => file.path)
            .filter((path) => /\.(exe|dll|node)$/i.test(path))
            .sort((left, right) => left.localeCompare(right)),
        ),
      "validated Windows candidate native files differ from inventory",
    );
  }
  assert(
    JSON.stringify(target.runtimeFiles) ===
      JSON.stringify(candidate.runtimeFiles),
    "win32-x64 runtime files differ from the audited candidate declaration",
  );
  assert(
    JSON.stringify(target.nativeFiles) ===
      JSON.stringify(candidate.nativeFiles),
    "win32-x64 native files differ from the audited candidate declaration",
  );
  for (const required of [
    "velocast-renderer.exe",
    "electron-host/media-client.cjs",
    "electron-host/media-runtime.cjs",
    "electron-host/node_modules/mediabunny/package.json",
    "electron-host/node_modules/mediabunny/LICENSE",
    "electron/electron.exe",
    "electron/LICENSE",
    "electron/LICENSES.chromium.html",
    "electron-host/main.cjs",
    "electron-host/profile-directory.cjs",
    "electron-runtime.json",
  ])
    assert(
      target.runtimeFiles.includes(required),
      `win32-x64 candidate file is missing: ${required}`,
    );
  assert(
    target.runtimeFiles.some((path) => path.startsWith("electron/locales/")),
    "win32-x64 candidate must declare Electron locale resources",
  );
  for (const path of target.runtimeFiles)
    assert(
      !/(^|\/)(src|include|cmake|debug)(\/|$)|\.(pdb|lib|obj)$/i.test(path),
      `win32-x64 candidate contains a development file: ${path}`,
    );
}

const supported = requiredTargets.filter(
  (id) => manifest.targets[id].artifact !== null,
);
process.stdout.write(
  `${JSON.stringify({ manifest: manifestPath, supported, blocked: requiredTargets.filter((id) => !supported.includes(id)) })}\n`,
);

function validateArchive(archive, label) {
  assert(archive && typeof archive === "object", `${label} is missing`);
  assert(
    typeof archive.url === "string" && archive.url.startsWith("https://"),
    `${label} URL must use HTTPS`,
  );
  assert(
    Number.isSafeInteger(archive.size) && archive.size > 0,
    `${label} size is invalid`,
  );
  assert(/^[a-f0-9]{64}$/.test(archive.sha256), `${label} SHA-256 is invalid`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`release.manifest_invalid: ${message}`);
  }
}
