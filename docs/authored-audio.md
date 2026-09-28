# Authored audio

React compositions can declare an `AudioPlan` or an async resolver of
`{ inputProps, signal, config }`. Core resolves it in the same prepared
session as frame rendering. Browser protocol 4 is required for authored audio
and volume automation.

Plans count integer sample frames after decoding and resampling. A clip declares
`source`, signed `startSample`, nonnegative `sourceStartSample`,
`durationSamples`, and finite nonnegative `gain`. Optional clip-local
`volumeEnvelope` points use increasing sample positions and nonnegative gains.
The envelope multiplies clip gain, interpolates linearly, and holds endpoint
values outside its points. `fadeAudioEnvelope` creates fade points. Full plans
cover the composition duration; ranges slice the same plan at independently
rounded absolute frame boundaries.

Native rendering resolves media against the frozen input snapshot. It fetches
bounded immutable source bytes, selects the first audio stream, resamples and
mixes to exact-duration stereo PCM, then encodes native AAC when available or
native Opus in MP4 at 48 kHz when AAC is unavailable, while copying the existing
video packets. The render CLI selects the available audio codec automatically;
if neither is available, it reports `media.audio_encoder_unavailable`. Source errors, mux
failures, and cancellation before publication preserve the previous completed
output. Native output targets stereo audio in MP4, with the actual codec
recorded in output metadata.

Preview uses the same plan through the [Web Audio clock](preview-audio-clock.md).
The TypeScript PCM mixer is a reference oracle for tests; it is not the native
streaming mixer. See [architecture](architecture.md) for snapshot ownership.

## One declaration for picture and sound

```tsx
import {
  createMediaTimeline,
  defineReactComposition,
  startVelocast,
} from "@velocast/react";

const video = { width: 1920, height: 1080, fps: 60, durationFrames: 600 };
const { audio, Timeline } = createMediaTimeline(video, [
  {
    id: "interview",
    kind: "video",
    src: "/interview.mp4",
    from: 60,
    durationFrames: 480,
    trimBeforeFrames: 120,
    fadeInFrames: 12,
    fadeOutFrames: 24,
  },
  {
    id: "music",
    kind: "audio",
    src: "/music.wav",
    durationFrames: 600,
    gain: 0.3,
  },
]);

startVelocast([
  defineReactComposition({ id: "scene", video, audio, component: Timeline }),
]);
```

`createMediaTimeline` snapshots source, timing, and styles once. Video audio is
included unless `muted: true`; audio-only clips emit no DOM. Missing source
audio is an error, so mark silent clips muted. `VideoClip` remains a muted
visual primitive for custom layouts. Keep `Timeline` at composition scope:
wrapping it in `Sequence` would shift pictures without shifting sound.
