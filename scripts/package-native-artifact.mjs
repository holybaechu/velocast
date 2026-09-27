import { createHash } from "node:crypto";
import {
  cpSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { create } from "tar";
import { verifyElectronRuntimeInventory } from "./verify-electron-runtime-inventory.mjs";
import { windowsCandidateState } from "./windows-candidate-state.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const [targetId, runtimeArgument, outputArgument] = process.argv.slice(2);
if (!targetId || !runtimeArgument || !outputArgument) {
  throw new Error(
    "usage: node scripts/package-native-artifact.mjs <target> <runtime-dir> <output.tar.gz>",
  );
}
const manifest = JSON.parse(
  readFileSync(join(repoRoot, "release", "velocast-release.json"), "utf8"),
);
const target = manifest.targets[targetId];
if (!target) {
  throw new Error(`artifact.unsupported_target: ${targetId}`);
}
if (targetId === "win32-x64") {
  const candidate = JSON.parse(
    readFileSync(
      join(repoRoot, "release", "windows-runtime-candidate.json"),
      "utf8",
    ),
  );
  if (
    candidate.status !== windowsCandidateState(target).status ||
    JSON.stringify(candidate.runtimeFiles) !==
      JSON.stringify(target.runtimeFiles) ||
    JSON.stringify(candidate.nativeFiles) !== JSON.stringify(target.nativeFiles)
  )
    throw new Error(
      "artifact.windows_candidate_mismatch: release manifest differs from audited candidate declaration",
    );
}
const runtimeDir = resolve(runtimeArgument);
const output = resolve(outputArgument);
assertOutsideRepo(output);
verifyNativeHost(targetId);
verifyReleaseCredentials(target.platform);

const renderer =
  target.platform === "win32"
    ? "velocast-renderer.exe"
    : target.platform === "darwin"
      ? target.runtimeFiles.find((file) => file.endsWith("/velocast-renderer"))
      : "velocast-renderer";
if (!renderer) {
  throw new Error(`artifact.runtime_invalid: no renderer path for ${targetId}`);
}
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
}).trim();
if (
  target.validatedCandidate &&
  target.validatedCandidate.sourceCommit !== commit
)
  throw new Error(
    "artifact.validated_candidate_stale: accepted evidence belongs to another commit",
  );
const files = target.runtimeFiles.map((path) => {
  const source = contained(runtimeDir, path);
  if (!existsSync(source) || !statSync(source).isFile()) {
    throw new Error(`artifact.runtime_missing: ${path}`);
  }
  return { path, size: statSync(source).size, sha256: sha256File(source) };
});
if (targetId === "win32-x64")
  verifyElectronRuntimeInventory(runtimeDir, files, {
    status:
      process.env.VELOCAST_RELEASE_MODE === "1"
        ? "prepared-release-candidate"
        : "unsigned-local-candidate",
    electronVersion: manifest.electronVersion,
    sourceCommit: commit,
  });
for (const nativeFile of target.nativeFiles) {
  verifyExecutableArchitecture(contained(runtimeDir, nativeFile), target.arch);
}
verifyReleaseSignature(target.platform, runtimeDir, renderer);

const inventory = {
  schema: "velocast-native-artifact-v1",
  target: targetId,
  sourceCommit: commit,
  packageVersion: manifest.packageVersion,
  nativeRendererVersion: manifest.nativeRendererVersion,
  protocolVersion: manifest.protocolVersion,
  files,
};
const staging = mkdtempSync(join(tmpdir(), `velocast-${targetId}-`));
const rootName = `velocast-${manifest.nativeRendererVersion}-${targetId}`;
const artifactRoot = join(staging, rootName);
try {
  for (const file of files) {
    mkdirSync(dirname(contained(artifactRoot, file.path)), { recursive: true });
    cpSync(
      contained(runtimeDir, file.path),
      contained(artifactRoot, file.path),
      {
        recursive: false,
        force: false,
      },
    );
  }
  writeFileSync(
    join(artifactRoot, "artifact-manifest.json"),
    `${JSON.stringify(inventory, null, 2)}\n`,
  );
  await create(
    {
      cwd: staging,
      file: output,
      gzip: { portable: true },
      mtime: new Date(0),
      portable: true,
      strict: true,
    },
    [rootName],
  );
  const evidence = {
    target: targetId,
    name: basename(output),
    format: "tar.gz",
    size: statSync(output).size,
    sha256: sha256File(output),
    sourceCommit: commit,
    renderer,
    root: rootName,
    unsigned: process.env.VELOCAST_RELEASE_MODE !== "1",
  };
  writeFileSync(`${output}.json`, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}

function verifyNativeHost(id) {
  const arch = process.arch;
  const platform = process.platform;
  const libc = platform === "linux" ? "-gnu" : "";
  const actual = `${platform}-${arch}${libc}`;
  if (actual !== id) {
    throw new Error(
      `artifact.native_runner_required: refusing to package ${id} on ${actual}`,
    );
  }
}

function verifyReleaseCredentials(platform) {
  if (process.env.VELOCAST_RELEASE_MODE !== "1") return;
  if (platform === "win32" && !process.env.VELOCAST_AUTHENTICODE_CERTIFICATE) {
    throw new Error(
      "release.credentials_missing: VELOCAST_AUTHENTICODE_CERTIFICATE",
    );
  }
  if (
    platform === "darwin" &&
    (!process.env.VELOCAST_APPLE_SIGNING_IDENTITY ||
      !process.env.VELOCAST_APPLE_NOTARY_PROFILE)
  ) {
    throw new Error(
      "release.credentials_missing: VELOCAST_APPLE_SIGNING_IDENTITY and VELOCAST_APPLE_NOTARY_PROFILE",
    );
  }
}

function verifyReleaseSignature(platform, root, renderer) {
  if (process.env.VELOCAST_RELEASE_MODE !== "1") return;
  if (platform === "win32") {
    const status = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `(Get-AuthenticodeSignature -LiteralPath '${contained(root, renderer).replaceAll("'", "''")}').Status`,
      ],
      { encoding: "utf8" },
    ).trim();
    if (status !== "Valid") {
      throw new Error(
        `release.signature_invalid: Authenticode status is ${status}`,
      );
    }
  }
  if (platform === "darwin") {
    const app = join(root, "Velocast Renderer.app");
    execFileSync("codesign", ["--verify", "--deep", "--strict", app], {
      stdio: "inherit",
    });
    execFileSync("xcrun", ["stapler", "validate", app], { stdio: "inherit" });
  }
}

function contained(root, child) {
  if (isAbsolute(child)) throw new Error(`artifact.path_invalid: ${child}`);
  const path = resolve(root, child);
  const rel = relative(resolve(root), path);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`artifact.path_invalid: ${child}`);
  }
  return path;
}

function assertOutsideRepo(path) {
  const rel = relative(repoRoot, path);
  if (!rel.startsWith("..") && !isAbsolute(rel)) {
    throw new Error(
      "artifact.output_invalid: release artifacts must be outside tracked source",
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

function verifyExecutableArchitecture(path, expected) {
  const bytes = readFileSync(path).subarray(0, 4096);
  let actual;
  if (bytes[0] === 0x7f && bytes.toString("ascii", 1, 4) === "ELF") {
    const machine = bytes.readUInt16LE(18);
    actual = machine === 0x3e ? "x64" : machine === 0xb7 ? "arm64" : undefined;
  } else if (bytes.toString("ascii", 0, 2) === "MZ") {
    const offset = bytes.readUInt32LE(0x3c);
    const machine = bytes.readUInt16LE(offset + 4);
    actual =
      machine === 0x8664 ? "x64" : machine === 0xaa64 ? "arm64" : undefined;
  } else if (bytes.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = bytes.readUInt32LE(4);
    actual =
      cpu === 0x01000007 ? "x64" : cpu === 0x0100000c ? "arm64" : undefined;
  }
  if (actual !== expected) {
    throw new Error(
      `artifact.wrong_architecture: ${path} is ${actual ?? "unknown"}, expected ${expected}`,
    );
  }
}
