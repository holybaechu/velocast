mod args;
mod audio_pipeline;
mod browser_protocol;
mod browser_surface;
mod cancellation;
mod capabilities;
mod capture;
mod electron_app;
mod encode;
mod encoder;
mod errors;
mod events;
mod frame_loop;
mod generated;
mod input_props;
mod native_browser;
mod output_media;
mod output_result;
mod output_workspace;
mod paint_state;
mod parallel;
mod pipeline;
mod platform;
mod render_job;
mod scheduler;
mod segment;
mod segment_muxer;
mod surface;
mod telemetry;

use args::Args;
use clap::Parser;
use errors::RendererError;
use events::{RendererEvent, RendererEventSink};
use native_browser::NativeBrowser;
#[cfg(test)]
use pipeline::render_plan::RenderPipelinePlan;
use pipeline::render_plan::RenderPipelineRoute;
use scheduler::{
    available_parallelism, resolve_effective_concurrency, FrameRange, StridedFrameAssignment,
};
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use velocast_protocol::{
    CompositionManifest, RenderJob, RenderJobKind, RenderMode, RendererAcceleration,
    RendererConcurrency,
};

fn main() -> anyhow::Result<()> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(run())
}

async fn run() -> anyhow::Result<()> {
    let args = Args::parse();
    if args.capabilities_json {
        println!("{}", capabilities::capabilities_json()?);
        return Ok(());
    }

    encode::windows::initialize_com_for_d3d11_encoding()?;
    tracing_subscriber::fmt()
        .with_env_filter("info")
        .with_writer(std::io::stderr)
        .init();
    let mut job = args.parse_job()?;
    job.render_session = Some(browser_protocol::render_session_for_job(&job));

    match job.kind().map_err(anyhow::Error::msg)? {
        RenderJobKind::CompositionWorker(_) => run_worker(job).await,
        RenderJobKind::Composition(_) | RenderJobKind::Url(_) => run_coordinator(job).await,
    }
}

async fn run_coordinator(job: RenderJob) -> anyhow::Result<()> {
    let mut output_context = output_result::OutputContext::default();
    let mut telemetry = coordinator_telemetry_for(&job);
    let started_at = Instant::now();
    let mut event_sink = match start_coordinator_events(&job).await {
        Ok(sink) => sink,
        Err(error) => {
            record_render_wall_time(&mut telemetry, started_at.elapsed());
            let report_result = write_optional_report(&job, &telemetry).await;
            let _ = output_result::write_optional(&job, &output_context, Some(&error)).await;
            return resolve_render_and_report_results(Err(error), report_result);
        }
    };
    let output = Path::new(&job.output);
    let directory = parallel::temp_chunk_dir_for_output(output, std::process::id());
    let temporary_output = parallel::temp_output_path_for(output, &directory);
    let mut report_attempted = false;
    let render_result = render_job::RenderJobResources::run(
        (job.capture_probe.is_none()
            && job.operation != velocast_protocol::RenderOperation::Inspect)
            .then_some(output),
        &temporary_output,
        &directory,
        async |resources| {
            resources.set_cancellation(cancellation::RenderCancellation::from_event_log_path(
                job.event_log_path.as_deref(),
            ));
            resources.check_cancellation()?;
            let render_result = run_coordinator_render(
                &job,
                &mut telemetry,
                &mut event_sink,
                resources,
                &mut output_context,
            )
            .await;
            record_render_wall_time(&mut telemetry, started_at.elapsed());
            let render_result = finalize_coordinator_render_result(&job, &telemetry, render_result);
            report_attempted = true;
            let report_result = write_optional_report(&job, &telemetry).await;
            let render_result = resolve_render_and_report_results(render_result, report_result);
            let result_record =
                output_result::write_optional(&job, &output_context, render_result.as_ref().err())
                    .await;
            resolve_render_and_report_results(render_result, result_record)
        },
    )
    .await;
    let render_result = if report_attempted {
        render_result
    } else {
        // Workspace setup can fail before the operation is entered. Refresh a
        // requested report anyway, retaining the setup error if reporting fails.
        record_render_wall_time(&mut telemetry, started_at.elapsed());
        let report_result = write_optional_report(&job, &telemetry).await;
        resolve_render_and_report_results(render_result, report_result)
    };
    let terminal_error = render_result.as_ref().err();
    if terminal_error.is_none() {
        log_renderer_success_warning(&telemetry);
    }
    let event_result =
        emit_terminal_renderer_event(&mut event_sink, &telemetry, terminal_error).await;
    let event_result = resolve_render_and_report_results(event_result, event_sink.flush().await);
    let result = resolve_render_and_report_results(render_result, event_result);
    if let Err(error) =
        output_result::write_optional(&job, &output_context, result.as_ref().err()).await
    {
        // A successful record was already durably staged before publication.
        // Do not turn post-publication housekeeping into a false failed video.
        tracing::warn!(?error, "could not refresh output result after finalization");
    }
    result
}

async fn start_coordinator_events(job: &RenderJob) -> anyhow::Result<RendererEventSink> {
    let mut sink =
        RendererEventSink::from_optional_path(job.event_log_path.as_deref().map(Path::new)).await?;
    sink.emit(RendererEvent::RendererStarted {
        mode: format!("{:?}", job.mode).to_ascii_lowercase(),
        output: job.output.clone(),
    })
    .await?;
    Ok(sink)
}

async fn emit_terminal_renderer_event(
    event_sink: &mut RendererEventSink,
    telemetry: &telemetry::RenderTelemetry,
    terminal_error: Option<&anyhow::Error>,
) -> anyhow::Result<()> {
    match terminal_error {
        None => {
            event_sink
                .emit(RendererEvent::RendererFinished {
                    frames_rendered: telemetry.frames_rendered,
                    frames_encoded: telemetry.frames_encoded,
                    fallback_used: telemetry.fallback_used,
                    fallback_reason: telemetry.fallback_reason.clone(),
                    cpu_readback_frames: telemetry.cpu_readback_frames,
                    capture_backend: telemetry.capture_backend.clone(),
                    conversion_backend: telemetry.conversion_backend.clone(),
                    encoder_backend: telemetry.encoder_backend.clone(),
                })
                .await
        }
        Some(error) => {
            event_sink
                .emit(RendererEvent::RendererFailed {
                    error: error.to_string(),
                })
                .await
        }
    }
}

#[cfg(test)]
fn terminal_renderer_error<'a>(
    render_result: &'a anyhow::Result<()>,
    report_result: &'a anyhow::Result<()>,
) -> Option<&'a anyhow::Error> {
    render_result
        .as_ref()
        .err()
        .or_else(|| report_result.as_ref().err())
}

async fn run_coordinator_render(
    job: &RenderJob,
    telemetry: &mut telemetry::RenderTelemetry,
    event_sink: &mut RendererEventSink,
    resources: &mut render_job::RenderJobResources,
    output_context: &mut output_result::OutputContext,
) -> anyhow::Result<()> {
    let initial_surface = initial_surface_for_job(job);
    let surface_mode = native_browser::resolve_surface_mode(initial_surface, job.acceleration)?;
    if surface_mode != initial_surface {
        telemetry.record_fallback(native_browser::ELECTRON_SOFTWARE_FALLBACK.to_owned());
    }
    let render_result = run_coordinator_render_with_surface_mode(
        job,
        telemetry,
        event_sink,
        resources,
        surface_mode,
        output_context,
    )
    .await;

    if let Err(error) = &render_result {
        if should_retry_software_capture_after_load_error(job.acceleration, telemetry, error) {
            tracing::info!(
                ?error,
                "accelerated Electron capture unavailable; retrying render with software paint"
            );
            record_auto_capture_fallback(telemetry, error);
            resources.reset_attempt().await?;
            return run_coordinator_render_with_surface_mode(
                job,
                telemetry,
                event_sink,
                resources,
                crate::browser_surface::BrowserSurfaceMode::Software,
                output_context,
            )
            .await;
        }
    }

    render_result
}

fn initial_surface_for_job(job: &RenderJob) -> crate::browser_surface::BrowserSurfaceMode {
    if job.operation != velocast_protocol::RenderOperation::Render
        || (job.acceleration == RendererAcceleration::Auto
            && job.pixel_format.as_deref().is_some_and(|format| {
                !velocast_renderer_policy::settings::hardware_preserves_requested_pixel_format(
                    format,
                )
            }))
    {
        crate::browser_surface::BrowserSurfaceMode::Software
    } else {
        crate::browser_surface::BrowserSurfaceMode::initial_for_acceleration(job.acceleration)
    }
}

fn should_retry_software_capture_after_load_error(
    acceleration: RendererAcceleration,
    telemetry: &telemetry::RenderTelemetry,
    error: &anyhow::Error,
) -> bool {
    crate::browser_surface::BrowserSurfaceMode::can_retry_software(acceleration)
        && telemetry.frames_rendered == 0
        && telemetry.frames_encoded == 0
        && is_accelerated_capture_start_failure(error)
}

fn is_accelerated_capture_start_failure(error: &anyhow::Error) -> bool {
    is_accelerated_paint_timeout(error)
        || error.chain().any(|cause| {
            cause
                .to_string()
                .contains("capture.accelerated_paint_unavailable")
                || cause.to_string().contains("capture.d3d11_pool_unavailable")
        })
}

fn is_accelerated_paint_timeout(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        matches!(
            cause.downcast_ref::<RendererError>(),
            Some(RendererError::PaintTimeout(_))
        )
    })
}

fn record_auto_capture_fallback(telemetry: &mut telemetry::RenderTelemetry, error: &anyhow::Error) {
    let reason = auto_capture_fallback_reason(error);
    telemetry.record_fallback(reason);
}

fn auto_capture_fallback_reason(error: &anyhow::Error) -> String {
    format!("accelerated Electron capture unavailable: {error}")
}

async fn run_coordinator_render_with_surface_mode(
    job: &RenderJob,
    telemetry: &mut telemetry::RenderTelemetry,
    event_sink: &mut RendererEventSink,
    resources: &mut render_job::RenderJobResources,
    surface_mode: crate::browser_surface::BrowserSurfaceMode,
    output_context: &mut output_result::OutputContext,
) -> anyhow::Result<()> {
    let input_props = input_props::read_input_props(job.input_props_path.as_deref())?;
    let renderer = NativeBrowser::new(surface_mode)?;
    let page_load_started_at = Instant::now();
    renderer.load(job).await?;
    telemetry.page_load_ms += page_load_started_at.elapsed().as_millis();
    let mut effective_job = job.clone();
    if surface_mode == crate::browser_surface::BrowserSurfaceMode::Software {
        effective_job.acceleration = RendererAcceleration::Off;
    }
    if effective_job.output_range.is_some() {
        if matches!(&effective_job.concurrency,Some(RendererConcurrency::Workers(workers)) if workers.get()!=1)
            || effective_job.assembly_mode == velocast_protocol::RendererAssemblyMode::Segments
        {
            return Err(anyhow::anyhow!(
                "output.range_parallel_unsupported: public ranges currently require one reference worker; use --concurrency 1 --assembly reference"
            ));
        }
        effective_job.concurrency = Some(RendererConcurrency::Workers(NonZeroU32::new(1).unwrap()));
        effective_job.assembly_mode = velocast_protocol::RendererAssemblyMode::Reference;
    }
    let job = &effective_job;
    let discovery_started_at = Instant::now();
    let compositions = renderer.discover_compositions()?;
    telemetry.composition_discovery_ms += discovery_started_at.elapsed().as_millis();
    if job.result_path.is_some() {
        output_context.compositions = compositions.clone();
    }
    if job.operation == velocast_protocol::RenderOperation::Inspect {
        for composition in &compositions {
            output_result::validate_composition(composition)?;
        }
        if let Some(id) = job.composition_id.as_deref() {
            output_context.selected = Some(frame_loop::select_composition(&compositions, id)?);
        }
        telemetry.frames_expected = 0;
        return Ok(());
    }
    let composition = match job.kind().map_err(anyhow::Error::msg)? {
        RenderJobKind::Url(url_job) => {
            select_url_composition_or_measure(&renderer, &compositions, &url_job.selector)?
        }
        RenderJobKind::Composition(composition_job) => {
            let composition_id = composition_job
                .composition_id
                .as_deref()
                .unwrap_or("product-hero");
            frame_loop::select_composition(&compositions, composition_id)?
        }
        RenderJobKind::CompositionWorker(_) => {
            return Err(anyhow::anyhow!(
                "composition_worker job cannot run on coordinator path"
            ));
        }
    };
    telemetry.frames_expected = composition.duration_frames;
    if job.result_path.is_some() {
        output_result::validate_composition(&composition)?;
        output_context.selected = Some(composition.clone());
    }
    if job.output_range.is_some() || job.operation == velocast_protocol::RenderOperation::Frame {
        let range = output_result::output_range(job, &composition)?;
        telemetry.frames_expected = if job.operation == velocast_protocol::RenderOperation::Frame {
            1
        } else {
            range.end_frame - range.start_frame
        };
    }
    if job.operation == velocast_protocol::RenderOperation::Frame {
        if !job.output.to_ascii_lowercase().ends_with(".png") {
            return Err(anyhow::anyhow!(
                "output.png_required: frame output must use a .png filename"
            ));
        }
        renderer.prepare_composition_with_input_props(&composition, None, input_props.as_ref())?;
        let directory =
            parallel::temp_chunk_dir_for_output(Path::new(&job.output), std::process::id());
        let temporary = parallel::temp_output_path_for(Path::new(&job.output), &directory);
        return frame_loop::render_frame_png(
            &composition,
            job.output_frame.expect("validated frame operation"),
            renderer.paint_state(),
            &renderer,
            &temporary,
            telemetry,
            event_sink,
        )
        .await;
    }

    if job.capture_probe == Some(velocast_protocol::RenderCaptureProbe::AcceleratedPaint) {
        renderer.prepare_composition_with_input_props(&composition, None, input_props.as_ref())?;
        let paint_state = renderer.paint_state();
        paint_state.install_standalone_owned_texture_pool()?;
        return frame_loop::probe_accelerated_paint_capture(
            &composition,
            paint_state,
            &renderer,
            telemetry,
        )
        .await;
    }

    // Resolve once after viewport/props preparation; freeze bounded local source
    // copies before frame capture and retain them inside the output transaction.
    renderer.prepare_composition_with_input_props(&composition, None, input_props.as_ref())?;
    let audio_directory =
        parallel::temp_chunk_dir_for_output(Path::new(&job.output), std::process::id());
    let audio = audio_pipeline::prepare(
        job,
        &composition,
        renderer.resolve_audio_plan(&composition, input_props.as_ref())?,
        &audio_directory,
    )?;

    let render_plan = crate::pipeline::plan_for_coordinator(
        job,
        &composition,
        available_parallelism(),
        std::process::id(),
        surface_mode,
    )?;
    event_sink
        .emit(RendererEvent::PipelinePlanResolved {
            route: render_plan.route.as_str().to_owned(),
            effective_concurrency: render_plan.effective_concurrency,
            probe_tier: render_plan.probe_tier.as_str().to_owned(),
            segment_count: render_plan.segments.len(),
            capture_mode: render_plan.backend.capture_mode.as_str().to_owned(),
            conversion_mode: render_plan.backend.conversion_mode.as_str().to_owned(),
            encoder_mode: render_plan.backend.encoder_mode.as_str().to_owned(),
            planned_encoder_backend: render_plan.backend.encoder_backend.clone(),
            encoder_backend: render_plan.backend.encoder_backend.clone(),
        })
        .await?;

    let render_result = match render_plan.route {
        RenderPipelineRoute::SerialReference => {
            match renderer.prepare_composition_with_input_props(
                &composition,
                prepare_initial_frame_for_render_loop(render_plan.route, &composition),
                input_props.as_ref(),
            ) {
                Ok(()) => {
                    frame_loop::render_frames(
                        job,
                        &composition,
                        &render_plan,
                        renderer.paint_state(),
                        &renderer,
                        telemetry,
                        Some(event_sink),
                    )
                    .await
                }
                Err(error) => Err(error),
            }
        }
        RenderPipelineRoute::ParallelSegments => {
            telemetry.mode = telemetry::RenderModeLabel::ParallelSegments;
            parallel::render_parallel_segments_with_local_worker(
                job,
                &composition,
                &render_plan,
                &renderer,
                telemetry,
                resources,
            )
            .await
        }
        RenderPipelineRoute::StreamedBgraWorkers => {
            record_streamed_bgra_worker_report(job, &composition, telemetry);
            drop(renderer);
            parallel::render_parallel(job, &composition, resources).await
        }
    };

    render_result?;
    if let Some(audio) = audio {
        audio_pipeline::mix_and_mux(audio, &render_plan.output.temp_output, resources, telemetry)
            .await?;
    }
    Ok(())
}

fn record_render_wall_time(telemetry: &mut telemetry::RenderTelemetry, elapsed: Duration) {
    telemetry.mark_finished(elapsed.as_millis());
}

fn coordinator_telemetry_for(job: &RenderJob) -> telemetry::RenderTelemetry {
    let mode = match job.operation {
        velocast_protocol::RenderOperation::Inspect => {
            telemetry::RenderModeLabel::CompositionInspection
        }
        velocast_protocol::RenderOperation::Frame => telemetry::RenderModeLabel::FramePng,
        velocast_protocol::RenderOperation::Render => telemetry::RenderModeLabel::ReferenceGpu,
    };
    telemetry::RenderTelemetry::new(mode)
}

fn log_renderer_success_warning(telemetry: &telemetry::RenderTelemetry) {
    if let Some(warning) = renderer_success_warning(telemetry) {
        tracing::warn!("{warning}");
    }
}

fn renderer_success_warning(telemetry: &telemetry::RenderTelemetry) -> Option<String> {
    if telemetry.cpu_readback_frames > 0 {
        return Some(format!(
            "renderer completed using CPU readback for {} frame(s)",
            telemetry.cpu_readback_frames
        ));
    }
    if telemetry.fallback_used {
        return Some(format!(
            "renderer completed using fallback path: {}",
            telemetry
                .fallback_reason
                .as_deref()
                .unwrap_or("unknown reason")
        ));
    }

    None
}

fn prepare_initial_frame_for_render_loop(
    _route: RenderPipelineRoute,
    _composition: &CompositionManifest,
) -> Option<u32> {
    None
}

fn resolve_render_and_report_results(
    render_result: anyhow::Result<()>,
    report_result: anyhow::Result<()>,
) -> anyhow::Result<()> {
    match (render_result, report_result) {
        (Err(render_error), _) => Err(render_error),
        (Ok(()), Err(report_error)) => Err(report_error),
        (Ok(()), Ok(())) => Ok(()),
    }
}

fn finalize_coordinator_render_result(
    job: &RenderJob,
    telemetry: &telemetry::RenderTelemetry,
    render_result: anyhow::Result<()>,
) -> anyhow::Result<()> {
    render_result?;
    if job.operation != velocast_protocol::RenderOperation::Render {
        return Ok(());
    }
    if job.capture_probe == Some(velocast_protocol::RenderCaptureProbe::AcceleratedPaint) {
        return telemetry.validate_required_capture_probe();
    }
    if job.acceleration == RendererAcceleration::Required {
        crate::platform::verify_render_completion(
            telemetry,
            job.mode != RenderMode::CompositionWorker,
        )?;
    }
    Ok(())
}

async fn write_optional_report(
    job: &RenderJob,
    telemetry: &telemetry::RenderTelemetry,
) -> anyhow::Result<()> {
    let Some(report_path) = job.report_path.as_deref() else {
        return Ok(());
    };
    telemetry::write_report(Path::new(report_path), telemetry).await
}

fn record_streamed_bgra_worker_report(
    job: &RenderJob,
    composition: &CompositionManifest,
    telemetry: &mut telemetry::RenderTelemetry,
) {
    telemetry.capture_backend = Some("streamed_bgra_workers".to_string());
    telemetry.conversion_backend = Some("cpu_bgra_readback".to_string());
    telemetry.encoder_backend = Some("raw_bgra_ffmpeg_stdin".to_string());
    telemetry.surface_format_in = Some("bgra".to_string());
    telemetry.surface_format_encoder =
        Some(job.pixel_format.as_deref().unwrap_or("yuv444p").to_string());
    telemetry.target_bitrate_bps = job.bitrate_bps;
    telemetry.cpu_readback_frames += u64::from(composition.duration_frames);
    telemetry.mode = telemetry::RenderModeLabel::StreamedBgraWorkers;
}

#[allow(dead_code)]
fn resolve_coordinator_concurrency(
    requested: Option<&RendererConcurrency>,
    acceleration: Option<RendererAcceleration>,
    max_concurrency: Option<NonZeroU32>,
    available_workers: u32,
    duration_frames: u32,
) -> u32 {
    if acceleration == Some(RendererAcceleration::Required) {
        return 1;
    }

    resolve_effective_concurrency(
        requested,
        max_concurrency,
        available_workers,
        duration_frames,
    )
}

async fn run_worker(mut job: RenderJob) -> anyhow::Result<()> {
    let initial_surface = initial_surface_for_job(&job);
    let surface_mode = native_browser::resolve_surface_mode(initial_surface, job.acceleration)?;
    if surface_mode == crate::browser_surface::BrowserSurfaceMode::Software {
        job.acceleration = RendererAcceleration::Off;
    }
    let (assignment, chunk_output) = worker_assignment_and_output(&job)?;
    let mut segment = if worker_output_is_mp4_segment(&chunk_output) {
        let work = segment::SegmentWork::from_worker_job(&job)?;
        let mut telemetry = work.telemetry();
        if surface_mode != initial_surface {
            telemetry.record_fallback(native_browser::ELECTRON_SOFTWARE_FALLBACK.to_owned());
        }
        Some((work, telemetry))
    } else {
        None
    };
    let worker_started_at = Instant::now();
    let renderer = NativeBrowser::new(surface_mode)?;
    let input_props = input_props::read_input_props(job.input_props_path.as_deref())?;
    let page_load_started_at = Instant::now();
    renderer.load(&job).await?;
    if let Some((_, telemetry)) = segment.as_mut() {
        telemetry.page_load_ms += page_load_started_at.elapsed().as_millis();
    }
    let composition = if let Some(composition) = worker_composition_from_job(&job) {
        composition
    } else {
        let discovery_started_at = Instant::now();
        let compositions = renderer.discover_compositions()?;
        if let Some((_, telemetry)) = segment.as_mut() {
            telemetry.composition_discovery_ms += discovery_started_at.elapsed().as_millis();
        }
        if let Some(selector) = job.selector.as_deref() {
            select_url_composition_or_measure(&renderer, &compositions, selector)?
        } else {
            let composition_id = job.composition_id.as_deref().unwrap_or("product-hero");
            frame_loop::select_composition(&compositions, composition_id)?
        }
    };
    if let Some((work, mut telemetry)) = segment {
        let mut probe_cache = segment_muxer::SegmentProbeCache::new();
        return segment::execute_segment(
            &work,
            &job,
            &composition,
            &renderer,
            input_props.as_ref(),
            &mut telemetry,
            worker_started_at,
            &mut probe_cache,
        )
        .await;
    }

    renderer.prepare_composition_with_input_props(
        &composition,
        Some(assignment.start),
        input_props.as_ref(),
    )?;
    if chunk_output == Path::new("-") {
        let mut stdout = tokio::io::stdout();
        frame_loop::render_frame_assignment_to_writer(
            &composition,
            assignment,
            renderer.paint_state(),
            &renderer,
            &mut stdout,
        )
        .await?;
        return Ok(());
    }

    frame_loop::render_frame_range_to_chunk(
        &composition,
        FrameRange::new(assignment.start, assignment.end),
        renderer.paint_state(),
        &renderer,
        &chunk_output,
    )
    .await
}

fn worker_output_is_mp4_segment(path: &Path) -> bool {
    segment::worker_output_is_segment(path)
}

fn worker_composition_from_job(job: &RenderJob) -> Option<CompositionManifest> {
    job.composition.clone()
}

fn select_url_composition_or_measure(
    renderer: &NativeBrowser,
    compositions: &[CompositionManifest],
    selector: &str,
) -> anyhow::Result<CompositionManifest> {
    match frame_loop::select_url_composition(compositions, selector) {
        Ok(composition) => Ok(composition),
        Err(_) => frame_loop::composition_from_selector_measurement(
            selector,
            renderer.measure_selector(selector)?,
        ),
    }
}

fn worker_assignment_and_output(
    job: &RenderJob,
) -> anyhow::Result<(StridedFrameAssignment, PathBuf)> {
    let RenderJobKind::CompositionWorker(worker_job) = job.kind().map_err(anyhow::Error::msg)?
    else {
        return Err(RendererError::InvalidWorkerJob.into());
    };
    if worker_job.frame_start >= worker_job.frame_end {
        return Err(RendererError::InvalidWorkerRange {
            start: worker_job.frame_start,
            end: worker_job.frame_end,
        }
        .into());
    }

    Ok((
        StridedFrameAssignment {
            start: worker_job.frame_start,
            end: worker_job.frame_end,
            step: worker_job
                .frame_step
                .unwrap_or_else(|| NonZeroU32::new(1).unwrap()),
        },
        PathBuf::from(worker_job.chunk_output),
    ))
}

#[cfg(test)]
fn worker_range_and_output(job: &RenderJob) -> anyhow::Result<(FrameRange, PathBuf)> {
    let (assignment, output) = worker_assignment_and_output(job)?;
    Ok((FrameRange::new(assignment.start, assignment.end), output))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};
    use velocast_protocol::{RenderJob, RenderMode};

    fn worker_job() -> RenderJob {
        RenderJob {
            operation: velocast_protocol::RenderOperation::Render,
            output_frame: None,
            output_range: None,
            result_path: None,
            mode: RenderMode::CompositionWorker,
            composition_id: Some("product-hero".to_string()),
            composition: None,
            serve_url: "http://127.0.0.1:4545".to_string(),
            selector: None,
            output: "renders/product-hero.mp4".to_string(),
            codec: "libx264".to_string(),
            pixel_format: Some("yuv444p".to_string()),
            bitrate_bps: None,
            acceleration: velocast_protocol::RendererAcceleration::Auto,
            concurrency: None,
            assembly_mode: velocast_protocol::RendererAssemblyMode::Auto,
            capture_probe: None,
            report_path: None,
            worker_report_path: None,
            event_log_path: None,
            input_props_path: None,
            render_session: None,
            verify_segments: false,
            frame_start: Some(10),
            frame_end: Some(20),
            frame_step: None,
            chunk_output: Some(".velocast/tmp/chunk-0000.bgra".to_string()),
        }
    }

    fn coordinator_job() -> RenderJob {
        let mut job = worker_job();
        job.mode = RenderMode::Composition;
        job.frame_start = None;
        job.frame_end = None;
        job.frame_step = None;
        job.chunk_output = None;
        job
    }

    fn composition(duration_frames: u32) -> CompositionManifest {
        CompositionManifest {
            id: "hero".to_string(),
            width: 1920,
            height: 1080,
            fps: 60,
            duration_frames,
            target: Some("#hero".to_string()),
            url: None,
            max_concurrency: None,
        }
    }

    #[test]
    fn auto_concurrency_uses_parallel_scheduler_without_runtime_gpu_probe() {
        let resolved = resolve_coordinator_concurrency(
            Some(&velocast_protocol::RendererConcurrency::Auto),
            None,
            None,
            8,
            240,
        );

        assert_eq!(resolved, 4);
    }

    #[test]
    fn auto_concurrency_does_not_use_compile_time_gpu_availability_as_runtime_probe() {
        let resolved = resolve_coordinator_concurrency(
            Some(&velocast_protocol::RendererConcurrency::Auto),
            None,
            None,
            8,
            240,
        );

        assert_eq!(resolved, 4);
    }

    #[test]
    fn explicit_worker_concurrency_overrides_gpu_serial_preference() {
        let resolved = resolve_coordinator_concurrency(
            Some(&velocast_protocol::RendererConcurrency::Workers(
                std::num::NonZeroU32::new(4).unwrap(),
            )),
            None,
            None,
            8,
            240,
        );

        assert_eq!(resolved, 4);
    }

    #[test]
    fn required_acceleration_forces_serial_concurrency() {
        let resolved = resolve_coordinator_concurrency(
            Some(&velocast_protocol::RendererConcurrency::Auto),
            Some(velocast_protocol::RendererAcceleration::Required),
            None,
            8,
            240,
        );

        assert_eq!(resolved, 1);
    }

    #[test]
    fn auto_acceleration_retries_software_for_accelerated_capture_failure() {
        let error = anyhow::anyhow!("capture.accelerated_paint_unavailable");
        let telemetry = telemetry::RenderTelemetry::new(telemetry::RenderModeLabel::ReferenceGpu);

        assert!(should_retry_software_capture_after_load_error(
            velocast_protocol::RendererAcceleration::Auto,
            &telemetry,
            &error
        ));
    }

    #[test]
    fn auto_acceleration_retries_software_for_paint_timeout_before_progress() {
        let error = anyhow::Error::new(RendererError::PaintTimeout(0));
        let telemetry = telemetry::RenderTelemetry::new(telemetry::RenderModeLabel::ReferenceGpu);

        assert!(should_retry_software_capture_after_load_error(
            velocast_protocol::RendererAcceleration::Auto,
            &telemetry,
            &error
        ));
    }

    #[test]
    fn explicit_software_format_chooses_software_capture_and_pool_failure_can_retry_before_progress(
    ) {
        let mut job = coordinator_job();
        job.acceleration = RendererAcceleration::Auto;
        job.pixel_format = Some("yuv444p".to_owned());
        assert_eq!(
            initial_surface_for_job(&job),
            crate::browser_surface::BrowserSurfaceMode::Software
        );
        job.pixel_format = Some("nv12".to_owned());
        assert_eq!(
            initial_surface_for_job(&job),
            crate::browser_surface::BrowserSurfaceMode::Accelerated
        );
        let mut telemetry =
            telemetry::RenderTelemetry::new(telemetry::RenderModeLabel::ReferenceGpu);
        let error = anyhow::anyhow!("capture.d3d11_pool_unavailable");
        assert!(should_retry_software_capture_after_load_error(
            RendererAcceleration::Auto,
            &telemetry,
            &error
        ));
        telemetry.frames_rendered = 1;
        assert!(!should_retry_software_capture_after_load_error(
            RendererAcceleration::Auto,
            &telemetry,
            &error
        ));
        assert!(!should_retry_software_capture_after_load_error(
            RendererAcceleration::Required,
            &telemetry,
            &error
        ));
    }

    #[test]
    fn auto_capture_fallback_preserves_paint_timeout_reason() {
        let error = anyhow::Error::new(RendererError::PaintTimeout(0));
        let mut telemetry =
            telemetry::RenderTelemetry::new(telemetry::RenderModeLabel::ReferenceGpu);

        record_auto_capture_fallback(&mut telemetry, &error);

        assert!(telemetry.fallback_used);
        assert_eq!(
            telemetry.fallback_reason.as_deref(),
            Some(
                "accelerated Electron capture unavailable: frame 0 timed out waiting for accelerated paint"
            )
        );
        assert!(telemetry.backend_diagnostics.is_empty());
    }

    #[test]
    fn required_acceleration_does_not_retry_software_for_accelerated_capture_failure() {
        let error = anyhow::Error::new(RendererError::PaintTimeout(0));
        let telemetry = telemetry::RenderTelemetry::new(telemetry::RenderModeLabel::ReferenceGpu);

        assert!(!should_retry_software_capture_after_load_error(
            velocast_protocol::RendererAcceleration::Required,
            &telemetry,
            &error
        ));
    }

    #[test]
    fn auto_acceleration_does_not_retry_for_unrelated_load_error() {
        let error = anyhow::anyhow!("Electron waitForReady timed out");
        let telemetry = telemetry::RenderTelemetry::new(telemetry::RenderModeLabel::ReferenceGpu);

        assert!(!should_retry_software_capture_after_load_error(
            velocast_protocol::RendererAcceleration::Auto,
            &telemetry,
            &error
        ));
    }

    #[test]
    fn off_acceleration_does_not_retry_software_for_accelerated_capture_failure() {
        let error = anyhow::Error::new(RendererError::PaintTimeout(0));
        let telemetry = telemetry::RenderTelemetry::new(telemetry::RenderModeLabel::ReferenceGpu);

        assert!(!should_retry_software_capture_after_load_error(
            velocast_protocol::RendererAcceleration::Off,
            &telemetry,
            &error
        ));
    }

    #[test]
    fn auto_acceleration_does_not_retry_after_render_progress() {
        let error = anyhow::Error::new(RendererError::PaintTimeout(1));
        let mut telemetry =
            telemetry::RenderTelemetry::new(telemetry::RenderModeLabel::ReferenceGpu);
        telemetry.frames_rendered = 1;
        telemetry.frames_encoded = 1;

        assert!(!should_retry_software_capture_after_load_error(
            velocast_protocol::RendererAcceleration::Auto,
            &telemetry,
            &error
        ));
    }

    #[test]
    fn auto_acceleration_does_not_retry_for_host_initialization_failure() {
        let error = anyhow::anyhow!("electron.host_start_failed");
        let telemetry = telemetry::RenderTelemetry::new(telemetry::RenderModeLabel::ReferenceGpu);

        assert!(!should_retry_software_capture_after_load_error(
            velocast_protocol::RendererAcceleration::Auto,
            &telemetry,
            &error
        ));
    }

    #[test]
    fn segments_required_workers_choose_parallel_segment_path() {
        let mut job = coordinator_job();
        job.assembly_mode = velocast_protocol::RendererAssemblyMode::Segments;
        job.acceleration = RendererAcceleration::Required;
        job.pixel_format = Some("nv12".to_string());
        job.concurrency = Some(velocast_protocol::RendererConcurrency::Workers(
            NonZeroU32::new(2).unwrap(),
        ));

        let plan = RenderPipelinePlan::for_coordinator(
            &job,
            &composition(90),
            8,
            1,
            crate::browser_surface::BrowserSurfaceMode::Accelerated,
            &crate::pipeline::synthetic_gpu_capabilities(),
        )
        .unwrap();

        assert_eq!(plan.route, RenderPipelineRoute::ParallelSegments);
        assert_eq!(plan.effective_concurrency, 2);
    }

    #[test]
    fn required_render_plan_rejects_software_only_capabilities_for_every_assembly_mode() {
        use velocast_protocol::RendererAssemblyMode::{Auto, Reference, Segments};
        use velocast_renderer_policy::encoder_plan::EncoderCapabilities;

        for assembly_mode in [Auto, Reference, Segments] {
            let mut job = coordinator_job();
            job.assembly_mode = assembly_mode;
            job.acceleration = RendererAcceleration::Required;
            job.pixel_format = Some("nv12".to_owned());
            job.concurrency = Some(RendererConcurrency::Workers(NonZeroU32::new(1).unwrap()));

            let error = RenderPipelinePlan::for_coordinator(
                &job,
                &composition(90),
                8,
                1,
                crate::browser_surface::BrowserSurfaceMode::Accelerated,
                &EncoderCapabilities::software_only(),
            )
            .unwrap_err();

            assert!(
                error
                    .to_string()
                    .starts_with("acceleration.required_unavailable:"),
                "{assembly_mode:?} must reject unavailable required GPU capture: {error}"
            );
        }
    }

    #[test]
    fn segments_single_worker_still_uses_segment_route() {
        let mut job = coordinator_job();
        job.assembly_mode = velocast_protocol::RendererAssemblyMode::Segments;
        job.concurrency = Some(velocast_protocol::RendererConcurrency::Workers(
            NonZeroU32::new(1).unwrap(),
        ));

        let plan = RenderPipelinePlan::for_coordinator(
            &job,
            &composition(90),
            8,
            1,
            crate::browser_surface::BrowserSurfaceMode::Accelerated,
            &crate::pipeline::synthetic_gpu_capabilities(),
        )
        .unwrap();

        assert_eq!(plan.route, RenderPipelineRoute::ParallelSegments);
        assert_eq!(plan.effective_concurrency, 1);
    }

    #[test]
    fn reference_required_workers_reject_parallel_concurrency() {
        let mut job = coordinator_job();
        job.assembly_mode = velocast_protocol::RendererAssemblyMode::Reference;
        job.acceleration = RendererAcceleration::Required;
        job.pixel_format = Some("nv12".to_string());
        job.concurrency = Some(velocast_protocol::RendererConcurrency::Workers(
            NonZeroU32::new(2).unwrap(),
        ));

        let error = RenderPipelinePlan::for_coordinator(
            &job,
            &composition(90),
            8,
            1,
            crate::browser_surface::BrowserSurfaceMode::Accelerated,
            &crate::pipeline::synthetic_gpu_capabilities(),
        )
        .unwrap_err()
        .to_string();

        assert_eq!(
            error,
            "reference assembly mode cannot run with concurrency greater than 1"
        );
    }

    #[test]
    fn auto_required_workers_choose_parallel_segments() {
        let mut job = coordinator_job();
        job.assembly_mode = velocast_protocol::RendererAssemblyMode::Auto;
        job.acceleration = RendererAcceleration::Required;
        job.pixel_format = Some("nv12".to_string());
        job.concurrency = Some(velocast_protocol::RendererConcurrency::Workers(
            NonZeroU32::new(2).unwrap(),
        ));

        let plan = RenderPipelinePlan::for_coordinator(
            &job,
            &composition(90),
            8,
            1,
            crate::browser_surface::BrowserSurfaceMode::Accelerated,
            &crate::pipeline::synthetic_gpu_capabilities(),
        )
        .unwrap();

        assert_eq!(plan.route, RenderPipelineRoute::ParallelSegments);
        assert_eq!(plan.effective_concurrency, 2);
    }

    #[test]
    fn auto_short_compositions_keep_serial_reference_route() {
        let mut job = coordinator_job();
        job.assembly_mode = velocast_protocol::RendererAssemblyMode::Auto;
        job.acceleration = RendererAcceleration::Required;
        job.pixel_format = Some("nv12".to_string());
        job.concurrency = Some(velocast_protocol::RendererConcurrency::Workers(
            NonZeroU32::new(4).unwrap(),
        ));

        let plan = RenderPipelinePlan::for_coordinator(
            &job,
            &composition(30),
            8,
            1,
            crate::browser_surface::BrowserSurfaceMode::Accelerated,
            &crate::pipeline::synthetic_gpu_capabilities(),
        )
        .unwrap();

        assert_eq!(plan.route, RenderPipelineRoute::SerialReference);
        assert_eq!(plan.effective_concurrency, 1);
    }

    #[test]
    fn render_loops_prepare_without_pre_rendering_first_frame() {
        let composition = CompositionManifest {
            id: "hero".to_string(),
            width: 1920,
            height: 1080,
            fps: 60,
            duration_frames: 240,
            target: Some("#hero".to_string()),
            url: None,
            max_concurrency: None,
        };

        assert_eq!(
            prepare_initial_frame_for_render_loop(
                RenderPipelineRoute::SerialReference,
                &composition
            ),
            None
        );
        assert_eq!(
            prepare_initial_frame_for_render_loop(
                RenderPipelineRoute::ParallelSegments,
                &composition
            ),
            None
        );
    }

    #[test]
    fn render_error_wins_over_report_error() {
        let error = resolve_render_and_report_results(
            Err(anyhow::anyhow!("render failed")),
            Err(anyhow::anyhow!("report failed")),
        )
        .unwrap_err();

        assert_eq!(error.to_string(), "render failed");
    }

    #[test]
    fn streamed_bgra_report_records_mode_raw_backend_and_conservative_frame_counts() {
        let job = coordinator_job();
        let composition = CompositionManifest {
            id: "hero".to_string(),
            width: 1920,
            height: 1080,
            fps: 60,
            duration_frames: 42,
            target: Some("#hero".to_string()),
            url: None,
            max_concurrency: None,
        };
        let mut telemetry = coordinator_telemetry_for(&job);
        telemetry.frames_expected = composition.duration_frames;

        record_streamed_bgra_worker_report(&job, &composition, &mut telemetry);

        assert_eq!(
            telemetry.mode,
            telemetry::RenderModeLabel::StreamedBgraWorkers
        );
        assert_eq!(
            telemetry.capture_backend.as_deref(),
            Some("streamed_bgra_workers")
        );
        assert_eq!(
            telemetry.encoder_backend.as_deref(),
            Some("raw_bgra_ffmpeg_stdin")
        );
        assert_eq!(telemetry.surface_format_in.as_deref(), Some("bgra"));
        assert_eq!(telemetry.surface_format_encoder.as_deref(), Some("yuv444p"));
        assert_eq!(telemetry.cpu_readback_frames, 42);
        assert_eq!(telemetry.frames_rendered, 0);
        assert_eq!(telemetry.frames_encoded, 0);
        assert_eq!(
            telemetry
                .validate_required_gpu_benchmark()
                .unwrap_err()
                .to_string(),
            "required GPU benchmark used 42 CPU readback frame(s)"
        );
    }

    #[test]
    fn success_warning_reports_auto_cpu_readback() {
        let mut telemetry = coordinator_telemetry_for(&coordinator_job());
        telemetry.cpu_readback_frames = 3;

        assert_eq!(
            renderer_success_warning(&telemetry).as_deref(),
            Some("renderer completed using CPU readback for 3 frame(s)")
        );
    }

    #[test]
    fn success_warning_reports_auto_fallback() {
        let mut telemetry = coordinator_telemetry_for(&coordinator_job());
        telemetry.record_fallback("D3D11 unavailable");

        assert_eq!(
            renderer_success_warning(&telemetry).as_deref(),
            Some("renderer completed using fallback path: D3D11 unavailable")
        );
    }

    #[tokio::test]
    async fn optional_report_writes_default_telemetry_for_early_failures() {
        let mut job = coordinator_job();
        let path = temp_report_path();
        job.report_path = Some(path.to_string_lossy().to_string());
        let telemetry = coordinator_telemetry_for(&job);

        write_optional_report(&job, &telemetry).await.unwrap();

        let report = fs::read_to_string(&path).unwrap();
        let json: serde_json::Value = serde_json::from_str(&report).unwrap();
        assert_eq!(json["mode"], "reference_gpu");
        assert_eq!(json["frames_expected"], 0);
        assert_eq!(json["cpu_readback_frames"], 0);

        fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn coordinator_refreshes_report_when_workspace_setup_fails_before_rendering() {
        let root = temp_report_path().with_extension("workspace-failure");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(".velocast"), b"blocks workspace creation").unwrap();
        let report = root.join("report.json");
        fs::write(&report, r#"{"stale":true}"#).unwrap();
        let mut job = coordinator_job();
        job.output = root.join("movie.mp4").to_string_lossy().into_owned();
        job.report_path = Some(report.to_string_lossy().into_owned());
        let directory =
            parallel::temp_chunk_dir_for_output(Path::new(&job.output), std::process::id());
        let expected_error = tokio::fs::create_dir_all(directory)
            .await
            .unwrap_err()
            .to_string();

        let error = run_coordinator(job).await.unwrap_err();

        assert_eq!(error.to_string(), expected_error);
        let json: serde_json::Value = serde_json::from_slice(&fs::read(&report).unwrap()).unwrap();
        assert_eq!(json["frames_expected"], 0);
        assert_eq!(json["frames_rendered"], 0);
        assert!(json.get("stale").is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn coordinator_reports_pending_recovery_and_keeps_it_primary_if_reporting_fails() {
        let root = temp_report_path().with_extension("pending-recovery");
        let output = root.join("movie.mp4");
        let directory = parallel::temp_chunk_dir_for_output(&output, std::process::id());
        let recovery =
            parallel::temp_output_path_for(&output, &directory).with_extension("previous.tmp");
        fs::create_dir_all(&directory).unwrap();
        fs::write(&recovery, b"previous video").unwrap();
        let report = root.join("report.json");
        fs::write(&report, r#"{"stale":true}"#).unwrap();
        let mut job = coordinator_job();
        job.output = output.to_string_lossy().into_owned();
        job.report_path = Some(report.to_string_lossy().into_owned());
        let expected_error = format!(
            "previous output recovery is pending at {}",
            recovery.display()
        );

        assert_eq!(
            run_coordinator(job.clone()).await.unwrap_err().to_string(),
            expected_error
        );
        let json: serde_json::Value = serde_json::from_slice(&fs::read(&report).unwrap()).unwrap();
        assert_eq!(json["frames_rendered"], 0);
        assert!(json.get("stale").is_none());

        let blocked_parent = root.join("blocked-report-parent");
        fs::write(&blocked_parent, b"not a directory").unwrap();
        job.report_path = Some(
            blocked_parent
                .join("report.json")
                .to_string_lossy()
                .into_owned(),
        );
        assert_eq!(
            run_coordinator(job).await.unwrap_err().to_string(),
            expected_error
        );
        assert_eq!(fs::read(&recovery).unwrap(), b"previous video");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn coordinator_finalization_rejects_required_gpu_readback() {
        let mut job = coordinator_job();
        job.acceleration = RendererAcceleration::Required;
        let mut telemetry = coordinator_telemetry_for(&job);
        telemetry.cpu_readback_frames = 3;

        let error = finalize_coordinator_render_result(&job, &telemetry, Ok(()))
            .unwrap_err()
            .to_string();

        assert_eq!(error, "required GPU benchmark used 3 CPU readback frame(s)");
    }

    #[test]
    fn coordinator_finalization_preserves_render_error_before_validation() {
        let mut job = coordinator_job();
        job.acceleration = RendererAcceleration::Required;
        let mut telemetry = coordinator_telemetry_for(&job);
        telemetry.cpu_readback_frames = 3;

        let error = finalize_coordinator_render_result(
            &job,
            &telemetry,
            Err(anyhow::anyhow!("render failed")),
        )
        .unwrap_err()
        .to_string();

        assert_eq!(error, "render failed");
    }

    #[test]
    fn coordinator_terminal_event_uses_report_error_after_render_success() {
        let render_result = Ok(());
        let report_result = Err(anyhow::anyhow!("report write failed"));

        let error = terminal_renderer_error(&render_result, &report_result)
            .expect("report error should become terminal renderer error");

        assert_eq!(error.to_string(), "report write failed");
    }

    #[test]
    fn coordinator_terminal_event_preserves_render_error_before_report_error() {
        let render_result = Err(anyhow::anyhow!("render failed"));
        let report_result = Err(anyhow::anyhow!("report write failed"));

        let error = terminal_renderer_error(&render_result, &report_result)
            .expect("render error should become terminal renderer error");

        assert_eq!(error.to_string(), "render failed");
    }

    #[test]
    fn worker_finalization_validates_required_gpu_path_without_worker_summary() {
        let mut job = worker_job();
        job.acceleration = RendererAcceleration::Required;
        job.chunk_output = Some(".velocast/tmp/segment-0000.mp4".to_string());
        let mut telemetry =
            telemetry::RenderTelemetry::new(telemetry::RenderModeLabel::ParallelSegments);
        telemetry.capture_backend = Some("electron_d3d11_shared_texture".to_string());
        telemetry.conversion_backend = Some("d3d11_video_processor".to_string());
        telemetry.encoder_backend = Some("h264_mf".to_string());
        telemetry.frames_expected = 120;
        telemetry.frames_rendered = 120;
        telemetry.frames_encoded = 120;
        telemetry.total_wall_ms = 1;

        finalize_coordinator_render_result(&job, &telemetry, Ok(())).unwrap();
    }

    #[test]
    fn render_timing_is_recorded_before_report_serialization() {
        let mut telemetry =
            telemetry::RenderTelemetry::new(telemetry::RenderModeLabel::ReferenceGpu);
        telemetry.frames_encoded = 240;

        record_render_wall_time(&mut telemetry, std::time::Duration::from_millis(2_000));

        assert_eq!(telemetry.total_wall_ms, 2_000);
        assert_eq!(telemetry.effective_fps_millis, 120_000);
    }

    #[test]
    fn compiled_d3d11_backend_is_not_used_as_a_concurrency_probe() {
        assert_eq!(
            resolve_coordinator_concurrency(None, None, None, 8, 240,),
            4
        );
    }

    #[test]
    fn reads_worker_range_from_job() {
        let job = worker_job();

        let (range, chunk_output) = worker_range_and_output(&job).unwrap();

        assert_eq!(range.start, 10);
        assert_eq!(range.end, 20);
        assert_eq!(
            chunk_output.to_string_lossy(),
            ".velocast/tmp/chunk-0000.bgra"
        );
    }

    #[test]
    fn detects_mp4_worker_output_case_insensitively() {
        assert!(worker_output_is_mp4_segment(Path::new(
            ".velocast/tmp/segment-0000.MP4"
        )));
    }

    #[test]
    fn split_segment_jobs_reuses_loaded_coordinator_as_one_worker() {
        let mut job = coordinator_job();
        job.assembly_mode = velocast_protocol::RendererAssemblyMode::Segments;
        job.concurrency = Some(velocast_protocol::RendererConcurrency::Workers(
            NonZeroU32::new(4).unwrap(),
        ));
        let composition = CompositionManifest {
            id: "hero".to_string(),
            width: 1920,
            height: 1080,
            fps: 60,
            duration_frames: 240,
            target: Some("#hero".to_string()),
            url: None,
            max_concurrency: None,
        };
        let plan = RenderPipelinePlan::for_coordinator(
            &job,
            &composition,
            8,
            42,
            crate::browser_surface::BrowserSurfaceMode::Accelerated,
            &crate::pipeline::synthetic_gpu_capabilities(),
        )
        .unwrap();

        let split = parallel::segment_work_from_plan(&plan).unwrap();

        assert_eq!(split.local.range.start, 0);
        assert_eq!(split.local.range.end, 60);
        assert_eq!(split.remote.len(), 3);
        assert_eq!(split.remote[0].range.start, 60);
        assert_eq!(split.remote[2].range.end, 240);
    }

    #[test]
    fn worker_job_uses_embedded_manifest_without_discovery() {
        let mut job = worker_job();
        job.composition = Some(CompositionManifest {
            id: "embedded".to_string(),
            width: 3840,
            height: 2160,
            fps: 60,
            duration_frames: 240,
            target: Some("#embedded".to_string()),
            url: None,
            max_concurrency: None,
        });

        let composition = worker_composition_from_job(&job).unwrap();

        assert_eq!(composition.id, "embedded");
        assert_eq!(composition.width, 3840);
    }

    #[test]
    fn mp4_segment_workers_do_not_pre_render_segment_start_during_prepare() {
        let source = include_str!("main.rs");
        let forbidden = [
            "prepare_composition(&composition, Some(",
            "assignment.start",
            "))",
        ]
        .concat();

        assert!(
            !source.contains(&forbidden),
            "mp4 segment workers must let the frame loop own the segment-start capture"
        );
    }

    #[test]
    fn rejects_worker_job_without_chunk_output() {
        let mut job = worker_job();
        job.chunk_output = None;

        assert_eq!(
            worker_range_and_output(&job).unwrap_err().to_string(),
            "composition_worker job requires chunk_output"
        );
    }

    #[test]
    fn rejects_worker_job_without_frame_start() {
        let mut job = worker_job();
        job.frame_start = None;

        assert_eq!(
            worker_range_and_output(&job).unwrap_err().to_string(),
            "composition_worker job requires frame_start"
        );
    }

    #[test]
    fn rejects_worker_job_without_frame_end() {
        let mut job = worker_job();
        job.frame_end = None;

        assert_eq!(
            worker_range_and_output(&job).unwrap_err().to_string(),
            "composition_worker job requires frame_end"
        );
    }

    #[test]
    fn rejects_empty_worker_frame_range() {
        let mut job = worker_job();
        job.frame_start = Some(10);
        job.frame_end = Some(10);

        assert_eq!(
            worker_range_and_output(&job).unwrap_err().to_string(),
            "worker frame range 10..10 must be non-empty"
        );
    }

    #[test]
    fn rejects_reversed_worker_frame_range() {
        let mut job = worker_job();
        job.frame_start = Some(20);
        job.frame_end = Some(10);

        assert_eq!(
            worker_range_and_output(&job).unwrap_err().to_string(),
            "worker frame range 20..10 must be non-empty"
        );
    }

    fn temp_report_path() -> PathBuf {
        std::env::temp_dir().join(format!(
            "velocast-test-report-{}.json",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[tokio::test]
    async fn coordinator_refreshes_report_when_event_log_setup_fails() {
        let root = temp_report_path().with_extension("events-setup");
        tokio::fs::create_dir_all(&root).await.unwrap();
        let blocker = root.join("not-a-directory");
        tokio::fs::write(&blocker, b"block event directory creation")
            .await
            .unwrap();
        let report = root.join("report.json");
        tokio::fs::write(&report, b"stale report").await.unwrap();
        let mut job = coordinator_job();
        job.output = root.join("video.mp4").to_string_lossy().into_owned();
        job.event_log_path = Some(blocker.join("events.jsonl").to_string_lossy().into_owned());
        job.report_path = Some(report.to_string_lossy().into_owned());

        let result = run_coordinator(job).await;

        assert!(result.is_err());
        let refreshed: serde_json::Value =
            serde_json::from_slice(&tokio::fs::read(&report).await.unwrap())
                .expect("event setup failure must still write valid telemetry");
        assert_eq!(refreshed["frames_encoded"], 0);
        assert!(!root.join("video.mp4").exists());
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
}
