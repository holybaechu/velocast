import { describe, expect, it } from "vitest";
import { assertCompatibleVelocastVersions } from "./package-versions.js";
import { loadReleaseManifest } from "./release-manifest.js";

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
});
