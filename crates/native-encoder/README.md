# Native NV12 encoder

This Windows x64 Node-API addon imports an Electron NV12 NT texture handle in the
Electron main process, copies its visible region into an owned D3D11 NV12
hardware frame, and encodes H264 with FFmpeg QSV, NVENC, or AMF. It performs no
raw-pixel IPC, CPU readback, RGB conversion, or software encoding fallback.
The shared source and the FFmpeg device must use the same GPU adapter. Other
platforms compile the interface but reject `ready()` as unsupported.

QSV uses a derived hardware device and an `AV_HWFRAME_MAP_DIRECT` mapping from
the owned D3D11 frame to a QSV surface. That mapping retains the source texture
and cannot fall back to a CPU transfer. Allocations are macroblock aligned;
visible frame and stream dimensions retain the requested size.

Build with `scripts/build-native-encoder.ps1`, providing an FFmpeg vcpkg root,
LLVM path, and explicit build/package directories outside the repository. The
package contains `velocast-native-encoder.node` and its dynamic dependencies.
Set `VELOCAST_NATIVE_ENCODER_ADDON` to the absolute `.node` path.

```js
const { NativeEncoder } = require(process.env.VELOCAST_NATIVE_ENCODER_ADDON);
const encoder = new NativeEncoder(JSON.stringify({
  width: 1920, height: 1080, fps: 60, codec: 'h264',
  output: absoluteStagingPath, expectedFrames: 120, bitrateBps: 20000000
}));
const ready = JSON.parse(await encoder.ready());
try {
  // Keep the Electron texture lease live through promise settlement.
  await encoder.encodeFrame(JSON.stringify({
    handle: '0x1234', textureWidth: 1920, textureHeight: 1080,
    sourceRect: { left: 0, top: 0, width: 1920, height: 1080 },
    width: 1920, height: 1080, pixelFormat: 'nv12', frame: 100, pts: 0,
    colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'limited' }
  }));
} finally {
  texture.release();
}
// Submit the remaining frames, then finalize the staging file.
const report = JSON.parse(await encoder.finish());
```

The constructor validates configuration and starts one native worker. All
graphics and codec operations run on that thread. `ready`, `encodeFrame`, and
`finish` return promises containing JSON reports; `abort` returns `Promise<void>`
after native cleanup. Admission uses a bounded two-command queue and rejects
overflow immediately. Calls after finish or abort are rejected. PTS must start
at zero and increment by one; source frame numbers must increase. Every frame
must match the configured dimensions, chroma alignment, texture descriptor,
format, and color metadata. Invalid frames terminate the session.

The addon acquires the source keyed mutex, submits the GPU copy, waits for a GPU
event query, and releases the mutex before resolving. A timeout while acquiring
the mutex is safe because no copy has started. Once a copy has started, its
promise cannot settle until completion or device removal, including during
abort. This keeps the source lease valid for all submitted GPU work. FFmpeg
receives owned AVFrames, retained until corresponding output packets or encoder
destruction. Finish drains the encoder and writes the MP4 trailer. Abort,
failure, and object disposal clean up the native session and remove unfinished
staging files. Existing output files are never overwritten.

Reports expose the actual hardware encoder and adapter, dimensions, frame rate,
bitrate, color metadata, submitted frame/packet/copy counts, and zero CPU
readback/raw IPC counters. The counters describe this addon; they do not make
claims about Chromium's internal compositor implementation.

## Synchronization and color references

- [Chromium constants.h](https://chromium.googlesource.com/chromium/src/+/master/gpu/command_buffer/common/constants.h)
  defines keyed mutex acquisition and release key zero for external clients.
- [Chromium DXGI handle manager](https://chromium.googlesource.com/chromium/src/+/main/gpu/command_buffer/service/dxgi_shared_handle_manager.cc)
  uses that same key for both operations.
- [Electron OSR consumer](https://github.com/electron/electron/blob/main/shell/browser/osr/osr_video_consumer.cc)
  passes the frame color space and retains the native handle until release.
- [Chromium capture pool](https://github.com/chromium/chromium/blob/main/components/viz/service/frame_sinks/video_capture/frame_sink_video_capturer_impl.cc)
  selects `CreateREC709()` for NV12, whose
  [definition](https://github.com/chromium/chromium/blob/main/ui/gfx/color_space.h)
  is BT709 primaries, transfer, and matrix with limited range. The addon validates
  the actual Electron metadata and sets those same FFmpeg frame/codec fields;
  it does not relabel other color spaces.
