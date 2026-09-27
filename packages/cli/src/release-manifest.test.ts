import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  REQUIRED_TARGET_IDS,
  availableReleaseTargets,
  releaseManifestPath,
  validatedRequirementsSha256,
  validateReleaseManifest,
} from "./release-manifest.js";

describe("release manifest", () => {
  it("pins Electron metadata without advertising unbuilt artifacts", () => {
    const manifest = validateReleaseManifest(
      JSON.parse(readFileSync(releaseManifestPath(), "utf8")),
    );

    expect(Object.keys(manifest.targets).sort()).toEqual(
      [...REQUIRED_TARGET_IDS].sort(),
    );
    expect(availableReleaseTargets(manifest)).toEqual([]);
    for (const targetId of REQUIRED_TARGET_IDS) {
      expect(manifest.electronVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(manifest.targets[targetId].runtimeFiles).toContain(
        "electron-runtime.json",
      );
      expect(manifest.targets[targetId].artifact).toBeNull();
      expect(manifest.targets[targetId].blocker).toBeTruthy();
    }
  });

  it("rejects stale schemas and malformed checksums", () => {
    const source = JSON.parse(
      readFileSync(releaseManifestPath(), "utf8"),
    ) as Record<string, unknown>;
    expect(() =>
      validateReleaseManifest({ ...source, artifactSchemaVersion: 2 }),
    ).toThrow("release.manifest_stale");

    expect(() =>
      validateReleaseManifest({ ...source, electronVersion: undefined }),
    ).toThrow("electronVersion and chromiumVersion are required");
  });

  it("refuses to advertise artifacts with unvalidated host requirements", () => {
    const source = JSON.parse(
      readFileSync(releaseManifestPath(), "utf8"),
    ) as Record<string, unknown>;
    const targets = structuredClone(source.targets) as Record<
      string,
      Record<string, unknown>
    >;
    targets["win32-x64"]!.requirements = {
      ...(targets["win32-x64"]!.requirements as Record<string, unknown>),
      validationStatus: "blocked",
    };
    targets["win32-x64"]!.artifact = {
      name: "velocast.tar.gz",
      url: "https://artifacts.invalid/velocast.tar.gz",
      format: "tar.gz",
      size: 1,
      sha256: "a".repeat(64),
      sourceCommit: "a".repeat(40),
      renderer: "velocast-renderer.exe",
      root: "velocast",
    };
    expect(() => validateReleaseManifest({ ...source, targets })).toThrow(
      "cannot record an installable artifact or validated candidate",
    );
  });

  it("accepts a URL-free validated candidate without making the target installable", () => {
    const source = JSON.parse(
      readFileSync(releaseManifestPath(), "utf8"),
    ) as Record<string, unknown>;
    const targets = structuredClone(source.targets) as Record<
      string,
      Record<string, unknown>
    >;
    const windows = targets["win32-x64"]!;
    windows.requirements = {
      ...(windows.requirements as Record<string, unknown>),
      validationStatus: "validated",
      minimumOsVersion: "10.0.26200",
    };
    windows.validatedCandidate = candidate(windows.requirements);
    const manifest = validateReleaseManifest({
      ...source,
      sourceCommit: "b".repeat(40),
      targets,
    });
    expect(manifest.targets["win32-x64"].artifact).toBeNull();
    expect(manifest.targets["win32-x64"].validatedCandidate?.sha256).toBe(
      "a".repeat(64),
    );
    expect(availableReleaseTargets(manifest)).toEqual([]);
  });

  it("rejects candidate URLs, placeholders and unvalidated requirements", () => {
    const source = JSON.parse(
      readFileSync(releaseManifestPath(), "utf8"),
    ) as Record<string, unknown>;
    const makeTargets = () =>
      structuredClone(source.targets) as Record<
        string,
        Record<string, unknown>
      >;
    const withCandidate = (
      overrides: Record<string, unknown>,
      validate = true,
    ) => {
      const targets = makeTargets();
      const windows = targets["win32-x64"]!;
      windows.requirements = {
        ...(windows.requirements as Record<string, unknown>),
        validationStatus: validate ? "validated" : "blocked",
        minimumOsVersion: "10.0.26200",
      };
      windows.validatedCandidate = {
        ...candidate(windows.requirements),
        ...overrides,
      };
      return { ...source, sourceCommit: "b".repeat(40), targets };
    };
    expect(() =>
      validateReleaseManifest(
        withCandidate({ url: "file:///private/artifact" }),
      ),
    ).toThrow("must be URL-free");
    expect(() =>
      validateReleaseManifest(withCandidate({ path: "D:/private/artifact" })),
    ).toThrow("validatedCandidate field path is not allowed");
    expect(() =>
      validateReleaseManifest(withCandidate({ sha256: "0".repeat(64) })),
    ).toThrow("validatedCandidate sha256 is invalid");
    expect(() =>
      validateReleaseManifest(withCandidate({ root: "<pending>" })),
    ).toThrow("validatedCandidate root is invalid");
    expect(() => validateReleaseManifest(withCandidate({}, false))).toThrow(
      "validated candidate before host and backend requirements",
    );
  });

  it("rejects an installable artifact that differs from its validated candidate", () => {
    const source = JSON.parse(
      readFileSync(releaseManifestPath(), "utf8"),
    ) as Record<string, unknown>;
    const targets = structuredClone(source.targets) as Record<
      string,
      Record<string, unknown>
    >;
    const windows = targets["win32-x64"]!;
    windows.requirements = {
      ...(windows.requirements as Record<string, unknown>),
      validationStatus: "validated",
      minimumOsVersion: "10.0.26200",
    };
    windows.validatedCandidate = candidate(windows.requirements);
    windows.artifact = {
      ...candidate(windows.requirements),
      sha256: "e".repeat(64),
      url: "https://artifacts.invalid/velocast.tar.gz",
    };
    expect(() =>
      validateReleaseManifest({
        ...source,
        sourceCommit: "b".repeat(40),
        targets,
      }),
    ).toThrow("artifact differs from validated candidate sha256");
  });

  it("rejects an artifact commit that conflicts with the root manifest commit", () => {
    const source = JSON.parse(
      readFileSync(releaseManifestPath(), "utf8"),
    ) as Record<string, unknown>;
    const targets = structuredClone(source.targets) as Record<
      string,
      Record<string, unknown>
    >;
    const windows = targets["win32-x64"]!;
    windows.requirements = {
      ...(windows.requirements as Record<string, unknown>),
      validationStatus: "validated",
      minimumOsVersion: "10.0.26200",
    };
    const validated = candidate(windows.requirements);
    delete windows.validatedCandidate;
    windows.artifact = {
      name: validated.name,
      format: validated.format,
      size: validated.size,
      sha256: validated.sha256,
      sourceCommit: validated.sourceCommit,
      renderer: validated.renderer,
      root: validated.root,
      url: "https://artifacts.invalid/velocast.tar.gz",
    };
    expect(() => validateReleaseManifest({ ...source, targets })).toThrow(
      "artifact sourceCommit differs from manifest sourceCommit",
    );
  });

  it("rejects a candidate commit that conflicts with the root manifest", () => {
    const source = JSON.parse(readFileSync(releaseManifestPath(), "utf8"));
    const windows = source.targets["win32-x64"];
    windows.requirements.validationStatus = "validated";
    windows.requirements.minimumOsVersion = "10.0.26200";
    windows.validatedCandidate = candidate(windows.requirements);
    source.sourceCommit = "d".repeat(40);
    expect(() => validateReleaseManifest(source)).toThrow(
      "validatedCandidate sourceCommit differs from manifest",
    );
  });
});

function candidate(requirements: unknown) {
  return {
    name: "velocast-0.1.0-win32-x64.tar.gz",
    format: "tar.gz",
    size: 123,
    sha256: "a".repeat(64),
    sourceCommit: "b".repeat(40),
    packageVersion: "0.1.0",
    nativeRendererVersion: "0.1.0",
    protocolVersion: 1,
    renderer: "velocast-renderer.exe",
    root: "velocast-0.1.0-win32-x64",
    signed: false,
    consumerEvidenceSha256: "c".repeat(64),
    hostRequirementsSha256: validatedRequirementsSha256(
      requirements as Parameters<typeof validatedRequirementsSha256>[0],
    ),
  };
}

it("requires the Electron bundle marker in declared runtime inventory", () => {
  const source = JSON.parse(readFileSync(releaseManifestPath(), "utf8"));
  source.targets["win32-x64"].runtimeFiles = source.targets[
    "win32-x64"
  ].runtimeFiles.filter((file: string) => file !== "electron-runtime.json");
  expect(() => validateReleaseManifest(source)).toThrow(
    "runtimeFiles must include electron-runtime.json",
  );
});
