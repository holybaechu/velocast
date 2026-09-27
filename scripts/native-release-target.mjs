import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { withDllSearchPath } from "./electron-runtime-package.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const [command, targetId] = process.argv.slice(2);
const manifest = JSON.parse(
  readFileSync(join(repoRoot, "release", "velocast-release.json"), "utf8"),
);
const target = manifest.targets[targetId];
if (!target) throw new Error(`release.unsupported_target: ${targetId}`);
verifyNativeRunner(targetId);
const evidence = process.env.VELOCAST_RELEASE_EVIDENCE;
if (!evidence) {
  throw new Error("release.configuration_missing: VELOCAST_RELEASE_EVIDENCE");
}
mkdirSync(evidence, { recursive: true });

switch (command) {
  case "build":
    buildTarget(targetId, target, evidence);
    break;
  case "package":
    packageTarget(targetId, evidence);
    break;
  case "validate":
    validateTarget(targetId, evidence);
    break;
  default:
    throw new Error(
      "usage: native-release-target.mjs <build|package|validate> <target>",
    );
}

function buildTarget(id, metadata, evidenceDir) {
  if (id !== "win32-x64") {
    throw new Error(`release.platform_blocked: ${id}: ${metadata.blocker}`);
  }
  const vcpkgRoot = process.env.VCPKG_ROOT ?? join(repoRoot, ".tools", "vcpkg");
  const targetDirectory = join(repoRoot, "target", "electron");
  const dllDirs = [
    join(vcpkgRoot, "installed", "x64-windows", "bin"),
    join(process.env.SystemRoot ?? "C:\\Windows", "System32"),
  ];
  run("pwsh", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(repoRoot, "scripts", "setup-accelerated-rendering.ps1"),
    "-VcpkgRoot",
    vcpkgRoot,
  ]);
  run("pwsh", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(repoRoot, "scripts", "build-electron-renderer.ps1"),
    "-VcpkgRoot",
    vcpkgRoot,
    "-TargetDirectory",
    targetDirectory,
  ]);
  const source = join(targetDirectory, "release");
  const runtime = join(evidenceDir, "runtime");
  const renderer = join(source, "velocast-renderer.exe");
  if (!existsSync(renderer)) {
    throw new Error(`release.runtime_staging_failed: ${source}`);
  }
  signWindowsRenderer(renderer);
  const requireElectron = createRequire(
    join(repoRoot, "packages", "electron-host", "package.json"),
  );
  const electron = dirname(requireElectron("electron"));
  const ffmpeg = mediaBinary("VELOCAST_FFMPEG_BINARY", "ffmpeg.exe");
  const ffprobe = mediaBinary("VELOCAST_FFPROBE_BINARY", "ffprobe.exe");
  const licenses =
    process.env.VELOCAST_NATIVE_LICENSES_DIR ??
    join(vcpkgRoot, "installed", "x64-windows", "share");
  if (!existsSync(licenses))
    throw new Error(
      "release.configuration_missing: native dependency license directory",
    );
  run(
    process.execPath,
    [
      join(repoRoot, "scripts", "package-electron-runtime.mjs"),
      "--renderer",
      renderer,
      "--electron",
      electron,
      "--ffmpeg",
      ffmpeg,
      "--ffprobe",
      ffprobe,
      ...dllDirs.flatMap((directory) => ["--dll-dir", directory]),
      "--licenses",
      licenses,
      "--output",
      runtime,
    ],
    withDllSearchPath(dllDirs),
  );
  process.stdout.write(`${JSON.stringify({ target: id, runtime })}\n`);
}

function mediaBinary(variable, name) {
  if (process.env[variable]) return process.env[variable];
  const found = execFileSync("where.exe", [name], {
    encoding: "utf8",
    windowsHide: true,
  })
    .split(/\r?\n/)
    .find(Boolean)
    ?.trim();
  if (!found) throw new Error(`release.configuration_missing: ${variable}`);
  return found;
}

function signWindowsRenderer(renderer) {
  if (process.env.VELOCAST_RELEASE_MODE !== "1") return;
  const certificate = process.env.VELOCAST_AUTHENTICODE_CERTIFICATE;
  if (!certificate) {
    throw new Error(
      "release.credentials_missing: VELOCAST_AUTHENTICODE_CERTIFICATE",
    );
  }
  const args = [
    "sign",
    "/fd",
    "SHA256",
    "/tr",
    process.env.VELOCAST_AUTHENTICODE_TIMESTAMP_URL ??
      "http://timestamp.digicert.com",
    "/td",
    "SHA256",
    "/f",
    certificate,
  ];
  if (process.env.VELOCAST_AUTHENTICODE_PASSWORD) {
    args.push("/p", process.env.VELOCAST_AUTHENTICODE_PASSWORD);
  }
  args.push(renderer);
  run("signtool.exe", args);
}

function packageTarget(id, evidenceDir) {
  const runtime = join(evidenceDir, "runtime");
  const archive = join(evidenceDir, `${id}.tar.gz`);
  run(process.execPath, [
    join(repoRoot, "scripts", "package-native-artifact.mjs"),
    id,
    runtime,
    archive,
  ]);
}

function validateTarget(id, evidenceDir) {
  const archive = join(evidenceDir, `${id}.tar.gz`);
  if (!existsSync(archive)) {
    throw new Error(`release.artifact_missing: ${archive}`);
  }
  run(process.execPath, [
    join(repoRoot, "scripts", "validate-native-consumer.mjs"),
    id,
    archive,
    evidenceDir,
  ]);
}

function verifyNativeRunner(id) {
  const actual = `${process.platform}-${process.arch}${process.platform === "linux" ? "-gnu" : ""}`;
  if (id !== actual) {
    throw new Error(
      `release.native_runner_required: expected ${id}, got ${actual}`,
    );
  }
}

function run(file, args, environment = process.env) {
  execFileSync(file, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: environment,
    shell: process.platform === "win32" && file.endsWith(".cmd"),
  });
}
