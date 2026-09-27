import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
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
  test: { environment: "jsdom" },
});
