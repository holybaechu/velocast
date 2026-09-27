import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { create, extract } from "tar";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDir = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  throw new Error("usage: pack-public-packages.mjs <output-directory>");
}
const rel = relative(repoRoot, outputDir);
if (!rel.startsWith("..") && !isAbsolute(rel)) {
  throw new Error(
    "package.output_invalid: package artifacts must be outside tracked source",
  );
}
mkdirSync(outputDir, { recursive: true });

const packages = [
  { name: "@velocast/core", filter: "./packages/core" },
  { name: "@velocast/gsap", filter: "./packages/gsap" },
  { name: "@velocast/react", filter: "./packages/react" },
  { name: "@velocast/remotion-source", filter: "./packages/remotion-source" },
  { name: "@velocast/remotion", filter: "./packages/remotion-compat" },
  { name: "@velocast/preview", filter: "./packages/preview" },
  { name: "velocast", filter: "./packages/cli" },
];
const reports = [];
for (const packageEntry of packages) {
  const temp = mkdtempSync(join(tmpdir(), "velocast-pack-"));
  try {
    execFileSync(
      pnpmCommand(),
      ["--filter", packageEntry.filter, "pack", "--pack-destination", temp],
      {
        cwd: repoRoot,
        stdio: "pipe",
        shell: process.platform === "win32",
      },
    );
    const rawName = readdirSync(temp).find((name) => name.endsWith(".tgz"));
    if (!rawName) throw new Error(`package.pack_failed: ${packageEntry.name}`);
    const unpacked = join(temp, "unpacked");
    mkdirSync(unpacked);
    await extract({ file: join(temp, rawName), cwd: unpacked, strict: true });
    const packageJsonPath = join(unpacked, "package", "package.json");
    writeFileSync(
      packageJsonPath,
      `${JSON.stringify(sortJson(JSON.parse(readFileSync(packageJsonPath, "utf8"))), null, 2)}\n`,
    );
    const output = join(outputDir, rawName);
    rmSync(output, { force: true });
    await create(
      {
        cwd: unpacked,
        file: output,
        gzip: { portable: true },
        mtime: new Date(0),
        portable: true,
        strict: true,
      },
      ["package"],
    );
    reports.push({
      package: packageEntry.name,
      name: basename(output),
      size: statSync(output).size,
      sha256: sha256File(output),
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
process.stdout.write(`${JSON.stringify(reports)}\n`);

function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}

function sha256File(path) {
  const hash = createHash("sha256");
  const handle = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    while ((bytesRead = readSync(handle, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(handle);
  }
  return hash.digest("hex");
}
