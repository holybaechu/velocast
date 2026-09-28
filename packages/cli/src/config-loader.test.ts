import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfigFromPath, resolveConfigPath } from "./config-loader.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await cleanupTempDirs();
});

describe("loadConfigFromPath", () => {
  it("loads a TypeScript config", async () => {
    const directory = await mkCliTempDir("velocast-config-");
    const configPath = join(directory, "velocast.config.ts");
    await writeFile(
      configPath,
      `export default {
        serve: {
          url: "http://127.0.0.1:9999",
        },
        renderer: {
          binary: "auto",
        },
      };`,
    );

    const config = await loadConfigFromPath(configPath);
    expect(config.serve?.url).toBe("http://127.0.0.1:9999");
    expect(config.renderer?.binary).toBe("auto");
  });

  it("resolves relative entry paths against the config file directory", async () => {
    const directory = await mkCliTempDir("velocast-config-entry-");
    const configPath = join(directory, "velocast.config.ts");
    await writeFile(join(directory, "index.html"), "<!doctype html>");
    await writeFile(
      configPath,
      `export default {
        entry: "index.html",
      };`,
    );

    const config = await loadConfigFromPath(configPath);

    expect(config.entry).toBe(join(directory, "index.html"));
  });

  it("loads the playground WebCodecs renderer defaults", async () => {
    const config = await loadConfigFromPath(
      "apps/playground/velocast.config.ts",
    );
    expect(config.renderer?.acceleration).toBe("auto");
    expect(config.renderer?.concurrency).toBe(1);
    expect(config.renderer?.pixelFormat).toBe("yuv420p");
  });

  it("resolves default config paths from the original invocation directory", async () => {
    const workspace = await mkCliTempDir("velocast-workspace-");
    const app = join(workspace, "apps", "demo");
    const packageCwd = join(workspace, "packages", "cli");
    await mkdir(app, { recursive: true });
    await mkdir(packageCwd, { recursive: true });
    await writeFile(join(workspace, "pnpm-workspace.yaml"), "");
    await writeFile(
      join(app, "velocast.config.ts"),
      `export default {
        serve: {
          url: "http://127.0.0.1:4545",
        },
      };`,
    );

    expect(
      resolveConfigPath("velocast.config.ts", {
        cwd: packageCwd,
        env: { INIT_CWD: app },
      }),
    ).toBe(join(app, "velocast.config.ts"));

    const config = await loadConfigFromPath("velocast.config.ts", {
      cwd: packageCwd,
      env: { INIT_CWD: app },
    });
    expect(config.serve?.url).toBe("http://127.0.0.1:4545");
  });

  it("rejects configs without a default export", async () => {
    const directory = await mkCliTempDir("velocast-config-");
    const configPath = join(directory, "velocast.config.ts");
    await writeFile(configPath, "export const config = {};");

    await expect(loadConfigFromPath(configPath)).rejects.toThrow(
      `config ${configPath} must export a default config`,
    );
  });

  it("rejects null or non-object default config exports", async () => {
    const directory = await mkCliTempDir("velocast-config-");
    const nullConfigPath = join(directory, "null.config.ts");
    const arrayConfigPath = join(directory, "array.config.ts");
    await writeFile(nullConfigPath, "export default null;");
    await writeFile(arrayConfigPath, "export default [];");

    await expect(loadConfigFromPath(nullConfigPath)).rejects.toThrow(
      `config ${nullConfigPath} must export a default config object`,
    );
    await expect(loadConfigFromPath(arrayConfigPath)).rejects.toThrow(
      `config ${arrayConfigPath} must export a default config object`,
    );
  });

  it("ignores blank cwd values when resolving config paths", () => {
    expect(
      resolveConfigPath("apps/playground/velocast.config.ts", {
        cwd: " ",
        env: {},
      }),
    ).toBe(
      resolve(process.cwd(), "../..", "apps/playground/velocast.config.ts"),
    );
  });

  it("rejects an empty config path", () => {
    expect(() => resolveConfigPath("  ")).toThrow(
      "--config must be a non-empty string",
    );
  });

  it("rejects non-string config paths from CLI parser edge cases", () => {
    expect(() => resolveConfigPath(true as unknown as string)).toThrow(
      "--config must be a non-empty string",
    );
  });
});

async function mkCliTempDir(prefix: string): Promise<string> {
  const cacheDir = join(process.cwd(), "node_modules", ".cache");
  await mkdir(cacheDir, { recursive: true });
  const dir = await mkdtemp(join(cacheDir, prefix));
  tempDirs.push(dir);
  return dir;
}

async function cleanupTempDirs(): Promise<void> {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
}
