use thiserror::Error;

#[derive(Debug, Error)]
pub enum RendererError {
    #[error("ffmpeg binary was not found on PATH")]
    FfmpegMissing,
    #[error("ffmpeg exited with code {0}")]
    FfmpegExited(i32),
    #[error("ffmpeg encoder initialization failed: {0}")]
    #[allow(dead_code)]
    FfmpegInit(String),
    #[error("accelerated rendering is required, but no compatible GPU backend is available on this platform.\nBackend cause: {0}")]
    RequiredAccelerationUnavailable(String),
    #[error("accelerated rendering is required, but it is not available for this render path: {0}.\nSet acceleration to \"auto\" to allow software fallback, or disable the incompatible option.")]
    RequiredAccelerationPathUnsupported(&'static str),
    #[error("D3D11 accelerated rendering is required, but this platform does not support the D3D11 encoder backend.\nUse Windows with D3D11-capable graphics hardware, or set acceleration to \"auto\" or \"off\".")]
    #[allow(dead_code)]
    D3D11PlatformUnsupported,
    #[error("D3D11 accelerated rendering is required, but it is not available for this render path: {0}.\nSet acceleration to \"auto\" to allow raw BGRA fallback, or disable the incompatible option.")]
    #[allow(dead_code)]
    D3D11PathUnsupported(&'static str),
    #[error("D3D11 accelerated rendering dependencies are missing.\nRun: .\\scripts\\setup-accelerated-rendering.ps1")]
    #[allow(dead_code)]
    D3D11SetupMissing,
    #[error("frame {0} timed out waiting for accelerated paint")]
    PaintTimeout(u32),
    #[error("worker {start}..{end} failed: {message}")]
    #[allow(dead_code)]
    WorkerFailed {
        start: u32,
        end: u32,
        message: String,
    },
    #[error("worker job requires frame_start, frame_end, and chunk_output")]
    #[allow(dead_code)]
    InvalidWorkerJob,
    #[error("worker frame range {start}..{end} must be non-empty")]
    InvalidWorkerRange { start: u32, end: u32 },
}
