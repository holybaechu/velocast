# Original Remotion projects as Velocast sources

`@velocast/remotion-source` loads an original project's installed Remotion,
bundler, React, and React DOM through a Node source adapter.
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

Discovery and inspection use Velocast's browser session to read original
Remotion metadata without a native renderer. For source-owned Chrome or Edge
reference capture, set `backend: "reference"` in `remotionSource(...)`.
That route captures PNG frames through CDP, then encodes the video with
WebCodecs. The native path uses normal renderer settings. Reference capture
rejects options it cannot honor.

The project's `remotion` and `@remotion/bundler` versions must match exactly.
React and React DOM must resolve to one shared
installation. The source package resolves from the entry project and rejects
fallback to Velocast's dependency tree. Only one upstream Remotion version
can load per Node process.

Current integration profiles admit Remotion **4.0.244 with React 18** and
**4.0.526–4.0.529 with React 18 or 19**. Required upstream functions and
version profiles are checked before use. The separate
`@velocast/remotion` package is a bounded JSX compatibility bridge with its
own pinned dependencies.

The adapter prepares the original bundle and a local media server. Velocast's
browser bridge selects compositions and captures frames; it does not launch
Remotion's rendering compositor. The original Remotion packages remain the
authoring and bundling inputs. Offthread video frames use Velocast's source
decoder. Mounted audio declarations are collected into a frozen sample plan;
the audio renderer writes a WAV intermediate for Mediabunny to encode
and mux with the WebCodecs video. Both source capture backends include audio.
Failure before publication preserves a
previous completed output.

Audio transforms such as `playbackRate` other than 1 or `toneFrequency` are
rejected with `remotion.audio_transform_unsupported`. Preprocess the source
audio for the intended pitch or tempo, then use `playbackRate={1}`. The audio
intermediate format is WAV.

Source adapters currently support discovery, inspection, PNG frames, and
complete MP4 output. Public frame ranges and the Velocast preview UI are not
supported for these sources. A source cannot also declare `entry`, `serve`,
or `renderer.snapshotRoot`; upstream asset/network behavior remains
unversioned. Focused tests live in `packages/remotion-source`.
