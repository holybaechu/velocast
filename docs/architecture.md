# Architecture and development boundaries

Velocast's public workflow is code authoring → exact frame/range checks → preview
→ complete video output. The engine shares frame, range, props, readiness, and
media semantics across authoring helpers and output routes. It does not require
ordinary React authors to choose an adapter or manage the browser protocol.

## Request flow

Node project integrations use `Config.source` and the common `SourceAdapter`
interface. They prepare composition metadata, a browser frame source or reference
capture callbacks, optional finished audio, and owned cleanup. CLI and Node
`compositions`, `inspect`, `frame`, and `render` calls share the coordinator in
`packages/cli/src/source-adapter.ts`. Browser frame adapters remain the separate
interface for seeking a prepared composition.

`@velocast/remotion-source` implements the Node interface using the entry
project's installed upstream packages. Its version profiles contain the
serializer, server, browser, and cleanup differences. The bounded JSX bridge in
`@velocast/remotion` keeps its own legacy dependencies.

```text
Declarative React / GSAP / Remotion / custom composition definitions
    → static build + frozen source and input-props session
    → one browser bootstrap, composition catalog, seek and readiness
        → preview playback
        → inspect | PNG frame | reference range | complete render
            → native capture, encode, audio, validation, publication
```

Preview renders the same registered browser compositions and uses the common
audio plan. Its frame/range output actions call the official output path; playback
in a browser alone is not proof of native capture or encoder correctness.

| Boundary                     | Owner                                                                                           | Observable contract                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Project creation             | `packages/cli/src/init-command.ts`, `templates/react-static.ts`                                 | One official React starter; refuses populated targets; no installation or rendering side effects             |
| Common semantics             | `packages/core/src/time.ts`, `interpolation.ts`, `audio-plan.ts`                                | Half-open ranges, explicit time conversion, shared motion and sample-plan rules                              |
| Project catalog and runtime  | `packages/core/src/project.ts`, `browser-protocol.ts`, `runtime.ts`                             | Pure composition definitions, atomic catalog publication, frame-source sessions, seek, cancellation, destroy |
| React authoring              | `packages/react/src/composition.tsx`, `frame-state.tsx`, `sequence.tsx`                         | Requested frame/props commit, local Sequence time, owned resources and root                                  |
| GSAP integration             | `packages/gsap/src/index.ts`                                                                    | Lazy timeline factory for project definitions; seek by `frame / fps`                                         |
| Remotion bridge              | `packages/remotion-compat/src/index.tsx`, `remotion.tsx`                                        | Pinned compatibility slice and explicit host metadata, not arbitrary JSX discovery                           |
| CLI parsing and job creation | `packages/cli/src/cli.ts`, `render-command-job.ts`, `renderer-options.ts`                       | Public options/precedence to validated native job                                                            |
| Snapshot and preview session | `packages/cli/src/input-snapshot.ts`, `preview-server.ts`; `packages/preview/src/controller.ts` | Source identity, isolated sessions, refresh/seek cancellation and owned output requests                      |
| Wire contract                | `contracts/renderer-protocol.json`                                                              | Generated TypeScript/Rust representations and actual cross-language conformance                              |
| Scheduling and routing       | `crates/renderer-policy`                                                                        | Plans from explicit facts, without native discovery dependencies                                             |
| Activation and execution     | `crates/renderer/src/pipeline/encoder_backends.rs`, `frame_loop.rs`                             | Actual opened backend, frame accounting and reported fallback                                                |
| Lifetime and publication     | `crates/renderer/src/render_job.rs`, `output_workspace.rs`, `segment.rs`                        | Await owned workers, validate staged output, preserve previous output on pre-publication failure             |

Paths in this table are repository-relative. Start with the owning boundary;
change a shared contract only when its observable behavior changes.

## Authoring and frame semantics

`defineReactComposition({ id, video, component, ... })` is the official React
definition. `startVelocast` validates the project catalog and installs the browser
protocol once. The helper owns the React root and frame source. The author supplies
the component, width/height/FPS/duration, and optional target/default props/fonts/
preload/audio. It commits the requested frame rather than mounting a guessed
initial frame. `useCurrentFrame()` reads local Sequence time;
`useVideoConfig()` and props remain composition-global. The helper re-exports core
interpolation/easing rather than defining a competing numerical implementation.

`Sequence` uses `[from, from + durationFrames)`, clips through every ancestor,
unmounts inactive children, and adds no DOM wrapper. Direct, repeated, and reverse
seeks must not rely on accumulated playback state. Registered fonts prepare before
layout effects. Asynchronous work must use the awaited resource/preload contract;
arbitrary effects or inner Suspense fallbacks are not general readiness signals.
See [React semantics](../packages/react/README.md).

A framework integration may use `defineFrameComposition` with one source that
opens a frame session, seeks frames, resolves optional audio, and disposes. Its
definition is inert until project startup. Core owns frame normalization,
lifecycle serialization, props snapshots, session state, and cancellation.
`resolveVideo` can derive metadata from the frozen props before discovery. The
older `registerFrameAdapter` interface remains available for existing projects.

GSAP authors can use `defineGsapComposition` with a lazy timeline factory; frame
seeking positions it. `registerGsapTimeline` remains for existing projects. No implicit global timeline discovery is part
of the supported authoring path. The official starter comes from CLI `init`, not
a second package template.

Remotion compatibility is separate from official React authoring. The bridge pins
Remotion **4.0.244** and React/ReactDOM **18.3.1**, uses an exact bare-`remotion`
alias, and requires explicit host metadata through `defineRemotionComposition`
or the older `registerRemotionComposition`.
`registerRoot` may bind identity; it does not discover arbitrary root JSX.
Upstream math/DOM exports and the frame/Sequence/image/font-delay behavior remain
bounded. The verified 4.0.526-style subset adds video, modern media names, prepared
volume callbacks, Series and Loop; the bundler helper preserves an exact alias.
Unsupported options fail
instead of silently approximating the whole Remotion ecosystem. See the
[compatibility contract](../packages/remotion-compat/README.md).

## Input, preview, and output

A configured `renderer.snapshotRoot` freezes the static entry tree and props into
a versioned source for all workers. Assets and media resolve within the owned
source boundary. A live/unversioned source must not be assigned a fabricated
digest. The session and source identity also accompany structured output results.

`velocast preview` serves a loopback player and owns its source session. The
starter's preview script builds once and starts a persistent build watcher.
Source refresh follows settled rebuilds: preflight the new snapshot at the selected
frame before committing it, invalidate stale work, retain the frame, and resume
previous playback. A failed preflight preserves the active snapshot. Manual
refresh pauses playback and `--no-auto-refresh` disables following source changes.
Element inspection reads the composition through session-bound RPC; highlighting
lives outside the captured iframe. Ctrl+C closes the owned
server/watch/jobs without deleting completed outputs. This is a code-editing and
playback workflow, not a visual timeline editor.

The public CLI output operations are `compositions`, `inspect`, `frame`, and
`render`. A frame is zero-based; a range supplies both inclusive-start and
exclusive-end bounds. A range keeps original source frame numbers/configuration
but rebases output PTS to zero. Public ranges currently use one reference worker;
whole-composition segmented rendering is a separate schedule. A PNG request uses
software capture intentionally and does not introduce PNG intermediates into
video output. Inspection validates declarations, not actual layout readiness.

CLI JSON success requires native results matching the request/session/source, not
just a process exit code. The native workspace owns staging and final publication;
the CLI does not infer failed output from timestamps or delete committed output
after a late diagnostic error. Local and subprocess segments share typed frame
execution, telemetry, finish/abort behavior, and validated assembly. See
[public output](public-output-api.md) and [snapshots](static-input-snapshot.md).

## Media and native capture

The composition-wide `AudioPlan` counts decoded/resampled sample frames, with
explicit source trim, placement, duration and gain. Public ranges slice the same
plan; preview and export do not invent separate timing rules. Remotion JSX audio
validates host declarations instead of being recursively inspected to create a
plan. Official `VideoClip` requests source-time frames through an explicit
provider/readiness boundary and remains muted. `createMediaTimeline` derives both
that visual tree and its audio plan from one set of clip declarations. Gain
envelopes use sample positions and linear ramps shared by native mixing, preview,
and output-range slicing. See [audio](authored-audio.md) and
[video frames](video-frame-source.md).

The renderer embeds its checked-in browser runtime directly. Browser readiness
and a committed React tree are necessary but do not prove that Electron captured
the matching paint. Capture generation and frame acknowledgements preserve
ordering. A media session selects native Mediabunny/NodeAV software codecs or
Chromium WebCodecs. Capture selection remains independent of encoding. Native
submissions can buffer packets; finalization verifies completed output. Explicit
container, video/audio codec, and profile choices remain binding. See
[media backends and formats](webcodecs.md) for readback, compatibility, and the
Windows x64 VP9 fallback.

## Validation and distribution boundaries

Run `pnpm check:fast` for generated-contract freshness, JS types/lint/tests, and
Rust protocol/policy tests without building the native renderer. The CLI wire
suite exchanges actual serialized jobs/events with Rust. Do not replace behavior
checks with source-string assertions or treat one language's unit tests as wire
compatibility.

Native changes additionally need focused renderer tests and real output checks
on the intended host. Browser DOM tests do not establish texture correctness;
policy tests do not establish hardware availability; CPU checks do not establish
performance. Performance claims require fixed inputs, encoder/bitrate, worker
count, CLI-to-publication timing, color/pixels, frames, audio and fallback facts.

The checked-in manifest advertises no downloadable native artifact. A Windows
candidate needs fresh runtime inventory and native acceptance before support or
publication can be claimed. Other platform entries are not validated support
claims. See [runtime candidate preparation](windows-runtime-candidate-prep.md).

Runtime inspection (`doctor`, version/capability checks) is distinct from acquisition.
Explicit configured/environment binaries must be usable; automatic selection must
not accept a broken candidate merely because it exists. Artifact acquisition
verifies archive and per-file identity, compatibility and architecture before
atomic cache promotion, and supplies the selected runtime's launch environment.
Prepared native runtime payloads are not npm lifecycle downloads. Resolver implementation lives
in `packages/cli/src/renderer-runtime.ts`, `renderer-binary.ts`, and
`artifact-resolver.ts`.

## Compatibility boundaries

`velocast init` owns the official starter. Other React projects in the repository
are development inputs, not alternative onboarding paths.

Explicit GSAP registration and omitted-value legacy defaults remain for existing
callers; new examples provide dimensions and FPS. The public
`cleanupRenderOutputOnFailure` export is deprecated but retained for older opt-in
adapters, never wrapped around transactional native publication. Core's testing
reset remains for active cross-package tests. Browser protocol 4 retains
`getDurationFrames` and renderable `getCompositions`; removing metadata APIs does
not remove these wire methods. Electron is the sole browser host. Host protocol
3 adds native Mediabunny codec dependencies and format selection. Signed distribution and broader
platform validation remain separate release requirements.
