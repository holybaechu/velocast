#![allow(dead_code)]

pub mod compatibility;
pub mod worker_report;

use std::path::{Path, PathBuf};

use tokio::io::AsyncReadExt;
use tokio::process::Command;
use velocast_protocol::{CompositionManifest, RenderJob, RenderMode, RendererAcceleration};

use crate::encoder::FfmpegEncoder;
use crate::native_browser::NativeBrowser;
use crate::pipeline::render_plan::{RenderPipelinePlan, RenderPipelineRoute};
use crate::render_job::{RenderJobResources, WorkerCommand as WorkerProcess};
use crate::scheduler::{
    available_parallelism, resolve_effective_concurrency, strided_frame_assignments, FrameRange,
};
use crate::segment::SegmentWork;

#[cfg(test)]
use velocast_renderer_policy::paths::chunk_paths;
pub use velocast_renderer_policy::paths::{temp_chunk_dir_for_output, temp_output_path_for};

pub fn build_worker_jobs(
    base: &RenderJob,
    composition: &CompositionManifest,
    ranges: &[FrameRange],
    _chunk_dir: &Path,
) -> anyhow::Result<Vec<RenderJob>> {
    Ok(
        strided_frame_assignments(composition.duration_frames, ranges.len() as u32)
            .into_iter()
            .map(|assignment| {
                let mut job = base.clone();
                job.result_path = None;
                job.operation = velocast_protocol::RenderOperation::Render;
                job.output_frame = None;
                job.output_range = None;
                job.mode = RenderMode::CompositionWorker;
                job.composition_id = Some(composition.id.clone());
                job.composition = Some(composition.clone());
                job.concurrency = None;
                job.event_log_path = None;
                job.frame_start = Some(assignment.start);
                job.frame_end = Some(assignment.end);
                job.frame_step = Some(assignment.step);
                job.chunk_output = Some("-".to_string());
                job
            })
            .collect(),
    )
}

pub struct SegmentWorkers {
    pub local: SegmentWork,
    pub remote: Vec<SegmentWork>,
}

pub fn segment_work_from_plan(plan: &RenderPipelinePlan) -> anyhow::Result<SegmentWorkers> {
    if plan.route != RenderPipelineRoute::ParallelSegments {
        return Err(anyhow::anyhow!(
            "segment worker jobs require a parallel segment render plan"
        ));
    }
    let mut segments = plan.segments.iter().map(SegmentWork::from_plan);
    let local = segments
        .next()
        .ok_or_else(|| anyhow::anyhow!("segment renderer produced no worker jobs"))?;
    Ok(SegmentWorkers {
        local,
        remote: segments.collect(),
    })
}

#[cfg(test)]
fn build_segment_worker_jobs_from_plan(
    base: &RenderJob,
    composition: &CompositionManifest,
    plan: &RenderPipelinePlan,
) -> anyhow::Result<Vec<RenderJob>> {
    let work = segment_work_from_plan(plan)?;
    Ok(std::iter::once(work.local)
        .chain(work.remote)
        .map(|segment| segment.worker_job(base, composition))
        .collect())
}

pub async fn render_parallel(
    base_job: &RenderJob,
    composition: &CompositionManifest,
    resources: &mut RenderJobResources,
) -> anyhow::Result<()> {
    let effective_concurrency = resolve_effective_concurrency(
        base_job.concurrency.as_ref(),
        composition.max_concurrency,
        available_parallelism(),
        composition.duration_frames,
    );

    if effective_concurrency <= 1 {
        return Err(anyhow::anyhow!(
            "parallel renderer received single-worker concurrency"
        ));
    }

    let assignments = strided_frame_assignments(composition.duration_frames, effective_concurrency);
    let output = Path::new(&base_job.output);
    let chunk_dir = temp_chunk_dir_for_output(output, std::process::id());
    let temp_output = temp_output_path_for(output, &chunk_dir);
    let worker_jobs = build_worker_jobs(
        base_job,
        composition,
        &assignments
            .iter()
            .map(|assignment| FrameRange::new(assignment.start, assignment.end))
            .collect::<Vec<_>>(),
        &chunk_dir,
    )?;
    assemble_streamed_workers(base_job, composition, worker_jobs, &temp_output, resources).await
}

pub async fn render_parallel_segments_with_local_worker(
    base_job: &RenderJob,
    composition: &CompositionManifest,
    plan: &RenderPipelinePlan,
    browser: &NativeBrowser,
    telemetry: &mut crate::telemetry::RenderTelemetry,
    resources: &mut RenderJobResources,
) -> anyhow::Result<()> {
    let work = segment_work_from_plan(plan)?;
    let all_segments = std::iter::once(&work.local)
        .chain(work.remote.iter())
        .collect::<Vec<_>>();
    let segments = all_segments
        .iter()
        .map(|segment| segment.output.clone())
        .collect::<Vec<_>>();
    let expected_frame_counts = all_segments
        .iter()
        .map(|segment| segment.range.end - segment.range.start)
        .collect::<Vec<_>>();
    let report_paths = all_segments
        .iter()
        .filter_map(|segment| segment.telemetry_report.clone())
        .collect::<Vec<_>>();
    let worker_report_paths = all_segments
        .iter()
        .filter_map(|segment| segment.worker_report.clone())
        .collect::<Vec<_>>();
    let remote_jobs = work
        .remote
        .iter()
        .map(|segment| segment.worker_job(base_job, composition))
        .collect();
    resources.spawn_workers(worker_commands(remote_jobs)?)?;

    let input_props = crate::input_props::read_input_props(base_job.input_props_path.as_deref())?;
    let mut local_telemetry = work.local.telemetry();
    let mut probe_cache = crate::segment_muxer::SegmentProbeCache::new();
    crate::segment::execute_segment(
        &work.local,
        base_job,
        composition,
        browser,
        input_props.as_ref(),
        &mut local_telemetry,
        std::time::Instant::now(),
        &mut probe_cache,
    )
    .await?;
    resources.wait_for_workers().await?;
    aggregate_segment_worker_reports(&report_paths, telemetry).await?;
    validate_segment_worker_compatibility(base_job, &worker_report_paths, telemetry).await?;
    seed_segment_probe_cache_from_worker_reports(&worker_report_paths, &segments, &mut probe_cache)
        .await?;
    let remux_started_at = std::time::Instant::now();
    let result = crate::segment_muxer::remux_segments_with_cache(
        &segments,
        &expected_frame_counts,
        &plan.output.concat_file,
        &plan.output.temp_output,
        segment_verification_for_job(base_job, composition),
        &mut probe_cache,
    )
    .await;
    telemetry.mux_or_remux_ms += remux_started_at.elapsed().as_millis();
    result
}

async fn aggregate_segment_worker_reports(
    report_paths: &[PathBuf],
    telemetry: &mut crate::telemetry::RenderTelemetry,
) -> anyhow::Result<()> {
    for report_path in report_paths {
        let bytes = tokio::fs::read(report_path).await.map_err(|error| {
            anyhow::anyhow!(
                "failed to read segment worker report {}: {error}",
                report_path.display()
            )
        })?;
        let worker: crate::telemetry::RenderTelemetry =
            serde_json::from_slice(&bytes).map_err(|error| {
                anyhow::anyhow!(
                    "failed to parse segment worker report {}: {error}",
                    report_path.display()
                )
            })?;
        telemetry.merge_segment_worker_report(&worker);
    }
    Ok(())
}

async fn validate_segment_worker_compatibility(
    base_job: &RenderJob,
    worker_report_paths: &[PathBuf],
    telemetry: &mut crate::telemetry::RenderTelemetry,
) -> anyhow::Result<()> {
    if base_job.acceleration != RendererAcceleration::Required {
        return Ok(());
    }

    let worker_reports = read_all_worker_reports(worker_report_paths).await?;
    match crate::parallel::compatibility::validate_required_segment_workers(&worker_reports) {
        Ok(_) => {
            telemetry.record_worker_compatibility();
            Ok(())
        }
        Err(error) => {
            telemetry.record_worker_incompatibility(error.to_string());
            Err(error)
        }
    }
}

async fn read_all_worker_reports(
    paths: &[PathBuf],
) -> anyhow::Result<Vec<crate::parallel::worker_report::SegmentWorkerReport>> {
    let mut reports = Vec::with_capacity(paths.len());
    for path in paths {
        reports.push(crate::parallel::worker_report::read_worker_report(path).await?);
    }
    Ok(reports)
}

async fn seed_segment_probe_cache_from_worker_reports(
    worker_report_paths: &[PathBuf],
    segments: &[PathBuf],
    probe_cache: &mut crate::segment_muxer::SegmentProbeCache,
) -> anyhow::Result<()> {
    for report in read_all_worker_reports(worker_report_paths).await? {
        let Some(probe) = report.segment_probe else {
            continue;
        };
        let Some(segment) = segments.get(report.segment_index) else {
            continue;
        };
        probe_cache.seed_segment_probe(segment.clone(), probe);
    }
    Ok(())
}

fn segment_verification_for_job(
    base_job: &RenderJob,
    composition: &CompositionManifest,
) -> crate::segment_muxer::SegmentVerification {
    let pixel_format = base_job
        .pixel_format
        .as_deref()
        .unwrap_or(match base_job.acceleration {
            RendererAcceleration::Required => "nv12",
            RendererAcceleration::Auto | RendererAcceleration::Off => "yuv444p",
        });
    let expected = crate::segment_muxer::ExpectedVideoOutput {
        width: composition.width,
        height: composition.height,
        fps: composition.fps,
        frame_count: composition.duration_frames,
        codec_name: crate::segment_muxer::expected_codec_name(&base_job.codec),
        pix_fmts: crate::segment_muxer::expected_stream_pix_fmts(pixel_format),
    };

    if base_job.verify_segments {
        return crate::segment_muxer::SegmentVerification::SegmentsAndFinal(expected);
    }

    if base_job.acceleration == RendererAcceleration::Required {
        return crate::segment_muxer::SegmentVerification::FinalOutput(expected);
    }

    crate::segment_muxer::SegmentVerification::None
}

fn worker_commands(worker_jobs: Vec<RenderJob>) -> anyhow::Result<Vec<WorkerProcess>> {
    let binary = std::env::current_exe()?;
    worker_jobs
        .into_iter()
        .map(|job| worker_process_for_job(&binary, job))
        .collect()
}

fn worker_process_for_job(binary: &Path, job: RenderJob) -> anyhow::Result<WorkerProcess> {
    let job_json = serde_json::to_string(&job)?;
    let capture_stdout = job.chunk_output.as_deref() == Some("-");
    let mut command = Command::new(binary);
    command.args(["--job-json", &job_json]);
    Ok(WorkerProcess {
        start: job.frame_start.unwrap_or(0),
        end: job.frame_end.unwrap_or(0),
        capture_stdout,
        command,
    })
}

async fn assemble_streamed_workers(
    job: &RenderJob,
    composition: &CompositionManifest,
    worker_jobs: Vec<RenderJob>,
    output: &Path,
    resources: &mut RenderJobResources,
) -> anyhow::Result<()> {
    let frame_len = frame_byte_len(composition.width, composition.height)?;
    let worker_count = worker_jobs.len();
    if worker_count == 0 {
        return Err(anyhow::anyhow!("streamed renderer produced no worker jobs"));
    }
    let commands = worker_commands(worker_jobs)?;
    let mut encoder = FfmpegEncoder::spawn(
        composition.width,
        composition.height,
        composition.fps,
        &job.codec,
        job.pixel_format.as_deref().unwrap_or("yuv444p"),
        job.bitrate_bps,
        &output.to_string_lossy(),
    )?;
    let result = async {
        resources.spawn_workers(commands)?;
        let mut bgra = vec![0_u8; frame_len];
        for frame in 0..composition.duration_frames {
            let worker_index = (frame as usize) % worker_count;
            resources
                .worker_stdout(worker_index)?
                .read_exact(&mut bgra)
                .await?;
            encoder.write_bgra_frame(&bgra).await?;
        }
        resources.wait_for_workers().await
    }
    .await;
    match result {
        Ok(()) => encoder.finish().await.map_err(Into::into),
        Err(error) => {
            let _ = encoder.abort().await;
            Err(error)
        }
    }
}

fn frame_byte_len(width: u32, height: u32) -> anyhow::Result<usize> {
    width
        .checked_mul(height)
        .and_then(|pixels| pixels.checked_mul(4))
        .map(|bytes| bytes as usize)
        .ok_or_else(|| anyhow::anyhow!("frame dimensions overflow"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::num::NonZeroU32;
    use velocast_protocol::{RenderMode, RendererAcceleration, RendererConcurrency};

    #[test]
    fn builds_worker_jobs_with_strided_stdout_assignments() {
        let mut base = render_job(Some(RendererConcurrency::Workers(
            NonZeroU32::new(2).unwrap(),
        )));
        base.render_session = Some(velocast_protocol::RenderSession {
            session_id: "pinned-job".to_string(),
            source_version: Some("snapshot-digest".to_string()),
        });
        let composition = composition_manifest("product-hero");
        let ranges = vec![FrameRange::new(0, 60), FrameRange::new(60, 120)];
        let chunk_dir = PathBuf::from(".velocast/tmp/test");

        let jobs = build_worker_jobs(&base, &composition, &ranges, &chunk_dir).unwrap();
        assert!(jobs
            .iter()
            .all(|job| job.render_session == base.render_session));

        assert_eq!(jobs[0].mode, RenderMode::CompositionWorker);
        assert_eq!(jobs[0].composition_id.as_deref(), Some("product-hero"));
        assert_eq!(jobs[0].frame_start, Some(0));
        assert_eq!(jobs[0].frame_end, Some(90));
        assert_eq!(jobs[0].frame_step, NonZeroU32::new(2));
        assert_eq!(jobs[0].chunk_output.as_deref(), Some("-"));
        assert_eq!(jobs[1].frame_start, Some(1));
        assert_eq!(jobs[1].frame_end, Some(90));
        assert_eq!(jobs[1].frame_step, NonZeroU32::new(2));
        assert_eq!(jobs[1].chunk_output.as_deref(), Some("-"));
    }

    #[test]
    fn builds_segment_worker_jobs_from_full_render_plan() {
        let mut base = render_job(Some(RendererConcurrency::Workers(
            NonZeroU32::new(2).unwrap(),
        )));
        base.acceleration = RendererAcceleration::Required;
        base.pixel_format = Some("nv12".to_string());
        base.assembly_mode = velocast_protocol::RendererAssemblyMode::Segments;
        let composition = composition_manifest("product-hero");
        let plan = RenderPipelinePlan::for_coordinator(
            &base,
            &composition,
            8,
            42,
            crate::browser_surface::BrowserSurfaceMode::Accelerated,
            &crate::pipeline::synthetic_gpu_capabilities(),
        )
        .unwrap();

        let jobs = build_segment_worker_jobs_from_plan(&base, &composition, &plan).unwrap();

        assert_eq!(jobs.len(), 2);
        assert_eq!(jobs[0].frame_start, Some(plan.segments[0].range.start));
        assert_eq!(jobs[0].frame_end, Some(plan.segments[0].range.end));
        assert_eq!(
            jobs[0].chunk_output.as_ref().map(PathBuf::from),
            Some(plan.segments[0].output.clone())
        );
        assert_eq!(
            jobs[0].report_path.as_ref().map(PathBuf::from),
            Some(plan.segments[0].telemetry_report.clone())
        );
        assert_eq!(
            jobs[0].worker_report_path.as_ref().map(PathBuf::from),
            plan.segments[0].worker_report.clone()
        );
        assert_eq!(jobs[1].frame_start, Some(plan.segments[1].range.start));
        assert_eq!(
            jobs[1].chunk_output.as_ref().map(PathBuf::from),
            Some(plan.segments[1].output.clone())
        );
    }

    #[test]
    fn required_segment_renders_verify_final_output_by_default() {
        let mut job = render_job(Some(RendererConcurrency::Workers(
            NonZeroU32::new(2).unwrap(),
        )));
        job.acceleration = RendererAcceleration::Required;
        job.verify_segments = false;
        let composition = composition_manifest("product-hero");

        let verification = segment_verification_for_job(&job, &composition);

        assert!(matches!(
            verification,
            crate::segment_muxer::SegmentVerification::FinalOutput(_)
        ));
    }

    #[test]
    fn explicit_segment_verification_keeps_deep_segment_probes() {
        let mut job = render_job(Some(RendererConcurrency::Workers(
            NonZeroU32::new(2).unwrap(),
        )));
        job.acceleration = RendererAcceleration::Required;
        job.verify_segments = true;
        let composition = composition_manifest("product-hero");

        let verification = segment_verification_for_job(&job, &composition);

        assert!(matches!(
            verification,
            crate::segment_muxer::SegmentVerification::SegmentsAndFinal(_)
        ));
    }

    #[tokio::test]
    async fn segment_worker_compatibility_does_not_require_coordinator_wall_time() {
        let root = unique_test_dir("segment-worker-compatibility-wall-time");
        let report_paths = vec![
            root.join("segment-0000.worker-report.json"),
            root.join("segment-0001.worker-report.json"),
        ];
        for (index, report_path) in report_paths.iter().enumerate() {
            worker_report::write_worker_report(report_path, &gpu_segment_worker_report(index))
                .await
                .unwrap();
        }
        let mut job = render_job(Some(RendererConcurrency::Workers(
            NonZeroU32::new(2).unwrap(),
        )));
        job.acceleration = RendererAcceleration::Required;
        let mut telemetry = valid_gpu_segment_telemetry_without_wall_time();

        validate_segment_worker_compatibility(&job, &report_paths, &mut telemetry)
            .await
            .unwrap();

        assert_eq!(
            telemetry.worker_backend_compatibility.as_deref(),
            Some("compatible")
        );
        assert_eq!(telemetry.total_wall_ms, 0);
        let _ = tokio::fs::remove_dir_all(&root).await;
    }

    #[test]
    fn optional_acceleration_segment_renders_skip_default_final_probe() {
        let mut job = render_job(Some(RendererConcurrency::Workers(
            NonZeroU32::new(2).unwrap(),
        )));
        job.acceleration = RendererAcceleration::Auto;
        job.verify_segments = false;
        let composition = composition_manifest("product-hero");

        let verification = segment_verification_for_job(&job, &composition);

        assert_eq!(
            verification,
            crate::segment_muxer::SegmentVerification::None
        );
    }

    #[test]
    fn worker_jobs_for_url_mode_pin_selected_composition_and_preserve_selector() {
        let mut base = render_job(Some(RendererConcurrency::Workers(
            NonZeroU32::new(2).unwrap(),
        )));
        base.mode = RenderMode::Url;
        base.composition_id = None;
        base.selector = Some("#hero".to_string());
        let composition = composition_manifest("selector:#hero");
        let jobs = build_worker_jobs(
            &base,
            &composition,
            &[FrameRange::new(0, 1)],
            &PathBuf::from(".velocast/tmp/test"),
        )
        .unwrap();

        assert_eq!(jobs[0].mode, RenderMode::CompositionWorker);
        assert_eq!(jobs[0].composition_id.as_deref(), Some("selector:#hero"));
        assert_eq!(jobs[0].selector.as_deref(), Some("#hero"));
    }

    #[test]
    fn worker_jobs_clear_coordinator_only_concurrency() {
        let base = render_job(Some(RendererConcurrency::Workers(
            NonZeroU32::new(2).unwrap(),
        )));
        let jobs = build_worker_jobs(
            &base,
            &composition_manifest("product-hero"),
            &[FrameRange::new(0, 10)],
            &PathBuf::from(".velocast/tmp/test"),
        )
        .unwrap();

        assert_eq!(jobs[0].concurrency, None);
    }

    #[test]
    fn orders_chunk_paths_by_worker_index() {
        let paths = chunk_paths(
            &[FrameRange::new(0, 2), FrameRange::new(2, 4)],
            &PathBuf::from(".velocast/tmp/test"),
        );

        assert_eq!(
            paths,
            vec![
                PathBuf::from(".velocast/tmp/test/chunk-0000.bgra"),
                PathBuf::from(".velocast/tmp/test/chunk-0001.bgra"),
            ]
        );
    }

    #[test]
    fn creates_temp_chunk_dir_next_to_output_parent() {
        let dir = temp_chunk_dir_for_output(Path::new("renders/product-hero.mp4"), 42);

        assert_eq!(dir, PathBuf::from("renders/.velocast/tmp/product-hero-42"));
    }

    #[test]
    fn creates_temp_final_output_path_inside_chunk_dir() {
        let path = temp_output_path_for(
            Path::new("renders/product-hero.mp4"),
            &PathBuf::from("renders/.velocast/tmp/product-hero-42"),
        );

        assert_eq!(
            path,
            PathBuf::from("renders/.velocast/tmp/product-hero-42/product-hero.final.mp4")
        );
    }

    #[test]
    fn streamed_worker_assembly_allocates_frame_buffer_before_loop() {
        let source = include_str!("parallel.rs");
        let allocation = "let mut bgra = vec![0_u8; frame_len];";
        let loop_header = "for frame in 0..composition.duration_frames";
        let allocation_pos = source.find(allocation).expect("BGRA allocation exists");
        let loop_pos = source.find(loop_header).expect("frame loop exists");

        assert!(
            allocation_pos < loop_pos,
            "parallel assembly should reuse one BGRA buffer instead of allocating per frame"
        );
    }

    fn gpu_segment_worker_report(index: usize) -> worker_report::SegmentWorkerReport {
        worker_report::SegmentWorkerReport {
            segment_index: index,
            start_frame: (index as u32) * 120,
            end_frame_exclusive: ((index as u32) + 1) * 120,
            frames_expected: 120,
            frames_rendered: 120,
            frames_encoded: 120,
            capture_backend: "electron_d3d11_shared_texture".to_string(),
            conversion_backend: "d3d11_video_processor".to_string(),
            encoder_backend: "h264_mf".to_string(),
            surface_format_in: "bgra".to_string(),
            surface_format_encoder: "nv12".to_string(),
            requested_codec: Some("h264".to_string()),
            selected_codec: Some("h264".to_string()),
            codec: "h264".to_string(),
            pixel_format: "nv12".to_string(),
            avg_frame_rate: "60/1".to_string(),
            timebase: "1/15360".to_string(),
            cpu_readback_frames: 0,
            fallback_used: false,
            segment_probe: None,
        }
    }

    fn valid_gpu_segment_telemetry_without_wall_time() -> crate::telemetry::RenderTelemetry {
        let mut telemetry = crate::telemetry::RenderTelemetry::new(
            crate::telemetry::RenderModeLabel::ParallelSegments,
        );
        telemetry.capture_backend = Some("electron_d3d11_shared_texture".to_string());
        telemetry.conversion_backend = Some("d3d11_video_processor".to_string());
        telemetry.encoder_backend = Some("h264_mf".to_string());
        telemetry.surface_format_in = Some("bgra".to_string());
        telemetry.surface_format_encoder = Some("nv12".to_string());
        telemetry.requested_codec = Some("h264".to_string());
        telemetry.selected_codec = Some("h264".to_string());
        telemetry.frames_expected = 240;
        telemetry.frames_rendered = 240;
        telemetry.frames_encoded = 240;
        telemetry
    }

    fn render_job(concurrency: Option<RendererConcurrency>) -> RenderJob {
        RenderJob {
            operation: velocast_protocol::RenderOperation::Render,
            output_frame: None,
            output_range: None,
            result_path: None,
            mode: RenderMode::Composition,
            composition_id: Some("product-hero".to_string()),
            composition: None,
            serve_url: "http://127.0.0.1:4545".to_string(),
            selector: None,
            output: "renders/product-hero.mp4".to_string(),
            codec: "libx264".to_string(),
            pixel_format: Some("yuv444p".to_string()),
            bitrate_bps: None,
            acceleration: velocast_protocol::RendererAcceleration::Auto,
            concurrency,
            assembly_mode: velocast_protocol::RendererAssemblyMode::Auto,
            capture_probe: None,
            report_path: None,
            worker_report_path: None,
            event_log_path: None,
            input_props_path: None,
            render_session: None,
            verify_segments: false,
            frame_start: None,
            frame_end: None,
            frame_step: None,
            chunk_output: None,
        }
    }

    fn composition_manifest(id: &str) -> CompositionManifest {
        CompositionManifest {
            id: id.to_string(),
            width: 1200,
            height: 630,
            fps: 30,
            duration_frames: 90,
            target: Some("#product-hero".to_string()),
            url: None,
            max_concurrency: None,
        }
    }

    fn unique_test_dir(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("velocast-{name}-{}-{nanos}", std::process::id()))
    }
}
