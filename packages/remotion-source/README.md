# @velocast/remotion-source

Run an original Remotion project through Velocast's common source pipeline.
Runtime packages are resolved from the project and checked against supported
integration profiles. The package does not install its own production Remotion
or React runtime.

```ts
import { defineConfig } from "velocast";
import { remotionSource } from "@velocast/remotion-source";

export default defineConfig({
  source: remotionSource({ entry: "src/index.tsx" }),
});
```

Use `velocast compositions`, `inspect`, `frame`, and `render` with this config.
Set `backend: "reference"` in the source to use upstream Remotion capture.

Supported Remotion versions are 4.0.244 and 4.0.526–4.0.529. The project's
Remotion, bundler, and renderer versions must match; React/React DOM must share
one compatible installation. Unsupported versions and missing capabilities fail
before capture. The legacy JSX bridge remains in the separate
`@velocast/remotion` package.

See [source configuration and lifecycle](../../docs/upstream-remotion.md) for
runtime setup, the separate native audio pass, and current limitations.
