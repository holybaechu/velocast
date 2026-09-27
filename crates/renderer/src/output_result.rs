use std::path::Path;
use tokio::io::AsyncWriteExt;
use velocast_protocol::{CompositionManifest, OutputFrameRange, RenderJob, RenderOperation};

#[derive(Default)]
pub(crate) struct OutputContext {
    pub compositions: Vec<CompositionManifest>,
    pub selected: Option<CompositionManifest>,
}

pub(crate) fn validate_composition(composition: &CompositionManifest) -> anyhow::Result<()> {
    if composition.width == 0
        || composition.height == 0
        || composition.fps == 0
        || composition.duration_frames == 0
    {
        return Err(anyhow::anyhow!(
            "output.invalid_composition: composition dimensions, fps and duration must be positive"
        ));
    }
    Ok(())
}

pub(crate) fn output_range(
    job: &RenderJob,
    composition: &CompositionManifest,
) -> anyhow::Result<OutputFrameRange> {
    validate_composition(composition)?;
    let range = job.output_range.clone().unwrap_or(OutputFrameRange {
        start_frame: 0,
        end_frame: composition.duration_frames,
    });
    if range.start_frame >= range.end_frame || range.end_frame > composition.duration_frames {
        return Err(anyhow::anyhow!(
            "output.invalid_range: requested [{}, {}) is outside composition [0, {})",
            range.start_frame,
            range.end_frame,
            composition.duration_frames
        ));
    }
    if job
        .output_frame
        .is_some_and(|frame| frame >= composition.duration_frames)
    {
        return Err(anyhow::anyhow!(
            "output.invalid_frame: requested frame is outside composition [0, {})",
            composition.duration_frames
        ));
    }
    Ok(range)
}

pub(crate) fn result_value(
    job: &RenderJob,
    context: &OutputContext,
    error: Option<&anyhow::Error>,
) -> serde_json::Value {
    let range = if job.operation == RenderOperation::Render {
        job.output_range.clone().or_else(|| {
            context
                .selected
                .as_ref()
                .map(|composition| OutputFrameRange {
                    start_frame: 0,
                    end_frame: composition.duration_frames,
                })
        })
    } else {
        None
    };
    let error = error.map(|error| {
        let message = format!("{error:#}");
        let prefix = message.split(':').next().unwrap_or("");
        let code = if prefix.contains('.')
            && prefix
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'_')
        {
            prefix
        } else {
            "renderer.failed"
        };
        serde_json::json!({"code":code,"message":message})
    });
    serde_json::json!({
        "apiVersion":velocast_protocol::OUTPUT_API_VERSION,
        "status":if error.is_some(){"failure"}else{"success"},
        "operation":job.operation,
        "renderSession":job.render_session,
        "sourceMode":if job.render_session.as_ref().and_then(|session|session.source_version.as_ref()).is_some(){"snapshot"}else{"unversioned"},
        "composition":context.selected,
        "compositions":context.compositions,
        "request":{"compositionId":job.composition_id,"frame":job.output_frame,"range":range},
        "outputPath":if job.operation==RenderOperation::Inspect{None}else{Some(&job.output)},
        "error":error,
    })
}

pub(crate) async fn write_optional(
    job: &RenderJob,
    context: &OutputContext,
    error: Option<&anyhow::Error>,
) -> anyhow::Result<()> {
    let Some(path) = job.result_path.as_deref() else {
        return Ok(());
    };
    let path = Path::new(path);
    if destination_key(path)? == destination_key(Path::new(&job.output))? {
        return Err(anyhow::anyhow!(
            "output.result_conflict: result_path must differ from output"
        ));
    }
    if let Some(parent) = path.parent().filter(|path| !path.as_os_str().is_empty()) {
        tokio::fs::create_dir_all(parent).await?;
    }
    let temporary = path.with_extension(format!("result-{}.tmp", std::process::id()));
    let bytes = serde_json::to_vec_pretty(&result_value(job, context, error))?;
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .await?;
    let written = async {
        file.write_all(&bytes).await?;
        file.flush().await?;
        Ok::<(), std::io::Error>(())
    }
    .await;
    drop(file);
    let result = match written {
        Ok(()) => tokio::fs::rename(&temporary, path).await,
        Err(error) => Err(error),
    };
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    result.map_err(Into::into)
}

fn destination_key(path: &Path) -> anyhow::Result<String> {
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut normalized = std::path::PathBuf::new();
    for component in absolute.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            component => normalized.push(component.as_os_str()),
        }
    }
    let resolved = std::fs::canonicalize(&normalized)
        .or_else(|_| {
            normalized
                .parent()
                .zip(normalized.file_name())
                .map(|(parent, name)| std::fs::canonicalize(parent).map(|parent| parent.join(name)))
                .unwrap_or_else(|| Ok(normalized.clone()))
        })
        .unwrap_or(normalized);
    let text = resolved.to_string_lossy().into_owned();
    Ok(if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (RenderJob, CompositionManifest) {
        let job=serde_json::from_value(serde_json::json!({"mode":"composition","composition_id":"hero","serve_url":"http://localhost","output":"out.mp4","codec":"libx264","render_session":{"sessionId":"one","sourceVersion":"source"},"output_range":{"startFrame":12,"endFrame":90}})).unwrap();
        let composition = CompositionManifest {
            id: "hero".to_owned(),
            width: 320,
            height: 180,
            fps: 30,
            duration_frames: 120,
            target: None,
            url: None,
            max_concurrency: None,
        };
        (job, composition)
    }
    #[test]
    fn public_range_preserves_original_configuration_and_exclusive_end() {
        let (mut job, composition) = fixture();
        assert_eq!(output_range(&job, &composition).unwrap().end_frame, 90);
        assert_eq!(composition.duration_frames, 120);
        job.output_range.as_mut().unwrap().end_frame = 121;
        assert!(output_range(&job, &composition).is_err());
        job.output_range = None;
        job.operation = RenderOperation::Frame;
        job.output_frame = Some(120);
        assert!(output_range(&job, &composition).is_err());
    }
    #[test]
    fn structured_result_keeps_identity_requested_source_frame_and_failure_cause() {
        let (job, composition) = fixture();
        let context = OutputContext {
            compositions: vec![composition.clone()],
            selected: Some(composition),
        };
        let value = result_value(&job, &context, None);
        assert_eq!(value["renderSession"]["sessionId"], "one");
        assert_eq!(value["sourceMode"], "snapshot");
        assert_eq!(value["composition"]["durationFrames"], 120);
        assert_eq!(value["request"]["range"]["startFrame"], 12);
        let value = result_value(
            &job,
            &context,
            Some(&anyhow::anyhow!("output.invalid_frame: outside source")),
        );
        assert_eq!(value["status"], "failure");
        assert_eq!(value["error"]["code"], "output.invalid_frame");
    }
    #[tokio::test]
    async fn refuses_a_result_alias_of_the_previous_output() {
        let (mut job, _) = fixture();
        job.output = "some-directory/../output.mp4".to_owned();
        job.result_path = Some("output.mp4".to_owned());
        let error = write_optional(&job, &OutputContext::default(), None)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("output.result_conflict"));
    }
}
