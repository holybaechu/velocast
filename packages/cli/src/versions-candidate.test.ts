import { expect, it } from "vitest";
import { versionsCommand } from "./commands.js";
import type { ArtifactResolver } from "./artifact-resolver.js";
import type { VelocastReleaseManifest } from "./release-manifest.js";

it("reports validated-but-unpublished separately from installable artifacts", async () => {
  const manifest = {
    packageVersion: "0.1.0",
    productVersion: "0.1.0",
    nativeRendererVersion: "0.1.0",
    protocolVersion: 1,
    electronVersion: "44.4.5",
    chromiumVersion: "chromium",
    releaseChannel: "private-rc-evidence",
    targets: {
      "win32-x64": {
        artifact: null,
        blocker: "Private Windows RC validated; no artifact is advertised.",
        requirements: { validationStatus: "validated" },
        validatedCandidate: {
          sha256: "a".repeat(64),
          sourceCommit: "b".repeat(40),
          signed: false,
        },
      },
    },
  } as unknown as VelocastReleaseManifest;
  const output: string[] = [];
  await versionsCommand(
    { json: true },
    {
      write: (value) => output.push(value),
      artifactResolver: {
        releaseManifest: () => manifest,
        targetId: () => "win32-x64",
        inspect: () => undefined,
      } as unknown as ArtifactResolver,
    },
  );
  expect(JSON.parse(output.join(""))).toMatchObject({
    target: "win32-x64",
    artifact: null,
    artifactStatus: "blocked",
    validationStatus: "validated",
    distributionStatus: "validated-unpublished",
    validatedCandidate: {
      sha256: "a".repeat(64),
      sourceCommit: "b".repeat(40),
      signed: false,
    },
  });
});
