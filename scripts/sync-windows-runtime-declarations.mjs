import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { windowsCandidateState } from "./windows-candidate-state.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const write = process.argv.includes("--write");
const releasePath = join(root, "release/velocast-release.json");
const declarationPath = join(root, "release/windows-runtime-candidate.json");
const release = JSON.parse(readFileSync(releasePath, "utf8"));
const current = JSON.parse(readFileSync(declarationPath, "utf8"));
const target = release.targets["win32-x64"];
const state = windowsCandidateState(target);
const optionIndex = process.argv.indexOf("--inventory");
const inventoryReference =
  optionIndex === -1 ? current.inventory?.path : process.argv[optionIndex + 1];
let inventory;
let inventoryPath;
let inventoryBytes;
if (state.validatedCandidate !== undefined) {
  if (!inventoryReference || inventoryReference.startsWith("--"))
    throw new Error(
      "release.windows_inventory_required: pass --inventory <path>",
    );
  inventoryPath = resolve(root, inventoryReference);
  const relativePath = relative(root, inventoryPath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath))
    throw new Error("release.windows_inventory_path_invalid");
  inventoryBytes = readFileSync(inventoryPath);
  inventory = JSON.parse(inventoryBytes);
  validateInventory(inventory);
}
const runtimeFiles =
  inventory === undefined
    ? target.runtimeFiles
    : [
        ...inventory.files.map((file) => file.path),
        "electron-runtime.json",
      ].sort((a, b) => a.localeCompare(b));
const nativeFiles = runtimeFiles.filter((path) =>
  /\.(exe|dll|node)$/i.test(path),
);
const declaration = {
  schema: "velocast-windows-runtime-candidate-declaration-v1",
  status: state.status,
  target: "win32-x64",
  browserHost: "electron",
  electronVersion: release.electronVersion,
  chromiumVersion: release.chromiumVersion,
  ...(inventory === undefined
    ? {}
    : {
        inventory: {
          path: relative(root, inventoryPath).replaceAll("\\", "/"),
          sha256: createHash("sha256").update(inventoryBytes).digest("hex"),
        },
      }),
  runtimeFiles,
  nativeFiles,
  ...(inventory === undefined
    ? {}
    : {
        provenance: {
          browserHost: inventory.browserHost,
          electronVersion: inventory.electronVersion,
          sourceCommit: inventory.sourceCommit,
        },
      }),
  licenses: current.licenses,
  ...(state.validatedCandidate === undefined
    ? {}
    : { validatedCandidate: state.validatedCandidate }),
  releaseState: state.releaseState,
  blockers: [target.blocker],
};
const nextRelease = structuredClone(release);
nextRelease.targets["win32-x64"].runtimeFiles = runtimeFiles;
nextRelease.targets["win32-x64"].nativeFiles = nativeFiles;
if (write) {
  writeFileSync(releasePath, `${JSON.stringify(nextRelease, null, 2)}\n`);
  writeFileSync(declarationPath, `${JSON.stringify(declaration, null, 2)}\n`);
} else if (
  JSON.stringify(current) !== JSON.stringify(declaration) ||
  JSON.stringify(release) !== JSON.stringify(nextRelease)
) {
  throw new Error(
    "release.windows_declaration_stale: run sync-windows-runtime-declarations.mjs --write",
  );
}
process.stdout.write(
  `${JSON.stringify({ mode: write ? "write" : "check", runtimeFiles: runtimeFiles.length, nativeFiles: nativeFiles.length, ...state.releaseState })}\n`,
);

function validateInventory(value) {
  if (
    value.schema !== "velocast-electron-runtime-v1" ||
    value.browserHost !== "electron" ||
    value.platform !== "win32" ||
    value.arch !== "x64" ||
    value.electronVersion !== release.electronVersion ||
    value.sourceCommit !== state.validatedCandidate.sourceCommit ||
    (release.sourceCommit !== null &&
      value.sourceCommit !== release.sourceCommit) ||
    !Array.isArray(value.files) ||
    value.files.length === 0
  )
    throw new Error(
      "release.windows_inventory_runtime_mismatch: Electron inventory differs from release manifest",
    );
  const paths = value.files.map((file) => file.path);
  if (
    paths.length !== new Set(paths).size ||
    paths.some(
      (path) =>
        typeof path !== "string" ||
        !path ||
        path.includes("..") ||
        path.startsWith("/"),
    )
  )
    throw new Error(
      "release.windows_inventory_invalid: file paths are invalid",
    );
}
