/** Known integration families; future versions require validation before admission. */
export interface RemotionIntegrationProfile {
  readonly id: "legacy-4" | "modern-4";
  readonly serialize: "serializeJSONWithDate" | "serializeJSONWithSpecialTypes";
  readonly deserialize:
    "deserializeJSONWithCustomFields" | "deserializeJSONWithSpecialTypes";
  readonly serverThreads: "concurrency" | "offthreadVideoThreads";
  readonly reactMajors: readonly number[];
  readonly metadataLogLevelBug: boolean;
  readonly browserClose: "positional" | "options";
}

export const SUPPORTED_REMOTION_VERSIONS = "4.0.244 or 4.0.526–4.0.529";

export function selectRemotionIntegrationProfile(
  version: string,
): RemotionIntegrationProfile {
  if (version === "4.0.244")
    return {
      id: "legacy-4",
      serialize: "serializeJSONWithDate",
      deserialize: "deserializeJSONWithCustomFields",
      serverThreads: "concurrency",
      reactMajors: [18],
      metadataLogLevelBug: true,
      browserClose: "positional",
    };
  if (/^4\.0\.(526|527|528|529)$/.test(version))
    return {
      id: "modern-4",
      serialize: "serializeJSONWithSpecialTypes",
      deserialize: "deserializeJSONWithSpecialTypes",
      serverThreads: "offthreadVideoThreads",
      reactMajors: [18, 19],
      metadataLogLevelBug: false,
      browserClose: "options",
    };
  throw new Error(
    `Unsupported Remotion version ${version}. Supported integration profiles: ${SUPPORTED_REMOTION_VERSIONS}. Install matching remotion, @remotion/bundler and @remotion/renderer versions in the entry project's dependencies.`,
  );
}
