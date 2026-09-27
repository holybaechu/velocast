# Browser execution contract

The browser protocol version is declared in
[`contracts/renderer-protocol.json`](../contracts/renderer-protocol.json). The
current version is **4**. Rebuild authoring packages and the native renderer
together when this contract changes. The output API and job/event wire version
are separate contracts.

`window.__velocast` exposes session binding, composition discovery, input props,
audio-plan resolution, exact-frame seeking, cancellation, and destruction.
`beginSession` binds a `sessionId` and optional `sourceVersion`; a different input
version requires destroying the previous session. `getCompositions`,
`getDurationFrames`, `getAudioPlan`, `setInputProps`, and `seekFrame` operate on
that prepared source. The renderer checks the protocol version and required
methods before invoking them.

Frame work must settle before `seekFrame` returns. Authors should derive visible
state from the requested frame and props, await fonts and owned resources, and
honor the supplied cancellation signal. Overlapping mutations fail rather than
running two seeks concurrently. `cancelPending()` invalidates pending work;
`destroy()` waits for work and cleanup to settle before another session can use
the page. An uncooperative hook can require reloading the page or ending the
native job.

The renderer also waits for browser paint after the composition reports
readiness. Browser readiness alone does not establish correct Electron texture
capture or encoded output. Use an exact-frame output check for that boundary.

See [architecture](architecture.md), [static snapshots](static-input-snapshot.md),
and [authored audio](authored-audio.md) for the surrounding contracts.
