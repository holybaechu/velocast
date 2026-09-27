import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));
export default defineConfig({
  resolve: { alias: [
    { find: /^remotion$/, replacement: local("./src/remotion.tsx") },
    { find: /^@velocast\/react$/, replacement: local("../react/src/index.ts") },
    { find: /^@velocast\/core\/testing$/, replacement: local("../core/src/testing.ts") },
    { find: /^@velocast\/core$/, replacement: local("../core/src/index.ts") },
  ] },
  test: { environment: "jsdom" },
});
