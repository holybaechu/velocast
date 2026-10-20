// Video snapshots use the GPU compositor; software mode is reserved for diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserSurfaceMode {
    WebCodecs,
    Software,
}
