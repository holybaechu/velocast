# Frame-derived authoring

A composition has a stable ID, width, height, fps and `durationFrames`.
`defineReactComposition` registers a React component; `startVelocast` starts the
definitions in the entry. Use the existing generated project's config and Vite
source plugin. Keep each source mapping paired with its composition.

Frames start at zero. Ranges are half-open: `[start,end)`. At 30fps, ten seconds is
300 frames; the final frame is 299. Derive motion from `useCurrentFrame`,
`interpolate` and `Easing`, with explicit bounds. `Sequence` and `Layer` give
children a local frame. A parent component's frame remains in its own scope.
Paused GSAP timelines and plain frame compositions also work; keep the project's
existing adapter when revising it. Wall clocks and autonomous playback cannot
define reproducible frames.

Use `Layer` with unique literal IDs for independently editable text/layout/timing.
Literal text and placement support Studio edits; expressions and reusable component
internals stay code-owned. Keep comments and human source edits when revising.

For scenes, use explicit frame intervals. Animate opacity/position over a bounded
overlap for transitions. Reuse ordinary React components or SVG for brand marks,
title cards and progress graphics. Read the supplied examples before adapting
them; register added compositions in `src/main.jsx` and source mappings in config.

## Runnable scene patterns

For a ten-second landscape intro, copy [product-intro.jsx](../examples/product-intro.jsx)
and [graphics.jsx](../examples/graphics.jsx) into `src`. Supply ten seconds of
footage at `public/assets/background.mp4` and music at `public/assets/music.wav`.
The composition contains three scenes with fades, animated text and a reusable
brand/progress graphic. Replace its copy and asset paths to fit the brief.
Scene intervals overlap by `fadeFrames`; outgoing text finishes fading at the next
scene's start, then incoming text fades in over the shared footage. Opacity eases
at both ends of each fade. When changing
the fade duration, extend each outgoing interval to the next start plus that
duration. This keeps transition text readable instead of layering two headlines.

For narrated portrait video, copy [portrait-explainer.jsx](../examples/portrait-explainer.jsx)
and the same graphics file. Supply `public/assets/narration.wav`, music, and
`src/captions.json` with integer-frame cues shaped like
`[{"start":0,"end":90,"text":"Make room for focus."}]`. Extend cues through frame
300 for the full ten seconds; adapt timing to the supplied recording.

Register either or both in the existing entry:

```jsx
import { startVelocast } from "@velocast/react";
import { productIntro } from "./product-intro.jsx";
import { portraitExplainer } from "./portrait-explainer.jsx";
startVelocast([productIntro, portraitExplainer]);
```

Add matching `studio.sources` entries in `velocast.config.ts`:
`"product-intro": "src/product-intro.jsx"` and
`"portrait-explainer": "src/portrait-explainer.jsx"`. Keep existing mappings and
registrations when adding to a project. Build, inspect boundary frames, render the
chosen composition and verify against its own dimensions. Reusable component
internals and expressions are code-owned; source editing remains ordinary React.

## Editable keyframe animation

Use `Layer.animation` for focused numeric motion that Studio agents can edit:

```jsx
<Layer
  id="headline"
  from={30}
  durationFrames={90}
  x={64}
  animation={{
    opacity: {
      keyframes: [
        { frame: 0, value: 0 },
        { frame: 15, value: 1 },
      ],
      easing: "easeOut",
    },
  }}
>
  Your next idea
</Layer>
```

Keyframe frames are local to the Layer: this example fades on composition frames
30–45. Tracks support `x`, `y`, `width`, `height`, `rotation` and `opacity`; use
2–128 increasing nonnegative integer frames. Values clamp at the track ends.
Sizes are nonnegative and opacity stays in `[0,1]`. Easing is `linear`, `easeIn`,
`easeOut` or `easeInOut`. A `null` track disables that property animation.
Ordinary `style` still applies last. Computed animation, spread objects, overridden
styles and ambiguous source declarations stay code-owned. Preserve existing
custom frame/GSAP logic unless the brief asks to replace it.
