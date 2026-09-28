use thiserror::Error;
#[derive(Debug, Error)]
pub enum RendererError {
    #[error("worker {start}..{end} failed: {message}")]
    WorkerFailed {
        start: u32,
        end: u32,
        message: String,
    },
}
