import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const workspace = resolve(import.meta.dirname, "../../..");
const directory = await mkdtemp(join(tmpdir(), "velocast-preview-pack-"));
const consumer = join(directory, "consumer");
const pnpmExec = process.env.npm_execpath;
const pnpm = pnpmExec
  ? pnpmExec.endsWith(".exe")
    ? { command: pnpmExec, prefix: [] }
    : { command: process.execPath, prefix: [pnpmExec] }
  : { command: "pnpm", prefix: [] };
const run = (command, args, cwd = workspace) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout.trim();
};

try {
  run(pnpm.command, [...pnpm.prefix, "--filter", "@velocast/core", "pack", "--pack-destination", directory]);
  run(pnpm.command, [...pnpm.prefix, "--filter", "@velocast/preview", "pack", "--pack-destination", directory]);
  const names = await readdir(directory);
  const core = names.find((name) => name.startsWith("velocast-core-") && name.endsWith(".tgz"));
  const preview = names.find((name) => name.startsWith("velocast-preview-") && name.endsWith(".tgz"));
  if (!core || !preview) throw new Error("package tarballs were not created");
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ name: "preview-pack-consumer", private: true, type: "module" }),
  );
  const npmCli = join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  run(
    process.execPath,
    [npmCli, "install", "--offline", "--ignore-scripts", join(directory, core), join(directory, preview)],
    consumer,
  );
  const entry = new URL(
    "./node_modules/@velocast/preview/dist/index.js",
    `file:///${consumer.replaceAll("\\", "/")}/`,
  );
  const root = new URL("./", entry);
  const required = [
    "ui/index.html",
    "ui/assets/app.js",
    "ui/assets/app.css",
    "platform/manifest.json",
  ];
  await Promise.all(required.map((path) => readFile(new URL(path, root))));
  const manifest = JSON.parse(
    await readFile(new URL("platform/manifest.json", root), "utf8"),
  );
  const api = await import(entry.href);
  if (typeof api.PreviewApp !== "function" || typeof api.HttpPreviewApi !== "function")
    throw new Error("public preview UI exports are missing");
  const expected = ["bridge.js", "child-bridge.js", "rpc-wire.js", "browser-runtime.js"];
  if (JSON.stringify(manifest.assets) !== JSON.stringify(expected))
    throw new Error("installed platform manifest does not match its fixed asset set");
  console.log(
    JSON.stringify(
      {
        consumer: "clean temporary project",
        tarballs: [core, preview],
        installedUI: required.slice(0, 3),
        installedPlatform: manifest.assets,
        publicExports: ["PreviewApp", "HttpPreviewApi"],
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
