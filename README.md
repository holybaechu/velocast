# Velocast

Velocast is a code-authored video engine for people and external AI coding agents.
Edit a web composition, inspect an exact frame or short range, preview the motion,
then render a video. The common engine is framework-independent; **React is the
first official authoring helper**. You do not select an internal adapter to use it.

Electron is the browser host on every platform. Mediabunny handles media
containers and local audio/video I/O. Its native NodeAV/FFmpeg backend supplies
software codecs by default; Chromium WebCodecs remains an explicit backend.
Windows is the first product target. The checked-in
[release manifest](release/velocast-release.json) has no published native
artifact. Native rendering currently requires a local source build or a
separately prepared runtime. See the [Electron renderer guide](docs/electron-renderer.md)
for platform limits and [Windows runtime preparation](docs/windows-runtime-candidate-prep.md).

The [media rendering guide](docs/webcodecs.md) explains format and backend
selection. Native encoding uses software codecs and CPU frame readback;
WebCodecs may use hardware, but actual hardware selection is not guaranteed.

See [PRODUCT.md](PRODUCT.md) for product goals and scope, the
[documentation index](docs/README.md) for technical guides, and
[architecture](docs/architecture.md) for implementation boundaries.

Current authoring packages require **browser protocol 4** and a matching rebuilt
native renderer. Prepared runtimes require **Electron host protocol 3** and must
include the Mediabunny server extension and its native dependencies.
The former experimental encoder environment variable is no longer needed;
`--acceleration required` now fails because WebCodecs cannot prove hardware use.

## Author → inspect → preview → render

External coding agents can install the packaged project workflow without changing
global agent settings:

```sh
velocast skill install .
```

This writes `.agents/skills/velocast/SKILL.md` in the selected project. The skill
uses the create → build → exact-frame check → fix → short-range render → full
render path documented below.

### 1. Start a React project

With the matching Velocast CLI available:

```sh
velocast init my-video
cd my-video
```

Run `velocast templates` to discover packaged starters. A lyrics workflow is also
available with `velocast init my-lyrics-video --template lyrics`. It starts with
an empty timed-text document: Velocast does not generate lyrics or imply that a
transcription happened.

To create an audio-backed version in one step, pass supplied local inputs:

```sh
velocast init my-lyrics-video --template lyrics --audio song.wav --lyrics captions.srt
```

The initializer copies the audio into the project, validates and preserves the
supplied cue text, measures bounded PCM energy/onset candidates, derives the
60 fps composition duration from decoded media metadata, and declares audio with
`createMediaTimeline`. It rejects cues beyond the measured audio duration.

`init` creates the official static React starter in a missing or empty directory.
It does not install dependencies, download a native runtime, start a server, or
render. The starter registers `hello-react`: 640×360, 30 fps, 90 frames, with local
artwork and editable Korean text.

For a prerelease checkout, obtain the **matching prepared package set** rather
than assuming the `0.1.0` packages are available from a public registry. Install
that set in the generated project before the following commands. Native output
also needs a prepared renderer; use `velocast doctor` to inspect readiness. See
[starter details](docs/react-project-starter.md) and the
[Windows candidate preparation record](docs/windows-runtime-candidate-prep.md).

```sh
npm run build
```

The build writes `dist`. The generated configuration makes the input boundary
explicit:

```ts
export default {
  entry: "dist/index.html",
  renderer: {
    snapshotRoot: "dist",
    acceleration: "auto",
  },
};
```

Keep assets in the built static bundle. A render freezes `snapshotRoot` and its
input props into one source version shared by its workers. External resources
are not silently downloaded into that snapshot. Without a configured snapshot
root, output reports an unversioned source rather than inventing a source hash.

### 2. Edit frame-derived React

Edit `src/main.jsx` and `src/style.css`, then rebuild. For example, this can replace
the starter's composition definition and component:

```jsx
import React from "react";
import {
  defineReactComposition,
  startVelocast,
  Sequence,
  useCurrentFrame,
  useInputProps,
  interpolate,
} from "@velocast/react";

function Caption() {
  const frame = useCurrentFrame(); // local frame: 0 at composition frame 30
  const { title } = useInputProps();
  const opacity = interpolate(frame, [0, 15], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return <h1 style={{ opacity }}>{title}</h1>;
}

function Scene() {
  return (
    <main style={{ width: 640, height: 360, background: "#d9eced" }}>
      <Sequence from={30} durationFrames={60}>
        <Caption />
      </Sequence>
    </main>
  );
}

const composition = defineReactComposition({
  id: "hello-react",
  component: Scene,
  video: { width: 640, height: 360, fps: 30, durationFrames: 90 },
  defaultProps: { title: "내 첫 번째 영상" },
});

startVelocast([composition]);
```

Use requested frame and inputs, not accumulated timers, to derive visible state.
`Sequence` clips a half-open interval and supplies local time without adding a
DOM wrapper. `useVideoConfig()` remains composition-global. Fonts and asynchronous
resources have explicit preparation hooks; arbitrary asynchronous React effects
are not a universal frame-readiness signal. See the
[React helper](packages/react/README.md) for `fonts`, `preload`,
`useFrameResource`, `VideoClip`, and authored audio.

### 3. Inspect one frame and a short range

From the generated project, after building:

```sh
npx velocast compositions --json
npx velocast inspect hello-react --json
npx velocast frame hello-react --frame 45 --output renders/frame-45.png --json
npx velocast render hello-react --start-frame 30 --end-frame 60 --concurrency 1 --assembly reference --output renders/range.mp4 --json
```

For repeatable agent diagnostics, keep explicit selector assertions in JSON and
run them against the built, frozen composition in an installed Chrome or Edge:

```sh
npx velocast check hello-react --frames 0,44,89 --assertions audit.assertions.json --snapshots audit-snapshots --json
```

`check` awaits the composition seek, fonts, image decoding, and browser paint. Its
report binds findings to a source hash, composition, frame/time, selector,
bounding box, and measured value. It checks page overflow and can assert
visibility, composition bounds, clipping ancestry, computed contrast, and motion
distance between exact frames. A bounded automatic scan also reports common
visible-text clipping, bounds, and measurable contrast problems; use `--strict`
to make those default warnings fail the command. The report states where DOM geometry and computed
colors cannot assess canvas/WebGL pixels, image/gradient backgrounds, text
antialiasing, or animation quality. See the [assertion schema and limits](docs/agent-composition-checks.md).

Frames are zero-based. Ranges are **start-inclusive, end-exclusive**: `[30,60)`
contains 30 frames. The component still receives its original source frame and
full composition duration; the output timeline starts at zero. Public range
output currently requires one reference worker. Complete video output has separate
multi-worker routes.

`frame` intentionally creates one PNG using software capture. It does not insert
PNG intermediates into the ordinary video pipeline. `--json` reports request,
session/source identity, output metadata, and structured errors. A previous
completed output is preserved on failure before publication. See the
[public output contract](docs/public-output-api.md).

### 4. Preview and refresh

```sh
npm run preview
```

The starter builds once and runs the official local player with a Vite build
watcher. Open the printed loopback URL. Play, seek, inspect transitions, and request
frame/range output. After editing and a successful rebuild, preview refreshes
automatically while retaining the selected frame. A broken build reports its
error and leaves the last working source available. Use **Refresh source** or
`--no-auto-refresh` for manual control. **Inspect element** shows actual text,
bounds, and styles for a CSS selector at the paused frame. Ctrl+C stops owned
servers, jobs, and the watcher; completed outputs stay
under `.velocast/preview-output`.

For a custom build, run `velocast preview --watch-command "YOUR_BUILD_WATCH_COMMAND"`
after an initial build. The command must be a trusted, persistent local watcher.
Preview is for playback and checking code-authored motion, not drag-and-drop
layout or visual timeline editing. DevTools investigation of another app belongs
to your external coding agent, not to a built-in Velocast agent.

### 5. Render the complete video

```sh
npm run render
npm run render -- --input-props-file input-props.json
```

Useful public options, also available as corresponding `renderer` config fields:

| CLI option                      | Meaning                                                                   |
| ------------------------------- | ------------------------------------------------------------------------- |
| `--codec h264`                  | Video codec: h264, hevc, av1, vp8, vp9, or prores                         |
| `--container webm`              | mp4, mov, webm, or mkv; otherwise inferred from the output path           |
| `--audio-codec opus`            | Explicit audio codec; auto uses AAC for MP4/MOV and Opus for WebM/MKV     |
| `--media-backend auto`          | Prefer WebCodecs; use native codecs when the requested encoder is unsupported |
| `--video-profile hq`            | ProRes profile: standard or hq                                            |
| `--bitrate 64M`                 | Requested video bitrate, not a guarantee of achieved bitrate              |
| `--acceleration required`       | Unsupported: WebCodecs cannot guarantee hardware acceleration             |
| `--acceleration auto`           | WebCodecs prefers hardware; native encoding currently uses software       |
| `--acceleration off`            | Prefer software encoding; Chromium makes the final choice                 |
| `--pixel-format yuv420p`        | Opaque SDR; ProRes uses yuv422p10le from an 8-bit capture source          |
| `--concurrency 8`               | Explicit complete-render worker count; `auto` is also accepted            |
| `--assembly segments`           | Complete-render segment assembly; `reference` selects the reference route |
| `--report renders/report.json`  | Renderer telemetry, including actual backends and fallback facts          |
| `--events renders/events.jsonl` | Structured renderer event log                                             |

Options override configuration. Explicit format requests remain binding. Not every codec/format/backend combination
is supported. For a live page there is also `render-url <url> --selector <selector>`;
a live URL is not the same immutable-input guarantee as the static snapshot path.

## Authoring choices and compatibility

Original Remotion projects can configure `source: remotionSource({ entry:
"src/index.tsx" })` from `@velocast/remotion-source`, then use the common
`compositions`, `inspect`, `frame`, and `render` commands. The adapter resolves
the project's installed runtime using tested compatibility profiles.
See [upstream Remotion integration](docs/upstream-remotion.md) for setup, supported
versions, reference rendering, and the separate audio-pass cost.

- **Official React:** `@velocast/react` defines the component and video metadata
  without mounting during module import. One `startVelocast` call installs the
  project catalog; React owns its capture root, time, readiness, props, and media.
  `velocast init` is the single official starter.
- **Common engine:** `@velocast/core` provides shared timing, ranges, interpolation,
  easing, audio-plan semantics, and `defineFrameComposition` for custom frame
  sources. `defineProject` validates a complete catalog before browser startup.
  The legacy `registerFrameAdapter` entry remains available.
- **Explicit GSAP:** `@velocast/gsap` offers `defineGsapComposition` with a timeline
  factory for the declarative project path. Velocast opens it lazily and seeks it
  by frame. The older `registerGsapTimeline` entry remains available. See the
  [GSAP guide](packages/gsap/README.md).
- **Bounded Remotion compatibility:** `@velocast/remotion` retains the original
  **4.0.244 / React 18.3.1** path and tests the documented **4.0.526-style** media
  API subset. Keep original imports, use the exact bundler helper, and define
  host metadata with `defineRemotionComposition`. Video/OffthreadVideo,
  modern media names, prepared volume callbacks, Series, Loop, and spring
  utilities extend the existing frame/Sequence/image/font support;
  unsupported features fail explicitly. See the
  [bridge guide](packages/remotion-compat/README.md).

Authored audio is a composition-wide sample plan shared by preview and rendering.
See [declarative composition authoring](docs/composition-authoring.md) for the
project bootstrap, custom frame sources, and migration from `register*` calls.
`createMediaTimeline` derives pictures and sound from one set of clip declarations,
including fades and sample-based gain envelopes. `VideoClip` remains a muted
primitive for custom layouts. HEVC, phone rotation, and explicitly tagged HDR/10-bit
sources use the bounded decoder; HDR inputs are normalized to SDR. See
[audio](docs/authored-audio.md) and
[video frames](docs/video-frame-source.md).

## Timed lyrics and measured music markers

Normalize supplied cues without changing their text:

```sh
velocast transcript import captions.srt --output src/lyrics.json --overwrite
velocast transcript import captions.vtt --output src/lyrics.json --overwrite
```

The normalized schema is `{schemaVersion: 1, sourceFormat, cues}`; each cue has a
string `id`, finite `startSeconds`, `endSeconds`, and `text`. Cue starts are
ordered and every interval satisfies `0 <= startSeconds < endSeconds`.

Analyze real local audio with bounded media decoding:

```sh
velocast analyze-audio song.wav --output src/music-analysis.json --max-duration 900 --overwrite
```

The output contains mono RMS energy markers and confidence-bounded onset
candidates measured from PCM. These candidates are not claims about tempo,
meter, downbeats, transcription, or lyric timing; verify them while listening.
Neither command downloads media or packages a personal source asset.

## Develop from this repository

Prerequisites: a supported Node.js version from [package.json](package.json),
the package's pnpm version, Rust stable, and Git. Native Windows builds
additionally need the MSVC C++ toolchain.

```sh
pnpm install
pnpm check:fast
pnpm build
node packages/cli/dist/bin.js init ../my-video
```

The direct built CLI can scaffold without a native runtime. Build the renderer:

```powershell
$rendererTarget = Join-Path $env:TEMP ('velocast-renderer-' + [guid]::NewGuid().ToString('N'))
pwsh -NoProfile -File scripts/build-electron-renderer.ps1 -TargetDirectory $rendererTarget -Test
$env:VELOCAST_RENDERER_BINARY = Join-Path $rendererTarget 'release/velocast-renderer.exe'
pnpm velocast doctor --json
pnpm velocast render product-hero --config apps/playground/velocast.config.ts --output renders/product-hero.mp4
```

The workspace installation supplies pinned Electron through the private
`@velocast/electron-host` package. The CLI discovers that host for source builds;
prepared runtimes supply their own bundled host and Mediabunny. No browser
selection flag is needed. `VELOCAST_RENDERER_BINARY` or `renderer.binary` can
select a compatible prepared runtime. A bare executable without its runtime
dependencies is insufficient.

On Linux and macOS, use `cargo build -p velocast-renderer --release` with Rust,
the installed Electron host. Linux also needs Electron's
system libraries and a display or Xvfb. The removed Vulkan, VAAPI, DRM, and CEF
development dependencies are no longer required.

Released-runtime resolution verifies archive size/hash, inventory, compatibility,
and architecture before atomic cache promotion. Native payloads are not npm
lifecycle downloads. `setup` requires an available manifest artifact; `doctor`
inspects rather than downloads. Private candidate manifests and offline cache
validation do not turn the unchanged foundation manifest into a public release.
See [candidate preparation](docs/windows-runtime-candidate-prep.md) and the
[architecture guide](docs/architecture.md) for test and ownership boundaries.
