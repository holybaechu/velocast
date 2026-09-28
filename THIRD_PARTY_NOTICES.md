# Third-party notices

Velocast packages include or depend on third-party software. JavaScript and
Rust dependency license metadata is preserved by their package managers.

The optional `@velocast/remotion` JSX bridge depends on Remotion 4.0.244 under
the `remotion-pinned` alias. The standalone `@velocast/remotion-source`
integration loads the original project's installed Remotion, bundler, and
renderer packages. Those packages retain their own Remotion licenses;
Velocast's license does not replace them.

Native Electron runtime preparation preserves Electron's `LICENSE` and
`LICENSES.chromium.html`, the MPL 2.0 licenses of Mediabunny and its extensions,
and NodeAV's MIT `LICENSE.md`, together with the installed dependency packages'
notices. The native media backend uses NodeAV's platform bindings to FFmpeg;
these are separate from Chromium's media components. The package manager's
NodeAV download/build hooks are disabled: the runtime uses the installed
platform binding packages and does not require standalone FFmpeg executables.

NodeAV's wrapper license does not describe every library linked into its native
bindings. Public binary release preparation must audit the actual platform
binding's FFmpeg build and third-party notices. The checked-in manifest remains
blocked for public native distribution until the existing release requirements
and this dependency audit have been completed.
