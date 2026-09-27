import { fileURLToPath } from "node:url";
/** Exact bare-specifier alias: pinned utilities and plugin imports retain their own identities. */
export function remotionCompatibilityViteConfig() {
  return {
    resolve: {
      alias: [
        {
          find: /^remotion$/,
          replacement: fileURLToPath(new URL("./remotion.js", import.meta.url)),
        },
      ],
      dedupe: ["react", "react-dom"],
    },
  };
}

type Alias = { readonly find: string | RegExp; readonly replacement: string };
type ViteLikeConfig = {
  readonly resolve?: {
    readonly alias?: readonly Alias[] | Readonly<Record<string, string>>;
    readonly dedupe?: readonly string[];
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
};

/** Add the exact Remotion alias to an existing Vite config without dropping its plugins. */
export function withRemotionCompatibilityViteConfig<T extends ViteLikeConfig>(
  config: T,
) {
  const compatibility = remotionCompatibilityViteConfig().resolve;
  const existingAliases = config.resolve?.alias;
  const aliases: Alias[] = Array.isArray(existingAliases)
    ? [...existingAliases]
    : Object.entries(existingAliases ?? {}).map(([find, replacement]) => ({
        find,
        replacement,
      }));
  return {
    ...config,
    resolve: {
      ...config.resolve,
      alias: [...compatibility.alias, ...aliases],
      dedupe: [
        ...new Set([
          ...compatibility.dedupe,
          ...(config.resolve?.dedupe ?? []),
        ]),
      ],
    },
  };
}
