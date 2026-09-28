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
    // Each media integration worker can own an Electron/Chrome process tree.
    maxWorkers: 4,
    exclude: [...configDefaults.exclude, ".tmp-*/**"],
  },
});
