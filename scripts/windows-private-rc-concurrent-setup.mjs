import { spawn } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
for (const name of ["npm-cli", "pnpm-cli", "output"])
  if (!args[name]) throw new Error(`missing --${name}`);
const cache = resolve(args.cache ?? process.env.VELOCAST_CACHE_DIR ?? "");
if (!args.cache || !cache)
  throw new Error("concurrent setup requires an explicit --cache");
if (existsSync(cache))
  throw new Error(`concurrent setup cache already exists: ${cache}`);
const childEnv = { ...process.env, VELOCAST_CACHE_DIR: cache };
const commands = [
  [process.execPath, [resolve(args["npm-cli"]), "setup", "--json"]],
  [process.execPath, [resolve(args["pnpm-cli"]), "setup", "--json"]],
];
const results = await Promise.all(
  commands.map(([command, commandArgs]) =>
    run(command, commandArgs, childEnv, 120_000),
  ),
);
for (const result of results)
  if (result.exitCode !== 0)
    throw new Error(
      `concurrent setup failed ${result.exitCode}\n${result.stdout}\n${result.stderr}`,
    );
const parsed = results.map((result) => JSON.parse(result.stdout));
if (
  parsed[0].artifactDir !== parsed[1].artifactDir ||
  parsed[0].sha256 !== parsed[1].sha256
)
  throw new Error("concurrent setup resolved different artifacts");
const leftovers = walk(cache).filter((path) =>
  /\.lock$|\.partial-|\.staging-/.test(path),
);
if (leftovers.length)
  throw new Error(`concurrent setup left temporary paths: ${leftovers.join(", ")}`);
writeFileSync(
  resolve(args.output),
  `${JSON.stringify(
    {
      status: "PASS",
      artifactDir: parsed[0].artifactDir,
      sha256: parsed[0].sha256,
      sources: parsed.map((result) => result.source),
      leftovers,
      commands: commands.map(([command, commandArgs]) => [command, ...commandArgs]),
    },
    null,
    2,
  )}\n`,
);

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
    const timer = setTimeout(() => {
      if (process.platform === "win32")
        spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
          windowsHide: true,
          stdio: "ignore",
        });
      else child.kill("SIGKILL");
    }, timeoutMs);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolveRun({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function walk(path, prefix = "") {
  const output = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    output.push(relative);
    if (entry.isDirectory()) output.push(...walk(`${path}/${entry.name}`, relative));
  }
  return output;
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2)
    result[values[index].replace(/^--/, "")] = values[index + 1];
  return result;
}
