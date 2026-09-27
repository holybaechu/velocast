# Public composition output API

The native output API version is **1**, independent of browser protocol 4.
The CLI checks `--capabilities-json` before requesting frame or range output
from a native binary.

```sh
velocast compositions --json
velocast inspect hello-react --json
velocast frame hello-react --frame 12 --output renders/frame-12.png --json
velocast render hello-react --start-frame 12 --end-frame 30 --concurrency 1 --assembly reference --output renders/range.mp4 --json
```

All commands accept `--config` and an input-props file. A configured
`renderer.snapshotRoot` freezes static input and props for all workers.
Otherwise results report `sourceMode: "unversioned"` without a fabricated
digest.

Frames are zero-based. Ranges are start-inclusive and end-exclusive, nonempty,
and within the discovered composition. The browser receives original source
frame numbers and full composition metadata; range output timestamps begin at
zero. Public ranges use one reference worker. Complete renders can use
segmented workers.

`frame` produces one PNG through software capture and validates its bytes
before publication. It does not insert PNG intermediates into ordinary video
output. `inspect` checks declared metadata, not layout or asset readiness.

JSON results include API version, status, operation, session/source identity,
composition, requested frame or range, output path, and a structured error
when applicable. The CLI checks native result metadata against the request
before reporting success. Native staging validates output before atomic
publication; failure before publication preserves a previous completed file.

See [static snapshots](static-input-snapshot.md) and
[architecture](architecture.md) for session and publication ownership.
