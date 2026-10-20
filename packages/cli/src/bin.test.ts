import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tsxCli = join(packageRoot, "node_modules", "tsx", "dist", "cli.mjs");
describe("bin process adapter", () => {
  it.skipIf(process.platform === "win32").each(["renderer", "serve readiness"])(
    "joins owned work and preserves output when SIGINT interrupts %s",
    async (phase) => {
      const root = mkdtempSync(join(tmpdir(), "velocast-bin-cancellation-"));
      const renderer = join(root, "renderer");
      const output = join(root, "output.mp4");
      const heartbeat = join(root, "heartbeat");
      const pidPath = join(root, "work.pid");
      const observed = join(root, "cancellation-observed");
      const listeners = join(root, "listeners.json");
      const configPath = join(root, "config.mjs");
      const capabilities = {
        outputApiVersion: 1,
        browserHosts: ["electron"],
        defaultBrowserHost: "electron",
        electronHostProtocolVersion: 5,
        videoEncoderBackend: "webcodecs",
        supportedMediaBackends: ["webcodecs"],
        mediaRuntime: "mediabunny",
        hardwareAccelerationGuarantee: false,
      };
      writeFileSync(
        renderer,
        `#!${process.execPath}
const fs = require("node:fs");
if (process.argv.includes("--capabilities-json")) {
  console.log(${JSON.stringify(JSON.stringify(capabilities))});
  process.exit(0);
}
const serving = process.argv.includes("--serve");
if (serving) process.on("SIGTERM", () => {});
const job = serving ? null : JSON.parse(process.argv[process.argv.indexOf("--job-json") + 1]);
fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
fs.writeFileSync(${JSON.stringify(heartbeat)}, ".");
setInterval(() => {
  if (job && fs.existsSync(job.event_log_path + "." + process.pid + ".cancel")) {
    fs.writeFileSync(${JSON.stringify(observed)}, "cancelled before publication");
    process.exit(1);
  }
  fs.appendFileSync(${JSON.stringify(heartbeat)}, ".");
}, 5);
if (job) setTimeout(() => fs.writeFileSync(job.output, "late output"), 300);
`,
      );
      chmodSync(renderer, 0o755);
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      const config = {
        renderer: { binary: renderer },
        ...(phase === "serve readiness"
          ? {
              serve: {
                url: "http://127.0.0.1:1",
                command: `${quote(renderer)} --serve; wait`,
              },
            }
          : {}),
      };
      writeFileSync(
        configPath,
        `import { writeFileSync } from "node:fs";
const count = () => [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
const before = count();
process.once("beforeExit", () => writeFileSync(${JSON.stringify(listeners)}, JSON.stringify({before, after: count()})));
export default ${JSON.stringify(config)};
`,
      );
      writeFileSync(output, "previous output");
      const command =
        phase === "renderer"
          ? ["render-url", "http://127.0.0.1:4545", "--selector", "#main"]
          : ["render", "Intro"];
      const owner = spawn(
        process.execPath,
        [
          tsxCli,
          "src/bin.ts",
          ...command,
          "--config",
          configPath,
          "--output",
          output,
        ],
        {
          cwd: packageRoot,
          env: {
            ...process.env,
            TSX_DISABLE_CACHE: "1",
            VELOCAST_ELECTRON_BINARY: process.execPath,
            VELOCAST_ELECTRON_HOST_SCRIPT: join(
              packageRoot,
              "../electron-host/main.cjs",
            ),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stderr = "";
      owner.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const exited = new Promise<number | null>((resolve, reject) => {
        owner.once("error", reject);
        owner.once("close", resolve);
      });
      try {
        await vi.waitFor(
          () => expect(existsSync(heartbeat), stderr).toBe(true),
          { timeout: 5_000 },
        );
        owner.kill("SIGINT");
        expect(await exited).not.toBe(0);
        expect(stderr).toContain("cancelled");
        const stopped = readFileSync(heartbeat, "utf8");
        await delay(500);
        expect(readFileSync(heartbeat, "utf8")).toBe(stopped);
        expect(readFileSync(output, "utf8")).toBe("previous output");
        if (phase === "renderer") expect(existsSync(observed)).toBe(true);
        else expect(existsSync(observed)).toBe(false);
        const counts = JSON.parse(readFileSync(listeners, "utf8"));
        expect(counts.after).toEqual(counts.before);
      } finally {
        owner.kill("SIGKILL");
        await exited.catch(() => {});
        if (existsSync(pidPath)) {
          const pid = Number(readFileSync(pidPath, "utf8"));
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              // The owned process may already have exited.
            }
          }
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
    10_000,
  );

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
