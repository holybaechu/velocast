import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@velocast\/core$/,
        replacement: fileURLToPath(
          new URL("../core/src/index.ts", import.meta.url),
        ),
      },
      {
        find: /^@velocast\/core\/testing$/,
        replacement: fileURLToPath(
          new URL("../core/src/testing.ts", import.meta.url),
        ),
      },
    ],
  },
  test: {
    environment: "jsdom",
  },
});
