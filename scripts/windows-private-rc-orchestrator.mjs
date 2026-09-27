import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SAFE_HOST_ENV = [
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
];
const FORBIDDEN_ENV = [
  "VELOCAST_RENDERER_BINARY",
  "VELOCAST_ARTIFACT_DIR",
  "VELOCAST_ARTIFACT_MANIFEST_SHA256",
  "CARGO_TARGET_DIR",
  "CEF_PATH",
  "VELOCAST_CEF_RUNTIME_DIR",
  "VELOCAST_LINUX_RENDERER_RUNTIME_DIR",
  "VELOCAST_LINUX_RENDERER_RUNTIME_SOURCE_DIR",
  "FFMPEG_PATH",
  "VCPKG_ROOT",
  "LIBCLANG_PATH",
];
const RESERVED_STEP_ENV = new Set(
  [
    ...FORBIDDEN_ENV,
    "PATH",
    "VELOCAST_RELEASE_MANIFEST",
    "VELOCAST_CACHE_DIR",
    "INIT_CWD",
    "VELOCAST_NEGATIVE_ATTEMPT_ROOT",
  ].map((name) => name.toLowerCase()),
);
const REQUIRED_NEGATIVES = new Set([
  "corrupt-archive",
  "corrupt-cache",
  "version-mismatch",
  "cancel-render",
  "offline-empty-cache",
]);

export async function runWindowsPrivateRc(
  manifest,
  options,
  dependencies = {},
) {
  validateManifest(manifest, options.execute === true);
  const stateDir = resolve(options.stateDir);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestSha256 = hash(manifestBytes);
  if (!options.execute) {
    return {
      status: "prepared-not-executed",
      manifestSha256,
      steps: manifest.steps.map(({ id, kind, scope, videoRole }) => ({
        id,
        kind,
        scope,
        ...(videoRole ? { videoRole } : {}),
      })),
    };
  }
  mkdirSync(stateDir, { recursive: true });
  const evidenceDir = join(stateDir, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const statePath = join(stateDir, "state.json");
  const state = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, "utf8"))
    : {
        schema: "velocast-windows-private-rc-state-v1",
        status: "running",
        manifestSha256,
        startedAt: now(dependencies),
        steps: {},
      };
  if (
    state.schema !== "velocast-windows-private-rc-state-v1" ||
    state.manifestSha256 !== manifestSha256
  )
    throw new Error(
      "private_rc.resume_manifest_changed: use a new state directory",
    );
  const run = dependencies.run ?? runCommand;
  for (const [index, step] of manifest.steps.entries()) {
    const fingerprint = hash(
      Buffer.from(
        JSON.stringify({
          step,
          environment: environmentFor(manifest, step, options.hostEnv ?? process.env),
        }),
      ),
    );
    let prior = state.steps[step.id];
    if (prior?.status === "complete") {
      if (prior.fingerprint !== fingerprint)
        throw new Error(`private_rc.resume_step_changed: ${step.id}`);
      try {
        verifyOutputRecords(prior.outputs);
      } catch (error) {
        recordResumeFailure(stateDir, step.id, error, dependencies);
        throw error;
      }
      continue;
    }
    if (prior?.status === "running" || prior?.status === "verifying") {
      const interrupted = prior.attempts?.at(-1);
      if (
        interrupted &&
        ["reserved", "running", "exited", "verifying"].includes(
          interrupted.status,
        )
      ) {
        interrupted.status = "interrupted";
        interrupted.finishedAt = now(dependencies);
        interrupted.error = "orchestrator resumed an unfinished attempt";
      }
      prior.status = "interrupted";
      prior.finishedAt = now(dependencies);
      state.status = "running";
      atomicJson(statePath, state);
    }
    const attempt = (prior?.attempts?.length ?? 0) + 1;
    const stepDir = join(evidenceDir, `${String(index + 1).padStart(2, "0")}-${step.id}`);
    mkdirSync(stepDir, { recursive: true });
    const stdoutPath = join(stepDir, `attempt-${attempt}.stdout.txt`);
    const stderrPath = join(stepDir, `attempt-${attempt}.stderr.txt`);
    const requestPath = join(stepDir, `attempt-${attempt}.request.json`);
    if (existsSync(stdoutPath) || existsSync(stderrPath) || existsSync(requestPath))
      throw new Error(`private_rc.evidence_exists: ${step.id}/${attempt}`);
    let negativeRoot;
    if (step.negative?.disposableRoot) {
      negativeRoot = contained(
        join(stateDir, "negative"),
        join(step.negative.disposableRoot, `attempt-${attempt}`),
      );
      if (existsSync(negativeRoot))
        throw new Error(`private_rc.evidence_exists: ${negativeRoot}`);
      mkdirSync(negativeRoot, { recursive: true });
    }
    const attemptStartedAt = now(dependencies);
    const attemptRecord = {
      attempt,
      status: "reserved",
      startedAt: attemptStartedAt,
      ...(negativeRoot ? { negativeRoot } : {}),
    };
    state.status = "running";
    state.steps[step.id] = {
      status: "running",
      fingerprint,
      attempts: [...(prior?.attempts ?? []), attemptRecord],
      startedAt: prior?.startedAt ?? attemptStartedAt,
    };
    atomicJson(statePath, state);
    const request = {
      id: step.id,
      argv: step.argv,
      cwd: step.cwd,
      env: environmentFor(manifest, step, options.hostEnv ?? process.env),
      timeoutMs: step.timeoutMs ?? manifest.defaultTimeoutMs ?? 30 * 60_000,
    };
    if (negativeRoot) {
      request.env.VELOCAST_NEGATIVE_ATTEMPT_ROOT = negativeRoot;
      if (step.negative.cacheRoot) {
        const cacheRoot = contained(negativeRoot, step.negative.cacheRoot);
        mkdirSync(cacheRoot, { recursive: true });
        request.env.VELOCAST_CACHE_DIR = cacheRoot;
      }
    }
    writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, {
      flag: "wx",
    });
    attemptRecord.status = "running";
    attemptRecord.request = evidenceRecord(requestPath);
    atomicJson(statePath, state);
    let result;
    try {
      result = await run(request);
    } catch (error) {
      result = {
        exitCode: 1,
        stdout: "",
        stderr: error instanceof Error ? error.stack ?? error.message : String(error),
        runnerError: true,
      };
    }
    writeFileSync(stdoutPath, result.stdout ?? "", { flag: "wx" });
    writeFileSync(stderrPath, result.stderr ?? "", { flag: "wx" });
    attemptRecord.status = "exited";
    attemptRecord.finishedAt = now(dependencies);
    attemptRecord.exitCode = result.exitCode;
    attemptRecord.stdout = evidenceRecord(stdoutPath);
    attemptRecord.stderr = evidenceRecord(stderrPath);
    if (result.runnerError) attemptRecord.runnerError = true;
    if (result.timedOut) attemptRecord.timedOut = true;
    if (result.outputLimitExceeded) attemptRecord.outputLimitExceeded = true;
    atomicJson(statePath, state);
    if (result.exitCode !== 0) {
      attemptRecord.status = "failed";
      state.steps[step.id].status = "failed";
      state.steps[step.id].finishedAt = attemptRecord.finishedAt;
      state.status = "failed";
      atomicJson(statePath, state);
      throw new Error(
        `private_rc.command_failed: ${step.id} exited ${result.exitCode}`,
      );
    }
    attemptRecord.status = "verifying";
    state.steps[step.id].status = "verifying";
    atomicJson(statePath, state);
    let outputs;
    try {
      outputs = step.outputs.map((path) => evidenceRecord(path));
    } catch (error) {
      attemptRecord.status = "output-verification-failed";
      attemptRecord.error =
        error instanceof Error ? error.message : String(error);
      state.steps[step.id].status = "failed";
      state.steps[step.id].finishedAt = now(dependencies);
      state.status = "failed";
      atomicJson(statePath, state);
      throw new Error(
        `private_rc.output_verification_failed: ${step.id}: ${attemptRecord.error}`,
        { cause: error },
      );
    }
    attemptRecord.status = "complete";
    state.steps[step.id] = {
      ...state.steps[step.id],
      status: "complete",
      finishedAt: attemptRecord.finishedAt,
      outputs,
    };
    atomicJson(statePath, state);
  }
  if (state.status !== "complete") {
    state.status = "complete";
    state.finishedAt = now(dependencies);
    atomicJson(statePath, state);
  }
  finalizeStateEvidence(stateDir, state);
  return state;
}

export function validateManifest(manifest, executing = false) {
  if (
    !manifest ||
    manifest.schema !== "velocast-windows-private-rc-run-v1" ||
    manifest.target !== "win32-x64" ||
    !Array.isArray(manifest.steps) ||
    !manifest.steps.length
  )
    throw new Error("private_rc.manifest_invalid");
  if (
    manifest.publication?.upload !== false ||
    manifest.publication?.publicRelease !== false ||
    manifest.publication?.supportedManifestFlip !== false
  )
    throw new Error("private_rc.publication_forbidden");
  if (executing && manifest.status !== "ready-private-rc")
    throw new Error("private_rc.inputs_not_ready");
  const ids = new Set();
  const scopes = new Set();
  const videos = new Set();
  const negatives = new Set();
  for (const step of manifest.steps) {
    if (
      !step ||
      typeof step.id !== "string" ||
      ids.has(step.id) ||
      !Array.isArray(step.argv) ||
      !step.argv.length ||
      step.argv.some((value) => typeof value !== "string" || !value) ||
      !isAbsolute(step.cwd) ||
      !Array.isArray(step.outputs) ||
      step.outputs.some((path) => !isAbsolute(path))
    )
      throw new Error(`private_rc.step_invalid: ${step?.id ?? "unknown"}`);
    if (!/^[a-z0-9][a-z0-9._-]{0,80}$/.test(step.id))
      throw new Error(`private_rc.step_id_invalid: ${step.id}`);
    const timeoutMs = step.timeoutMs ?? manifest.defaultTimeoutMs ?? 30 * 60_000;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1_000 ||
      timeoutMs > 24 * 60 * 60_000
    )
      throw new Error(`private_rc.timeout_invalid: ${step.id}`);
    for (const name of Object.keys(step.env ?? {}))
      if (RESERVED_STEP_ENV.has(name.toLowerCase()))
        throw new Error(`private_rc.environment_override_forbidden: ${name}`);
    if (["upload", "publish", "support-flip"].includes(step.kind))
      throw new Error(`private_rc.publication_step_forbidden: ${step.id}`);
    ids.add(step.id);
    if (step.scope === "npm" || step.scope === "pnpm") scopes.add(step.scope);
    if (step.videoRole) videos.add(step.videoRole);
    if (step.negative) {
      negatives.add(step.negative.case);
      if (
        !step.negative.disposableRoot ||
        isAbsolute(step.negative.disposableRoot) ||
        relative(".", step.negative.disposableRoot).startsWith("..")
      )
        throw new Error(`private_rc.negative_scope_invalid: ${step.id}`);
      if (
        step.negative.cacheRoot !== undefined &&
        (typeof step.negative.cacheRoot !== "string" ||
          !step.negative.cacheRoot ||
          isAbsolute(step.negative.cacheRoot) ||
          relative(".", step.negative.cacheRoot).startsWith(".."))
      )
        throw new Error(`private_rc.negative_cache_invalid: ${step.id}`);
    }
  }
  for (const scope of ["npm", "pnpm"])
    if (!scopes.has(scope))
      throw new Error(`private_rc.package_manager_missing: ${scope}`);
  for (const role of ["original-lyrics", "clip-caption-music"])
    if (!videos.has(role)) throw new Error(`private_rc.video_missing: ${role}`);
  for (const negative of REQUIRED_NEGATIVES)
    if (!negatives.has(negative))
      throw new Error(`private_rc.negative_missing: ${negative}`);
}

export function environmentFor(manifest, step, hostEnv) {
  const env = {};
  for (const name of SAFE_HOST_ENV)
    if (hostEnv[name] !== undefined) env[name] = hostEnv[name];
  const path =
    step.environment === "install"
      ? manifest.environment.installPath
      : manifest.environment.minimalPath;
  env.PATH = path;
  env.VELOCAST_RELEASE_MANIFEST = manifest.environment.releaseManifest;
  env.VELOCAST_CACHE_DIR = manifest.environment.cacheRoot;
  env.INIT_CWD = step.cwd;
  for (const [name, value] of Object.entries(step.env ?? {})) env[name] = value;
  for (const name of Object.keys(env))
    if (FORBIDDEN_ENV.some((forbidden) => forbidden.toLowerCase() === name.toLowerCase()))
      delete env[name];
  return env;
}

function runCommand(input) {
  return new Promise((resolveRun, reject) => {
    const batch =
      process.platform === "win32" && /\.(?:cmd|bat)$/i.test(input.argv[0]);
    const executable = batch
      ? (process.env.ComSpec ?? join(process.env.SystemRoot, "System32", "cmd.exe"))
      : input.argv[0];
    const args = batch
      ? ["/d", "/c", "call", ...input.argv]
      : input.argv.slice(1);
    const child = spawn(executable, args, {
      cwd: input.cwd,
      env: input.env,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let outputLimitExceeded = false;
    let stopping = false;
    const maxOutputBytes = 64 * 1024 * 1024;
    const collect = (target, chunk) => {
      const next = target + String(chunk);
      if (Buffer.byteLength(next) > maxOutputBytes) {
        outputLimitExceeded = true;
        if (!stopping) void stopTree("output limit exceeded");
        return next.slice(0, maxOutputBytes);
      }
      return next;
    };
    child.stdout.on("data", (chunk) => (stdout = collect(stdout, chunk)));
    child.stderr.on("data", (chunk) => (stderr = collect(stderr, chunk)));
    const timeout = setTimeout(() => {
      timedOut = true;
      void stopTree(`timeout after ${input.timeoutMs}ms`);
    }, input.timeoutMs);
    const joined = new Promise((resolveJoined) =>
      child.once("close", (code, signal) =>
        resolveJoined({ code, signal }),
      ),
    );
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    joined.then(({ code, signal }) => {
      clearTimeout(timeout);
      resolveRun({
        exitCode:
          timedOut || outputLimitExceeded ? 124 : (code ?? (signal ? 1 : 0)),
        stdout,
        stderr,
        timedOut,
        outputLimitExceeded,
      });
    });

    async function stopTree(reason) {
      if (stopping) return;
      stopping = true;
      stderr += `${stderr ? "\n" : ""}private_rc.terminated: ${reason}\n`;
      await terminateProcessTree(child);
      let joinTimer;
      const outcome = await Promise.race([
        joined.then(() => "joined"),
        new Promise(
          (resolveWait) =>
            (joinTimer = setTimeout(() => resolveWait("timeout"), 10_000)),
        ),
      ]);
      clearTimeout(joinTimer);
      if (outcome !== "joined") {
        child.kill("SIGKILL");
        reject(new Error("private_rc.process_tree_join_timeout"));
      }
    }
  });
}

/** Test seam for bounded real child-process termination; production orchestration
 * uses the same runner when no injected runner is supplied. */
export function runCommandForTest(input) {
  return runCommand(input);
}

async function terminateProcessTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await new Promise((resolveTree) => {
      const killer = spawn(
        "taskkill.exe",
        ["/pid", String(child.pid), "/t", "/f"],
        { windowsHide: true, stdio: "ignore" },
      );
      killer.once("error", () => {
        child.kill("SIGKILL");
        resolveTree();
      });
      killer.once("close", () => resolveTree());
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  try {
    process.kill(-child.pid, 0);
    process.kill(-child.pid, "SIGKILL");
  } catch {
    /* The process group already exited. */
  }
}

function recordResumeFailure(stateDir, stepId, error, dependencies) {
  const directory = join(stateDir, "resume-failures");
  mkdirSync(directory, { recursive: true });
  let attempt = 1;
  let path;
  do {
    path = join(directory, `${stepId}-attempt-${attempt}.json`);
    attempt += 1;
  } while (existsSync(path));
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        stepId,
        observedAt: now(dependencies),
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  );
}

function evidenceRecord(path) {
  if (!existsSync(path) || !statSync(path).isFile())
    throw new Error(`private_rc.evidence_missing: ${path}`);
  const bytes = readFileSync(path);
  return { path: resolve(path), bytes: bytes.length, sha256: hash(bytes) };
}

function verifyOutputRecords(records) {
  for (const record of records ?? []) {
    const actual = evidenceRecord(record.path);
    if (actual.bytes !== record.bytes || actual.sha256 !== record.sha256)
      throw new Error(`private_rc.resume_output_changed: ${record.path}`);
  }
}

function contained(root, child) {
  const absoluteRoot = resolve(root);
  const path = resolve(absoluteRoot, child);
  const rel = relative(absoluteRoot, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new Error(`private_rc.negative_scope_invalid: ${child}`);
  return path;
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  renameSync(temporary, path);
}

function finalizeStateEvidence(stateDir, state) {
  const path = join(stateDir, "state.final.json");
  const shaPath = join(stateDir, "state.final.sha256");
  const bytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
  const digest = hash(bytes);
  if (existsSync(path) || existsSync(shaPath)) {
    if (
      !existsSync(path) ||
      !existsSync(shaPath) ||
      hash(readFileSync(path)) !== digest ||
      readFileSync(shaPath, "utf8").trim() !== `${digest}  state.final.json`
    )
      throw new Error("private_rc.final_evidence_changed");
    return;
  }
  writeFileSync(path, bytes, { flag: "wx" });
  writeFileSync(shaPath, `${digest}  state.final.json\n`, { flag: "wx" });
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function now(dependencies) {
  return dependencies.now?.() ?? new Date().toISOString();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.manifest || !args.state)
    throw new Error(
      "usage: node scripts/windows-private-rc-orchestrator.mjs --manifest <run.json> --state <directory> [--execute]",
    );
  const manifest = JSON.parse(readFileSync(resolve(args.manifest), "utf8"));
  const result = await runWindowsPrivateRc(manifest, {
    stateDir: resolve(args.state),
    execute: args.execute === true,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--execute") result.execute = true;
    else if (value?.startsWith("--")) result[value.slice(2)] = values[++index];
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
