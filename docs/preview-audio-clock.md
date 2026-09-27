# Shared-plan preview audio clock

`prepareWebAudioClock()` in `packages/preview/src/web-audio-clock.ts`
implements the `AudioPlanClock` port. It uses the composition's common
sample plan. A prepared clock starts paused. Playback uses
`AudioContext.currentTime`; seek stops old sources before scheduling new ones.
Pause and disposal invalidate pending resume operations. Source tails are
silence; gains are not normalized.

The factory owns its audio context and decoded-buffer cache. Its loader must
resolve immutable session-owned sources and bound decoding. The clock rejects
unsupported channel counts and rates and limits retained PCM to 128 MiB by
default. That limit does not bound the browser decoder's peak allocation.
Preparation cancellation waits for outstanding decode work before cleanup.

Scheduling follows the standard source-node
[`start(when, offset, duration)`](https://www.w3.org/TR/webaudio-1.0/#dom-audiobuffersourcenode-start)
semantics at playback rate one. See [authored audio](authored-audio.md) for the
plan shared with native output. Unit tests live with the clock source.
