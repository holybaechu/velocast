use crate::native_browser::NativeBrowser;
use crate::render_job::{RenderJobResources, WorkerCommand};
use crate::telemetry::{RenderModeLabel, RenderTelemetry};
use anyhow::{ensure, Context};
use serde_json::json;
use std::path::{Path, PathBuf};
use velocast_protocol::{
    CompositionManifest, OutputFrameRange, RenderJob, RenderMode, RenderOperation,
    RendererAssemblyMode,
};
pub use velocast_renderer_policy::paths::{temp_chunk_dir_for_output, temp_output_path_for};
use velocast_renderer_policy::render_plan::RenderPipelinePlan;

fn segment_job(
    base: &RenderJob,
    composition: &CompositionManifest,
    start: u32,
    end: u32,
    output: &Path,
    report: &Path,
) -> RenderJob {
    let mut job = base.clone();
    job.mode = RenderMode::CompositionWorker;
    job.operation = RenderOperation::Render;
    job.composition = Some(composition.clone());
    job.composition_id = Some(composition.id.clone());
    job.frame_start = Some(start);
    job.frame_end = Some(end);
    job.frame_step = None;
    job.chunk_output = Some(output.to_string_lossy().into_owned());
    job.output_range = None;
    job.output_frame = None;
    job.result_path = None;
    job.report_path = Some(report.to_string_lossy().into_owned());
    job.worker_report_path = None;
    job.concurrency = None;
    job.assembly_mode = RendererAssemblyMode::Reference;
    job
}
pub async fn render_segments(
    job: &RenderJob,
    composition: &CompositionManifest,
    plan: &RenderPipelinePlan,
    browser: &NativeBrowser,
    output: &Path,
    directory: &Path,
    resources: &mut RenderJobResources,
    report: &mut RenderTelemetry,
    events: &mut crate::events::RendererEventSink,
) -> anyhow::Result<()> {
    let container = crate::webcodecs::container(job)?;
    let paths: Vec<PathBuf> = plan
        .ranges
        .iter()
        .enumerate()
        .map(|(i, _)| directory.join(format!("segment-{i:04}.{container}")))
        .collect();
    let reports: Vec<PathBuf> = paths
        .iter()
        .map(|p| p.with_extension("report.json"))
        .collect();
    let mut commands = Vec::new();
    for (index, range) in plan.ranges.iter().enumerate().skip(1) {
        let mut worker = segment_job(
            job,
            composition,
            range.start,
            range.end,
            &paths[index],
            &reports[index],
        );
        let cancellation_event_path = directory.join(format!("worker-{index:04}.events.jsonl"));
        worker.event_log_path = Some(cancellation_event_path.to_string_lossy().into_owned());
        let mut command = tokio::process::Command::new(std::env::current_exe()?);
        command
            .arg("--job-json")
            .arg(serde_json::to_string(&worker)?);
        if browser.surface_mode() == crate::browser_surface::BrowserSurfaceMode::Bitmap {
            command.env("VELOCAST_ELECTRON_FORCE_BITMAP", "1");
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.as_std_mut().creation_flags(0x08000000);
        }
        commands.push(WorkerCommand {
            start: range.start,
            end: range.end,
            command,
            cancellation_event_path: Some(cancellation_event_path),
        });
    }
    resources.spawn_workers(commands)?;
    let range = plan.ranges.first().context("renderer.empty_segment_plan")?;
    let mut local = job.clone();
    local.output_range = Some(OutputFrameRange {
        start_frame: range.start,
        end_frame: range.end,
    });
    let mut local_report = RenderTelemetry::new(RenderModeLabel::ReferenceWebCodecs);
    let local_result = crate::webcodecs::render(
        &local,
        composition,
        browser,
        &paths[0],
        None,
        resources,
        &mut local_report,
        events,
    )
    .await;
    report.mode = RenderModeLabel::ParallelSegments;
    report.capture_backend = local_report.capture_backend.clone();
    report.conversion_backend = local_report.conversion_backend.clone();
    report.encoder_backend = local_report.encoder_backend.clone();
    report.surface_format_in = local_report.surface_format_in.clone();
    report.surface_format_encoder = local_report.surface_format_encoder.clone();
    report.selected_codec = local_report.selected_codec.clone();
    report.requested_codec = local_report.requested_codec.clone();
    report.target_bitrate_bps = local_report.target_bitrate_bps;
    report.webcodecs = local_report.webcodecs.clone();
    report.merge_worker(&local_report);
    local_result?;
    resources.wait_for_workers().await?;
    for (index, report_path) in reports.iter().enumerate().skip(1) {
        let worker: RenderTelemetry = serde_json::from_slice(&tokio::fs::read(report_path).await?)?;
        let range = plan.ranges[index];
        ensure!(
            worker.frames_encoded == range.end - range.start
                && worker.frames_rendered == worker.frames_encoded,
            "worker.frame_count_mismatch"
        );
        ensure!(
            worker.encoder_backend == report.encoder_backend
                && worker.selected_codec == report.selected_codec,
            "worker.encoder_mismatch"
        );
        report.merge_worker(&worker);
    }
    let now = std::time::Instant::now();
    let metadata = browser.media_operation(
        json!({"kind":"concat","paths":paths,"outputPath":std::path::absolute(output)?,"fps":composition.fps}),
    )?;
    report.mux_or_remux_ms += now.elapsed().as_millis();
    crate::output_media::validate_video(&metadata, composition, composition.duration_frames)?;
    crate::output_media::validate_codec(&metadata, crate::webcodecs::codec(job)?)?;
    crate::output_media::validate_container(&metadata, crate::webcodecs::container(job)?)?;
    report.worker_backend_compatibility = Some("compatible".into());
    resources.check_cancellation()?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn workers_keep_source_identity_and_explicit_segment_bounds() {
        let job:RenderJob=serde_json::from_value(json!({"mode":"composition","serve_url":"http://localhost","output":"movie.mp4","codec":"h264","result_path":"result.json"})).unwrap();
        let c: CompositionManifest = serde_json::from_value(
            json!({"id":"scene","width":640,"height":360,"fps":30,"durationFrames":90}),
        )
        .unwrap();
        let worker = segment_job(
            &job,
            &c,
            30,
            60,
            Path::new("segment.mp4"),
            Path::new("report.json"),
        );
        assert_eq!(worker.serve_url, job.serve_url);
        assert_eq!(worker.frame_start, Some(30));
        assert_eq!(worker.frame_end, Some(60));
        assert!(worker.result_path.is_none());
        assert_eq!(worker.render_session, job.render_session);
    }
}
