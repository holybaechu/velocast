import { basename } from "node:path";

export function validReleasePackageSet(packages, version) {
  if (
    !Array.isArray(packages) ||
    packages.length !== 7 ||
    new Set(packages).size !== packages.length ||
    packages.some(
      (name) => typeof name !== "string" || basename(name) !== name,
    ) ||
    typeof version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
  )
    return false;
  return [
    `velocast-${version}.tgz`,
    `velocast-core-${version}.tgz`,
    `velocast-gsap-${version}.tgz`,
    `velocast-react-${version}.tgz`,
    `velocast-remotion-${version}.tgz`,
    `velocast-remotion-source-${version}.tgz`,
    `velocast-preview-${version}.tgz`,
  ].every((name) => packages.includes(name));
}
