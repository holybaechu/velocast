# @velocast/remotion

For an original Remotion project, use the standalone
**`@velocast/remotion-source` adapter**. It resolves the project's installed
Remotion/React packages and uses the common `compositions`, `inspect`, `frame`,
and `render` commands. It needs no JSX alias or duplicate audio declaration.
See [upstream setup, versions, and costs](../../docs/upstream-remotion.md).

The deprecated `@velocast/remotion/upstream` export forwards to
`@velocast/remotion-source/upstream`. The remainder of this document describes
the bounded JSX bridge and its pinned dependencies, retained for existing
consumers independently of the standalone source adapter.

## Bounded compatibility entry

The original Remotion **4.0.244** source slice and the explicitly listed
**4.0.526** media API slice are tested with one React/ReactDOM **18.3.1** instance.
Pure upstream exports remain pinned to 4.0.244 to preserve original output;
4.0.526 is a test dependency, not a second runtime. This is not compatibility
with the whole Remotion ecosystem. Upstream dependency terms remain applicable.

Keep the component's original imports. In the explicit compatibility build,
configure an exact bundler alias (not a broad substring replacement):

```js
// vite.config.ts; retain the original project's Remotion declaration.
import { remotionCompatibilityViteConfig } from "@velocast/remotion/bundler";
export default remotionCompatibilityViteConfig();
```

Existing hosts can continue to register the unchanged component:

```tsx
import { registerRemotionComposition } from "@velocast/remotion";
import { OriginalScene } from "./OriginalScene";
registerRemotionComposition("scene", {
  component: OriginalScene,
  width: 1920,
  height: 1080,
  fps: 60,
  durationInFrames: 120,
  defaultProps: { label: "가사" },
  audio: {
    sampleRate: 48000,
    tracks: [
      {
        src: "/song.mp4", // unchanged JSX/staticFile() value
        source: "/song.mp4", // immutable snapshot URL identity (optional)
      },
    ],
  },
});
```

## Declarative project entry

For a new Velocast host, define the composition without registering it during
module import, then start the project once. `defaultProps` must be a complete
set of component props. The Remotion source component can keep its existing bare
`remotion` imports.

```tsx
import { defineRemotionComposition, startVelocast } from "@velocast/remotion";
import { OriginalScene } from "./OriginalScene";

const scene = defineRemotionComposition({
  id: "scene",
  component: OriginalScene,
  width: 1920,
  height: 1080,
  fps: 60,
  durationInFrames: 120,
  defaultProps: { label: "가사" },
});

startVelocast([scene]);
```

The project bootstrap validates all composition IDs before installing the
browser protocol. It retains a stable protocol object and opens the React frame
source on the first frame or audio request. The existing
`registerRemotionComposition` entry remains available for older hosts.

To add the exact Remotion alias to a Vite config that already has plugins or
aliases, use `withRemotionCompatibilityViteConfig(existingConfig)` from
`@velocast/remotion/bundler`. It preserves those existing settings.

## First source slice

- `useCurrentFrame`, `useVideoConfig` map to the official frame/props session.
  Remotion's `durationInFrames`, `id`, `defaultProps`, `props`, and `defaultCodec`
  fields are retained. The host maps duration to the common `durationFrames`.
- `interpolate`, `Easing`, `AbsoluteFill`, `staticFile`, `spring`,
  `measureSpring`, and `random` are the exact pinned
  upstream exports, not copied or approximately reimplemented utilities.
- `Img` waits for the mounted image's decode through the common frame-resource
  contract, forwards refs/HTML attributes, and rejects stale sources. It fails on
  decode errors; retry/player-specific options are explicitly unsupported.
- `Sequence` maps integer, half-open timing to the common frame store. Its
  `absolute-fill` and `none` layouts are supported; timeline, premount and
  dimension overrides fail explicitly.
- `registerRoot()` records the unchanged entry component. The host may bind that
  identity with the `root` option, but must still provide an explicit composition
  manifest. The bridge never recursively renders arbitrary root JSX to discover
  compositions. Rendering `<Composition>` directly reports
  `VELOCAST_REMOTION_MANIFEST_REQUIRED`.
- `delayRender()`/`continueRender()` handles (including the ones used by pinned
  Google Fonts) block the host preload gate before the first component commit.
  Declared React-helper `fonts` remain the owned, deterministic font path.

## Deterministic audio preparation

The native renderer asks for its composition-wide `AudioPlan` before the first
JSX frame commit. Therefore `<Audio>` is validation input, never an audio-plan
discovery mechanism. The host must declare either an `AudioPlan` or a static
descriptor (or a props-derived callback returning one). A descriptor converts
integer `from`, `durationInFrames`, `startFrom`, `endAt`, and numeric or callback `volume`
boundaries to samples using independently rounded absolute frame boundaries.
The result is resolved once for an equal frozen props snapshot and reused by
both `getAudioPlan()` and the frame preload path.

Mounted `<Audio>` emits no browser audio element. It must match a declared source,
trim, gain and absolute `Sequence` window. Callback volumes are resolved once
for every integer clip-local frame, independent of source trim, then converted
to a sample envelope with linear interpolation between those frame boundaries.
Each mounted frame checks its callback value against the frozen envelope. Unplanned audio, a missing active
declared track, undeclared callback automation, and playback/loop/browser-only options
fail explicitly. An `AudioPlan` alone expects its clip `source` to equal JSX
`src`; use the descriptor's separate `src` and `source` fields when the unchanged
browser URL differs from the native file identity. PNG-only frame requests still
resolve the same host declaration in preload and do not recursively call the core
protocol.

Colocated tests cover frame reordering, sessions and props, image readiness,
Sequence-local timing, manifest identity, font-delay blocking, AudioPlan
boundaries, resolver reuse, and undeclared audio diagnostics. Use a matching
native renderer for output checks.

## Video and modern media names

`Video`, `OffthreadVideo`, and `Html5Video` share the deterministic `VideoClip`
RGBA frame preparation path. The Velocast Remotion host supplies the immutable
snapshot decoder automatically; set `getVideoFrame` for an owned frame loader.
The frame does not become ready until all mounted video pixels are decoded and
painted. Decoder failures reject the frame instead of capturing stale pixels.
Supported props are `src`, `startFrom`/`endAt` or `trimBefore`/`trimAfter`,
`muted`, `volume`, `style`, and `className`. Both naming pairs use output fps.
Supplying both names for one trim boundary fails with `TRIM_CONFLICT`.
`Html5Audio` is an alias for the bridge's `Audio` implementation.

Unmuted videos require matching host audio tracks, exactly like `<Audio>`.
The descriptor accepts the same modern trim aliases and `volume: (frame) => n`.
Callbacks must be pure, finite and nonnegative. Exactly collinear points are
removed during preparation, including long constant plateaus. A three-minute
60fps fade-and-duck callback is covered by the tests. This slice supports at most
500,000 frames and 9,998 non-collinear points per callback track and nonnegative Sequence placement; use a
sparse sample envelope for longer automation or preroll. When supplying an
AudioPlan directly, a numeric JSX `volume` validates the clip base gain and the
host envelope supplies the automation. Dynamic `muted`, speed,
looping media, alternate audio streams, HDR/tone mapping, transparency options,
HTML media refs/events and `@remotion/media` are not implemented. Unsupported
video props produce a named error. `TransitionSeries`, Player,
Studio and the plugin ecosystem remain outside this slice.

```tsx
const fade = (frame: number) => Math.min(1, frame / 30);
// Existing JSX:
<Sequence from={60} durationInFrames={300}>
  <OffthreadVideo src={staticFile('clip.mp4')} trimBefore={120}
    trimAfter={420} volume={fade} />
</Sequence>
// Host audio descriptor:
{sampleRate:48000, tracks:[{src:staticFile('clip.mp4'), from:60,
 durationInFrames:300, trimBefore:120, trimAfter:420, volume:fade}]}
```

For new ordinary clips, the official React `createMediaTimeline` helper derives
picture and audio from one descriptor and avoids this migration declaration
pair. Arbitrary JSX is not recursively evaluated to discover composition audio.

Tests for the 4.0.526 API slice run
reordered/repeated frames with `Html5Video`, `OffthreadVideo`, `Html5Audio`, modern
trims, `useVideoConfig` and callback volume. They verify real React resource
readiness and compare spring values to the installed 4.0.526 implementation in
an isolated process. These tests do not establish whole-movie native pixel
parity for every original project.

The modern trim and callback contracts were checked against installed upstream
4.0.526 declarations and source, and the official [OffthreadVideo source](https://github.com/remotion-dev/remotion/blob/main/packages/core/src/video/OffthreadVideo.tsx).

`node scripts/verify-remotion-media-native.mjs prepare RENDERER OUTPUT` builds a
real H.264/AAC source and matching official timeline/Remotion media compositions.
`run RENDERER OUTPUT --browser CHROME` compares native full/range decoded pixels,
decoded audio and exact PCM hashes against each other and the FFmpeg plan reference;
then checks reordered browser frame pixels. The full-versus-range PCM comparison
uses `1e-7` absolute tolerance for interpolated endpoint rounding. The optional
`browser` mode performs only the real decoder/frame-readiness comparison and does
not claim native output validation.

## Series and Loop timing

`Series` accepts direct `Series.Sequence` children (including fragments). Each
sequence has a positive integer `durationInFrames`, optional integer `offset`
for gaps or overlap, and `absolute-fill`/`none` layout plus style/className. The
last sequence may use `Infinity` to fill the remaining composition. A `name`
is accepted as a nonvisual label. Rendering `Series.Sequence` outside `Series`,
passing unsupported props, or using fractional timing produces an explicit error.

`Loop` accepts a positive integer `durationInFrames`, nonnegative integer `times`
(default `Infinity`, bounded by the composition), and the same layout options.
Only the requested iteration mounts. `Loop.useLoop()` returns the closest
`{iteration, durationInFrames}` or `null`, while `useCurrentFrame()` resets within
each iteration. These timings use the same half-open Sequence frame contract;
reordered frames do not replay earlier iterations. Transition effects, premount,
Series refs, fractional timing and Studio timeline controls are outside this slice.

Audio remains explicitly prepared: declare one host track per active loop
iteration or Series sequence, including any parent offsets and clipping. Volume
callbacks restart in each Loop iteration. Media's own `loop` and
`loopVolumeCurveBehavior='extend'` are separate unsupported options. Tests cover
nested loops, finite/default counts, audio callback resets, Series overlap/gaps,
final Infinity, parent clipping and repeated/reordered seeks.
