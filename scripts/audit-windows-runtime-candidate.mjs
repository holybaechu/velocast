import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const [rootArgument, outputArgument] = process.argv.slice(2);
if (!rootArgument || !outputArgument)
  throw new Error(
    "usage: node scripts/audit-windows-runtime-candidate.mjs <electron-runtime-dir> <report.json>",
  );
const root = resolve(rootArgument);
const output = resolve(outputArgument);
const manifestPath = join(root, "electron-runtime.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (
  manifest.schema !== "velocast-electron-runtime-v1" ||
  !["unsigned-local-candidate", "prepared-release-candidate"].includes(
    manifest.status,
  ) ||
  manifest.browserHost !== "electron" ||
  manifest.platform !== "win32" ||
  manifest.arch !== "x64" ||
  !Array.isArray(manifest.files) ||
  !manifest.files.length
)
  throw new Error(
    "candidate.audit_state: expected unsigned Windows x64 Electron runtime",
  );
const paths = new Set();
let bytes = 0;
for (const file of manifest.files) {
  const path = resolve(root, file.path);
  const relativePath = relative(root, path);
  if (
    paths.has(file.path) ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath) ||
    !existsSync(path) ||
    !statSync(path).isFile() ||
    statSync(path).size !== file.size ||
    createHash("sha256").update(readFileSync(path)).digest("hex") !==
      file.sha256
  )
    throw new Error(`candidate.audit_file: ${file.path}`);
  paths.add(file.path);
  bytes += file.size;
}
const discovered = walk(root);
const declared = new Set([...paths, "electron-runtime.json"]);
if (
  discovered.length !== declared.size ||
  discovered.some((path) => !declared.has(path))
)
  throw new Error(
    "candidate.audit_inventory: undeclared or missing runtime files",
  );
for (const name of [
  "velocast-renderer.exe",
  "electron/electron.exe",
  "electron-host/main.cjs",
  "electron-host/media-client.cjs",
  "electron-host/media-runtime.cjs",
  "electron-host/node_modules/mediabunny/package.json",
  "electron-host/node_modules/mediabunny/LICENSE",
])
  if (!paths.has(name)) throw new Error(`candidate.audit_required: ${name}`);
if (
  [...paths].some((path) => /(^|\/)libcef\.(dll|so)$|(^|\/)cef[-_]/i.test(path))
)
  throw new Error("candidate.audit_cef_files: CEF files are forbidden");
if (
  manifest.rendererCapabilities?.defaultBrowserHost !== "electron" ||
  manifest.rendererCapabilities?.electronHostProtocolVersion !== 2 ||
  manifest.rendererCapabilities?.videoEncoderBackend !== "webcodecs" ||
  manifest.rendererCapabilities?.mediaRuntime !== "mediabunny" ||
  JSON.stringify(manifest.rendererCapabilities?.browserHosts) !== '["electron"]'
)
  throw new Error(
    "candidate.audit_capabilities: renderer is not Electron-only",
  );
const report = {
  schema: "velocast-windows-electron-runtime-audit-v1",
  status: "PASS-private-candidate-only",
  candidate: root,
  manifest: {
    path: manifestPath,
    sha256: createHash("sha256")
      .update(readFileSync(manifestPath))
      .digest("hex"),
    files: manifest.files.length,
    bytes,
  },
  browserHost: "electron",
  electronVersion: manifest.electronVersion,
  sourceCommit: manifest.sourceCommit,
  releaseState: {
    publicUploadPerformed: false,
    supportedManifestChanged: false,
  },
};
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({ output, status: report.status, files: report.manifest.files, bytes })}\n`,
);

function walk(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink())
      throw new Error(`candidate.audit_symlink: ${entry.name}`);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory()
      ? walk(join(directory, entry.name), relativePath)
      : [relativePath];
  });
}
