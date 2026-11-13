// Video capture uses GPU shared textures; explicit still output uses snapshots.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserSurfaceMode {
    WebCodecs,
    Snapshot,
}
