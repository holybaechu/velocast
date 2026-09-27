import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const args = parseArgs(process.argv.slice(2));
for (const name of [
  "base",
  "artifact",
  "evidence",
  "host-requirements",
  "output",
])
  if (!args[name]) throw new Error(`missing --${name}`);
const output = resolve(args.output);
const rel = relative(repo, output);
if (!rel.startsWith("..") && !isAbsolute(rel))
  throw new Error("private_rc.output_invalid: manifest must stay outside repo");
const artifactPath = resolve(args.artifact);
const artifactBytes = readFileSync(artifactPath);
const artifactSha256 = digest(artifactBytes);
const evidence = JSON.parse(readFileSync(resolve(args.evidence), "utf8"));
const requirements = JSON.parse(
  readFileSync(resolve(args["host-requirements"]), "utf8"),
);
if (
  evidence.target !== "win32-x64" ||
  evidence.format !== "tar.gz" ||
  evidence.name !== artifactPath.split(/[\\/]/).at(-1) ||
  evidence.size !== artifactBytes.length ||
  evidence.sha256 !== artifactSha256 ||
  !/^[a-f0-9]{40}$/.test(evidence.sourceCommit) ||
  !evidence.renderer ||
  !evidence.root
)
  throw new Error("private_rc.artifact_evidence_invalid");
if (
  requirements.validationStatus !== "validated" ||
  !requirements.minimumOsVersion ||
  !Array.isArray(requirements.captureBackends) ||
  !requirements.captureBackends.length ||
  !Array.isArray(requirements.conversionBackends) ||
  !requirements.conversionBackends.length ||
  !Array.isArray(requirements.encoderBackends) ||
  !requirements.encoderBackends.length ||
  (requirements.softwareFallbackRequired &&
    !requirements.softwareFallbackImplemented)
)
  throw new Error("private_rc.host_requirements_invalid");
const manifest = JSON.parse(readFileSync(resolve(args.base), "utf8"));
manifest.releaseChannel = "private-rc";
manifest.sourceCommit = evidence.sourceCommit;
const target = manifest.targets?.["win32-x64"];
if (!target) throw new Error("private_rc.win32_target_missing");
target.requirements = requirements;
target.artifact = {
  name: evidence.name,
  url: pathToFileURL(artifactPath).href,
  format: "tar.gz",
  size: evidence.size,
  sha256: evidence.sha256,
  sourceCommit: evidence.sourceCommit,
  renderer: evidence.renderer,
  root: evidence.root,
};
delete target.validatedCandidate;
target.blocker = null;
writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({
    output,
    sha256: digest(readFileSync(output)),
    artifact: { path: artifactPath, size: statSync(artifactPath).size, sha256: artifactSha256 },
    sourceCommit: evidence.sourceCommit,
    publication: false,
  })}\n`,
);

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2)
    result[values[index].replace(/^--/, "")] = values[index + 1];
  return result;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
