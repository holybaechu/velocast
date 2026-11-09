# Inspect, revise and recover

Build before inspecting or exporting saved changes:

```sh
npm run build
npx --no-install velocast frame video --frame 90 --output renders/frame-90.png --json
npx --no-install velocast render video --start-frame 90 --end-frame 150 --output renders/range.mp4 --json
npx --no-install velocast verify renders/range.mp4 --expect-frames 60 --expect-fps 30 --expect-width 960 --expect-height 540 --json
```

Use the actual composition ID and dimensions from `compositions --json`.
Range requests keep original composition frame identity; encoded timestamps start
at zero. `verify` checks metadata/cadence, not pixel or sound quality. Open frame
PNGs and play the actual video with sound. `check --help` exposes sampled DOM
layout/text/contrast assertions; these complement visual review.

`npm run studio` builds, starts the watcher and prints its local URL. Inspect the
current source before changing it after human edits. Wait for a successful build;
saved source and displayed build are distinct. A failed build retains the previous
working frame. Preserve external changes and comments, then reapply your change
against current source rather than replacing an older copy.

For a connected MCP agent, start `velocast mcp --url <printed-Studio-URL>` using
the existing agent's MCP configuration, or use **Connect agent** in Studio. Discover
tools, choose an explicit tab with `studio_context`, then read `studio_source`.
Guard edits with its current source version/revision. After a build, refresh
context; seek with `studio_control`, inspect `studio_frame`, submit `studio_render`
and poll/wait with `studio_job`. On a conflict, reload context and preserve the
other writer's change. A dirty draft/build error needs resolution before export.

Use `studio_inspect` for one Layer's resolved text, styles, bounds and hierarchy,
alongside its source fields and editability reasons. Pass the chosen tab's current
integer revision, source version, composition ID and exact Layer ID. Pause first;
inspection refuses changing frames, drafts, duplicate IDs and unbuilt source.

If frame capture returns a pending job or `pollError`, retain its job ID and use
`studio_job` to wait or cancel. Retrying `studio_frame` reuses matching pending
work. After a disconnected export request, `studio_job` with `action: "list"`
recovers job IDs; inspect their original source/frame/range before resuming.

Use `studio_animate` for a source-editable `Layer.animation` track: `set` supplies
at least two `{frame,value}` keyframes, `keyframe` inserts/replaces one point, and
`remove` disables one property track. Pass the composition's saved **file revision**
from `studio_source`, its source version, element ID and numeric property. Frames
are local to the Layer, including when its `from` is nonzero. Use the authoring
reference for supported properties/easings and leave computed custom motion in code.

`studio_edit`, `studio_animate` and `studio_replace_source` return a receipt. With
`clientId` and optional `waitMs` (up to 30000), they can wait for that explicit tab.
Read its stage: `saved` proves file persistence; `built` proves the exact file
revision is in the accepted build; `displayed` additionally proves the named tab
reported that build and revision ready. `superseded` means another edit replaced
the requested revision; `failed` reports syntax/recovery problems. A timeout can
return `saved` or `built`; the source write remains saved. Use
`studio_wait_for_build` with the returned `revision` to continue checking. Rebuilds
still run through the project's watcher. Inspect the rendered pixels afterward;
display confirmation does not judge their appearance.

Recovery:

- Missing assets: inspect the reported source/path, restore the supplied file
  under `public/assets`, rebuild and retry a frame before a full render.
- Failed render: read the structured error and stderr; check `doctor --json`,
  codec/container support and the requested frame bounds. Failed/cancelled renders
  preserve previous output before publication. Keep successful originals while
  iterating and use a new filename for revisions.
- Cancel owned CLI work with Ctrl+C; wait for command exit. In Studio cancel the
  job and wait for `cancelled` via `studio_job` before retrying or cleanup. MCP
  disconnect leaves Studio and its jobs running. Stop the Studio process with
  Ctrl+C when finished; it owns its watcher/exports.
- Stale source: rebuild, then wait for Studio to accept the completed build.
  Read the fresh revisions before retrying. Supported literal edits retain durable
  undo/redo history, including observed external edits.
- Interrupted Studio edit: use the reported **Recover edit** action. Preserve the
  history directory and any existing source. If an interrupted transaction prevents
  the initial build, start Studio against its last completed build to recover;
  otherwise follow the recovery paths reported by Studio before replacing anything.

Report a runtime or codec limitation accurately. Hardware acceleration is a
preference; `required` is unsupported. An unavailable renderer, failed check or
uninspected output is not a completed delivery.
