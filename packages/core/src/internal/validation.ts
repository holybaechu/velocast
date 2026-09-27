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

export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function optionalNonEmptyString(
  id: string,
  key: string,
  value: unknown,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  assertNonEmptyString(value, `${id} ${key} must be a non-empty string`);
  return value.trim();
}

export function optionalPositiveSafeInteger(
  id: string,
  key: string,
  value: unknown,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPositiveSafeInteger(value)) {
    throw new Error(`${id} ${key} must be a positive integer`);
  }
  return value;
}
