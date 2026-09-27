# Static input snapshots

`packages/cli/src/input-snapshot.ts` freezes a selected built/static root,
entry, and optional input-props file for one render session. All workers use
the same owned bytes. A live URL remains explicitly unversioned.

```ts
const snapshot = await createInputSnapshot({
  root: builtDirectory,
  entryPath: "index.html",
  inputPropsPath: selectedPropsFile,
});
try {
  await runAllWorkers({
    serveUrl: snapshot.url,
    session: snapshot.session,
    inputPropsPath: snapshot.inputPropsPath,
  });
} finally {
  await snapshot.close();
}
```

The entry must be a regular file inside the selected root. Props bytes are
copied once; the original file is unchanged. `sourceVersion` hashes sorted
paths, exact bytes, the entry selection, and optional props. Host paths,
timestamps, and random ports do not affect it. A fresh run has a fresh
`sessionId` even for identical content.

Symlinks, junctions, nonregular files, and entry escapes are rejected.
Inventory and byte checks detect changes during creation. Limits are 256 MiB
of input bytes, 4,096 files, and 8,192 filesystem entries. These limits are
not process memory bounds.

The snapshot server binds to loopback, supports GET/HEAD and single byte
ranges, and rejects foreign Host/Origin values. CSP confines resource
fetches to the snapshot origin, data, and blob. This is a dependency boundary
for trusted composition code, not a sandbox for hostile JavaScript.
`close()` stops serving and releases owned resources after all workers join.

Set `entry` and `renderer.snapshotRoot` in `velocast.config.ts` to use
this mode. The CLI resolves both relative to the config file. It rejects
snapshot mode combined with a live serve URL or `render-url`. See
[public output](public-output-api.md) for result semantics.
