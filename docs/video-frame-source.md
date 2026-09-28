# Bounded video frame source

`packages/cli/src/video-frame-source.ts` provides the Node-side decoder used
by video clips. The caller supplies a snapshot-owned immutable regular file and
its SHA-256. The decoder verifies the hash and file identity before and during
use, including cache hits.

```ts
const source = await openVideoFrameSource({
  path: immutableMediaCopy,
  sourceHash,
});
try {
  const frame = await source.frameAt(originalSourceSeconds, signal);
  // Original PTS, rational time base, display size, and caller-owned RGBA
} finally {
  await source.close();
}
```

`frameAt` takes original PTS timeline seconds. Clip placement and trim mapping
belong to the caller. The `video-pts.ts` index validates increasing PTS and
uses half-open intervals `[PTS_i, PTS_(i+1))`; it does not infer variable-frame
timing from nominal FPS.

Inputs are local MP4/QuickTime or Matroska/WebM files with admitted progressive
H.264, HEVC, VP8, VP9, or AV1 pixel formats. Network protocols, playlists,
interlaced input, and unsupported formats fail explicitly. Container rotation
is applied to the returned display-oriented RGBA. Explicitly tagged PQ/HLG
BT.2020 inputs are tone-mapped to SDR BT.709; ambiguous HDR metadata is
rejected. HDR output is outside this decoder boundary.

The decoder indexes source timestamps, checks each returned frame's PTS and
dimensions, and returns caller-owned RGBA bytes. Forward requests reuse one
persistent seekable Mediabunny decoder per source; repeated frames use a
bounded cache. Reverse and distant requests seek within that session. It never
extracts a whole clip to raw frames on disk.

Default bounds include 512 MiB encoded input, 16 MiB or 250,000 index frames,
32 MiB RGBA frame, eight live Electron media processes across the Node
process, sixteen queued requests per source, and four cached frames.
`maxDecoderCursors` remains a compatibility ceiling of four, while the runtime
uses one persistent session per source. `maxCacheBytes` can lower the cache
limit. These bounds do not include Chromium codec memory or caller-retained
arrays. Cancellation closes the active session before settling; closing drains
work, reaps the host, and clears the cache.

Focused unit and browser media integration tests live beside the decoder source.
See [authored audio](authored-audio.md) for the separate sound path.
