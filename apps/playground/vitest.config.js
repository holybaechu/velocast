import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@velocast\/core$/,
        replacement: fileURLToPath(
          new URL("../../packages/core/src/index.ts", import.meta.url),
        ),
      },
      {
        find: /^@velocast\/core\/testing$/,
        replacement: fileURLToPath(
          new URL("../../packages/core/src/testing.ts", import.meta.url),
        ),
      },
      {
        find: /^@velocast\/gsap$/,
        replacement: fileURLToPath(
          new URL("../../packages/gsap/src/index.ts", import.meta.url),
        ),
      },
    ],
  },
});
