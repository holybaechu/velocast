# Cross-platform rendering options

Research date: 2026-09-27. This is an implementation proposal, not a support
announcement or a performance result. Electron is pinned to **44.4.5** in
[`packages/electron-host/package.json`](../packages/electron-host/package.json).

Follow-up: the [experimental WebCodecs implementation](experimental-webcodecs.md)
now provides an opt-in serial H.264 route. The recommendations below describe
the original research; native macOS/Linux media backends remain proposed.

## Recommendation and current boundary

Keep Electron/Chromium, the composition protocol, deterministic Rust scheduling,
audio, and transactional output. Add native frame transport and media backends
behind an owned-frame contract. This preserves the existing DOM/React/GSAP/
Remotion execution model and allows Windows D3D11 to remain the performance
baseline. There is no verified library substitution that preserves every current
feature and performance property automatically.

The repository currently implements accelerated Windows capture and encoding;
macOS/Linux use software, and required GPU capture fails. Previous CEF and Unix
GPU implementations were removed. These are repository facts documented in
[platform support](electron-renderer.md) and [architecture](architecture.md),
not evidence that upstream Electron lacks those platform APIs.

| Layer            | Available upstream                                             | Work still needed in Velocast                                                    |
| ---------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Windows          | D3D shared handles and native hardware encoding                | Preserve current route and gates                                                 |
| macOS            | Electron IOSurface export; CoreVideo/Metal; VideoToolbox       | Transfer, conversion, encoding integration, runtime validation                   |
| Linux            | Electron NativePixmap export; DMA-BUF/Vulkan/VA-API/NVENC APIs | Transfer, device/format negotiation, synchronization, vendor-specific validation |
| Browser encoding | Electron sharedTexture to VideoFrame; WebCodecs                | Experimental alternative with weaker hardware guarantees                         |

## Electron already exposes the necessary starting point

Pinned [OSR source](https://github.com/electron/electron/blob/v44.4.5/shell/browser/osr/osr_video_consumer.cc)
accepts Windows DXGI handles, macOS IOSurfaces, and Linux NativePixmaps and retains
the captured resource until explicit release. Upstream availability does not
establish success on every driver, display configuration, or Velocast workload.

The [handle contract](https://github.com/electron/electron/blob/v44.4.5/docs/api/structures/shared-texture-handle.md)
includes a process-local `IOSurfaceRef` on macOS and per-plane file descriptors,
strides, offsets, sizes, and a modifier on Linux. Extending JSON metadata alone
cannot make these handles valid inside the separate Rust process.

- On macOS, use a small native Electron addon to transfer an IOSurface Mach port,
  or perform native ingestion in that same process. Electron's
  [design note](https://github.com/electron/electron/blob/v44.4.5/shell/common/api/shared_texture/README.md)
  explains the process-local pointer and Mach-port requirement. Apple warns that
  passing IOSurface IDs does not provide the same pool-reuse protection as
  [Mach-port transfer](<https://developer.apple.com/documentation/corevideo/cvpixelbuffercreatewithiosurface(_:_:_:_:)>).
- On Linux, transfer descriptors using a Unix socket's `SCM_RIGHTS`, accompanied
  by validated plane metadata; descriptor numbers alone are insufficient.
  [Linux socket contract](https://man7.org/linux/man-pages/man7/unix.7.html).
- Retain generation, frame identity, dimensions, color metadata, and bounded
  leases. The [OSR release contract](https://github.com/electron/electron/blob/v44.4.5/docs/api/structures/offscreen-shared-texture.md)
  limits outstanding textures. Release only after the consumer has finished
  accessing the source; an owned GPU copy plus completion fence can allow early
  browser release without waiting for the entire encode operation.

## Native media routes

**macOS first:** IOSurface → Metal → owned NV12 CoreVideo pixel buffer →
VideoToolbox, retaining FFmpeg for packets, muxing, and existing audio behavior.
Apple exposes IOSurface-backed pixel buffers and
[Metal views of their planes](<https://developer.apple.com/documentation/corevideo/cvmetaltexturecachecreatetexturefromimage(_:_:_:_:_:_:_:_:_:)>).
The latter must remain retained until GPU completion. FFmpeg's
[VideoToolbox encoder](https://github.com/FFmpeg/FFmpeg/blob/n8.0/libavcodec/videotoolboxenc.c)
accepts `AV_PIX_FMT_VIDEOTOOLBOX` frames carrying a `CVPixelBufferRef`, so a CPU
pixel pipe is not intrinsically required. This reference is not a claim about
the version or configuration of a future packaged macOS FFmpeg build.

Port the existing color equations and tags deliberately. VideoToolbox
[retains input buffers while needed](<https://developer.apple.com/documentation/videotoolbox/vtcompressionsessionencodeframe(_:imagebuffer:presentationtimestamp:duration:frameproperties:sourceframerefcon:infoflagsout:)>);
do not overwrite a surface just because submission returned. Its
[required-hardware option](https://developer.apple.com/documentation/videotoolbox/kvtvideoencoderspecification_requirehardwareacceleratedvideoencoder)
fails session creation when the requested acceleration cannot be provided.
Codec, profile, bit depth, and parallel-session support still require probing.

**Linux in bounded hardware tiers:** NativePixmap/DMA-BUF → GPU conversion →
VA-API on selected Intel/AMD configurations; evaluate NVIDIA as a separate
CUDA/OpenGL-to-NVENC path. Vulkan is useful for conversion and explicit control,
but neither it nor a raw DMA-BUF proves encoder interoperability. Vulkan requires
querying support for the actual
[format/modifier/usage combination](https://docs.vulkan.org/refpages/latest/refpages/source/VK_EXT_image_drm_format_modifier.html).
VA-API's [PRIME import contract](https://github.com/intel/libva/blob/master/va/va_drmcommon.h)
explicitly allows drivers to reject particular plane/object layouts.

Negotiate the same device and compatible allocations across capture, conversion,
and encoding. Establish producer completion and consumer completion; Linux
[DMA-BUF synchronization](https://docs.kernel.org/driver-api/dma-buf.html)
distinguishes implicit fences from explicit synchronization. A valid fd is not a
completion signal. NVIDIA's [encoding guide](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-video-encoder-api-prog-guide/)
documents CUDA/OpenGL input resource handling on Linux, not universal direct
import of any Chromium DMA-BUF. Treat that bridge as a separate feasibility gate.

## Libraries and alternatives

| Option                             | Assessment for this repository                                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| FFmpeg + native platform APIs      | Recommended for maximum control. Reuse existing encoding/muxing concepts; add surface interop per platform.                         |
| Electron sharedTexture + WebCodecs | Worth a small prototype for less native glue; preserve native Windows backend while testing it.                                     |
| wgpu                               | Consider for shared conversion shaders after external-memory feasibility is proven; not a complete capture/encode solution.         |
| GStreamer                          | Strong media-pipeline alternative if its platform plugins materially reduce maintenance; larger migration than adding two backends. |
| Tauri/Wry                          | Poor fit for preserving one Chromium rendering baseline.                                                                            |
| CEF                                | Technically capable, but changing browser host does not remove native surface/encoder work.                                         |

The WebCodecs prototype can use `paint` → `sharedTexture.importSharedTexture` →
`sendSharedTexture` → `getVideoFrame()` → `VideoEncoder`, returning encoded
packets to the existing output owner. This keeps browser composition capture.
The [managed Electron API](https://github.com/electron/electron/blob/v44.4.5/docs/api/shared-texture.md)
is experimental; `allReferencesReleased` controls when the original source can
be released. Use the requested frame's deterministic PTS, bounded encoder queues,
explicit `VideoFrame.close()`, and correct drain/cancellation behavior.

Pinned [import source](https://github.com/electron/electron/blob/v44.4.5/shell/common/api/electron_api_shared_texture.cc)
does implement Linux descriptor duplication and NativePixmap import despite a
stale "to be implemented" comment. Its Linux shared-image usage flags omit
WebGPU read/write, so do not assume a portable WebGPU conversion route.
The pinned [sharedTexture tests](https://github.com/electron/electron/blob/v44.4.5/spec/api-shared-texture-spec.ts)
are gated to macOS arm64. Most importantly,
[WebCodecs](https://www.w3.org/TR/webcodecs/#hardware-acceleration) specifies
hardware acceleration as an ignorable preference and mandates no particular
codec. It therefore cannot alone establish the current required-hardware and
no-uncompressed-readback promises. Probe codec support and measure color,
quality, hidden copies, and actual encoder selection before promoting this route.

wgpu [supports Metal, Vulkan, and DX12](https://docs.rs/wgpu/30.0.1/wgpu/enum.Backend.html),
but not a D3D11 backend. Its
[native texture wrapping](https://docs.rs/wgpu/30.0.1/wgpu/struct.Device.html#method.create_texture_from_hal)
is unsafe, backend-specific, and requires a texture from that device with correct
resource state. It does not eliminate native imports, fences, or encoder memory
requirements. Rewriting the working D3D11 route around it would introduce risk.

GStreamer provides [DMA-BUF modifier negotiation](https://gstreamer.freedesktop.org/documentation/additional/design/dmabuf.html),
[VA-API encoding](https://gstreamer.freedesktop.org/documentation/va/vah264enc.html),
and [VideoToolbox encoding](https://gstreamer.freedesktop.org/documentation/applemedia/vtenc_h264.html).
These are useful components, but custom browser ingestion and exact PTS still
belong to Velocast. Negotiate GPU memory explicitly: the existence of a hardware
encoder element does not prove the pipeline avoided uploads/readbacks.

Tauri uses [WebView2 on Windows and WebKit on macOS/Linux](https://v2.tauri.app/reference/webview-versions/).
Inference: adopting it broadens CSS/media/rendering compatibility work and gives
up the same pinned Chromium engine across platforms. CEF's
[accelerated callback](https://github.com/chromiumembedded/cef/blob/master/include/cef_render_handler.h)
offers native surfaces but requires copying before callback return. Reintroducing
it would add another browser integration without solving encoding portability.

## Minimal architectural changes

1. Generalize `PlatformSurface` in
   [`surface.rs`](../crates/renderer/src/surface.rs) and the Windows-owned texture
   coupling in [`paint_state.rs`](../crates/renderer/src/paint_state.rs) to an
   owned frame lease. Keep platform handles and fences inside each backend.
2. Extend [`protocol.cjs`](../packages/electron-host/protocol.cjs) with tagged
   transport metadata and native handle transfer. Preserve frame/generation and
   release acknowledgement behavior; do not serialize pointers as portable IDs.
3. Replace the single Windows encoder-availability fact in
   [`encoder_plan.rs`](../crates/renderer-policy/src/encoder_plan.rs) with explicit
   capture/import/conversion/encode capabilities: device identity, formats,
   modifiers, color contract, codecs, and whether CPU readback is required.
4. Keep pipeline orchestration platform-neutral in
   [`frame_loop.rs`](../crates/renderer/src/frame_loop.rs) and backend activation
   in [`encoder.rs`](../crates/renderer/src/encoder.rs). An encoder/capture session
   owns its surface pool, submissions, drain, and abort. Preserve actual-opened
   backend telemetry, actionable fallback reasons, and strict `required` behavior.

## Acceptance before changing defaults

Run existing portable and native gates on real target systems, including direct,
reverse, repeated, static and ranged seeks; fonts/video readiness; reload/resize;
audio alignment; parallel workers; cancellation; and preservation of prior output.
Require zero dropped, duplicated, or reordered scheduled frames. Test color ramps,
chroma edges, range/matrix tags, and decoded output at matched quality settings.

For Windows, a proposed gate is no more than **5% median end-to-end slowdown**
against the existing backend on the same machine after enough repeated runs to
distinguish change from noise; also inspect tail latency and peak CPU/GPU memory.
This is a proposed budget, not an observed result. Compare fixed inputs,
dimensions, codec, bitrate/quality, worker count, and CLI-to-publication timing.

Require no uncompressed CPU readback for accelerated video. PNG remains the
intentional software route. For new platforms, measure against their local
software baseline and a native encoder reference; equal speed across unlike GPUs
is not a meaningful promise. Validate unsupported hardware and busy encoders,
long-run resource bounds, signed packaging, and installation separately.

No macOS/Linux GPU render or performance benchmark was run for this research.
The linked WebCodecs experiment has separate validation. Implement Windows-preserving seams first, then a macOS route,
then one defined Linux hardware tier; broaden only after these gates pass.
