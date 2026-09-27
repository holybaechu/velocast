export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function assertNonEmptyString(
  value: unknown,
  errorMessage: string,
): asserts value is string {
  if (!isNonEmptyString(value)) {
    throw new Error(errorMessage);
  }
}

export function isObjectRecord(
  value: unknown,
): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
