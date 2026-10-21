import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertCompatibleVelocastVersions,
  installedVelocastVersions,
} from "./package-versions.js";
import { loadReleaseManifest } from "./release-manifest.js";

const lookupPaths = vi.hoisted(() => [] as string[]);
vi.mock("node:module", () => ({
  createRequire: () => ({
    resolve: Object.assign(
      (name: string) => join(lookupPaths[0]!, name, "index.js"),
      { paths: () => lookupPaths },
    ),
  }),
}));

afterEach(() => {
  for (const directory of lookupPaths.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function install(name: string, metadata: string): void {
  const root =
    lookupPaths[0] ?? mkdtempSync(join(tmpdir(), "velocast-versions-"));
  if (!lookupPaths.length) lookupPaths.push(root);
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), metadata);
}

describe("official package compatibility", () => {
  it("accepts one exact package/native/protocol release line", () => {
    expect(() =>
      assertCompatibleVelocastVersions(loadReleaseManifest(), {
        velocast: "0.1.0",
        "@velocast/core": "0.1.0",
      }),
    ).not.toThrow();
  });

  it("rejects mixed official package versions", () => {
    expect(() =>
      assertCompatibleVelocastVersions(loadReleaseManifest(), {
        velocast: "0.1.0",
        "@velocast/core": "0.0.9",
      }),
    ).toThrow("package.version_mismatch");
  });

  it.each([
    "@velocast/react",
    "@velocast/preview",
    "@velocast/remotion",
    "@velocast/remotion-source",
  ])("discovers and rejects a mismatched installed %s", (name) => {
    install(name, JSON.stringify({ name, version: "0.0.9" }));
    expect(installedVelocastVersions()[name]).toBe("0.0.9");
    expect(() =>
      assertCompatibleVelocastVersions(loadReleaseManifest()),
    ).toThrow("package.version_mismatch");
  });

  it("allows optional integrations to be absent", () => {
    expect(installedVelocastVersions()).toEqual({ velocast: "0.1.0" });
  });

  it("rejects an installed integration missing its metadata", () => {
    install("@velocast/core", "{}");
    rmSync(join(lookupPaths[0]!, "@velocast/core/package.json"));
    expect(() => installedVelocastVersions()).toThrow();
  });

  it("does not hide malformed metadata from an installed integration", () => {
    install("@velocast/core", "{broken");
    expect(() => installedVelocastVersions()).toThrow();
  });

  it("rejects installed integration metadata without a version", () => {
    install("@velocast/react", JSON.stringify({ name: "@velocast/react" }));
    expect(() => installedVelocastVersions()).toThrow(
      "package.metadata_invalid",
    );
  });
});
