import { defineConfig } from "@velocast/core";

export default defineConfig({
  entry: "index.html",
  renderer: {
    binary: "auto",
    acceleration: "required",
    concurrency: "auto",
    assembly: "segments",
    pixelFormat: "nv12",
  },
});
