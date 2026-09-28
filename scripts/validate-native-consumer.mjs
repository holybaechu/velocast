import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { release as osRelease, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const [targetId, archiveArgument, evidenceArgument] = process.argv.slice(2);
if (!targetId || !archiveArgument || !evidenceArgument) {
  throw new Error(
    "usage: validate-native-consumer.mjs <target> <artifact> <evidence-dir>",
  );
}
const archive = resolve(archiveArgument);
const evidenceDir = resolve(evidenceArgument);
const artifactEvidence = JSON.parse(readFileSync(`${archive}.json`, "utf8"));
const candidate = JSON.parse(
  readFileSync(join(repoRoot, "release", "velocast-release.json"), "utf8"),
);
candidate.sourceCommit = artifactEvidence.sourceCommit;
candidate.releaseChannel = "native-dry-run";
candidate.targets[targetId].artifact = {
  ...artifactEvidence,
  url: pathToFileURL(archive).toString(),
};
delete candidate.targets[targetId].artifact.target;
delete candidate.targets[targetId].artifact.unsigned;
candidate.targets[targetId].blocker = null;
const hostRequirements = resolvedHostRequirements(
  targetId,
  candidate.targets[targetId].requirements,
);
candidate.targets[targetId].requirements = hostRequirements;
const candidatePath = join(evidenceDir, `${targetId}-candidate-manifest.json`);
writeFileSync(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);

const campaign = mkdtempSync(join(tmpdir(), `velocast-consumer-${targetId}-`));
const packs = join(campaign, "packs");
mkdirSync(packs, { recursive: true });
const results = [];
try {
  await run(pnpm(), ["build"], repoRoot);
  await run(
    process.execPath,
    [join(repoRoot, "scripts", "pack-public-packages.mjs"), packs],
    repoRoot,
  );
  const tarballs = readdirSync(packs).filter((name) => name.endsWith(".tgz"));
  const core = only(tarballs, "velocast-core-");
  const gsapPackage = only(tarballs, "velocast-gsap-");
  const cli = only(tarballs, "velocast-0");
  await run(
    process.execPath,
    [
      join(repoRoot, "scripts", "audit-package-tarballs.mjs"),
      ...tarballs.map((name) => join(packs, name)),
    ],
    repoRoot,
  );
  for (const name of tarballs) {
    cpSync(join(packs, name), join(evidenceDir, `${targetId}-${name}`));
  }
  writeFileSync(
    join(evidenceDir, `${targetId}-package-audit.json`),
    `${JSON.stringify({ status: "PASS", packages: tarballs.sort() }, null, 2)}\n`,
  );

  for (const manager of ["npm", "pnpm"]) {
    const consumer = join(campaign, manager);
    cpSync(join(repoRoot, "apps", "playground"), consumer, { recursive: true });
    const indexPath = join(consumer, "index.html");
    writeFileSync(
      indexPath,
      readFileSync(indexPath, "utf8").replace(
        "../../packages/gsap/browser/velocast-gsap.global.js",
        "./node_modules/@velocast/gsap/browser/velocast-gsap.global.js",
      ),
    );
    const packageJson = {
      name: `velocast-consumer-${manager}`,
      private: true,
      type: "module",
    };
    if (manager === "pnpm") {
      packageJson.dependencies = {
        velocast: fileSpec(join(packs, cli)),
        "@velocast/core": fileSpec(join(packs, core)),
        "@velocast/gsap": fileSpec(join(packs, gsapPackage)),
        gsap: "3.15.0",
      };
      writeFileSync(
        join(consumer, "pnpm-workspace.yaml"),
        `packages:\n  - '.'\noverrides:\n  '@velocast/core': '${fileSpec(join(packs, core))}'\n`,
      );
    }
    writeFileSync(
      join(consumer, "package.json"),
      `${JSON.stringify(packageJson, null, 2)}\n`,
    );
    const installArgs =
      manager === "npm"
        ? [
            "install",
            "--ignore-scripts",
            join(packs, cli),
            join(packs, core),
            join(packs, gsapPackage),
            "gsap@3.15.0",
          ]
        : ["install", "--ignore-scripts"];
    await run(managerCommand(manager), installArgs, consumer);
    await run(
      process.execPath,
      [
        "-e",
        "await Promise.all([import('velocast'), import('@velocast/core'), import('@velocast/core/testing'), import('@velocast/gsap')])",
      ],
      consumer,
    );

    const cache = join(campaign, `${manager}-cache`);
    const env = {
      ...process.env,
      VELOCAST_CACHE_DIR: cache,
      VELOCAST_RELEASE_MANIFEST: candidatePath,
    };
    await Promise.all([
      cliRun(manager, consumer, ["setup", "--json"], env),
      cliRun(manager, consumer, ["setup", "--json"], env),
    ]);
    await cliRun(manager, consumer, ["setup", "--json"], env);
    await cliRun(manager, consumer, ["versions", "--json"], env);
    await cliRun(manager, consumer, ["doctor", "--json"], env);
    const offlineEnv = { ...env, VELOCAST_OFFLINE: "1" };
    await cliRun(manager, consumer, ["setup", "--json"], offlineEnv);

    const output = join(evidenceDir, `${manager}-${targetId}.mp4`);
    const report = join(evidenceDir, `${manager}-${targetId}-report.json`);
    await cliRun(
      manager,
      consumer,
      [
        "render",
        "product-hero",
        "--config",
        "velocast.config.ts",
        "--output",
        output,
        "--report",
        report,
      ],
      offlineEnv,
    );
    results.push({ manager, consumer, output, report });
  }

  const repeat = join(evidenceDir, `pnpm-${targetId}-repeat.mp4`);
  const repeatReport = join(evidenceDir, `pnpm-${targetId}-repeat-report.json`);
  const pnpmResult = results.find((result) => result.manager === "pnpm");
  const repeatEnv = {
    ...process.env,
    VELOCAST_CACHE_DIR: join(campaign, "pnpm-cache"),
    VELOCAST_RELEASE_MANIFEST: candidatePath,
    VELOCAST_OFFLINE: "1",
  };
  await cliRun(
    "pnpm",
    pnpmResult.consumer,
    [
      "render",
      "product-hero",
      "--config",
      "velocast.config.ts",
      "--output",
      repeat,
      "--report",
      repeatReport,
    ],
    repeatEnv,
  );
  const preferredSoftware = join(evidenceDir, `pnpm-${targetId}-software.mp4`);
  const preferredSoftwareReport = join(evidenceDir, `pnpm-${targetId}-software-report.json`);
  await cliRun("pnpm", pnpmResult.consumer, [
    "render", "product-hero", "--config", "velocast.config.ts",
    "--acceleration", "off", "--output", preferredSoftware,
    "--report", preferredSoftwareReport,
  ], repeatEnv);
  for (const result of results) {
    const args = [
      join(repoRoot, "scripts", "verify-consumer-render.mjs"),
      "--video",
      result.output,
      "--report",
      result.report,
      "--target",
      targetId,
    ];
    if (result.manager === "pnpm") args.push("--compare", repeat);
    await run(process.execPath, args, repoRoot);
  }
  await run(process.execPath, [join(repoRoot, "scripts", "verify-consumer-render.mjs"),
    "--video", preferredSoftware, "--report", preferredSoftwareReport, "--target", targetId], repoRoot);
  const validation = {
    target: targetId,
    packageManagers: ["npm", "pnpm"],
    frames: 240,
    hostRequirements,
    scenarios: {
      scriptsDisabled: true,
      freshSetup: true,
      cachedSetup: true,
      offlineSetup: true,
      concurrentSetup: true,
      npmRender: true,
      pnpmRender: true,
      deterministicRepeat: true,
      softwarePreference: true,
    },
    status: "PASS",
  };
  writeFileSync(
    join(evidenceDir, `${targetId}-consumer-validation.json`),
    `${JSON.stringify(validation, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(validation)}\n`);
} finally {
  if (process.env.VELOCAST_KEEP_CONSUMER_TEMP !== "1") {
    rmSync(campaign, { recursive: true, force: true });
  }
}

async function cliRun(manager, cwd, args, env) {
  await run(managerCommand(manager), ["exec", "velocast", ...args], cwd, env);
}

async function run(file, args, cwd, env = process.env) {
  const result = await exec(file, args, {
    cwd,
    env,
    maxBuffer: 16 * 1024 * 1024,
    shell: process.platform === "win32" && file.endsWith(".cmd"),
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function only(names, prefix) {
  const matches = names.filter((name) => basename(name).startsWith(prefix));
  if (matches.length !== 1)
    throw new Error(
      `consumer.pack_invalid: expected one ${prefix} tarball, got ${matches}`,
    );
  return matches[0];
}

function managerCommand(manager) {
  return process.platform === "win32" ? `${manager}.cmd` : manager;
}

function fileSpec(path) {
  return `file:${path.replaceAll("\\", "/")}`;
}

function pnpm() {
  return managerCommand("pnpm");
}

function resolvedHostRequirements(target, requirements) {
  const minimumOsVersion =
    process.env.VELOCAST_RELEASE_MINIMUM_OS_VERSION ??
    requirements.minimumOsVersion ??
    hostOsVersion();
  const minimumGlibcVersion = target.startsWith("linux-")
    ? (process.env.VELOCAST_RELEASE_MINIMUM_GLIBC_VERSION ??
      process.report?.getReport()?.header?.glibcVersionRuntime)
    : null;
  if (
    !minimumOsVersion ||
    (target.startsWith("linux-") && !minimumGlibcVersion)
  ) {
    throw new Error(
      `consumer.requirements_missing: machine-readable minimum host baseline for ${target}`,
    );
  }
  return {
    ...requirements,
    validationStatus: "validated",
    minimumOsVersion,
    minimumGlibcVersion,
  };
}

function hostOsVersion() {
  if (process.platform === "darwin") {
    return readCommand("sw_vers", ["-productVersion"]);
  }
  return osRelease();
}

function readCommand(file, args) {
  return execFileSync(file, args, { encoding: "utf8" }).trim();
}
