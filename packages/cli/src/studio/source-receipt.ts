import { StudioCodeError } from "./studio-code-config.js";

export const SOURCE_RECEIPT_FILE = "_velocast-sources.json";
export const MAX_SOURCE_RECEIPT_BYTES = 128 * 1024;
export const MAX_SOURCE_RECEIPT_ENTRIES = 512;

export function validReceiptId(id: string): boolean {
  return (
    id.length > 0 &&
    id.length <= 256 &&
    !!id.trim() &&
    !Array.from(id).some((character) => character.charCodeAt(0) < 32)
  );
}

export function parseSourceReceipt(value: unknown): Record<string, string> {
  const invalid = () =>
    new StudioCodeError(
      400,
      "studio.code_receipt_invalid",
      `Invalid ${SOURCE_RECEIPT_FILE}; rebuild with studioSourcePlugin from velocast/vite`,
    );
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid();
  const receipt = value as Record<string, unknown>;
  if (
    receipt.version !== 1 ||
    Object.keys(receipt).some(
      (key) => key !== "version" && key !== "revisions",
    ) ||
    !receipt.revisions ||
    typeof receipt.revisions !== "object" ||
    Array.isArray(receipt.revisions)
  )
    throw invalid();
  const revisions = Object.entries(receipt.revisions);
  if (
    revisions.length > MAX_SOURCE_RECEIPT_ENTRIES ||
    revisions.some(
      ([id, revision]) =>
        !validReceiptId(id) ||
        typeof revision !== "string" ||
        !/^[a-f0-9]{64}$/.test(revision),
    )
  )
    throw invalid();
  return Object.freeze(
    Object.assign(Object.create(null), Object.fromEntries(revisions)),
  ) as Record<string, string>;
}

/** The receipt must come from the immutable copy used by the displayed frame. */
export async function readSourceReceipt(
  snapshotUrl: string,
  signal: AbortSignal,
): Promise<Record<string, string> | undefined> {
  const response = await fetch(
    new URL(`/${SOURCE_RECEIPT_FILE}`, snapshotUrl),
    {
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      redirect: "error",
    },
  );
  if (response.status === 404) {
    await response.body?.cancel();
    return;
  }
  if (
    !response.ok ||
    Number(response.headers.get("content-length")) > MAX_SOURCE_RECEIPT_BYTES
  ) {
    await response.body?.cancel();
    throw new StudioCodeError(
      400,
      "studio.code_receipt_invalid",
      `Could not read bounded ${SOURCE_RECEIPT_FILE} from the frozen build`,
    );
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (response.body)
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > MAX_SOURCE_RECEIPT_BYTES)
        throw new StudioCodeError(
          400,
          "studio.code_receipt_invalid",
          "Source receipt exceeds 128 KiB",
        );
      chunks.push(chunk);
    }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new StudioCodeError(
      400,
      "studio.code_receipt_invalid",
      `Invalid JSON in ${SOURCE_RECEIPT_FILE}; rebuild the project`,
    );
  }
  return parseSourceReceipt(value);
}
