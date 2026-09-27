# Original Remotion projects as Velocast sources

`@velocast/remotion-source` loads an original project's installed Remotion,
bundler, renderer, React, and React DOM through a Node source adapter.
Original `registerRoot`, `Composition`, hooks, sequences, media, and
`calculateMetadata` run upstream.

```ts
// velocast.config.ts
import { defineConfig } from "velocast";
import { remotionSource } from "@velocast/remotion-source";

export default defineConfig({
  source: remotionSource({ entry: "src/index.tsx" }),
});
```

The entry resolves relative to the config. Install matching Velocast packages
alongside the project's own Remotion dependencies. The current native artifact
is unpublished, so prerelease use requires a prepared local package set.

```sh
velocast compositions --json
velocast inspect MyVideo --json
velocast frame MyVideo --frame 42 --output renders/frame.png
velocast render MyVideo --output renders/video.mp4 --input-props-file props.json
```

Discovery and inspection use upstream metadata without a native renderer.
For upstream reference capture, set `backend: "reference"` in
`remotionSource(...)`. The native path uses normal renderer settings. Reference
capture rejects options it cannot honor.

The project's `remotion`, `@remotion/bundler`, and `@remotion/renderer`
versions must match exactly. React and React DOM must resolve to one shared
installation. The source package resolves from the entry project and rejects
fallback to Velocast's dependency tree. Only one upstream Remotion version
can load per Node process.

Current integration profiles admit Remotion **4.0.244 with React 18** and
**4.0.526–4.0.529 with React 18 or 19**. Required upstream functions and
version profiles are checked before use. The separate
`@velocast/remotion` package is a bounded JSX compatibility bridge with its
own pinned dependencies.

The adapter prepares the original bundle and media server. Its browser bridge
drives upstream frames and readiness while the common Velocast output
coordinator handles capture and publication. Native full video output performs
a separate upstream audio pass and copies finished AAC into the result.
Reference capture renders video and audio together. Failure before publication
preserves a previous completed output.

Source adapters currently support discovery, inspection, PNG frames, and
complete MP4 output. Public frame ranges and the Velocast preview UI are not
supported for these sources. A source cannot also declare `entry`, `serve`,
or `renderer.snapshotRoot`; upstream asset/network behavior remains
unversioned. Focused tests live in `packages/remotion-source`.
