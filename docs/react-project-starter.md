# React static project starter

`velocast init <directory>` creates an explicitly selected missing or empty directory. `--json` returns the absolute directory, template name/version, composition ID, created-file list and `dependenciesInstalled: false`.

```powershell
velocast init my-video
Set-Location my-video
npm install
npm run build
npm run render
```

Init itself does **not** run npm, install dependencies, start a server, download a runtime, or render. The commands above are explicit follow-up actions for the project owner. Matching prerelease Velocast packages can be installed from the project's packed tarballs instead of a registry.

## Template v3

- Official `defineReactComposition`, `startVelocast`, `useCurrentFrame`, `useVideoConfig`, and `useInputProps` APIs; one project bootstrap and no direct ReactDOM root management. The helper creates its capture root, so the HTML entry needs no empty target element.
- `hello-react`: 640×360, 30fps, 90 frames. Korean title/subtitle, local SVG cover, and a deterministic frame-derived progress indicator. There are no wall-clock animations or external images/scripts/fonts.
- React/ReactDOM **18.3.1**, `@velocast/react` and `velocast` **0.1.0**; the Vite version is pinned in the generated package file.
- `npm run build` writes static `dist`. `velocast.config.ts` uses `entry: "dist/index.html"`, `renderer.snapshotRoot: "dist"`, and acceleration `auto`. `npm run render` invokes the actual current CLI syntax `velocast render hello-react --output renders/hello-react.mp4`.
- `npm run preview` builds once, starts the local player and owns a Vite build watcher. After a successful rebuild, **Refresh source** preserves the selected frame and pauses playback. The player supports playback, seeking, PNG and half-open range output; it is not a visual timeline editor. Ctrl+C stops owned servers, jobs and the watcher while retaining completed outputs.
- `input-props.json` demonstrates `npm run render -- --input-props-file input-props.json`. Offline code/style edits require rebuilding first.
- System Korean font fallback is explicit. Cross-machine typography requires adding a licensed local font; the starter does not claim font identity across operating systems.

## Creation and packaging

Nonempty directories (including hidden files), files, symlinks/junctions and symlink ancestors are rejected. All template bytes are staged under an owned random sibling directory. Publication rechecks the target and replaces only a missing or still-empty destination. Empty-directory removal is non-recursive, so concurrently added user files are not erased. Failed staging is removed within a checked parent scope; init never recursively removes the chosen project directory. Concurrent init attempts produce one complete project rather than overwriting each other.

The generated file bytes are deterministic across destination names.
`velocast-template.json` records the template version; a second init refuses
the populated target. Template source is
`packages/cli/src/templates/react-static.ts`. Focused init tests live beside
the command in `packages/cli/src`.
