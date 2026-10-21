import { isObjectRecord } from "./internal/validation.js";

const knownRendererErrorPatterns = [
  /(?:media|encoder|runtime|acceleration|capture|webcodecs|electron|output|worker)\.[a-z_]+(?:: [^\r\n]+|(?=\r?$))/m,
  /composition [^\r\n]+ was not found/,
  /selector [^\r\n]+ was not found in composition metadata/,
];

const rendererSuccessWarningPatterns = [
  /renderer completed using fallback path: [^\r\n]+(?:\r?\nBackend cause: [^\r\n]+)?/,
  /renderer completed using CPU readback for \d+ frame\(s\)/,
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
  for (const pattern of rendererSuccessWarningPatterns) {
    const match = output.match(pattern);
    if (match) {
      return match[0].trimEnd();
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
