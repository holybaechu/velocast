import { cac } from "cac";
import type { Command } from "cac";
import { loadConfigFromPath } from "./config-loader.js";
import { initCommand } from "./init-command.js";
import { auditCommand, type AgentAuditOptions } from "./agent-audit.js";
import {
  analyzeMusicCommand,
  type AnalyzeMusicCommandOptions,
} from "./music-analysis.js";
import { installSkillCommand } from "./skill-install.js";
import { templatesCommand } from "./template-catalog.js";
import {
  importTranscriptCommand,
  type TranscriptImportOptions,
} from "./timestamps.js";
import {
  previewCommand,
  type PreviewCommandOptions,
} from "./preview-command.js";
import {
  failedOutputResult,
  OutputFailureError,
  printOutputResult,
} from "./output-result.js";
import { resolveCliOutputPath } from "./paths.js";
import type { RustRenderJob } from "./render-command-job.js";
import {
  doctorCommand,
  inspectCompositions,
  renderFrame,
  type InspectionCommandOptions,
  probeCapture,
  renderComposition,
  renderUrl,
  setupCommand,
  type ProbeCaptureCommandOptions,
  type RenderCommandOptions,
  versionsCommand,
} from "./commands.js";

export interface CliDependencies {
  previewCommand?: typeof previewCommand;
  inspectCompositions?: typeof inspectCompositions;
  renderFrame?: typeof renderFrame;
  initCommand?: typeof initCommand;
  loadConfigFromPath?: typeof loadConfigFromPath;
  doctorCommand?: typeof doctorCommand;
  probeCapture?: typeof probeCapture;
  renderComposition?: typeof renderComposition;
  renderUrl?: typeof renderUrl;
  setupCommand?: typeof setupCommand;
  versionsCommand?: typeof versionsCommand;
  auditCommand?: typeof auditCommand;
  analyzeMusicCommand?: typeof analyzeMusicCommand;
  installSkillCommand?: typeof installSkillCommand;
  templatesCommand?: typeof templatesCommand;
  importTranscriptCommand?: typeof importTranscriptCommand;
}

interface RenderOptions extends RenderCommandOptions {
  config: string;
  output?: string;
}

interface RenderUrlOptions extends RenderOptions {
  selector?: string;
}

interface ProbeOptions extends ProbeCaptureCommandOptions {
  config: string;
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
    .command("preview", "Play, seek and inspect an immutable project version")
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
    .action(async (options: PreviewCommandOptions & { config: string }) => {
      const config = await loadConfig(options.config);
      await (dependencies.previewCommand ?? previewCommand)(config, options);
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
      "Create a React project without installing dependencies",
    )
    .option("--template <id>", "Starter template: react-static or lyrics", {
      default: "react-static",
    })
    .option(
      "--audio <path>",
      "Local audio copied into a lyrics project and analyzed",
    )
    .option("--lyrics <path>", "Supplied SRT, VTT, or JSON timed text")
    .option("--json", "Print the created project as JSON")
    .action(
      async (
        directory: string,
        options: JsonOptions & {
          template: "react-static" | "lyrics";
          audio?: string;
          lyrics?: string;
        },
      ) => {
        await (dependencies.initCommand ?? initCommand)(directory, {
          json: options.json,
          ...(options.template === "react-static"
            ? {}
            : { template: options.template }),
          ...(options.audio ? { audio: options.audio } : {}),
          ...(options.lyrics ? { lyrics: options.lyrics } : {}),
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
      "skill <action> [directory]",
      "Install the Velocast agent workflow into a project",
    )
    .option("--json", "Print the installed project path as JSON")
    .action(
      async (
        action: string,
        directory: string | undefined,
        options: JsonOptions,
      ) => {
        if (action !== "install")
          throw new Error("skill.invalid_action: expected 'install'");
        await (dependencies.installSkillCommand ?? installSkillCommand)(
          directory ?? ".",
          options,
        );
      },
    );

  cli
    .command(
      "transcript <action> <input>",
      "Validate SRT, VTT, or JSON timed text",
    )
    .option("--output <path>", "New normalized JSON output path")
    .option("--format <format>", "Input format: srt, vtt, or json")
    .option(
      "--overwrite",
      "Atomically replace an existing normalized JSON file",
    )
    .option("--json", "Print machine-readable JSON")
    .action(
      async (
        action: string,
        input: string,
        options: TranscriptImportOptions,
      ) => {
        if (action !== "import")
          throw new Error("transcript.invalid_action: expected 'import'");
        if (!options.output) throw new Error("--output is required");
        await (dependencies.importTranscriptCommand ?? importTranscriptCommand)(
          input,
          options,
        );
      },
    );

  cli
    .command(
      "analyze-audio <input>",
      "Measure bounded RMS energy and onset candidates from local audio",
    )
    .option("--output <path>", "New analysis JSON output path")
    .option("--max-duration <seconds>", "Maximum decoded duration", {
      default: 900,
    })
    .option("--overwrite", "Atomically replace an existing analysis JSON file")
    .option("--json", "Print machine-readable JSON")
    .action(async (input: string, options: AnalyzeMusicCommandOptions) => {
      if (!options.output) throw new Error("--output is required");
      await (dependencies.analyzeMusicCommand ?? analyzeMusicCommand)(
        input,
        options,
      );
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
        options: AgentAuditOptions & { config: string },
      ) => {
        const config = await loadConfig(options.config);
        await (dependencies.auditCommand ?? auditCommand)(
          config,
          compositionId,
          options,
        );
      },
    );

  cli
    .command("setup", "Download and verify the native runtime for this host")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: JsonOptions) => {
      await (dependencies.setupCommand ?? setupCommand)({ json: options.json });
    });

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

  cli
    .command(
      "probe-capture <compositionId>",
      "Probe native accelerated browser capture",
    )
    .option("--config <path>", "Config path", { default: "velocast.config.ts" })
    .option("--report <path>", "Write a renderer telemetry report to this path")
    .option(
      "--input-props-file <path>",
      "JSON file containing composition input props",
    )
    .action(async (compositionId: string, options: ProbeOptions) => {
      const config = await loadConfig(options.config);
      await (dependencies.probeCapture ?? probeCapture)(
        config,
        compositionId,
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
    await cli.runMatchedCommand();
  } catch (error) {
    if (
      structuredRequest &&
      !(error instanceof OutputFailureError && error.reported)
    )
      printOutputResult(failedOutputResult(structuredRequest, error), true);
    throw error;
  }
}

function addCommonRenderOptions(command: Command): Command {
  return command
    .option("--json", "Print structured output metadata")
    .option("--start-frame <number>", "Public range start, inclusive")
    .option("--end-frame <number>", "Public range end, exclusive")
    .option("--concurrency <workers>", "Renderer worker count or auto")
    .option(
      "--codec <codec>",
      "Video codec: h264, hevc, av1, or a supported encoder name",
    )
    .option("--pixel-format <format>", "Output pixel format")
    .option("--bitrate <value>", "Target video bitrate, e.g. 60M or 12000k")
    .option(
      "--acceleration <mode>",
      "Renderer acceleration mode: required, auto, or off",
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
      "Probe segment streams and final frame count after remux",
    );
}
