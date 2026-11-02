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
      adapters: ["react", "gsap", "javascript", "project"],
      react: {
        definition: "@velocast/react defineReactComposition and startVelocast",
        editing:
          "Layer with a unique literal id; supported literals write back to JSX, computed values stay code-controlled",
        media:
          "StillImage for decoded stills; createMediaTimeline shares video/audio timing; muted video skips audio decoding",
        example: "velocast init my-video --template product-demo",
      },
      project: {
        format: "velocast-project",
        version: 1,
        parser: "@velocast/core parseVideoProject",
        renderer: "@velocast/react defineProjectCompositions",
        layers: ["text", "shape", "image", "video", "audio"],
        timing:
          "Nonoverlapping scene cuts in composition frames; layer frames relative to scene or composition; ranges fit their parent",
        editing:
          "Stable IDs; array order controls visual stacking; source project.json is shared with Studio",
        media:
          "Local relative asset paths; video assets require hasAudio; images use a fixed first/default frame; trimBeforeFrames, gain, fadeInFrames and fadeOutFrames",
        example: "velocast init my-video --template editable-project",
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
        "Source files and config.inputPropsFile are durable; selection, playback and canvas zoom are session-local",
      concurrency:
        "Version-gated edits and refreshes; one active export per Studio server",
      lifetime:
        "Jobs and URLs belong to the Studio server; completed output files survive shutdown",
    },
    runtime: {
      readiness: "velocast doctor --json",
      encoding: "Electron WebCodecs; codec availability depends on the host",
      acceleration: "auto and off are preferences; required is unsupported",
      releases:
        "Native downloads depend on a published verified release; local builds are supported",
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
