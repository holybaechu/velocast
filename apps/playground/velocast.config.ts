import { defineConfig } from "@velocast/core";

export default defineConfig({
  entry: "index.html",
  renderer: {
    binary: "auto",
    acceleration: "auto",
    concurrency: 1,
    assembly: "reference",
    pixelFormat: "yuv420p",
  },
});
