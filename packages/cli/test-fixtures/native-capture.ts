import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

const expectation = process.env.VELOCAST_CAPTURE_EXPECTATION;
assert(
  expectation === undefined ||
    expectation === "required" ||
    expectation === "unavailable",
  "VELOCAST_CAPTURE_EXPECTATION must be required or unavailable",
);
export const nativeCaptureRequired = expectation === "required";

// Required profiles must exercise the selected build, never public artifacts.
export async function requireNativeCaptureRuntime(): Promise<void> {
  for (const name of [
    "VELOCAST_RENDERER_BINARY",
    "VELOCAST_ELECTRON_BINARY",
    "VELOCAST_ELECTRON_HOST_SCRIPT",
  ]) {
    const path = process.env[name];
    assert(
      path && isAbsolute(path),
      `${name} must be an absolute native integration path`,
    );
    assert((await stat(path)).isFile(), `${name} must name an existing file`);
  }
}
