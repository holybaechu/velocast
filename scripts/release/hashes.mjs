import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";

export function sha256File(path) {
  const hash = createHash("sha256");
  const handle = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    while ((bytesRead = readSync(handle, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(handle);
  }
  return hash.digest("hex");
}

export function requirementsSha256(requirements) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        validationStatus: requirements.validationStatus,
        minimumOsVersion: requirements.minimumOsVersion,
        minimumGlibcVersion: requirements.minimumGlibcVersion,
        gpuRequired: requirements.gpuRequired,
        captureBackends: requirements.captureBackends,
        conversionBackends: requirements.conversionBackends,
        encoderBackends: requirements.encoderBackends,
        softwareFallbackRequired: requirements.softwareFallbackRequired,
        softwareFallbackImplemented: requirements.softwareFallbackImplemented,
      }),
    )
    .digest("hex");
}
