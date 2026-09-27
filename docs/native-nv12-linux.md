# Linux Vulkan NV12 validation

The `gpu-pipeline` crate loads Vulkan at runtime through `ash`. Its probe and
owned NV12 image pool are cross-platform Rust code. They do not import DMA-BUF
frames, encode video, or establish a zero-copy render-to-encoder path on Linux.
The pool creates transfer-only NV12 images, without encode-source usage or an
encode video profile in `pNext`; those images are not validated as encoder
inputs. An encode-ready pool remains separate integration work.
The crate compiled with `cargo check -p gpu-pipeline` in Kali WSL on September
27, 2026; no Linux GPU execution or DMA-BUF import was tested.

In a Linux or WSL checkout with Rust installed, compile and inspect actual
capabilities with:

```sh
gpu_work="$(mktemp -d "${TMPDIR:-/tmp}/velocast-gpu-pipeline.XXXXXX")"
export CARGO_TARGET_DIR="$gpu_work/target"
cargo test -p gpu-pipeline
cargo run -p gpu-pipeline --bin vulkan-probe
```

To try the diagnostic NV12 pool exercise on physical device index 0, add
`-- --exercise-nv12 --device 0` to the `cargo run` command. The JSON records
`diagnostic_readback_frames: 1` because this check uploads neutral BT.709
limited-range pixels and reads them back after a GPU image copy. It also
records `gpu_only_copies: 1` for a separate image-to-image operation that
waits for GPU completion without reading pixels on the CPU. The test requires
the Linux Vulkan loader, a compatible driver, and NV12 optimal-image transfer
support. WSL availability alone does not establish GPU support.

The device report lists raw extensions, queue flags, a stable Vulkan device
UUID, and duplicate enumeration indices. A usable Vulkan H.264 encode path
additionally requires the video encode queue and codec extensions, a queue
family advertising video encode, and a successful H.264 profile plus NV12
encode-source format query. A null profile result means the query was not
applicable, not that encoding was validated. DMA-BUF import and export need
their own modifier, plane layout, ownership, and synchronization validation
before Linux native frames can be connected to an encoder.
