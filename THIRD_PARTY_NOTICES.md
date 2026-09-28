# Third-party notices

Velocast packages include or depend on third-party software. JavaScript and
Rust dependency license metadata is preserved by their package managers.

The optional `@velocast/remotion` JSX bridge depends on Remotion 4.0.244 under
the `remotion-pinned` alias. The standalone `@velocast/remotion-source`
integration loads the original project's installed Remotion, bundler, and
renderer packages. Those packages retain their own Remotion licenses;
Velocast's license does not replace them.

Native Electron release artifacts include Electron's `LICENSE` and
`LICENSES.chromium.html` and Mediabunny's MPL 2.0 `LICENSE`. Electron distributes its
own Chromium media components, including `ffmpeg.dll` on Windows; they are
covered by Electron's notice bundle. Velocast does not package standalone
FFmpeg command-line tools or link the renderer to FFmpeg libraries.
