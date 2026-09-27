# Declarative composition authoring

This document describes browser composition definitions. Whole projects from
another authoring system can instead use a Node `SourceAdapter` through
`Config.source`; see [original Remotion project sources](upstream-remotion.md).
The source adapter owns project preparation, while the browser frame source
owns seeking a selected composition.

A composition is one named renderable output. It has dimensions, frame rate,
duration, input props, and one frame source. Scenes and timed sequences live
inside a composition. A project may contain compositions backed by different
frameworks.

## React project

```tsx
import {
  defineReactComposition,
  startVelocast,
  useCurrentFrame,
} from "@velocast/react";

function Scene({ title }: { title: string }) {
  return (
    <h1>
      {title} · {useCurrentFrame()}
    </h1>
  );
}

const scene = defineReactComposition({
  id: "scene",
  video: { width: 640, height: 360, fps: 30, durationFrames: 90 },
  component: Scene,
  defaultProps: { title: "Hello" },
});

startVelocast([scene]);
```

`defineReactComposition` validates a pure definition. It does not mount React
or install the browser protocol. `startVelocast` validates every composition ID
before publishing the project. React creates an owned capture root unless an
existing empty `target` is supplied. Keep `startVelocast` in the browser entry,
not inside a React render function.

For required props, supply complete `defaultProps` or a `parseProps` function.
The parser receives shallow-merged defaults and supplied input and must return
the complete component props. Input props are frozen for a prepared source;
changing them disposes its frame session before opening another one. A
`resolveVideo(props, { signal })` function on a low-level composition can
resolve duration and other metadata from that same input snapshot before
discovery. In that form, `video` may be omitted entirely; no placeholder
duration enters the catalog.

## Custom frame source

Use `defineFrameComposition` when a framework helper cannot express the source.
Its source opens lazily on the first seek or audio-plan request. A session owns
its DOM/resources until `dispose` completes.

```ts
import { defineFrameComposition, startVelocast } from "@velocast/core";

const bars = defineFrameComposition({
  id: "bars",
  video: {
    width: 640,
    height: 360,
    fps: 30,
    durationFrames: 90,
    target: "#bars",
  },
  source: {
    open({ signal }) {
      signal.throwIfAborted();
      const canvas = document.createElement("canvas");
      canvas.id = "bars";
      canvas.width = 640;
      canvas.height = 360;
      document.body.append(canvas);
      const context = canvas.getContext("2d")!;
      return {
        seekFrame(frame, { signal }) {
          signal.throwIfAborted();
          context.fillStyle = "#102030";
          context.fillRect(0, 0, 640, 360);
          context.fillStyle = "#6ce5c3";
          context.fillRect(40, 300 - frame * 2, 80, frame * 2);
        },
        dispose() {
          canvas.remove();
        },
      };
    },
  },
});

startVelocast([bars]);
```

The source must settle its frame work before `seekFrame` returns. Honor the
required `AbortSignal` in preparation and seeking; teardown waits for pending
work before disposal. A single composition has one source. That source may use
multiple libraries internally, but it must return one ready frame and one
audio plan for each prepared input snapshot.

The older `registerFrameAdapter`, `registerReactComposition`,
`registerGsapTimeline`, and `registerRemotionComposition` calls remain available
for existing projects. The new project entry can contain React, GSAP, Remotion,
and custom definitions together. The renderer-facing `window.__velocast`
protocol remains the same versioned wire interface for now.
