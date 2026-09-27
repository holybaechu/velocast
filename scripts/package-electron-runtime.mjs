import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findDumpbin,
  packageElectronRuntime,
  withDllSearchPath,
  windowsImports,
} from "./electron-runtime-package.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = { dllDirs: [], host: join(root, "packages/electron-host") };
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index],
    value = process.argv[index + 1];
  if (
    !value ||
    ![
      "--renderer",
      "--electron",
      "--host",
      "--ffmpeg",
      "--ffprobe",
      "--output",
      "--dll-dir",
      "--licenses",
    ].includes(key)
  )
    throw new Error(`Unknown/missing option: ${key}`);
  if (key === "--dll-dir") options.dllDirs.push(resolve(value));
  else options[key.slice(2)] = resolve(value);
}
for (const key of ["renderer", "electron", "ffmpeg", "ffprobe", "output"])
  if (!options[key])
    throw new Error(
      "Required: --renderer EXE --electron DIST --ffmpeg EXE --ffprobe EXE --dll-dir DIR --output NEW-DIR [--licenses DIR]",
    );
const dumpbin = findDumpbin();
options.readImports = (file) => windowsImports(dumpbin, file);
options.probeCapabilities = (binary) =>
  JSON.parse(
    execFileSync(binary, ["--capabilities-json"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
      env: withDllSearchPath(options.dllDirs),
    }),
  );
options.sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
}).trim();
const manifest = packageElectronRuntime(options);
console.log(
  JSON.stringify(
    {
      output: options.output,
      files: manifest.files.length,
      bytes: manifest.files.reduce((sum, file) => sum + file.size, 0),
      rendererCapabilities: manifest.rendererCapabilities,
      status: manifest.status,
    },
    null,
    2,
  ),
);
