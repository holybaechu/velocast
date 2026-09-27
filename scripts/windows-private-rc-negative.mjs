import { spawn } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [scenario, ...rawArgs] = process.argv.slice(2);
const args = parseArgs(rawArgs);
for (const name of ["cli", "manifest", "artifact", "output"])
  if (!args[name]) throw new Error(`missing --${name}`);
const root = process.env.VELOCAST_NEGATIVE_ATTEMPT_ROOT;
const cache = process.env.VELOCAST_CACHE_DIR;
if (!root || !cache)
  throw new Error(
    "VELOCAST_NEGATIVE_ATTEMPT_ROOT and schema-owned VELOCAST_CACHE_DIR are required",
  );
mkdirSync(root, { recursive: true });
mkdirSync(cache, { recursive: true });
const cli = resolve(args.cli);
const baseManifest = JSON.parse(readFileSync(resolve(args.manifest), "utf8"));
let result;
switch (scenario) {
  case "corrupt-archive":
    result = await corruptArchive();
    break;
  case "corrupt-cache":
    result = await corruptCache();
    break;
  case "version-mismatch":
    result = await versionMismatch();
    break;
  case "offline-empty-cache":
    result = await expectSetupFailure(
      { ...process.env, VELOCAST_OFFLINE: "1" },
      /artifact\.offline_missing/,
    );
    break;
  case "cancel-render":
    result = await cancelRender();
    break;
  default:
    throw new Error(`unsupported negative scenario: ${scenario}`);
}
writeFileSync(
  resolve(args.output),
  `${JSON.stringify({ scenario, status: "PASS", root, cache, ...result }, null, 2)}\n`,
);

async function corruptArchive() {
  const corrupt = join(root, "corrupt.tar.gz");
  copyFileSync(resolve(args.artifact), corrupt);
  const bytes = readFileSync(corrupt);
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  writeFileSync(corrupt, bytes);
  const manifest = derivedManifest((target) => {
    target.artifact.url = pathToFileURL(corrupt).href;
  });
  return expectSetupFailure(
    { ...process.env, VELOCAST_RELEASE_MANIFEST: manifest },
    /artifact\.(checksum|size)_mismatch/,
  );
}

async function versionMismatch() {
  const manifest = derivedManifest((target, derived) => {
    derived.sourceCommit = "0".repeat(40);
    target.artifact.sourceCommit = "0".repeat(40);
  });
  return expectSetupFailure(
    { ...process.env, VELOCAST_RELEASE_MANIFEST: manifest },
    /artifact\.compatibility_mismatch/,
  );
}

async function corruptCache() {
  if (!args["valid-cache"])
    throw new Error("corrupt-cache requires --valid-cache");
  cpSync(resolve(args["valid-cache"]), cache, { recursive: true });
  const inventoryPath = walk(cache).find((path) => path.endsWith("artifact-manifest.json"));
  if (!inventoryPath) throw new Error("valid cache has no artifact-manifest.json");
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  const renderer = inventory.files.find((file) => file.path === "velocast-renderer.exe") ??
    inventory.files[0];
  const runtimeRoot = dirname(inventoryPath);
  const selected = join(runtimeRoot, renderer.path);
  const bytes = readFileSync(selected);
  bytes[Math.min(bytes.length - 1, 64)] ^= 0xff;
  writeFileSync(selected, bytes);
  return expectSetupFailure(
    { ...process.env, VELOCAST_OFFLINE: "1" },
    /artifact\.(offline_missing|runtime_corrupt)/,
  );
}

async function cancelRender() {
  for (const name of ["project", "config", "composition"])
    if (!args[name]) throw new Error(`cancel-render requires --${name}`);
  const events = join(root, "cancel.events.jsonl");
  const report = join(root, "cancel.report.json");
  const output = join(root, "cancel.mp4");
  const child = spawn(
    process.execPath,
    [
      cli,
      "render",
      args.composition,
      "--config",
      resolve(args.config),
      "--output",
      output,
      "--events",
      events,
      "--report",
      report,
      "--json",
    ],
    {
      cwd: resolve(args.project),
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((resolveExit) =>
    child.once("close", (code) => resolveExit(code ?? 1)),
  );
  await waitFor(
    () => existsSync(events) && readFileSync(events, "utf8").includes('"renderer_started"'),
    60_000,
  );
  await killTree(child.pid);
  const exitCode = await exited;
  if (exitCode === 0 || existsSync(output))
    throw new Error(`cancel render unexpectedly published output (exit ${exitCode})`);
  return { exitCode, stdout, stderr, outputPublished: false, events, report };
}

async function expectSetupFailure(env, pattern) {
  const execution = await run(process.execPath, [cli, "setup", "--json"], env, 120_000);
  const literal = `${execution.stdout}\n${execution.stderr}`;
  if (execution.exitCode === 0 || !pattern.test(literal))
    throw new Error(
      `expected setup failure ${pattern}, got ${execution.exitCode}\n${literal}`,
    );
  return execution;
}

function derivedManifest(change) {
  const manifest = structuredClone(baseManifest);
  change(manifest.targets["win32-x64"], manifest);
  const path = join(root, "release-manifest.json");
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return path;
}

function run(command, commandArgs, env, timeoutMs) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, commandArgs, {
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    const timer = setTimeout(() => void killTree(child.pid), timeoutMs);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolveRun({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

async function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    await new Promise((resolveTree) => {
      const child = spawn(
        "taskkill.exe",
        ["/pid", String(pid), "/t", "/f"],
        { windowsHide: true, stdio: "ignore" },
      );
      child.once("error", () => resolveTree());
      child.once("close", () => resolveTree());
    });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      process.kill(pid, "SIGKILL");
    }
  }
}

async function waitFor(check, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("timed out waiting for renderer_started");
}

function walk(path) {
  const output = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const absolute = join(path, entry.name);
    if (entry.isDirectory()) output.push(...walk(absolute));
    else if (entry.isFile()) output.push(absolute);
  }
  return output;
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2)
    result[values[index].replace(/^--/, "")] = values[index + 1];
  return result;
}
