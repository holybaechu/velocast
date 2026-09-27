import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tsxCli = join(packageRoot, "node_modules", "tsx", "dist", "cli.mjs");
describe("bin process adapter", () => {
  it("accepts a leading pnpm argument separator before the command", () => {
    const result = spawnSync(
      process.execPath,
      [tsxCli, "src/bin.ts", "--", "render", "product-hero"],
      {
        cwd: packageRoot,
        encoding: "utf8",
        env: { ...process.env, VELOCAST_DEBUG: "" },
      },
    );

    expect(result.status).toBe(1);
    expect(combinedOutput(result).trim()).toBe("--output is required");
  });

  it("prints command help and exits successfully", () => {
    const result = spawnSync(
      process.execPath,
      [tsxCli, "src/bin.ts", "--help"],
      {
        cwd: packageRoot,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("render <compositionId>");
    expect(result.stdout).toContain("render-url <url>");
    expect(result.stdout).toContain("probe-capture <compositionId>");
    expect(result.stdout).toContain("init <directory>");
    expect(result.stderr).toBe("");
  });

  it("rejects blank config paths with a clear error", () => {
    const result = spawnSync(
      process.execPath,
      [
        tsxCli,
        "src/bin.ts",
        "--",
        "render",
        "product-hero",
        "--config",
        " ",
        "--output",
        "renders/out.mp4",
      ],
      {
        cwd: packageRoot,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(combinedOutput(result)).toContain(
      "--config must be a non-empty string",
    );
  });

  it("prints error stacks when VELOCAST_DEBUG is enabled", () => {
    const configPath = join(
      tmpdir(),
      `velocast-debug-error-${process.pid}.config.ts`,
    );
    writeFileSync(
      configPath,
      'throw new Error("debug config failed"); export default {};',
    );

    const result = (() => {
      try {
        return spawnSync(
          process.execPath,
          [
            tsxCli,
            "src/bin.ts",
            "--",
            "render",
            "product-hero",
            "--config",
            configPath,
            "--output",
            join(tmpdir(), "velocast-debug-out.mp4"),
          ],
          {
            cwd: packageRoot,
            encoding: "utf8",
            env: { ...process.env, VELOCAST_DEBUG: "1" },
          },
        );
      } finally {
        rmSync(configPath, { force: true });
      }
    })();

    expect(result.status).toBe(1);
    expect(combinedOutput(result)).toContain("Error: debug config failed");
    expect(combinedOutput(result)).toContain("at ");
  });

  it("loads dependency-free TypeScript configs from render artifact folders", () => {
    const directory = mkdtempSync(join(tmpdir(), "velocast-artifact-config-"));
    const configPath = join(directory, "velocast.config.ts");
    writeFileSync(join(directory, "index.html"), "<!doctype html>");
    writeFileSync(
      configPath,
      `export default {
        entry: "index.html",
        renderer: {
          binary: "velocast-missing-renderer-binary",
        },
      };`,
    );

    const result = (() => {
      try {
        return spawnSync(
          process.execPath,
          [
            tsxCli,
            "src/bin.ts",
            "--",
            "render",
            "lesson-video",
            "--config",
            configPath,
            "--output",
            join(directory, "out.mp4"),
          ],
          {
            cwd: packageRoot,
            encoding: "utf8",
          },
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    })();

    expect(result.status).toBe(1);
    expect(combinedOutput(result)).toContain(
      "velocast-missing-renderer-binary",
    );
    expect(combinedOutput(result)).not.toContain(
      "__filename is not defined in ES module scope",
    );
  });
});

function combinedOutput(result: ReturnType<typeof spawnSync>): string {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}
