import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(repoRoot, "release", "velocast-release.json");
const packageName = process.argv[2] ?? "cli";
const destination = join(
  repoRoot,
  "packages",
  packageName,
  "dist",
  "release-manifest.json",
);

await mkdir(dirname(destination), { recursive: true });
if (packageName === "cli") {
  await copyFile(source, destination);
}
await copyFile(
  join(repoRoot, "LICENSE"),
  join(dirname(destination), "LICENSE"),
);
await copyFile(
  join(repoRoot, "THIRD_PARTY_NOTICES.md"),
  join(dirname(destination), "THIRD_PARTY_NOTICES.md"),
);
