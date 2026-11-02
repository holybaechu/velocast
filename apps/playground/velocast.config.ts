import { defineConfig } from "@velocast/core";

export default defineConfig({
  entry: "dist/index.html",
  renderer: {
    snapshotRoot: "dist",
    binary: "auto",
    acceleration: "auto",
    concurrency: 1,
    assembly: "reference",
    pixelFormat: "yuv420p",
  },
});
