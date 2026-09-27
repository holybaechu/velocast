# Third-party notices

Velocast packages include or depend on third-party software. JavaScript and
Rust dependency license metadata is preserved by their package managers.

The optional `@velocast/remotion` JSX bridge depends on Remotion 4.0.244 under
the `remotion-pinned` alias. The standalone `@velocast/remotion-source` integration
loads the original project's installed Remotion, bundler, and renderer packages.
Those packages retain their own Remotion licenses; Velocast's license does not
replace them. Consult each installed dependency's license file for its terms.
The upstream source adapter and older bridge have separate documented
compatibility scopes.

Native release artifacts must contain the license and notice files declared in
`release/velocast-release.json`. In particular, every CEF artifact must include
the upstream `LICENSE.txt` and `CREDITS.html` from the pinned official CEF
binary distribution. The release workflow rejects an artifact when either file
is absent.

Windows native release candidates also inventory these components separately:

- FFmpeg library DLLs are taken from the pinned vcpkg build. Its complete
  `share/ffmpeg/copyright` file must be included with the native artifact.
- Intel oneVPL (`libvpl.dll`) is MIT licensed. The pinned vcpkg
  `share/libvpl/copyright` file must be included with the native artifact.
- The currently evaluated Gyan FFmpeg command-line build identifies itself as
  GPL v3. A candidate containing its `ffmpeg.exe` or `ffprobe.exe` must include
  that distribution's `LICENSE` and `README.txt`, and is not approved for
  public distribution until the GPL source and redistribution obligations have
  been reviewed and implemented.
- Microsoft VC runtime DLLs must come from the matching Visual Studio
  Redistributable directory. Their redistribution terms remain part of the
  final release audit.

No CEF or other native binary is distributed in the public JavaScript package.
