mod args;
mod audio_pipeline;
mod browser_protocol;
mod browser_surface;
mod cancellation;
mod capabilities;
mod electron_app;
mod errors;
mod events;
mod frame_loop;
mod generated;
mod input_props;
mod native_browser;
mod output_media;
mod output_result;
mod output_workspace;
mod parallel;
mod render_job;
mod scheduler;
mod telemetry;
mod webcodecs;

use args::Args;
use clap::Parser;
use events::{RendererEvent, RendererEventSink};
use native_browser::NativeBrowser;
use std::path::Path;
use std::time::{Duration, Instant};
use velocast_protocol::{CompositionManifest, RenderJob, RenderJobKind, RenderOperation};

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
    tracing_subscriber::fmt()
        .with_env_filter("info")
        .with_writer(std::io::stderr)
        .init();
    let mut job = args.parse_job()?;
    job.render_session = Some(browser_protocol::render_session_for_job(&job));
    match job.kind().map_err(anyhow::Error::msg)? {
        RenderJobKind::CompositionWorker(_) => run_worker(job).await,
        _ => run_coordinator(job).await,
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
    let directory =
        parallel::temp_chunk_dir_for_output(&std::path::absolute(output)?, std::process::id());
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
    let result = finalize_terminal_reporting(render_result, event_result);
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

async fn run_coordinator_render(
    job: &RenderJob,
    report: &mut telemetry::RenderTelemetry,
    events: &mut RendererEventSink,
    resources: &mut render_job::RenderJobResources,
    context: &mut output_result::OutputContext,
) -> anyhow::Result<()> {
    let mode = initial_surface_for_job(job);
    let result =
        run_coordinator_render_with_mode(job, report, events, resources, context, mode).await;
    if let Err(error) = &result {
        if mode == browser_surface::BrowserSurfaceMode::WebCodecs
            && report.frames_encoded == 0
            && shared_texture_unavailable(error)
        {
            let reason = format!(
                "Shared texture capture unavailable; using bitmap capture with WebCodecs: {error}"
            );
            resources.reset_attempt().await?;
            *report = coordinator_telemetry_for(job);
            report.fallback_used = true;
            report.fallback_reason = Some(reason);
            *context = output_result::OutputContext::default();
            return run_coordinator_render_with_mode(
                job,
                report,
                events,
                resources,
                context,
                browser_surface::BrowserSurfaceMode::Bitmap,
            )
            .await;
        }
    }
    result
}
fn initial_surface_for_job(job: &RenderJob) -> browser_surface::BrowserSurfaceMode {
    if job.operation != RenderOperation::Render {
        browser_surface::BrowserSurfaceMode::Software
    } else if std::env::var("VELOCAST_ELECTRON_FORCE_BITMAP").as_deref() == Ok("1") {
        browser_surface::BrowserSurfaceMode::Bitmap
    } else {
        browser_surface::BrowserSurfaceMode::WebCodecs
    }
}
fn shared_texture_unavailable(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        let message = cause.to_string();
        let message = message
            .strip_prefix("electron.host_error: ")
            .unwrap_or(&message);
        message.starts_with("capture.shared_texture_unavailable:")
            || message.starts_with("Electron webcodecs paint timed out")
    })
}

async fn run_coordinator_render_with_mode(
    job: &RenderJob,
    telemetry: &mut telemetry::RenderTelemetry,
    event_sink: &mut RendererEventSink,
    resources: &mut render_job::RenderJobResources,
    output_context: &mut output_result::OutputContext,
    mode: browser_surface::BrowserSurfaceMode,
) -> anyhow::Result<()> {
    if job.operation == RenderOperation::Render {
        webcodecs::validate_job(job)?;
    }
    let props = input_props::read_input_props(job.input_props_path.as_deref())?;
    let renderer = NativeBrowser::new(mode)?;
    let started = Instant::now();
    renderer.load(job).await?;
    telemetry.page_load_ms += started.elapsed().as_millis();
    let started = Instant::now();
    let compositions = renderer.discover_compositions()?;
    telemetry.composition_discovery_ms += started.elapsed().as_millis();
    for composition in &compositions {
        output_result::validate_composition(composition)?;
    }
    output_context.compositions = compositions.clone();
    if job.operation == RenderOperation::Inspect {
        if let Some(id) = job.composition_id.as_deref() {
            output_context.selected = Some(frame_loop::select_composition(&compositions, id)?);
        }
        return Ok(());
    }
    let composition = match job.kind().map_err(anyhow::Error::msg)? {
        RenderJobKind::Url(url) => {
            select_url_composition_or_measure(&renderer, &compositions, &url.selector)?
        }
        RenderJobKind::Composition(value) => frame_loop::select_composition(
            &compositions,
            value.composition_id.as_deref().unwrap_or("product-hero"),
        )?,
        _ => anyhow::bail!("renderer.invalid_coordinator_job"),
    };
    output_result::validate_composition(&composition)?;
    if job.operation == RenderOperation::Render {
        webcodecs::validate_geometry(&composition)?;
    }
    output_context.selected = Some(composition.clone());
    let range = output_result::output_range(job, &composition)?;
    telemetry.frames_expected = if job.operation == RenderOperation::Frame {
        1
    } else {
        range.end_frame - range.start_frame
    };
    renderer.prepare_composition_with_input_props(&composition, None, props.as_ref())?;
    let directory =
        parallel::temp_chunk_dir_for_output(&std::path::absolute(&job.output)?, std::process::id());
    let temporary = parallel::temp_output_path_for(Path::new(&job.output), &directory);
    if job.operation == RenderOperation::Frame {
        anyhow::ensure!(
            job.output.to_ascii_lowercase().ends_with(".png"),
            "output.png_required: frame output must use .png"
        );
        return frame_loop::render_frame_png(
            &composition,
            job.output_frame.context("output.frame_required")?,
            &renderer,
            &temporary,
            telemetry,
            event_sink,
        )
        .await;
    }
    let audio = audio_pipeline::prepare(
        job,
        &composition,
        renderer.resolve_audio_plan(&composition, props.as_ref())?,
        &directory,
    )?;
    let plan = velocast_renderer_policy::render_plan::RenderPipelinePlan::for_job(
        job,
        &composition,
        scheduler::available_parallelism(),
    )?;
    let requested_backend = job.media_backend.as_deref().unwrap_or("auto");
    event_sink
        .emit(RendererEvent::PipelinePlanResolved {
            route: plan.route.as_str().into(),
            effective_concurrency: plan.concurrency,
            probe_tier: "media_metadata".into(),
            segment_count: plan.ranges.len(),
            capture_mode: if mode == browser_surface::BrowserSurfaceMode::Bitmap {
                "electron_bitmap"
            } else {
                "electron_shared_texture"
            }
            .into(),
            conversion_mode: match requested_backend {
                "webcodecs" => "chromium_webcodecs",
                "native" => "mediabunny_native",
                _ => "media_auto",
            }
            .into(),
            encoder_mode: requested_backend.into(),
            planned_encoder_backend: format!(
                "electron_{requested_backend}_{}",
                webcodecs::codec(job)?
            ),
            encoder_backend: format!("electron_{requested_backend}_{}", webcodecs::codec(job)?),
        })
        .await?;
    if plan.ranges.len() > 1 {
        parallel::render_segments(
            job,
            &composition,
            &plan,
            &renderer,
            &temporary,
            &directory,
            resources,
            telemetry,
            event_sink,
        )
        .await?;
        if let Some(audio) = audio {
            let mixed = directory.join(format!("audio-final.{}", webcodecs::container(job)?));
            let metadata=renderer.media_operation(serde_json::json!({"kind":"mux-audio-plan","videoPath":temporary,"outputPath":mixed,"audio":audio,"audioCodec":webcodecs::audio_codec(job)?,"fps":composition.fps}))?;
            output_media::validate_video(&metadata, &composition, telemetry.frames_expected)?;
            output_media::validate_codec(&metadata, webcodecs::codec(job)?)?;
            output_media::validate_container(&metadata, webcodecs::container(job)?)?;
            webcodecs::record_audio(
                &audio,
                &metadata,
                telemetry,
                Some(webcodecs::audio_codec(job)?),
            )?;
            std::fs::rename(&mixed, &temporary)?;
        }
    } else {
        webcodecs::render(
            job,
            &composition,
            &renderer,
            &temporary,
            audio.as_ref(),
            resources,
            telemetry,
            event_sink,
        )
        .await?;
    }
    resources.check_cancellation()?;
    Ok(())
}

use anyhow::Context;
fn select_url_composition_or_measure(
    renderer: &NativeBrowser,
    compositions: &[CompositionManifest],
    selector: &str,
) -> anyhow::Result<CompositionManifest> {
    frame_loop::select_url_composition(compositions, selector).or_else(|_| {
        frame_loop::composition_from_selector_measurement(
            selector,
            renderer.measure_selector(selector)?,
        )
    })
}
fn record_render_wall_time(report: &mut telemetry::RenderTelemetry, elapsed: Duration) {
    report.mark_finished(elapsed.as_millis());
}
fn coordinator_telemetry_for(job: &RenderJob) -> telemetry::RenderTelemetry {
    telemetry::RenderTelemetry::new(match job.operation {
        RenderOperation::Inspect => telemetry::RenderModeLabel::CompositionInspection,
        RenderOperation::Frame => telemetry::RenderModeLabel::FramePng,
        _ => telemetry::RenderModeLabel::ReferenceWebCodecs,
    })
}
fn log_renderer_success_warning(_report: &telemetry::RenderTelemetry) {}
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
fn finalize_terminal_reporting(
    render_result: anyhow::Result<()>,
    event_result: anyhow::Result<()>,
) -> anyhow::Result<()> {
    render_result?;
    if let Err(error) = event_result {
        tracing::warn!(
            ?error,
            "output transaction completed; terminal event reporting failed"
        );
    }
    Ok(())
}

fn finalize_coordinator_render_result(
    job: &RenderJob,
    report: &telemetry::RenderTelemetry,
    result: anyhow::Result<()>,
) -> anyhow::Result<()> {
    result?;
    if job.operation == RenderOperation::Render {
        anyhow::ensure!(
            report.frames_encoded == report.frames_expected
                && report.frames_rendered == report.frames_expected,
            "output.frame_count_mismatch"
        );
    }
    Ok(())
}
async fn write_optional_report(
    job: &RenderJob,
    report: &telemetry::RenderTelemetry,
) -> anyhow::Result<()> {
    if let Some(path) = &job.report_path {
        telemetry::write_report(Path::new(path), report).await?;
    }
    Ok(())
}
async fn run_worker(mut job: RenderJob) -> anyhow::Result<()> {
    webcodecs::validate_job(&job)?;
    let worker = match job.kind().map_err(anyhow::Error::msg)? {
        RenderJobKind::CompositionWorker(value) => value,
        _ => unreachable!(),
    };
    anyhow::ensure!(
        worker.frame_step.is_none_or(|step| step.get() == 1),
        "worker.stride_unsupported: encoded segments must be contiguous"
    );
    let output = std::path::PathBuf::from(worker.chunk_output);
    anyhow::ensure!(
        output != Path::new("-"),
        "worker.output_required: raw frame stdout workers have been retired"
    );
    let output = std::path::absolute(output)?;
    let range = velocast_protocol::OutputFrameRange {
        start_frame: worker.frame_start,
        end_frame: worker.frame_end,
    };
    job.output_range = Some(range);
    let props = input_props::read_input_props(job.input_props_path.as_deref())?;
    let mut report =
        telemetry::RenderTelemetry::new(telemetry::RenderModeLabel::ReferenceWebCodecs);
    let started = Instant::now();
    let directory = output.with_extension("worker-workspace");
    let temporary = directory.join(format!("segment.{}", webcodecs::container(&job)?));
    render_job::RenderJobResources::run(Some(&output), &temporary, &directory, async |resources| {
        resources.set_cancellation(cancellation::RenderCancellation::from_event_log_path(
            job.event_log_path.as_deref(),
        ));
        resources.check_cancellation()?;
        let renderer = NativeBrowser::new(initial_surface_for_job(&job))?;
        let load_started = Instant::now();
        renderer.load(&job).await?;
        report.page_load_ms += load_started.elapsed().as_millis();
        let composition = match &job.composition {
            Some(value) => value.clone(),
            None => frame_loop::select_composition(
                &renderer.discover_compositions()?,
                job.composition_id.as_deref().unwrap_or("product-hero"),
            )?,
        };
        output_result::output_range(&job, &composition)?;
        webcodecs::validate_geometry(&composition)?;
        renderer.prepare_composition_with_input_props(&composition, None, props.as_ref())?;
        webcodecs::render(
            &job,
            &composition,
            &renderer,
            &temporary,
            None,
            resources,
            &mut report,
            &mut RendererEventSink::disabled(),
        )
        .await
    })
    .await?;
    report.mark_finished(started.elapsed().as_millis());
    write_optional_report(&job, &report).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn terminal_event_failure_preserves_a_published_success() {
        let root = std::env::temp_dir().join(format!(
            "velocast-publication-events-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let directory = root.join("workspace");
        let output = root.join("movie.mp4");
        let temporary = directory.join("movie.mp4");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(&output, b"previous output").unwrap();
        let rendered = render_job::RenderJobResources::run(
            Some(&output),
            &temporary,
            &directory,
            async |_| {
                std::fs::write(&temporary, b"validated new output")?;
                Ok(())
            },
        )
        .await;
        assert!(
            finalize_terminal_reporting(rendered, Err(anyhow::anyhow!("event log failed"))).is_ok()
        );
        assert_eq!(std::fs::read(&output).unwrap(), b"validated new output");
        assert!(!directory.exists());
        let failed = finalize_terminal_reporting(
            Err(anyhow::anyhow!("render failed")),
            Err(anyhow::anyhow!("event log failed")),
        );
        assert_eq!(failed.unwrap_err().to_string(), "render failed");
        std::fs::remove_file(output).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
    #[test]
    fn bitmap_retry_only_accepts_capture_failures() {
        assert!(shared_texture_unavailable(&anyhow::anyhow!(
            "electron.host_error: capture.shared_texture_unavailable: import failed"
        )));
        assert!(!shared_texture_unavailable(&anyhow::anyhow!(
            "electron.host_error: webcodecs.unsupported_config"
        )));
        assert!(!shared_texture_unavailable(&anyhow::anyhow!("electron.host_error: composition failed: capture.shared_texture_unavailable: authored text")));
    }
    #[test]
    fn failures_remain_primary_when_report_writes_also_fail() {
        let result = resolve_render_and_report_results(
            Err(anyhow::anyhow!("render failed")),
            Err(anyhow::anyhow!("report failed")),
        );
        assert_eq!(result.unwrap_err().to_string(), "render failed");
    }
    #[test]
    fn completion_requires_all_scheduled_frames() {
        let job:RenderJob=serde_json::from_value(serde_json::json!({"mode":"composition","serve_url":"http://localhost","output":"movie.mp4","codec":"h264"})).unwrap();
        let mut report = coordinator_telemetry_for(&job);
        report.frames_expected = 2;
        report.frames_rendered = 2;
        report.frames_encoded = 1;
        assert!(finalize_coordinator_render_result(&job, &report, Ok(())).is_err());
        report.frames_encoded = 2;
        assert!(finalize_coordinator_render_result(&job, &report, Ok(())).is_ok());
    }
}
