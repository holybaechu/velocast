// Renderer-only capture choice. CpuBitmap uses the same host protocol and
// encoder as Bitmap, but starts a fresh Electron process with CPU compositing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserSurfaceMode {
    WebCodecs,
    Bitmap,
    CpuBitmap,
    Software,
}

impl BrowserSurfaceMode {
    pub fn is_bitmap(self) -> bool {
        matches!(self, Self::Bitmap | Self::CpuBitmap)
    }
}
