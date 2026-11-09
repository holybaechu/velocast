import type { Command } from "cac";
import { TEMPLATE_CATALOG } from "../authoring/template-catalog.js";
import {
  BROWSER_PROTOCOL_VERSION,
  OUTPUT_API_VERSION,
} from "../generated/renderer-contracts.js";

/** Command names, arguments and options come from the parser used to execute them. */
export function capabilitiesReport(commands: readonly Command[]) {
  return {
    apiVersion: 1,
    browserProtocolVersion: BROWSER_PROTOCOL_VERSION,
    outputApiVersion: OUTPUT_API_VERSION,
    authoring: {
      default: "react",
      adapters: ["react", "gsap", "javascript"],
      react: {
        definition: "@velocast/react defineReactComposition and startVelocast",
        editing:
          "Layer with a unique literal id; supported literals write back to JSX, computed values stay code-controlled",
        media:
          "StillImage for decoded stills; createMediaTimeline shares video/audio timing; muted video skips audio decoding",
        example: "velocast init my-video --template product-demo",
      },
      composition:
        "Stable ID, dimensions, fps, durationFrames and a frame-derived source",
      inputs:
        "config.inputPropsFile selects saved JSON for all operations; --input-props-file overrides it. Custom composition defaults merge shallowly.",
      timing: {
        firstFrame: 0,
        rangeEnd: "exclusive",
        audioUnit: "sample frames",
      },
      assets:
        "Keep assets local to renderer.snapshotRoot for reproducible snapshot rendering",
    },
    commands: commands.map((command) => ({
      name: command.name,
      usage: `velocast ${command.rawName}`,
      description: command.description,
      arguments: command.args.map((argument) => ({
        name: argument.value,
        required: argument.required,
        variadic: argument.variadic,
      })),
      options: command.options.map((option) => ({
        flag: option.rawName,
        description: option.description,
        ...(option.config.default === undefined
          ? {}
          : { default: option.config.default }),
      })),
    })),
    templates: TEMPLATE_CATALOG,
    studio: {
      source:
        "Built static entry with renderer.snapshotRoot; source adapter studio is unsupported",
      discovery: "GET /api/capabilities at the URL printed by studio --json",
      codeEditing:
        "Map composition IDs in config.studio.sources and build with studioSourcePlugin from velocast/vite. GET /api/code reports fields and revisions; saved source must match the displayed build receipt before export.",
      persistence:
        "Mapped source files and durable recovery history are shared. Generic input files remain code-owned. Browser selection and playback are exposed as explicit client contexts",
      concurrency:
        "Version-gated edits and refreshes; one active export per Studio server",
      lifetime:
        "Jobs and URLs belong to the Studio server; completed output files survive shutdown",
    },
    agent: {
      skill: {
        name: "velocast",
        install: "velocast skills install",
        update: "velocast skills update",
        directory: ".agents/skills/velocast",
        scaffolding:
          "init includes the packaged skill; updates preserve local modifications",
      },
      transport: "MCP stdio using velocast mcp --url <Studio URL>",
      connection:
        "Connect agent in Studio supplies command and args for an existing MCP-capable agent",
      context:
        "Explicit browser client IDs, presented frame, selection, drafts and errors; controls require matching context/source revisions and browser acknowledgement",
      source:
        "Guarded literal or whole-file writes to explicitly mapped sources; durable undo and recovery",
      images:
        "studio_frame returns exact-frame PNG content, reusing completed matching jobs",
      inspection:
        "studio_inspect combines guarded source fields with resolved DOM bounds/styles and Layer hierarchy in an explicit paused tab",
      animation:
        "studio_animate sets, upserts keyframes or disables numeric Layer.animation tracks through guarded source writes and durable history",
      confirmation:
        "Source-write receipts distinguish saved, built and displayed; studio_wait_for_build follows one exact source revision without claiming a timeout was displayed",
      lifecycle:
        "MCP shutdown leaves the existing Studio and its exports running",
    },
    runtime: {
      readiness: "velocast doctor --json",
      encoding: "Electron WebCodecs; codec availability depends on the host",
      acceleration: "auto and off are preferences; required is unsupported",
      releases:
        "Native downloads depend on a published verified release; setup --from <archive> --sha256 <trusted-hash> installs a complete trusted local bundle without build tools",
    },
    examples: [
      "velocast init my-video --json",
      "velocast compositions --json",
      "velocast frame product-demo --frame 30 --output frame.png --json",
      "velocast render product-demo --start-frame 0 --end-frame 30 --output clip.mp4 --json",
      "velocast verify clip.mp4 --expect-frames 30 --expect-fps 30 --expect-audio --json",
    ],
  };
}
