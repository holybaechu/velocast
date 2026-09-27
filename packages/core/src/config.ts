import type { Config } from "./types.js";

export function defineConfig<const T extends Config>(config: T): T {
  return config;
}
