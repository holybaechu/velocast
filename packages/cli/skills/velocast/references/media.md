# Local media and timed captions

Keep supplied assets in `public/assets`; source paths such as `assets/shot.mp4`
resolve inside the built `renderer.snapshotRoot`. Rebuild after replacing media.
The snapshot freezes assets and input props for a render. Download or generate
licensed media locally before authoring; a remote URL is blocked by snapshot policy.

Use `StillImage` for decoded stills. Use `createMediaTimeline(video, clips)` to
declare audio and video once. Mount `<media.Timeline />` at composition scope and
pass `audio: media.audio` to `defineReactComposition`. Clip `from`,
`durationFrames`, `trimBeforeFrames`, `fadeInFrames` and `fadeOutFrames` count
composition frames. `gain` is linear. Mark silent footage `muted: true` so audio
decoding is omitted. `Timeline` must use the same metadata as the composition.

Place narration and background music as separate clips. Keep music below speech;
listen to the actual mix. Duck using `volumeEnvelope` when needed: its positions
are clip-local decoded **sample frames**, at the timeline sample rate (48kHz by
default). Use either fade durations or an envelope on a clip. A lower-level audio
plan also counts sample frames, not video frames or interleaved channel samples.

Use supplied caption timing when available. Normalize seconds to integer video
frames once, then display a cue only when `start <= frame && frame < end`.
Keep caption scope at composition frame zero, or convert local frames explicitly.
Inspect frames immediately before and after each cue boundary. Verify speech
against the supplied recording; inferred timings need review and are not measured
word alignment. Keep text inside portrait safe margins and use a contrast backing.
