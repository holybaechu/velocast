import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: false,
    outDir: "browser",
    lib: {
      entry: "src/global.ts",
      name: "VelocastGSAPBundle",
      formats: ["iife"],
      fileName: () => "velocast-gsap.global.js",
    },
    rollupOptions: {
      output: {
        extend: true,
      },
    },
  },
});
