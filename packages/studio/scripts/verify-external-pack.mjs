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
import { join, resolve } from "node:path";

const workspace = resolve(import.meta.dirname, "../../..");
const directory = await mkdtemp(join(tmpdir(), "velocast-studio-pack-"));
const consumer = join(directory, "consumer");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (command, args, cwd = workspace) => {
  const batch = process.platform === "win32" && command.endsWith(".cmd");
  const result = spawnSync(
    batch ? (process.env.ComSpec ?? "cmd.exe") : command,
    batch ? ["/d", "/c", "call", command, ...args] : args,
    {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
    },
  );
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout.trim();
};

try {
  run(pnpm, ["--filter", "@velocast/core", "pack", "--pack-destination", directory]);
  run(pnpm, ["--filter", "@velocast/studio", "pack", "--pack-destination", directory]);
  const names = await readdir(directory);
  const core = names.find((name) => name.startsWith("velocast-core-") && name.endsWith(".tgz"));
  const studio = names.find((name) => name.startsWith("velocast-studio-") && name.endsWith(".tgz"));
  if (!core || !studio) throw new Error("package tarballs were not created");
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ name: "studio-pack-consumer", private: true, type: "module" }),
  );
  // pnpm's installed dependencies do not populate npm's offline cache.
  const icons = run(
    npm,
    ["pack", "--ignore-scripts", "--pack-destination", directory],
    join(workspace, "packages/studio/node_modules/lucide"),
  );
  run(
    npm,
    ["install", "--offline", "--ignore-scripts", join(directory, core), join(directory, studio), join(directory, icons)],
    consumer,
  );
  const entry = new URL(
    "./node_modules/@velocast/studio/dist/index.js",
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
  if (typeof api.StudioApp !== "function" || typeof api.HttpStudioApi !== "function")
    throw new Error("public studio UI exports are missing");
  const expected = [
    "bridge.js",
    "child-bridge.js",
    "rpc-wire.js",
    "element-inspection.js",
    "browser-runtime.js",
  ];
  if (JSON.stringify(manifest.assets) !== JSON.stringify(expected))
    throw new Error("installed platform manifest does not match its fixed asset set");
  await Promise.all(
    expected.map((name) => readFile(new URL(`platform/${name}`, root))),
  );
  console.log(
    JSON.stringify(
      {
        consumer: "clean temporary project",
        tarballs: [core, studio],
        installedUI: required.slice(0, 3),
        installedPlatform: manifest.assets,
        publicExports: ["StudioApp", "HttpStudioApi"],
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
