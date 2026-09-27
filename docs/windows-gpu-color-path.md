# Windows GPU color conversion

The Windows D3D11 H.264 path is:

```text
Electron shared BGRA texture → owned GPU texture → GPU crop/SRV copy
    → shader Y and UV passes into encoder NV12 texture → hardware H.264
    → compressed-packet metadata filter → muxed output
```

Capture leases and GPU completion fences protect texture ownership. The
converter keeps a GPU-only BGRA crop/SRV texture per encoder and writes directly
to the NV12 encoder surface. This avoids uncompressed-frame CPU readback during
conversion. GPU copies and normal CPU resource, compressed-packet, and mux work
remain. See [texture ownership](../crates/renderer/src/capture/windows_d3d11/owned_texture.rs)
and [shader submission](../crates/renderer/src/encode/windows/d3d11/shader_converter.rs).

The H.264 shader uses full-range BT.601 coefficients, nearest-integer
quantization, and centered 2×2 chroma averaging. The
[HLSL source](../crates/renderer/src/encode/windows/d3d11/shader_converter.hlsl)
defines the arithmetic. Output metadata signals full range, BT.601 matrix,
centered chroma, BT.709 primaries, and gamma-2.2 transfer. The
[compressed metadata filter](../crates/renderer/src/encode/windows/d3d11/metadata_bsf.rs)
writes matching H.264 VUI; it changes metadata, not pixels.

H.264 selects this shader by default. HEVC and AV1 retain the legacy
VideoProcessor path and have separate quality behavior. For diagnostics,
`VELOCAST_EXPERIMENTAL_D3D11_CONVERTER` can choose one of the converter
modes implemented in
[conversion_mode.rs](../crates/renderer/src/encode/windows/d3d11/conversion_mode.rs).
Unset it for normal defaults.

Shader dimensions must be positive and even, at most 16,384 per axis. Source
textures must be supported BGRA8, single-mip, single-slice, and non-MSAA.
The crop must match the output size exactly; the path does not scale. Invalid
plane views, device capabilities, or destination geometry fail explicitly.
Hardware availability and output quality need real native checks on the
intended Windows host.
