import { spawn } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
for (const name of ["harness", "project", "runtime", "output"])
  if (!args[name]) throw new Error(`missing --${name}`);
const command = [process.execPath, resolve(args.harness)];
const project = resolve(args.project);
const cli = realpathSync(
  resolve(args.cli ?? join(project, "node_modules/velocast/dist/bin.js")),
);
const execution = await run(command[0], command.slice(1), {
  ...process.env,
  INIT_CWD: project,
  VELOCAST_PREVIEW_GATE_PROJECT: project,
  VELOCAST_PREVIEW_GATE_CLI: cli,
  VELOCAST_PREVIEW_GATE_FFMPEG_BIN: resolve(args.runtime),
});
if (execution.exitCode !== 0)
  throw new Error(
    `preview harness failed ${execution.exitCode}\n${execution.stdout}\n${execution.stderr}`,
  );
let result;
try {
  result = JSON.parse(execution.stdout);
} catch (cause) {
  throw new Error("preview harness did not emit one JSON result", { cause });
}
writeFileSync(
  resolve(args.output),
  `${JSON.stringify(
    {
      status: "PASS",
      command,
      project,
      cli,
      runtime: resolve(args.runtime),
      result,
      stdout: execution.stdout,
      stderr: execution.stderr,
    },
    null,
    2,
  )}\n`,
);

function run(commandPath, commandArgs, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(commandPath, commandArgs, {
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
    }, 10 * 60_000);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolveRun({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2)
    result[values[index].replace(/^--/, "")] = values[index + 1];
  return result;
}
