import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = resolve(packageRoot, "../..");
const source = await readFile(
  resolve(workspace, "crates/renderer/browser/runtime.js"),
  "utf8",
);
const contract = JSON.parse(
  await readFile(
    resolve(workspace, "contracts/renderer-protocol.json"),
    "utf8",
  ),
);
if (
  !Number.isSafeInteger(contract.browserProtocolVersion) ||
  !source.trim().startsWith("(() => {")
)
  throw new Error("Unexpected trusted browser runtime source/contract");
const platform = resolve(packageRoot, "dist/platform");
await mkdir(platform, { recursive: true });
for (const [sourceName, name] of [
  ["bridge-entry.js", "bridge.js"],
  ["child-bridge.js", "child-bridge.js"],
  ["rpc-wire.js", "rpc-wire.js"],
  ["element-inspection.js", "element-inspection.js"],
])
  await copyFile(
    resolve(packageRoot, "dist", sourceName),
    resolve(platform, name),
  );
await copyFile(
  resolve(packageRoot, "src/browser-runtime.d.ts"),
  resolve(packageRoot, "dist/browser-runtime.d.ts"),
);
await writeFile(
  resolve(platform, "browser-runtime.js"),
  `// Trusted build-time native runtime wrapper. No eval or source rewriting.\nexport const browserRuntime = ${source.trim()}\nexport const browserProtocolVersion = ${contract.browserProtocolVersion};\n`,
);
const assets = [
  "bridge.js",
  "child-bridge.js",
  "rpc-wire.js",
  "element-inspection.js",
  "browser-runtime.js",
];
const hashes = {};
for (const name of assets)
  hashes[name] = createHash("sha256")
    .update(await readFile(resolve(platform, name)))
    .digest("hex");
await writeFile(
  resolve(platform, "manifest.json"),
  JSON.stringify(
    {
      entryScript: "bridge.js",
      assets,
      configurationAsset: "config.js",
      configurationExport: "previewConfig",
      rpcProtocolVersion: 1,
      browserProtocolVersion: contract.browserProtocolVersion,
      nativeRuntimeSHA256: createHash("sha256").update(source).digest("hex"),
      sha256: hashes,
    },
    null,
    2,
  ),
);
