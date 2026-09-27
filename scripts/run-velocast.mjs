import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDirectory);
const forwarded = process.argv.slice(2);

const result = spawnSync(
  process.execPath,
  [join(repoRoot, "packages", "cli", "dist", "bin.js"), ...forwarded],
  {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  },
);

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
