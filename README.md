# Velocast

Velocast renders video from JavaScript and TypeScript projects. Author compositions
with React, GSAP, or plain JavaScript, inspect them in the browser preview, and
export through the Rust renderer and Electron media host.

## Getting started

Use the Node.js, pnpm, and Rust versions in [mise.toml](mise.toml). From the
repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
cargo build -p velocast-renderer
pnpm velocast doctor
```

`pnpm build` builds the JavaScript packages; Cargo builds the native renderer.
Set `CARGO_TARGET_DIR` to a directory outside the checkout to keep native build
outputs there; the CLI also searches that directory for the renderer.

Rendering and media tests need Electron and its system dependencies. If dependency
installation skipped scripts, run
`node packages/electron-host/node_modules/electron/install.js`. For Linux display
libraries and sandbox setup, follow the commands in the
[workspace setup action](.github/actions/setup/action.yml).

Browser-audit tests also need Chrome, Chromium, or Edge. Set
`VELOCAST_BROWSER_BINARY` to the executable if it is not discovered automatically.

Downloadable native releases are currently blocked in the
[release manifest](release/velocast-release.json). Use a local build, or set
`VELOCAST_RENDERER_BINARY` to an existing renderer. `pnpm velocast doctor` reports
missing runtime requirements.

Try the included playground:

```sh
pnpm velocast preview --config apps/playground/velocast.config.ts
pnpm velocast compositions --config apps/playground/velocast.config.ts
pnpm velocast render product-hero --config apps/playground/velocast.config.ts --output ../product-hero.mp4
```

Use `pnpm velocast --help` for commands and `pnpm velocast render --help` for
render options.

## Project layout

| Directory                                     | Responsibility                                          |
| --------------------------------------------- | ------------------------------------------------------- |
| `apps/playground`                             | Example compositions                                    |
| `packages/core`, `react`, `gsap`              | Composition authoring and frame timing                  |
| `packages/cli`                                | Commands, project loading, rendering, and runtime setup |
| `packages/preview`                            | Browser preview and playback                            |
| `packages/remotion-compat`, `remotion-source` | Remotion compatibility and project integration          |
| `packages/electron-host`                      | Browser capture and media processing                    |
| `crates`                                      | Rust protocol, rendering policy, and renderer           |
| `contracts`                                   | Shared protocol definitions and generated-type inputs   |
| `scripts`, `release`                          | Build, verification, and release tooling and manifests  |

CLI internals are grouped into `authoring`, `project`, `render`, `runtime`,
`preview`, and `media`, with tests beside the implementation. `commands.ts` defines
the public package exports; `cli.ts` parses command-line arguments.

## Development

```sh
pnpm check:fast
cargo test -p velocast-renderer
```

`check:fast` checks generated contracts, Rust policy, TypeScript types, lint, and
JavaScript tests. On headless Linux, run it with `xvfb-run -a pnpm check:fast` after
the display setup above. Native capture, encoding, or audio changes also need
representative rendered-output checks on the affected platform.

Edit [contracts/renderer-protocol.json](contracts/renderer-protocol.json) and run
`pnpm contracts:generate` when changing shared wire types. See
[AGENTS.md](AGENTS.md) for contribution and validation requirements.

## License

[MIT](LICENSE). Third-party notices are in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
