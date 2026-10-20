// Video capture requires the GPU compositor. Software is reserved for diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserSurfaceMode {
    WebCodecs,
    Software,
}
