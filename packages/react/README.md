# @velocast/react — official authoring helper

Verified dependency baseline: React and React DOM **18.3.1**. This package is not
a Remotion compatibility layer. The author declares a component and metadata;
the helper registers and manages the engine's frame adapter.

```tsx
import {
  defineReactComposition,
  startVelocast,
  useCurrentFrame,
  preloadImage,
} from "@velocast/react";

function Scene({ title, image }: { title: string; image: string }) {
  return (
    <div>
      <img src={image} alt="" />
      {title}: {useCurrentFrame()}
    </div>
  );
}

const scene = defineReactComposition({
  id: "scene",
  component: Scene,
  video: { width: 640, height: 360, fps: 30, durationFrames: 90 },
  defaultProps: { title: "한글 영상", image: "/cover.svg" },
  fonts: [{ family: "Korean", source: 'url("/korean.woff2")' }],
  preload: ({ inputProps, signal }) =>
    preloadImage(inputProps.image, { signal }),
});

startVelocast([scene]);
```

`defineReactComposition` is inert: it validates a definition without mounting
React or publishing browser globals. `startVelocast` validates the project
catalog and installs the browser protocol once. With no `target`, the React
helper creates and owns the capture root. The older
`registerReactComposition(id, options)` call remains available for existing
projects.

## Frame and input contract

- `useCurrentFrame()` reads the requested composition frame, not wall time.
- `useVideoConfig()` returns width, height, fps and durationFrames.
- `useInputProps<Props>()` reads the same props passed to the component.
- Defaults are **shallow merged** with own supplied input properties. A supplied
  `undefined` overrides its default; nested objects replace their default object.
  Omitted input uses defaults. `null`, arrays and primitive input are rejected.
- Every seek, including a same-frame props update, runs `preload` and commits a
  new snapshot. `preload` receives frame, resolved inputProps and AbortSignal,
  never an internal adapter. It must honor cancellation and finish its work.
- Registered fonts load before the first component commit, so font-dependent
  `useLayoutEffect` measurements do not precede font readiness. FontFace failures
  fail the frame; no intentional fallback-font success is reported.
- `preloadImage` decodes a detached image and removes its source on completion
  or abort. The native browser readiness gate still validates actual DOM images.

## Sequences and motion

`Sequence` clips its children to `[from, from + durationFrames)` in its parent's
local time. `from` defaults to 0; zero duration is empty; negative starts permit
pre-roll. Every ancestor clips visibility. Inactive children are unmounted, not
hidden with CSS, and the sequence adds no DOM wrapper.

```tsx
import {
  Sequence,
  useCurrentFrame,
  interpolate,
  Easing,
} from "@velocast/react";

function Line() {
  const frame = useCurrentFrame(); // 0 at composition frame 60
  const opacity = interpolate(frame, [0, 15], [0, 1], {
    easing: Easing.inOut(Easing.linear),
    extrapolateRight: "clamp",
  });
  return <p style={{ opacity }}>한글 가사</p>;
}
function Scene() {
  return (
    <Sequence from={60} durationFrames={120}>
      <Line />
    </Sequence>
  );
}
```

Hooks must execute in a component **inside** the sequence to read its local
frame. `useVideoConfig()` and input props stay composition-global, as does the
`preload` callback's frame. Nested offsets and clipping call the core's
`resolveSequenceFrame`; `interpolate`, `Easing` and `cubicBezier` are re-exported
from core, not reimplemented. Their numeric/extrapolation rules are therefore
identical for ordinary JS and React. These exports are not a full Remotion API.

## Lifecycle and limits

The helper uses `createRoot`, an external frame store and `flushSync` to complete
synchronous React DOM/layout-effect work before a seek resolves. A suspended
top-level tree that cannot commit is a failed frame, not a successful fallback.
Use `preload` for asynchronous resources; arbitrary asynchronous effects or
user-owned inner Suspense fallbacks are not a general readiness contract.

Mount does not render a guessed initial frame. The first actual seek renders the
requested frame after resources. Do not drive animation from timers or accumulated
effect state; derive visible state from frame and inputs. The shared AudioPlan
and VideoClip boundaries provide authored media timing; general visual timeline
editing is outside this helper's scope.

Cancellation prevents late preload completion from committing a frame. The core
waits for an outstanding callback to settle before teardown/reuse. Destroy
unmounts React, removes owned roots, removes owned FontFaces and releases store
subscriptions. Reinitialization creates fresh component state. An optional
`target` must identify an existing empty element; it is retained and its inline
style restored on teardown. Existing children are never silently deleted.

Use `velocast init <directory>` for the supported starter. The CLI owns that
single versioned source and emits it without installing dependencies;
`@velocast/react` no longer ships a second copyable template. The version-3
starter includes Hangul, local artwork, deterministic props, `npm run preview`,
build watching and explicit source refresh. Supply a licensed local font when
cross-machine typography must be fixed.

## Tests

Colocated tests exercise React commits, frame and props updates, callback
ordering, resource readiness, cancellation, cleanup and reinitialization.
The current browser protocol is version 4. For native output, use a matching
renderer and the [repository workflow](../../README.md).

## Colocated picture and sound

Use `createMediaTimeline(config, clips, sampleRate?)` for ordinary placed clips.
Each descriptor declares `id`, `kind: 'video' | 'audio'`, `src`, and
`durationFrames`, with optional `from`, `trimBeforeFrames`, `muted`, `gain`,
`fadeInFrames`, `fadeOutFrames`, or sample-local `volumeEnvelope`. Video clips
also accept `style` and `className`. The result contains `audio` for registration
and `Timeline` for JSX, so both use one source and timing declaration. Register
`component: Timeline` directly, or compose `<Timeline />` with other UI. It uses
the snapshot frame service by default and accepts `getFrame` for an owned
loader. See [authored audio](../../docs/authored-audio.md) for a complete example.
