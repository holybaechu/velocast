import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@velocast/react": fileURLToPath(
        new URL("./src/index.ts", import.meta.url),
      ),
      "@velocast/core/testing": fileURLToPath(
        new URL("../core/src/testing.ts", import.meta.url),
      ),
      "@velocast/core": fileURLToPath(
        new URL("../core/src/index.ts", import.meta.url),
      ),
    },
  },
  test: { environment: "jsdom" },
});
