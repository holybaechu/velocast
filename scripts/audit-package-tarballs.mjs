import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { extract } from "tar";

const tarballs = process.argv.slice(2);
if (tarballs.length === 0) {
  throw new Error("usage: audit-package-tarballs.mjs <package.tgz> [...]");
}

const reports = [];
for (const tarball of tarballs) {
  const temp = mkdtempSync(join(tmpdir(), "velocast-package-audit-"));
  try {
    await extract({ file: tarball, cwd: temp, strict: true });
    const root = join(temp, "package");
    const metadata = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    );
    requireValue(metadata.private !== true, `${metadata.name} is private`);
    requireValue(
      metadata.license === "MIT",
      `${metadata.name} license is missing`,
    );
    for (const section of [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      for (const [name, version] of Object.entries(metadata[section] ?? {})) {
        requireValue(
          typeof version === "string" &&
            !version.startsWith("workspace:") &&
            !version.startsWith("file:") &&
            !version.includes("\\") &&
            !version.startsWith("/"),
          `${metadata.name} ${section}.${name} is not publishable: ${version}`,
        );
      }
    }
    for (const target of exportedPaths(metadata)) {
      requireValue(
        statSync(join(root, target)).isFile(),
        `${metadata.name} export ${target} is missing`,
      );
    }
    requireValue(
      readdirSync(root, { recursive: true }).some((path) =>
        String(path).endsWith("LICENSE"),
      ),
      `${metadata.name} does not include LICENSE`,
    );
    requireValue(
      readdirSync(root, { recursive: true }).some((path) =>
        String(path).endsWith("THIRD_PARTY_NOTICES.md"),
      ),
      `${metadata.name} does not include third-party notices`,
    );
    for (const child of readdirSync(root, {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!child.isFile()) continue;
      const path = join(child.parentPath, child.name);
      const rel = relative(root, path).replaceAll("\\", "/");
      requireValue(
        !/(^|\/)(src|fixtures|coverage|\.cache)(\/|$)/.test(rel),
        `${metadata.name} contains build junk: ${rel}`,
      );
      requireValue(
        !/\.(pem|key|pfx)$/.test(rel),
        `${metadata.name} contains credentials: ${rel}`,
      );
      if (rel.endsWith(".map")) {
        const source = readFileSync(path, "utf8");
        requireValue(
          !/[A-Za-z]:[\\/]|\\\\wsl|\/(home|Users)\//.test(source),
          `${metadata.name} source map contains a machine path: ${rel}`,
        );
      }
    }
    reports.push({ name: metadata.name, version: metadata.version, tarball });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
process.stdout.write(`${JSON.stringify(reports)}\n`);

function exportedPaths(metadata) {
  const paths = [];
  if (typeof metadata.bin === "string") paths.push(metadata.bin);
  if (metadata.bin && typeof metadata.bin === "object")
    paths.push(...Object.values(metadata.bin));
  collectExports(metadata.exports, paths);
  return [
    ...new Set(
      paths
        .filter((value) => typeof value === "string")
        .map((value) => value.replace(/^\.\//, "")),
    ),
  ];
}

function collectExports(value, output) {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const child of Object.values(value)) collectExports(child, output);
}

function requireValue(condition, message) {
  if (!condition) throw new Error(`package.audit_failed: ${message}`);
}
