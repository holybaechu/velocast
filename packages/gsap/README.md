# `@velocast/gsap`

Define a composition with a timeline factory. The definition is pure: it does
not create a timeline or touch the DOM. Velocast opens a fresh timeline for a
render session, pauses it, and seeks it by frame. On disposal it calls GSAP's
`revert()` to restore pre-animation inline styles. For older timeline-like
objects without `revert()`, it calls `kill()` when available.

```ts
import { defineGsapComposition, startVelocast } from "@velocast/gsap";
import { gsap } from "gsap";

const hero = defineGsapComposition({
  id: "hero",
  video: {
    width: 1920,
    height: 1080,
    fps: 60,
    durationFrames: 180,
    target: "#hero",
  },
  createTimeline: () =>
    gsap.timeline({ paused: true }).to("#hero", {
      x: 600,
      duration: 3,
    }),
});

startVelocast([hero]);
```

State `durationFrames` explicitly in declarative definitions so the composition
catalog can be read before a timeline is created. This also gives infinite
repeats a bounded render duration. GSAP callbacks are suppressed during frame
seeks, which keeps forward, reverse, and repeated seeks deterministic.

The legacy `registerGsapTimeline` interface remains available for existing
entries:

```ts
registerGsapTimeline("hero", timeline, {
  width: 1920,
  height: 1080,
  fps: 60,
  target: "#hero",
});
```

When `durationFrames` is omitted, legacy registration infers the frame count
from `totalDuration()` when available, including repeats and repeat delays.
Infinite timelines need an explicit `durationFrames`. Legacy seeking retains
its existing callback behavior.

Calling `registerGsapTimeline(id, timeline)` without options still uses 1920×1080
at 30 fps for compatibility. Browser-global consumers can use
`VelocastGSAP.register(id, timeline, options)` with the same options.
