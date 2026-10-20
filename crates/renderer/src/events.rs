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
        // Replace the directory entry before streaming: truncating an existing
        // event file could also truncate a hard-linked video or input file.
        let mut temporary_name = path.as_os_str().to_os_string();
        temporary_name.push(format!(".events-{}.tmp", std::process::id()));
        let temporary = std::path::PathBuf::from(temporary_name);
        let file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .await?;
        if let Err(error) = tokio::fs::rename(&temporary, path).await {
            drop(file);
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(error.into());
        }
        Ok(Self::Jsonl(file))
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
    async fn jsonl_initialization_preserves_hard_links_and_resets_reused_paths() {
        let directory = std::env::temp_dir().join(format!(
            "velocast-event-replacement-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let output = directory.join("movie.mp4");
        let event_path = directory.join("events.jsonl");
        std::fs::write(&output, b"previous video").unwrap();
        std::fs::hard_link(&output, &event_path).unwrap();

        let mut first = RendererEventSink::jsonl(&event_path).await.unwrap();
        first
            .emit(RendererEvent::RendererStarted {
                mode: "composition".into(),
                output: "movie.mp4".into(),
            })
            .await
            .unwrap();
        first.flush().await.unwrap();
        drop(first);
        assert_eq!(std::fs::read(&output).unwrap(), b"previous video");

        let mut second = RendererEventSink::jsonl(&event_path).await.unwrap();
        assert!(std::fs::read(&event_path).unwrap().is_empty());
        second
            .emit(RendererEvent::RendererFailed {
                error: "next invocation".into(),
            })
            .await
            .unwrap();
        second.flush().await.unwrap();
        drop(second);
        let text = std::fs::read_to_string(&event_path).unwrap();
        let events = text.lines().collect::<Vec<_>>();
        assert_eq!(events.len(), 1);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(events[0]).unwrap()["error"],
            "next invocation"
        );
        assert_eq!(std::fs::read(&output).unwrap(), b"previous video");
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 2);

        let unrelated_staging =
            directory.join(format!("events.jsonl.events-{}.tmp", std::process::id()));
        std::fs::write(&unrelated_staging, b"another writer owns this file").unwrap();
        assert!(RendererEventSink::jsonl(&event_path).await.is_err());
        assert_eq!(std::fs::read_to_string(&event_path).unwrap(), text);
        assert_eq!(
            std::fs::read(&unrelated_staging).unwrap(),
            b"another writer owns this file"
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

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
            cpu_readback_frames: 90,
            capture_backend: Some("electron_compositor_snapshot".to_string()),
            conversion_backend: Some("chromium_webcodecs".to_string()),
            encoder_backend: Some("electron_webcodecs_h264".to_string()),
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
            90
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(lines[1]).unwrap()["encoder_backend"],
            "electron_webcodecs_h264"
        );
        tokio::fs::remove_file(path).await.unwrap();
    }
}
