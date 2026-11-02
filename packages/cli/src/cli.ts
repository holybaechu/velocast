import { cac } from "cac";
import type { Command } from "cac";
import { loadConfigFromPath } from "./project/config-loader.js";
import { initCommand } from "./authoring/init-command.js";
import {
  checkFramesCommand,
  type FrameCheckOptions,
} from "./authoring/frame-check.js";
import { templatesCommand } from "./authoring/template-catalog.js";
import { capabilitiesReport } from "./project/capabilities.js";
import { mcpCommand, type McpOptions } from "./mcp/mcp-command.js";
import {
  MediaVerificationError,
  verifyMediaCommand,
  type VerifyMediaOptions,
} from "./media/verify-command.js";
import {
  studioCommand,
  type StudioCommandOptions,
} from "./studio/studio-command.js";
import {
  failedOutputResult,
  OutputFailureError,
  printOutputResult,
  outputError,
} from "./render/output-result.js";
import { resolveCliOutputPath } from "./project/paths.js";
import type { RustRenderJob } from "./render/render-command-job.js";
import {
  doctorCommand,
  inspectCompositions,
  renderFrame,
  type InspectionCommandOptions,
  renderComposition,
  renderUrl,
  setupCommand,
  type RenderCommandOptions,
  versionsCommand,
} from "./commands.js";

export interface CliDependencies {
  verifyMediaCommand?: typeof verifyMediaCommand;
  studioCommand?: typeof studioCommand;
  inspectCompositions?: typeof inspectCompositions;
  renderFrame?: typeof renderFrame;
  initCommand?: typeof initCommand;
  loadConfigFromPath?: typeof loadConfigFromPath;
  doctorCommand?: typeof doctorCommand;
  renderComposition?: typeof renderComposition;
  renderUrl?: typeof renderUrl;
  setupCommand?: typeof setupCommand;
  versionsCommand?: typeof versionsCommand;
  checkFramesCommand?: typeof checkFramesCommand;
  templatesCommand?: typeof templatesCommand;
  mcpCommand?: typeof mcpCommand;
}

interface RenderOptions extends RenderCommandOptions {
  config: string;
  output?: string;
}

interface RenderUrlOptions extends RenderOptions {
  selector?: string;
}

interface JsonOptions {
  json?: boolean;
}
interface InspectionOptions extends InspectionCommandOptions {
  config: string;
}
interface FrameOptions extends InspectionOptions {
  frame?: string | number;
  output?: string;
}

/** Parse a Node-style argv and await its command without handling process exits. */
export async function runCli(
  argv: string[],
  dependencies: CliDependencies = {},
): Promise<void> {
  const cli = cac("velocast");
  const loadConfig = dependencies.loadConfigFromPath ?? loadConfigFromPath;
  cli
    .command(
      "capabilities",
      "Discover commands, authoring contracts and workflow constraints",
    )
    .option("--json", "Print machine-readable capability metadata")
    .action((options: JsonOptions) => {
      const report = capabilitiesReport(cli.commands);
      process.stdout.write(
        options.json
          ? `${JSON.stringify(report, null, 2)}\n`
          : `Author React, GSAP and JavaScript compositions. Frames start at 0; range ends are exclusive.\n\n${report.commands.map((command) => `${command.usage}\n  ${command.description}`).join("\n")}\n\nUse capabilities --json for contracts and examples; doctor --json checks this host.\n`,
      );
    });
  cli
    .command(
      "verify <input>",
      "Check video metadata and timestamps against explicit expectations",
    )
    .option("--expect-frames <number>", "Expected encoded video frame count")
    .option(
      "--expect-fps <number>",
      "Expected constant frame cadence starting at zero",
    )
    .option("--expect-width <number>", "Expected display width")
    .option("--expect-height <number>", "Expected display height")
    .option("--expect-audio", "Require an audio track")
    .option("--json", "Print machine-readable verification results")
    .action(async (input: string, options: VerifyMediaOptions) => {
      await (dependencies.verifyMediaCommand ?? verifyMediaCommand)(
        input,
        options,
      );
    });
  cli
    .command(
      "studio",
      "Open Velocast Studio to inspect, adjust and export compositions",
    )
    .option("--config <path>", "Config path", { default: "velocast.config.ts" })
    .option("--port <number>", "Loopback UI port (0 selects a free port)", {
      default: 0,
    })
    .option("--input-props-file <path>", "JSON composition input props")
    .option(
      "--output-directory <path>",
      "Frame/range output directory outside snapshotRoot",
    )
    .option(
      "--watch-command <command>",
      "Trusted persistent project build/watch command",
    )
    .option(
      "--no-auto-refresh",
      "Wait for manual Refresh source after a successful build",
    )
    .option("--json", "Print startup URL and session as JSON")
    .action(async (options: StudioCommandOptions & { config: string }) => {
      const config = await loadConfig(options.config);
      await (dependencies.studioCommand ?? studioCommand)(config, options);
    });
  cli
    .command(
      "mcp",
      "Connect an existing agent to a running Studio over MCP stdio",
    )
    .option("--url <url>", "Studio loopback URL shown by studio --json")
    .action(async (options: McpOptions) => {
      await (dependencies.mcpCommand ?? mcpCommand)(options);
    });
  let structuredRequest: Partial<RustRenderJob> | undefined;
  const remember = (
    operation: "render" | "inspect" | "frame",
    compositionId: string | undefined,
    output: string | undefined,
    json: boolean | undefined,
  ) => {
    if (json)
      structuredRequest = {
        operation,
        composition_id: compositionId ?? null,
        ...(output ? { output: resolveCliOutputPath(output) } : {}),
      };
  };

  const inspection = (
    command: string,
    description: string,
    single: boolean,
  ) => {
    const action = async (
      id: string | undefined,
      options: InspectionOptions,
    ) => {
      remember("inspect", id, undefined, options.json);
      const config = await loadConfig(options.config);
      await (dependencies.inspectCompositions ?? inspectCompositions)(
        config,
        id,
        options,
      );
    };
    const registration = cli
      .command(command, description)
      .option("--config <path>", "Config path", {
        default: "velocast.config.ts",
      })
      .option("--json", "Print structured output metadata")
      .option("--input-props-file <path>", "JSON composition input props");
    if (single)
      registration.action((id: string, options: InspectionOptions) =>
        action(id, options),
      );
    else
      registration.action((options: InspectionOptions) =>
        action(undefined, options),
      );
  };
  inspection("compositions", "List registered compositions", false);
  inspection(
    "inspect <compositionId>",
    "Inspect a composition's configuration",
    true,
  );
  cli
    .command(
      "frame <compositionId>",
      "Render one exact composition frame as PNG",
    )
    .option("--config <path>", "Config path", { default: "velocast.config.ts" })
    .option("--frame <number>", "Original composition frame (zero based)")
    .option("--output <path>", "Output PNG path")
    .option("--json", "Print structured output metadata")
    .option("--input-props-file <path>", "JSON composition input props")
    .action(async (id: string, options: FrameOptions) => {
      remember("frame", id, options.output, options.json);
      if (!options.output) throw new Error("--output is required");
      if (options.frame === undefined)
        throw new Error("output.invalid_frame: --frame is required");
      if (structuredRequest)
        structuredRequest.output_frame =
          typeof options.frame === "number"
            ? options.frame
            : Number(options.frame);
      const config = await loadConfig(options.config);
      await (dependencies.renderFrame ?? renderFrame)(
        config,
        id,
        options.output,
        options,
      );
    });

  cli
    .command(
      "init <directory>",
      "Create a video project without installing dependencies",
    )
    .option("--template <id>", "Starter template: product-demo or blank", {
      default: "product-demo",
    })
    .option("--json", "Print the created project as JSON")
    .action(
      async (
        directory: string,
        options: JsonOptions & {
          template: "product-demo" | "blank";
        },
      ) => {
        await (dependencies.initCommand ?? initCommand)(directory, {
          json: options.json,
          ...(options.template === "product-demo"
            ? {}
            : { template: options.template }),
        });
      },
    );

  cli
    .command("templates", "List packaged project templates and workflows")
    .option("--json", "Print machine-readable JSON")
    .action((options: JsonOptions) => {
      (dependencies.templatesCommand ?? templatesCommand)(options);
    });

  cli
    .command(
      "check <compositionId>",
      "Audit exact frames in a real browser against explicit assertions",
    )
    .option("--config <path>", "Config path", { default: "velocast.config.ts" })
    .option(
      "--frames <list>",
      "Comma-separated frames (default: first,middle,last)",
    )
    .option(
      "--assertions <path>",
      "JSON selector/layout/contrast/motion assertions",
    )
    .option("--input-props-file <path>", "JSON composition input props")
    .option("--snapshots <directory>", "Write inspected browser PNGs")
    .option("--browser <path>", "Chrome or Edge executable")
    .option(
      "--strict",
      "Fail on automatic text clipping, bounds, and contrast findings",
    )
    .option("--json", "Print machine-readable audit report")
    .action(
      async (
        compositionId: string,
        options: FrameCheckOptions & { config: string },
      ) => {
        const config = await loadConfig(options.config);
        await (dependencies.checkFramesCommand ?? checkFramesCommand)(
          config,
          compositionId,
          options,
        );
      },
    );

  cli
    .command("setup", "Install and verify the native runtime for this host")
    .option(
      "--from <archive>",
      "Install a complete trusted local runtime archive",
    )
    .option("--sha256 <hash>", "Expected SHA-256 of the trusted local archive")
    .option("--json", "Print machine-readable JSON")
    .action(
      async (options: JsonOptions & { from?: string; sha256?: string }) => {
        await (dependencies.setupCommand ?? setupCommand)({
          json: options.json,
          ...(options.from !== undefined ? { from: options.from } : {}),
          ...(options.sha256 !== undefined ? { sha256: options.sha256 } : {}),
        });
      },
    );

  cli
    .command("versions", "Show package, native, protocol and Electron versions")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: JsonOptions) => {
      await (dependencies.versionsCommand ?? versionsCommand)({
        json: options.json,
      });
    });

  addCommonRenderOptions(
    cli
      .command("render <compositionId>", "Render a registered composition")
      .option("--config <path>", "Config path", {
        default: "velocast.config.ts",
      })
      .option("--output <path>", "Output video path"),
  ).action(async (compositionId: string, options: RenderOptions) => {
    remember("render", compositionId, options.output, options.json);
    if (!options.output) {
      throw new Error("--output is required");
    }
    const config = await loadConfig(options.config);
    await (dependencies.renderComposition ?? renderComposition)(
      config,
      compositionId,
      options.output,
      options,
    );
  });

  addCommonRenderOptions(
    cli
      .command("render-url <url>", "Render a URL and selector")
      .option("--config <path>", "Config path", {
        default: "velocast.config.ts",
      })
      .option("--selector <selector>", "DOM selector")
      .option("--output <path>", "Output video path"),
  ).action(async (url: string, options: RenderUrlOptions) => {
    remember("render", undefined, options.output, options.json);
    if (!options.selector) {
      throw new Error("--selector is required");
    }
    if (!options.output) {
      throw new Error("--output is required");
    }
    const config = await loadConfig(options.config);
    await (dependencies.renderUrl ?? renderUrl)(
      config,
      url,
      options.selector,
      options.output,
      options,
    );
  });

  cli
    .command("doctor", "Check Velocast runtime readiness")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: JsonOptions) => {
      await (dependencies.doctorCommand ?? doctorCommand)({
        json: options.json,
      });
    });

  cli.help();
  try {
    cli.parse(argv, { run: false });
    if (!cli.matchedCommand && cli.args.length) {
      const command = cli.args[0];
      throw new Error(
        `cli.unknown_command: unknown command ${JSON.stringify(command)}; use capabilities --json or --help`,
      );
    }
    await cli.runMatchedCommand();
  } catch (error) {
    if (
      structuredRequest &&
      !(error instanceof OutputFailureError && error.reported)
    )
      printOutputResult(failedOutputResult(structuredRequest, error), true);
    else if (
      !structuredRequest &&
      argv.includes("--json") &&
      !(error instanceof MediaVerificationError) &&
      !(
        error instanceof Error &&
        error.message.startsWith("audit.assertions_failed:")
      )
    ) {
      const detail = outputError(error);
      process.stdout.write(
        JSON.stringify({
          apiVersion: 1,
          status: "failure",
          operation: cli.matchedCommandName ?? cli.args[0] ?? null,
          error: {
            ...detail,
            code:
              detail.code === "renderer.failed" ? "cli.failed" : detail.code,
          },
        }) + "\n",
      );
    }
    throw error;
  }
}

function addCommonRenderOptions(command: Command): Command {
  return command
    .option("--json", "Print structured output metadata")
    .option("--start-frame <number>", "Public range start, inclusive")
    .option("--end-frame <number>", "Public range end, exclusive")
    .option("--concurrency <workers>", "Renderer worker count or auto")
    .option("--codec <codec>", "Video codec: h264, hevc, av1, vp8, or vp9")
    .option("--container <format>", "Output container: mp4, mov, webm, or mkv")
    .option(
      "--audio-codec <codec>",
      "Audio codec: auto, aac, opus, mp3, flac, vorbis, pcm-s16, pcm-s24, or pcm-f32",
    )
    .option("--media-backend <backend>", "Media backend: auto or webcodecs")
    .option("--video-profile <profile>", "Video profile: auto")
    .option("--pixel-format <format>", "Output pixel format")
    .option("--bitrate <value>", "Target video bitrate, e.g. 60M or 12000k")
    .option(
      "--acceleration <mode>",
      "Encoding preference: auto or off; required is unsupported",
    )
    .option(
      "--assembly <mode>",
      "Renderer assembly mode: auto, reference, or segments",
    )
    .option("--report <path>", "Write a renderer telemetry report to this path")
    .option("--events <path>", "Write renderer JSONL events to this path")
    .option(
      "--input-props-file <path>",
      "JSON file containing composition input props",
    )
    .option(
      "--verify-segments",
      "Compatibility flag; output metadata checks always run",
    );
}
