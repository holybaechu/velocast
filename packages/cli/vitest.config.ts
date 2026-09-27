import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@velocast\/core$/,
        replacement: fileURLToPath(
          new URL("../core/src/index.ts", import.meta.url),
        ),
      },
    ],
  },
  test: {
    exclude: [...configDefaults.exclude, ".tmp-*/**"],
  },
});
