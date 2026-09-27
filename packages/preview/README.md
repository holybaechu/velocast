# @velocast/preview

Framework-neutral preview coordination, a shared-plan Web Audio clock, isolated
iframe transport and the code-authored player UI. The `velocast preview` CLI owns
the project server and immutable source snapshots; this package does not create
its own project server.

## Project player

Run `npm run preview` from the version-3 React starter, or
`velocast preview --config velocast.config.ts --port 0 --json` for a built static
project with `renderer.snapshotRoot`. The CLI prints the local player URL.
The player supports play/pause, frame seek, playback ranges, PNG/range output,
automatic source refresh, and read-only element inspection. After two settled
source observations, the player prepares a new immutable snapshot and validates
its selected frame and decoded audio before committing it. The prepared audio
clock is handed to playback without decoding it again. A broken
build leaves the old snapshot available and reports its error; another edit can
recover automatically. Refresh retains the selected frame. Automatic refresh
resumes playback when it was playing; the manual button pauses it.

Use `--no-auto-refresh` for manual source control. Automatic refresh waits while
an output request is running. Source revisions are filesystem change hints;
cryptographic snapshot identities remain the authority for output. Rebuilds must
finish writing their entry and resources before they can be accepted.

Pause and inspect a CSS selector to see the selected frame's actual text, bounds,
computed styles, and optional nearest `data-velocast-source` attribute. Highlighting
is drawn outside the composition iframe, so it never enters renders. Source
annotations are authored hints, not inferred React source maps.

Inspection is scoped to the selected composition target. Abandoned prepared
snapshots expire after a minute; disposal also makes a separate bounded discard
request so cancellation does not cancel its own cleanup.

Output files survive session closure; owned snapshots, render jobs, media
decoders and optional watch children do not.

`PreviewApp`, `HttpPreviewApi`, `IframePreviewConnection` and
`IframePreviewTransport` are also exported for hosts. The installed package ships
`dist/ui` and a manifest under `dist/platform`. Parent/child RPC checks origin,
window, channel, request and session identities instead of trusting arbitrary
page messages.

## Controller

`PreviewController` accepts a `PreviewTransport`, an optional `PreviewScheduler`
and an optional `prepareAudio` factory. The source supplies its existing
session/source version, composition metadata, immutable props and optional shared
`AudioPlan`. The controller does not manufacture source identities or mix audio.

- `refresh(source, frame?)` replaces source after old work and resources settle.
  The default frame preserves the selected frame, clipped to the new composition.
- `seek(frame)` selects an integer frame, clipped to the active range. Same-frame
  requests still execute, so a new source/props version can be presented.
- `setPlaybackRange({start, end})` selects a nonempty half-open interval, intersected
  with the composition. Refresh resets it to the full composition.
- `play()` and `pause()` await frame/audio readiness. Playing again after the end
  restarts at the range start; a manual seek to the last frame can play that frame.
- `getState()` and `subscribe()` expose status, source, requested/presented frame,
  playback/range state and visible errors. Frame results are published only after
  the current seek completes. A UI can retain its last image during seeking; it
  must not label a requested frame as already presented.
- `dispose()` immediately invalidates callbacks and pauses sound, then joins old
  work and releases audio/transport. A failed cleanup remains retriable through
  another dispose. Commands cannot reopen a disposed controller.

Only one transport operation runs at a time; pending explicit seeks coalesce to
the latest intent. Superseded operations reject with `AbortError` and never
publish a stale result. `transport.dispose()` must join any abandoned lower-level
work before resolving, including work whose public abort promise returned early.
Transport results must be immutable or transport-owned.

The scheduler's `schedule(callback)` must queue asynchronously and return a
canceller. Its `now()` supplies monotonic milliseconds **only for silent sources**.
Visual ticks wait for the previous seek and then select the latest clock frame;
they skip missed frames instead of accumulating a playback queue.

## Audio time

`AudioPlanClock` exposes the shared plan's sample rate, total samples and
`currentSample/play/pause/seek/dispose`. `prepareWebAudioClock` implements this port
with owned Web Audio resources. The host injects immutable-source resolution and
a bounded `loadBuffer` decoder; the clock separately limits retained PCM.

With audio, the sample cursor is authoritative; the controller never substitutes
a second wall clock. Explicit frame seeks use the shared **round** conversion
(44,100 Hz / 24fps, frame 1 → sample 1,838). Playback does not re-seek or re-start
audio on each visual tick. The selected end is exclusive. The audio plan must
cover the selected playback range rather than silently freezing at a short plan.

An unresolved audio resume can be invalidated and its clock disposed. Invalid
sources, clocks, ranges and current request failures are visible in state and
reject the initiating promise. Automatic tick failures also publish error state.
Cleanup runs even without a later command. `PreviewError.cause` preserves the
original failure and `cleanupError` retains any secondary release errors.

## Tests

Colocated controller and Web Audio tests cover source refresh, playback, seeks,
sample rounding, cancellation, and cleanup. Native output requires a matching
renderer and the [repository workflow](../../README.md).
