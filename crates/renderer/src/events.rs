use std::path::Path;

use tokio::io::AsyncWriteExt;
pub use velocast_protocol::RendererEvent;

pub enum RendererEventSink {
    Disabled,
    Jsonl(tokio::fs::File),
}

impl RendererEventSink {
    pub fn disabled() -> Self {
        Self::Disabled
    }

    pub async fn from_optional_path(path: Option<&Path>) -> anyhow::Result<Self> {
        match path {
            Some(path) => Self::jsonl(path).await,
            None => Ok(Self::disabled()),
        }
    }

    pub async fn jsonl(path: &Path) -> anyhow::Result<Self> {
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            tokio::fs::create_dir_all(parent).await?;
        }
        Ok(Self::Jsonl(tokio::fs::File::create(path).await?))
    }

    pub async fn emit(&mut self, event: RendererEvent) -> anyhow::Result<()> {
        match self {
            Self::Disabled => Ok(()),
            Self::Jsonl(file) => {
                let json = serde_json::to_vec(&event)?;
                file.write_all(&json).await?;
                file.write_all(b"\n").await?;
                Ok(())
            }
        }
    }

    pub async fn flush(&mut self) -> anyhow::Result<()> {
        match self {
            Self::Disabled => Ok(()),
            Self::Jsonl(file) => {
                file.flush().await?;
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn jsonl_event_sink_writes_one_json_object_per_line() {
        let path = std::env::temp_dir().join(format!(
            "velocast-render-events-{}.jsonl",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut sink = RendererEventSink::jsonl(&path).await.unwrap();

        sink.emit(RendererEvent::RendererStarted {
            mode: "composition".to_string(),
            output: "renders/hero.mp4".to_string(),
        })
        .await
        .unwrap();
        sink.emit(RendererEvent::RendererFinished {
            frames_rendered: 90,
            frames_encoded: 90,
            fallback_used: false,
            fallback_reason: None,
            cpu_readback_frames: 0,
            capture_backend: Some("electron_d3d11_shared_texture".to_string()),
            conversion_backend: Some("d3d11_video_processor".to_string()),
            encoder_backend: Some("h264_mf".to_string()),
        })
        .await
        .unwrap();
        sink.flush().await.unwrap();

        let text = tokio::fs::read_to_string(&path).await.unwrap();
        let lines = text.lines().collect::<Vec<_>>();
        assert_eq!(lines.len(), 2);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(lines[0]).unwrap()["event"],
            "renderer_started"
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(lines[1]).unwrap()["event"],
            "renderer_finished"
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(lines[1]).unwrap()["cpu_readback_frames"],
            0
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(lines[1]).unwrap()["encoder_backend"],
            "h264_mf"
        );
        tokio::fs::remove_file(path).await.unwrap();
    }
}
