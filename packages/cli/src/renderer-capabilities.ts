import { spawnSync } from "node:child_process";
import { assertElectronBrowserSelection } from "./electron-runtime.js";
import { isObjectRecord } from "./internal/validation.js";

export interface RendererCapabilitySupport {
  available: boolean;
  reason?: string;
  /** Explicit output API version; absence means the legacy render-only API. */
  outputApiVersion?: number;
  browserHosts?: Array<"electron">;
  defaultBrowserHost?: "electron";
  d3d11FfmpegEncoder?: {
    compiled: boolean;
    encoders?: Record<string, boolean>;
  };
}

export interface RendererCapabilitySpawnOptions {
  encoding: "utf8";
  env: NodeJS.ProcessEnv;
  maxBuffer: number;
  timeout: number;
  windowsHide: true;
}

export interface RendererCapabilitySpawnResult {
  error?: Error;
  status: number | null;
  stdout: string;
  stderr: string;
}

export type RendererCapabilitySpawn = (
  binary: string,
  args: string[],
  options: RendererCapabilitySpawnOptions,
) => RendererCapabilitySpawnResult;

/** Inspects an existing binary; the caller supplies an environment without staging. */
export function probeRendererCapabilities(
  binary: string,
  env: NodeJS.ProcessEnv,
  spawn: RendererCapabilitySpawn = spawnSync,
): RendererCapabilitySupport {
  try {
    assertElectronBrowserSelection(env);
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const result = spawn(binary, ["--capabilities-json"], {
    encoding: "utf8",
    env,
    maxBuffer: 1024 * 1024,
    timeout: 5_000,
    windowsHide: true,
  });
  if (result.error) {
    return {
      available: false,
      reason: `renderer capability probe failed: ${result.error.message}`,
    };
  }
  if (result.status !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== "");
    return {
      available: false,
      reason: `renderer capability probe exited with code ${result.status}${detail ? `: ${detail}` : ""}`,
    };
  }
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!isObjectRecord(parsed)) {
      return {
        available: false,
        reason: "renderer capability output was not a JSON object",
      };
    }
    if (
      !Array.isArray(parsed.browserHosts) ||
      parsed.browserHosts.length !== 1 ||
      parsed.browserHosts[0] !== "electron" ||
      parsed.defaultBrowserHost !== "electron" ||
      parsed.electronHostProtocolVersion !== 1
    ) {
      return {
        available: false,
        reason:
          "renderer.electron_unsupported: rebuild or install a renderer advertising Electron host protocol 1",
      };
    }
    const d3d11 = parsed.d3d11FfmpegEncoder;
    const browserSupport: Pick<
      RendererCapabilitySupport,
      "browserHosts" | "defaultBrowserHost"
    > = {
      ...(Array.isArray(parsed.browserHosts)
        ? { browserHosts: ["electron"] as Array<"electron"> }
        : {}),
      ...(parsed.defaultBrowserHost === "electron"
        ? { defaultBrowserHost: parsed.defaultBrowserHost }
        : {}),
    };
    const outputApiVersion =
      Number.isInteger(parsed.outputApiVersion) &&
      typeof parsed.outputApiVersion === "number"
        ? parsed.outputApiVersion
        : undefined;
    if (!isObjectRecord(d3d11))
      return {
        available: true,
        ...browserSupport,
        ...(outputApiVersion === undefined ? {} : { outputApiVersion }),
      };
    return {
      available: true,
      ...browserSupport,
      ...(outputApiVersion === undefined ? {} : { outputApiVersion }),
      d3d11FfmpegEncoder: {
        compiled: d3d11.compiled === true,
        encoders: isObjectRecord(d3d11.encoders)
          ? Object.fromEntries(
              Object.entries(d3d11.encoders).filter(
                (entry): entry is [string, boolean] =>
                  typeof entry[1] === "boolean",
              ),
            )
          : undefined,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      available: false,
      reason: `renderer capability output was not valid JSON: ${message}`,
    };
  }
}
