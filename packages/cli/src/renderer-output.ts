import { isObjectRecord } from "./internal/validation.js";

const knownRendererErrorPatterns = [
  /(?:media|encoder|runtime|acceleration|capture|webcodecs)\.[a-z_]+: [^\r\n]+/,
  /electron\.[a-z_]+: [^\r\n]+/,
  /config serve\.url is required for render/,
  /composition [^\r\n]+ was not found/,
  /selector [^\r\n]+ was not found in composition metadata/,
  /capture\.accelerated_paint_unavailable/,
  /capture\.accelerated_readback_unavailable/,
  /accelerated rendering [^\r\n]+/,
  /hardware encoder [^\r\n]+/,
  /frame \d+ timed out waiting for accelerated paint/,
  /required GPU benchmark [^\r\n]+/,
  /worker_backend\.incompatible:[^\r\n]+/,
  /remuxed output [^\r\n]+/,
  /webcodecs decoded (?:(?:boundary|selected) )?frame hash probe failed for [^\r\n]+/,
  /decoded (?:boundary|selected) frame hash probe returned \d+ frame\(s\), expected \d+ in [^\r\n]+/,
  /decoded frame hash count \d+ did not match expected frame count \d+ in [^\r\n]+/,
  /decoded selected frame hash count \d+ did not match selected frame count \d+ in [^\r\n]+/,
  /decoded selected frame hash probe missing frame \d+ in [^\r\n]+/,
  /adjacent duplicate decoded(?: segment-boundary)? frame(?: hash)? at (?:frame|index) \d+ in [^\r\n]+/,
  /frame 0 matched preview frame \d+ in [^\r\n]+/,
  /frames \d+-\d+ repeated decoded frame hash: frame \d+ matched frame \d+ in [^\r\n]+/,
  /frame \d+ matched frame 0 in [^\r\n]+/,
  /worker \d+\.\.\d+ failed/,
];

const multilineRendererErrorPatterns = [
  /accelerated rendering is required, but no compatible GPU backend is available on this platform\.\r?\nBackend cause: [^\r\n]+/,
  /accelerated rendering is required, but it is not available for this render path: [^\r\n]+\r?\nSet acceleration to "auto" [^\r\n]+/,
  /accelerated rendering currently supports nv12\/yuv420p output, but [^\r\n]+\r?\nUse --pixel-format [^\r\n]+/,
];

const multilineRendererSuccessWarningPatterns = [
  /renderer completed using fallback path: [^\r\n]+(?:\r?\nBackend cause: [^\r\n]+)?/,
];

const rendererSuccessWarningPatterns = [
  /renderer completed using CPU readback for \d+ frame\(s\)/,
  /renderer completed using fallback path: [^\r\n]+/,
  /hardware encoder unavailable; falling back to software BGRA stdin[^\r\n]*/,
  /required GPU benchmark used \d+ CPU readback frame\(s\)/,
  /required GPU benchmark fell back from the GPU path: [^\r\n]+/,
];

export function extractKnownRendererError(output: string): string | undefined {
  const workerFailure = output.match(/worker \d+\.\.\d+ failed:[\s\S]*$/);
  if (workerFailure) {
    return workerFailure[0].trimEnd();
  }

  const webcodecsEncoderInitializationFailure = output.match(
    /encoder.webcodecs_open_failed:[\s\S]*$/,
  );
  if (webcodecsEncoderInitializationFailure) {
    return webcodecsEncoderInitializationFailure[0].trimEnd();
  }

  for (const pattern of multilineRendererErrorPatterns) {
    const match = output.match(pattern);
    if (match) {
      return match[0].trimEnd();
    }
  }

  for (const pattern of knownRendererErrorPatterns) {
    const match = output.match(pattern);
    if (match) {
      return match[0];
    }
  }

  return undefined;
}

export function extractRendererSuccessWarning(
  output: string,
): string | undefined {
  for (const pattern of multilineRendererSuccessWarningPatterns) {
    const match = output.match(pattern);
    if (match) {
      return match[0].trimEnd();
    }
  }

  for (const pattern of rendererSuccessWarningPatterns) {
    const match = output.match(pattern);
    if (match) {
      return match[0];
    }
  }

  return undefined;
}

export function extractRendererReportSuccessWarning(
  report: unknown,
): string | undefined {
  if (!isObjectRecord(report)) {
    return undefined;
  }

  const fallbackUsed = report.fallback_used === true;
  const fallbackReason =
    typeof report.fallback_reason === "string" && report.fallback_reason.trim()
      ? report.fallback_reason.trim()
      : undefined;
  if (fallbackUsed) {
    const backendDiagnostics = formatUnavailableBackendDiagnostics(
      report.backend_diagnostics,
      fallbackReason,
    );
    if (fallbackReason && backendDiagnostics) {
      return `renderer completed using fallback path: ${fallbackReason}\nBackend diagnostics: ${backendDiagnostics}`;
    }
    if (fallbackReason) {
      return `renderer completed using fallback path: ${fallbackReason}`;
    }
    if (backendDiagnostics) {
      return `renderer completed using fallback path\nBackend diagnostics: ${backendDiagnostics}`;
    }
    return "renderer completed using fallback path";
  }

  const cpuReadbackFrames = report.cpu_readback_frames;
  if (
    typeof cpuReadbackFrames === "number" &&
    Number.isInteger(cpuReadbackFrames) &&
    cpuReadbackFrames > 0
  ) {
    return `renderer completed using CPU readback for ${cpuReadbackFrames} frame(s)`;
  }

  return undefined;
}

function formatUnavailableBackendDiagnostics(
  diagnostics: unknown,
  fallbackReason: string | undefined,
): string | undefined {
  if (!Array.isArray(diagnostics)) {
    return undefined;
  }

  const formatted = diagnostics
    .map((diagnostic) => formatUnavailableBackendDiagnostic(diagnostic))
    .filter((diagnostic): diagnostic is string => diagnostic !== undefined);
  const missingFromFallbackReason = formatted.filter((diagnostic) =>
    fallbackReason === undefined ? true : !fallbackReason.includes(diagnostic),
  );
  if (missingFromFallbackReason.length === 0) {
    return undefined;
  }

  return missingFromFallbackReason.join("; ");
}

function formatUnavailableBackendDiagnostic(
  diagnostic: unknown,
): string | undefined {
  if (!isObjectRecord(diagnostic) || diagnostic.available !== false) {
    return undefined;
  }
  if (typeof diagnostic.backend !== "string" || !diagnostic.backend.trim()) {
    return undefined;
  }
  if (
    typeof diagnostic.unavailable_code !== "string" ||
    !diagnostic.unavailable_code.trim()
  ) {
    return undefined;
  }
  if (
    typeof diagnostic.unavailable_reason !== "string" ||
    !diagnostic.unavailable_reason.trim()
  ) {
    return undefined;
  }

  const unavailableReason = diagnostic.unavailable_reason.startsWith(
    diagnostic.unavailable_code,
  )
    ? diagnostic.unavailable_reason
    : `${diagnostic.unavailable_code}: ${diagnostic.unavailable_reason}`;
  return `${diagnostic.backend} unavailable: ${unavailableReason}`;
}
