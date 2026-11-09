# Velocast

Velocast is a video creation framework and local toolchain for JavaScript and
TypeScript. Author motion graphics, explainers, presentations, social videos, and
mixed-media compositions with React, GSAP, or plain JavaScript. Humans and agents
edit the same project files in Studio or a source editor, inspect exact frames,
and export through the Rust
renderer and Electron media host.

## Getting started

Use the Node.js, pnpm, and Rust versions in [mise.toml](mise.toml). From the
repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
cargo build -p velocast-renderer
pnpm velocast doctor
```

`pnpm build` builds the JavaScript packages; Cargo builds the native renderer.
Set `CARGO_TARGET_DIR` to a directory outside the checkout to keep native build
outputs there; the CLI also searches that directory for the renderer.

Rendering and media tests need Electron and its system dependencies. If dependency
installation skipped scripts, run
`node packages/electron-host/node_modules/electron/install.js`. For Linux display
libraries and sandbox setup, follow the commands in the
[workspace setup action](.github/actions/setup/action.yml).

Browser frame-check tests also need Chrome, Chromium, or Edge. Set
`VELOCAST_BROWSER_BINARY` to the executable if it is not discovered automatically.

Downloadable native releases are currently blocked in the
[release manifest](release/velocast-release.json). A complete local runtime bundle
can be installed without Rust or renderer environment variables:

```sh
velocast setup --from /absolute/path/velocast-native.tar.gz --sha256 <trusted-sha256>
velocast doctor
```

Get the bundle and its hash from a trusted builder. This explicitly trusts that
local archive; it is not a signed public release. Setup verifies its hash,
platform, version, and inventory before selecting the managed installation.
It remains usable offline after the archive is removed. `versions --json`
distinguishes this installation from public release availability. On Windows,
produce a bundle from a built checkout with the Visual Studio build tools available:

```sh
pnpm electron:package --renderer <renderer.exe> --electron packages/electron-host/node_modules/electron/dist --output <new-absolute-runtime-directory>
pnpm release:package-native win32-x64 <absolute-runtime-directory> <absolute-output.tar.gz>
```

Keep those build artifacts outside the checkout. The packager records the SHA-256
hash used by setup.

A local Cargo build or `VELOCAST_RENDERER_BINARY` also works during development.
`doctor --json` reports the selected runtime and its capabilities.

For an external project using a bare local renderer executable, also set
`VELOCAST_ELECTRON_HOST_SCRIPT` to this checkout's absolute
`packages/electron-host/main.cjs` path and `VELOCAST_ELECTRON_BINARY` to the pinned
Electron executable. Complete runtime bundles carry that layout themselves.

Try the included playground:

```sh
pnpm velocast studio --config apps/playground/velocast.config.ts
pnpm velocast compositions --config apps/playground/velocast.config.ts
pnpm velocast render product-hero --config apps/playground/velocast.config.ts --output ../product-hero.mp4
```

Use `pnpm velocast --help` for commands and `pnpm velocast render --help` for
render options.

## Create a video project

For a coding agent, run `velocast skills install` in an existing video project,
then reload its skills and ask it to make a video with `/velocast`. New projects
include the same skill in `.agents/skills/velocast`. It covers local media,
narration/captions, scene patterns, exact-frame inspection, Studio/MCP and recovery.
`velocast skills --json` lists its packaged files. After updating the CLI, run
`velocast skills update`; local edits stop an update before any files change.
Use `--directory <skills-root>` to install a separate copy for comparison or an
agent-specific location. Additional local files are retained.

With a working CLI and runtime, create a project outside the framework checkout:

```sh
velocast init my-video
cd my-video
npm install
npm run studio
```

Init writes files without installing dependencies. Matching Velocast packages must
be available from your package source; prerelease consumers need the matching
packed packages from this checkout. The native release limitation above also
applies to generated projects.

The default `product-demo` project contains ordinary React source: a 30-second
product video with images and local music, plus a portrait motion graphic.
Use `--template blank` for a ten-second React composition with one editable title.
Composition files live in `src`; register them in `src/main.jsx`.

In Studio, select a layer in the canvas or timeline, edit supported text, layout
or timing, and save. The changes write into the composition's JSX file. A file
location and read-only reason identify values controlled by custom code. Save
code in your editor to change arbitrary animation, components, or composition
dimensions. Export the complete video, a short range, or the current frame.

## Source editing in Studio

Wrap independently editable content in `Layer` from `@velocast/react`, with a
unique literal `id`. Map each composition to its source file in config:

```ts
export default defineConfig({
  entry: "dist/index.html",
  studio: { sources: { "product-demo": "src/product-demo.jsx" } },
  renderer: { snapshotRoot: "dist" },
});
```

Each mapped file belongs to one composition and must be inside the config's
directory. Include the build plugin in `vite.config.mjs`:

```js
import { studioSourcePlugin } from "velocast/vite";
import config from "./velocast.config.ts";
export default {
  base: "./",
  plugins: [studioSourcePlugin(config.studio.sources)],
};
```

The plugin records the source revisions used by each successful build. Studio
uses that record to prevent stale output after an edit, failed build, or
composition switch. Source editing currently requires this Vite integration;
other build tools can still produce ordinary renderable entries.

Use regular `writeBundle` hooks in other plugins. The receipt publisher rejects
competing `order: "post"` hooks, including output-only plugins, so source revisions
are published only after the other output hooks succeed.

Studio edits supported inline literals, preserving surrounding code
and comments. Computed expressions, spreads, repeated declarations, and complex
children remain code-controlled. Source inspection reports each field's value,
editability, and reason. Keep separate JSX nodes for independently editable
objects.

`Layer` provides absolute placement (`x`, `y`, `width`, `height`, `rotation`,
`opacity`), timing (`from`, `durationFrames`), and ordinary React children.
Its `style` uses normal CSS properties; overriding placement there makes the
corresponding placement control read-only. Use `StillImage` for decoded images
with deterministic first-frame handling, and `createMediaTimeline` for shared
audio/video timing. Assets belong in `public/assets` and use paths such as
`assets/shot.png` in source.

Saved edits and displayed builds are separate states. Wait for the completed
build before inspecting or exporting the change. Undo/redo retains 50 source
versions in `.velocast/source-history`, including observed external edits, across
server restarts. Add `.velocast/` to your project's ignore file. Playback,
selection, zoom, and ranges are session settings.

Writes check the current source revision and serialize cooperating writers.
Interrupted edits keep recoverable copies; Studio shows **Recover edit** only
when needed. Recovery preserves an externally recreated source file. A stale
edit must be reloaded and reapplied. Keep normal version control as well:
arbitrary editors holding old file handles do not participate in this lock.
The local filesystem must support hard links; unsupported filesystems fail
before replacement. A recovery interrupted while holding `recovery.lock` needs
manual attention: preserve the reported recovery directory, confirm that its
recorded process has stopped, then remove only that lock and retry recovery.

If an interrupted edit prevents the starter's initial build, run `velocast studio`
directly against the last completed build, recover, then restart `npm run studio`.
If no build remains, stop the project processes and preserve the history directory.
Its `pending.json` identifies the missing source and retained `<transaction>.source`
file; copy those retained bytes back only when the destination is absent, rebuild,
then use **Recover edit** to finish the journal. Preserve any existing destination.

Custom inputs remain ordinary code-owned JSON. `config.inputPropsFile` supplies
Studio and command defaults; `--input-props-file` overrides it. Config paths are
relative to the config file, command paths to the working directory. Studio
reads these inputs and refreshes completed snapshots; edit the file with your
source editor or agent.

## Authoring model

A **composition** has a stable ID, dimensions, frame rate, duration in frames, and
a source that can produce any requested frame. `defineReactComposition` adapts a
React component; `defineFrameComposition` accepts a plain JavaScript source with
`open`, `seekFrame`, optional `getAudioPlan`, and `dispose`. GSAP adapters seek a
paused timeline. `startVelocast` registers a project's composition definitions.

For example, a React composition can use a local frame to animate a title:

```jsx
import React from "react";
import {
  defineReactComposition,
  Layer,
  startVelocast,
  useCurrentFrame,
} from "@velocast/react";

function Title({ title }) {
  const frame = useCurrentFrame();
  return (
    <main
      style={{ width: 960, height: 540, background: "#142230", color: "white" }}
    >
      <Layer
        id="title"
        x={72}
        y={200}
        width={816}
        height={100}
        opacity={Math.min(1, frame / 15)}
        style={{ fontSize: 56 }}
      >
        {title}
      </Layer>
    </main>
  );
}

startVelocast([
  defineReactComposition({
    id: "title",
    video: { width: 960, height: 540, fps: 30, durationFrames: 90 },
    component: Title,
    defaultProps: { title: "Hello, video" },
  }),
]);
```

Frames start at zero. Ranges use an inclusive start and exclusive end.
`Sequence` scopes its children to a local frame; `interpolate` and `Easing` derive
motion from frames. Avoid wall-clock animation for renderable content.
In this example, placement literals are editable in Studio; `title` and animated
opacity are controlled by code. Replace `{title}` with literal text to edit the
text directly in Studio.

For custom compositions, default props merge shallowly with supplied JSON inputs;
`parseProps` validates the merged values. Inputs and assets are frozen for each
render session.
`resolveVideo` can resolve core composition metadata from that input snapshot.

`createMediaTimeline` in `@velocast/react` combines sequenced audio/video clips,
trimming, gain, and fades into a visual `Timeline` and an audio plan. Audio plan
positions count decoded sample frames at the plan's sample rate. `VideoClip` uses
the shared frame decoder for exact seeking. Mark silent video clips `muted: true`
to omit audio decoding. Await asynchronous frame resources
with `useFrameResource` or the composition's readiness hooks. Keep assets local
under the built `renderer.snapshotRoot`; remote resources are blocked by the
snapshot policy. Use local licensed fonts when typography must match across hosts.

## Studio, inspection, export, and verification

The starter's Studio script builds once, owns a build watcher, and prints a local
Studio URL. Completed source builds refresh the selected composition and frame.
A failed candidate keeps the previous working frame and reports the error.

Export shows progress, cancellation, and a link to the finished file.
Ctrl+C stops the server, watcher, and owned work. Completed files remain in
`.velocast/studio-output` or your chosen `--output-directory`.

Standalone commands work without Studio or agent setup. From the generated project:

```sh
npm run build
velocast compositions --json
velocast frame product-demo --frame 60 --output renders/slide.png --json
velocast render product-demo --start-frame 0 --end-frame 30 --output renders/clip.mp4 --json
velocast verify renders/clip.mp4 --expect-frames 30 --expect-fps 30 --expect-audio --json
```

Inspect the PNG and play the video with sound. `verify` checks media metadata,
frame count, timestamps, dimensions, and optional expectations; it does not judge
pixels or sound quality. It indexes up to two million frames. `check` separately
audits sampled DOM frames against layout, text, contrast, and motion assertions;
its JSON report describes the limits. Render JSON records the composition,
original requested frame/range, source version, result, and absolute output path.
Failed or cancelled renders preserve previous output before publication.
Encoding choices are explicit; codec availability depends on the host, and
hardware acceleration is a preference rather than a guarantee.

## Scripted clients and external agents

Start with `velocast capabilities --json`: command arguments and options come from
the live parser. Use command-specific `--help` for details and `doctor --json` for
runtime readiness. JSON commands exit nonzero on failure and provide a structured
report on stdout; diagnostics may also appear on stderr.

To connect an existing MCP-capable agent, start Studio and open **Connect agent**.
Copy its command and arguments into your agent's MCP server configuration. The
equivalent terminal command is:

```sh
velocast mcp --url http://127.0.0.1:3000
```

Use the actual Studio URL; `studio --port 3000` keeps that port stable. The MCP
process uses stdio and leaves Studio running when disconnected. It adds no model
or chat service. Enable it only for trusted local projects: source code runs
with the same permissions as the project's existing build and renderer.

An agent's normal sequence is:

1. Discover tools and call `studio_context` to select an explicit browser tab.
2. Read `studio_source` for editable fields, source revision, and recovery state.
   Request `includeSource` only for whole-file work.
3. Use `studio_edit` for supported literals or `studio_replace_source` for a
   mapped file. Other project files remain editable with the agent's own tools.
4. Wait for the project watcher and Studio to accept the completed build. Read
   fresh context after a conflict. Dirty drafts and build errors remain visible.
5. Use `studio_control` to select, seek, play, pause, or switch composition.
   Controls require the explicit tab and current revisions and wait for its
   acknowledgement. Pause tolerates playback advancing the state revision.
   If the browser blocks sound, click Play once in Studio to enable audio, then retry.
6. Call `studio_frame` at a paused, ready frame to inspect its PNG. It reports the
   displayed build and dirty state, and reuses a completed matching frame export.
7. Start `studio_render`, then use `studio_job` to wait for completion or cancel.
   Supply the tab and revision to require its clean, export-ready state.

For targeted visual work, `studio_inspect` reads one stable Layer ID in a paused,
clean tab. It combines resolved text, styles, bounds and parent/child information
with source values and editability reasons. It rejects duplicate rendered IDs and
changed frames rather than returning an ambiguous inspection.

`studio_animate` sets a `Layer.animation` track, inserts/replaces a keyframe, or
disables a property track. Supported numeric properties are `x`, `y`, `width`,
`height`, `rotation` and `opacity`. Keyframes use the Layer's local integer clock,
clamp at their ends, and support `linear`, `easeIn`, `easeOut` and `easeInOut`.
For example, `animation={{opacity: {keyframes: [{frame: 0, value: 0},
{frame: 15, value: 1}], easing: "easeOut"}}}` fades in over its first 15 frames.
Computed motion and style overrides remain code-owned. Animation edits use the
same source revision guards and durable history as literal edits.

Source write tools return a receipt distinguishing `saved`, `built` and
`displayed`. Pass `clientId` and optional `waitMs` to wait for that explicit tab,
or call `studio_wait_for_build` with the returned saved `revision`. A timeout
reports the stage actually reached; the saved edit remains applied. `superseded`
reports another source revision and `failed` reports syntax/recovery problems.
Display confirmation checks build and browser revisions; inspect a frame to
judge the pixels. No build command runs through MCP: the project's watcher still
owns compilation.

The same behavior is available over loopback HTTP. Start `studio --json`, then
read `GET /api/capabilities` at its URL for request limits and current operations:

| Operation                                            | Request / result                                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/session`                                   | Active immutable source version, snapshot URL, inputs, and saved file revision                                                             |
| `GET /api/changes`                                   | Current source revision hint                                                                                                               |
| `GET /api/code?compositionId=...`                    | Source file, revision, elements, supported fields and read-only reasons; disabled without a source mapping                                 |
| `POST /api/code`                                     | `{compositionId, expectedSourceVersion, expectedRevision, edits:[{id,field,value}]}`; guarded literal edits in one file                    |
| `POST /api/code/history`                             | `{compositionId, expectedSourceVersion, expectedRevision, action:"undo" or "redo"}`                                                        |
| `GET /api/inputs`                                    | Current saved input object, path, and revision; disabled without an explicit file                                                          |
| `POST /api/code/replace`                             | `{compositionId, expectedSourceVersion, expectedRevision, source}`; replaces one mapped source file                                        |
| `POST /api/code/recover`                             | `{compositionId, expectedSourceVersion}`; recovers a stopped interrupted write                                                             |
| `GET /api/clients`                                   | Connected tabs, presented frames, selection, revisions, drafts, and errors                                                                 |
| `POST /api/control`                                  | `{clientId, expectedRevision, expectedSourceVersion, action, ...}`; acknowledged browser control                                           |
| `POST /api/prepare-refresh`                          | `{expectedSourceVersion}`; candidate snapshot for validation                                                                               |
| `POST /api/commit-refresh` or `/api/discard-refresh` | `{expectedSourceVersion, candidateSessionId}`; accepts or releases the candidate                                                           |
| `POST /api/jobs`                                     | `{compositionId, expectedSourceVersion, frame}` or `{compositionId, expectedSourceVersion, range:{start,end}}`; returns HTTP 202 and a job |
| `GET /api/jobs` or `/api/jobs/:id`                   | Session job history or one job                                                                                                             |
| `POST /api/jobs/:id/cancel`                          | Cancels and waits for owned work to stop                                                                                                   |

Use `compositions --json` for composition metadata. Poll a submitted job until
`succeeded`, `failed`, or `cancelled`; intermediate states are `running` and
`cancelling`. Success includes `result.outputPath` and `result.url`; failure
includes `error.code` and `error.message`. Jobs survive HTTP disconnection.
The server serializes exports, retains 100 job records, and limits request bodies
and source-edit requests to 1 MiB. Stale versions or source revisions return HTTP 409:
read the current state, preserve other edits, and retry deliberately.

After a source edit, rebuild and check that the prepared session's
`codeRevisions[compositionId]` equals the saved source revision. Validate that
candidate in the browser
before committing it. Studio performs this sequence automatically;
scripted clients can use the documented CLI frame/check commands to diagnose
their changes. `POST /api/refresh` with `{expectedSourceVersion}` remains available
for clients that validate their build separately. Artifact URLs and job history
last for the server session; absolute output files survive shutdown.

## Compatibility

Update project scripts to `velocast studio`. The public server entry is
`velocast/studio`, exporting `createStudioServer`; browser applications use
`StudioApp` from `@velocast/studio`. The default output directory is
`.velocast/studio-output`. There are no command or package aliases.

New `product-demo` and `blank` projects use React source. Existing React/GSAP
projects continue to render through their authoring APIs. For supported React
source editing, add `Layer` boundaries, `studio.sources` mappings, and the Vite
plugin shown above. The structured project schema, JSON renderer/template,
mutable input form, media-import editor, and their HTTP mutations are removed.
Migrate those projects to React compositions using `Layer`, `StillImage`, and
`createMediaTimeline`; keep assets in `public/assets`. Custom `inputPropsFile`
remains supported as read-only Studio input.

## Project layout

| Directory                                     | Responsibility                                          |
| --------------------------------------------- | ------------------------------------------------------- |
| `apps/playground`                             | Example compositions                                    |
| `packages/core`, `react`, `gsap`              | Composition authoring and frame timing                  |
| `packages/cli`                                | Commands, project loading, rendering, and runtime setup |
| `packages/studio`                             | Source inspection, direct edits, playback and export    |
| `packages/remotion-compat`, `remotion-source` | Remotion compatibility and project integration          |
| `packages/electron-host`                      | Browser capture and media processing                    |
| `crates`                                      | Rust protocol, rendering policy, and renderer           |
| `contracts`                                   | Shared protocol definitions and generated-type inputs   |
| `scripts`, `release`                          | Build, verification, and release tooling and manifests  |

CLI internals are grouped into `authoring`, `project`, `render`, `runtime`,
`studio`, `mcp`, and `media`, with tests beside the implementation. `commands.ts` defines
the public package exports; `cli.ts` parses command-line arguments.

## Development

```sh
pnpm check:fast
cargo test -p velocast-renderer
```

`check:fast` checks generated contracts, Rust policy, TypeScript types, lint, and
JavaScript tests. On headless Linux, run it with `xvfb-run -a pnpm check:fast` after
the display setup above. Native capture, encoding, or audio changes also need
representative rendered-output checks on the affected platform.

Edit [contracts/renderer-protocol.json](contracts/renderer-protocol.json) and run
`pnpm contracts:generate` when changing shared wire types. See
[AGENTS.md](AGENTS.md) for contribution and validation requirements.

## License

[MIT](LICENSE). Third-party notices are in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
