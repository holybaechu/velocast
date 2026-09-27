use std::path::Path;

use serde_json::Value;
use tokio::fs::File;
use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::task::yield_now;
use tokio::time::{Duration, Instant};
use velocast_protocol::{CompositionManifest, RenderContext, RenderJob, RendererAcceleration};

use crate::browser_protocol::BrowserDriver;
use crate::encoder::{EncoderExecutionContext, FrameEncodeStats, VideoEncoder};
use crate::errors::RendererError;
use crate::events::{RendererEvent, RendererEventSink};
use crate::paint_state::{AcceleratedFrame, PaintState};
use crate::pipeline::render_plan::{encoder_settings_for_job, RenderPipelinePlan};
use crate::scheduler::{FrameRange, FrameSchedule, StridedFrameAssignment};
use crate::surface::{
    CapturedFrame, GpuSurfaceFrame, PlatformSurface, SoftwareFrame, SoftwarePixelFormat,
    SurfaceFormat, TextureSourceRect, WindowsD3D11Surface,
};

const INITIAL_POST_RENDER_SETTLE_PAINTS: usize = 4;
const CAPTURE_GENERATION_SETTLE_PAINTS: usize = 2;
const PAINT_REINVALIDATION_INTERVAL: Duration = Duration::from_millis(50);

trait FrameEncoder {
    async fn write_frame(
        &mut self,
        absolute_frame: u32,
        frame: CapturedFrame,
    ) -> anyhow::Result<FrameEncodeStats>;
    async fn finish(self) -> Result<(), RendererError>;
    async fn abort(self) -> Result<(), RendererError>;
}

impl FrameEncoder for VideoEncoder {
    async fn write_frame(
        &mut self,
        absolute_frame: u32,
        frame: CapturedFrame,
    ) -> anyhow::Result<FrameEncodeStats> {
        VideoEncoder::write_frame(self, absolute_frame, frame).await
    }

    async fn finish(self) -> Result<(), RendererError> {
        VideoEncoder::finish(self).await
    }

    async fn abort(self) -> Result<(), RendererError> {
        VideoEncoder::abort(self).await
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SelectorMeasurement {
    pub width: f64,
    pub height: f64,
}

pub fn get_compositions_script() -> &'static str {
    "window.__velocast.getCompositions()"
}

pub fn seek_frame_script(frame: u32, context: &RenderContext) -> anyhow::Result<String> {
    let composition_id = serde_json::to_string(&context.composition_id)?;
    let json = serde_json::to_string(context)?;
    Ok(format!(
        "window.__velocast.seekFrame({composition_id}, {frame}, {json})"
    ))
}

pub fn select_composition(
    compositions: &[CompositionManifest],
    id: &str,
) -> anyhow::Result<CompositionManifest> {
    compositions
        .iter()
        .find(|composition| composition.id == id)
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("composition {id} was not found"))
}

pub fn select_url_composition(
    compositions: &[CompositionManifest],
    selector: &str,
) -> anyhow::Result<CompositionManifest> {
    compositions
        .iter()
        .find(|composition| composition.target.as_deref() == Some(selector))
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("selector {selector} was not found in composition metadata"))
}

pub fn composition_from_selector_measurement(
    selector: &str,
    measurement: SelectorMeasurement,
) -> anyhow::Result<CompositionManifest> {
    if !measurement.width.is_finite()
        || !measurement.height.is_finite()
        || measurement.width <= 0.0
        || measurement.height <= 0.0
        || measurement.width > u32::MAX as f64
        || measurement.height > u32::MAX as f64
    {
        return Err(anyhow::anyhow!(
            "selector {selector} must have positive finite bounds"
        ));
    }

    Ok(CompositionManifest {
        id: format!("selector:{selector}"),
        width: measurement.width.ceil() as u32,
        height: measurement.height.ceil() as u32,
        fps: 30,
        duration_frames: 1,
        target: Some(selector.to_string()),
        url: None,
        max_concurrency: None,
    })
}

pub async fn render_frames(
    job: &RenderJob,
    composition: &CompositionManifest,
    plan: &RenderPipelinePlan,
    paint_state: PaintState,
    browser: &impl BrowserDriver,
    telemetry: &mut crate::telemetry::RenderTelemetry,
    event_sink: Option<&mut RendererEventSink>,
) -> anyhow::Result<()> {
    let temp_output = &plan.output.temp_output;
    let spawned = VideoEncoder::spawn_plan(plan.backend.encoder_plan.clone())?;
    if let Err(error) = install_encoder_owned_texture_pool(&paint_state, &spawned.encoder) {
        let _ = spawned.encoder.abort().await;
        return Err(error);
    }
    apply_encoder_report(telemetry, spawned.report);
    let raw_bgra_backend = matches!(&spawned.encoder, VideoEncoder::RawBgra(_));
    if let Some(range) = &job.output_range {
        render_scheduled_frames_with_encoder(
            composition,
            range.start_frame..range.end_frame,
            paint_state,
            browser,
            spawned.encoder,
            raw_bgra_backend,
            telemetry,
            event_sink,
        )
        .await?;
    } else {
        render_frames_with_encoder(
            composition,
            paint_state,
            browser,
            spawned.encoder,
            raw_bgra_backend,
            telemetry,
            event_sink,
        )
        .await?;
    }
    if job.acceleration == RendererAcceleration::Required || job.output_range.is_some() {
        validate_required_reference_output(
            temp_output,
            job,
            composition,
            telemetry.surface_format_encoder.as_deref(),
        )
        .await?;
    }
    if job.output_range.is_some() {
        crate::output_media::validate_rebased_video(temp_output).await?;
    }
    Ok(())
}

pub(crate) async fn render_frame_png(
    composition: &CompositionManifest,
    frame: u32,
    paint_state: PaintState,
    browser: &impl BrowserDriver,
    output: &Path,
    telemetry: &mut crate::telemetry::RenderTelemetry,
    event_sink: &mut RendererEventSink,
) -> anyhow::Result<()> {
    let context = render_context(composition);
    let captured = render_one_frame(
        &context,
        frame,
        &paint_state,
        browser,
        Some(telemetry),
        browser.requires_initial_post_render_paint_settle(),
        false,
    )
    .await?;
    record_captured_frame(telemetry, &captured);
    telemetry.frames_rendered = 1;
    emit_frame_rendered_event(&mut Some(&mut *event_sink), frame, telemetry).await?;
    let pixels = captured.into_bgra_with_telemetry(telemetry)?;
    crate::output_media::write_bgra_png(composition.width, composition.height, &pixels, output)
        .await?;
    telemetry.encoder_backend = Some("ffmpeg_png".to_owned());
    telemetry.surface_format_encoder = Some("rgba".to_owned());
    telemetry.frames_encoded = 1;
    emit_frame_encoded_event(&mut Some(&mut *event_sink), frame, 1).await?;
    Ok(())
}

async fn validate_required_reference_output(
    output: &Path,
    job: &RenderJob,
    composition: &CompositionManifest,
    encoder_pixel_format: Option<&str>,
) -> anyhow::Result<()> {
    let probe = crate::segment_muxer::probe_segment(output).await?;
    crate::segment_muxer::validate_final_output(
        &probe,
        &expected_video_output_for_job(job, composition, encoder_pixel_format),
    )
    .map_err(|error| {
        anyhow::anyhow!(
            "required reference output validation failed for {}: {error}",
            output.display()
        )
    })
}

pub async fn probe_accelerated_paint_capture(
    composition: &CompositionManifest,
    paint_state: PaintState,
    driver: &impl BrowserDriver,
    telemetry: &mut crate::telemetry::RenderTelemetry,
) -> anyhow::Result<()> {
    telemetry.capture_probe = Some("accelerated_paint".to_string());
    telemetry.frames_expected = 1;
    let context = render_context(composition);
    let captured = render_one_frame(
        &context,
        0,
        &paint_state,
        driver,
        Some(telemetry),
        true,
        true,
    )
    .await?;
    record_capture_probe_frame(captured, telemetry)
}

fn record_capture_probe_frame(
    captured: CapturedFrame,
    telemetry: &mut crate::telemetry::RenderTelemetry,
) -> anyhow::Result<()> {
    match captured {
        CapturedFrame::GpuSurface(surface_frame) => {
            surface_frame
                .platform_surface
                .validate_for_capture_probe()?;
            let metadata = surface_frame
                .platform_surface
                .capture_metadata(surface_frame.source_format);
            telemetry.capture_probe = Some("accelerated_paint".to_string());
            telemetry.record_capture_surface_metadata(&metadata);
            telemetry.frames_rendered = 1;
            if crate::pipeline::backend_registry::required_gpu_capture_probe_validation(
                metadata.capture_backend,
            )
            .is_some()
            {
                Ok(())
            } else {
                Err(anyhow::anyhow!(
                    "capture.accelerated_paint_unavailable: accelerated paint did not provide a supported GPU capture backend"
                ))
            }
        }
        CapturedFrame::BgraSoftware(frame) => {
            let metadata = frame.capture_metadata();
            telemetry.capture_probe = Some("accelerated_paint".to_string());
            telemetry.record_capture_surface_metadata(&metadata);
            telemetry.frames_rendered = 1;
            Err(anyhow::anyhow!(
                "capture.accelerated_paint_unavailable: accelerated paint probe received software BGRA paint"
            ))
        }
    }
}

#[cfg(test)]
fn record_capture_probe_frame_for_test(
    frame: &mut AcceleratedFrame,
    telemetry: &mut crate::telemetry::RenderTelemetry,
) -> anyhow::Result<()> {
    let captured = capture_current_accelerated_frame(frame, 0, Some(telemetry))?;
    record_capture_probe_frame(captured, telemetry)
}

fn apply_encoder_report(
    telemetry: &mut crate::telemetry::RenderTelemetry,
    report: crate::encoder::EncoderSpawnReport,
) {
    telemetry.encoder_backend = Some(report.encoder_backend);
    telemetry.conversion_backend = report.conversion_backend;
    telemetry.surface_format_encoder = Some(report.surface_format_encoder);
    telemetry.requested_codec = report.requested_codec;
    telemetry.selected_codec = report.selected_codec;
    telemetry.target_bitrate_bps = report.target_bitrate_bps;
    telemetry.record_backend_diagnostics(report.backend_diagnostics);
    if report.fallback_used {
        telemetry.record_fallback(
            report
                .fallback_reason
                .unwrap_or_else(|| "unknown fallback".to_string()),
        );
    }
}

fn expected_video_output_for_job(
    job: &RenderJob,
    composition: &CompositionManifest,
    encoder_pixel_format: Option<&str>,
) -> crate::segment_muxer::ExpectedVideoOutput {
    let pixel_format = job
        .pixel_format
        .as_deref()
        // Auto may select a GPU encoder or software fallback. Validate against
        // that observed format when no explicit user format was requested.
        .or(encoder_pixel_format)
        .unwrap_or(match job.acceleration {
            RendererAcceleration::Required | RendererAcceleration::Auto => "nv12",
            RendererAcceleration::Off => "yuv444p",
        });
    crate::segment_muxer::ExpectedVideoOutput {
        width: composition.width,
        height: composition.height,
        fps: composition.fps,
        frame_count: job
            .output_range
            .as_ref()
            .map_or(composition.duration_frames, |range| {
                range.end_frame.saturating_sub(range.start_frame)
            }),
        codec_name: crate::segment_muxer::expected_codec_name(&job.codec),
        pix_fmts: crate::segment_muxer::expected_stream_pix_fmts(pixel_format),
    }
}

pub async fn render_frame_range_to_segment(
    job: &RenderJob,
    composition: &CompositionManifest,
    range: FrameRange,
    paint_state: PaintState,
    browser: &impl BrowserDriver,
    segment_output: &Path,
    telemetry: &mut crate::telemetry::RenderTelemetry,
) -> anyhow::Result<()> {
    if let Some(parent) = segment_output
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        tokio::fs::create_dir_all(parent).await?;
    }

    let settings = encoder_settings_for_job(
        job,
        composition,
        segment_output,
        EncoderExecutionContext::SegmentWorker,
    )?;
    let spawned = VideoEncoder::spawn_with_report(settings)?;
    if let Err(error) = install_encoder_owned_texture_pool(&paint_state, &spawned.encoder) {
        let _ = spawned.encoder.abort().await;
        return Err(error);
    }
    let raw_bgra_backend = matches!(&spawned.encoder, VideoEncoder::RawBgra(_));
    apply_encoder_report(telemetry, spawned.report);
    render_frame_range_with_encoder(
        composition,
        range,
        paint_state,
        browser,
        spawned.encoder,
        raw_bgra_backend,
        telemetry,
    )
    .await
}

#[cfg(test)]
fn serial_temp_output_path_for(output: &Path, process_id: u32) -> std::path::PathBuf {
    let temp_dir = crate::parallel::temp_chunk_dir_for_output(output, process_id);
    crate::parallel::temp_output_path_for(output, &temp_dir)
}

async fn render_frame_range_with_encoder<E>(
    composition: &CompositionManifest,
    range: FrameRange,
    paint_state: PaintState,
    browser: &impl BrowserDriver,
    encoder: E,
    raw_bgra_backend: bool,
    telemetry: &mut crate::telemetry::RenderTelemetry,
) -> anyhow::Result<()>
where
    E: FrameEncoder,
{
    render_scheduled_frames_with_encoder(
        composition,
        range.frames(),
        paint_state,
        browser,
        encoder,
        raw_bgra_backend,
        telemetry,
        None,
    )
    .await
}

async fn render_frames_with_encoder<E>(
    composition: &CompositionManifest,
    paint_state: PaintState,
    browser: &impl BrowserDriver,
    encoder: E,
    raw_bgra_backend: bool,
    telemetry: &mut crate::telemetry::RenderTelemetry,
    event_sink: Option<&mut RendererEventSink>,
) -> anyhow::Result<()>
where
    E: FrameEncoder,
{
    render_scheduled_frames_with_encoder(
        composition,
        FrameSchedule::new(composition.duration_frames),
        paint_state,
        browser,
        encoder,
        raw_bgra_backend,
        telemetry,
        event_sink,
    )
    .await
}

async fn render_scheduled_frames_with_encoder<E>(
    composition: &CompositionManifest,
    frames: impl IntoIterator<Item = u32>,
    paint_state: PaintState,
    browser: &impl BrowserDriver,
    mut encoder: E,
    raw_bgra_backend: bool,
    telemetry: &mut crate::telemetry::RenderTelemetry,
    mut event_sink: Option<&mut RendererEventSink>,
) -> anyhow::Result<()>
where
    E: FrameEncoder,
{
    let context = render_context(composition);
    let mut needs_initial_paint_settle = browser.requires_initial_post_render_paint_settle();
    let render_result = async {
        for frame in frames {
            let render_started_at = Instant::now();
            let captured = render_one_frame(
                &context,
                frame,
                &paint_state,
                browser,
                Some(&mut *telemetry),
                needs_initial_paint_settle,
                false,
            )
            .await?;
            telemetry.frame_render_wait_ms += render_started_at.elapsed().as_millis();
            record_captured_frame(telemetry, &captured);
            telemetry.frames_rendered += 1;
            emit_frame_rendered_event(&mut event_sink, frame, telemetry).await?;
            let captured = if raw_bgra_backend {
                if matches!(&captured, CapturedFrame::GpuSurface(_))
                    && telemetry.conversion_backend.is_none()
                {
                    telemetry.conversion_backend = Some("cpu_bgra_readback".to_string());
                }
                let capture_backend = captured.capture_metadata().capture_backend;
                let pixels = captured.into_bgra_with_telemetry(telemetry)?;
                CapturedFrame::BgraSoftware(SoftwareFrame {
                    capture_backend,
                    width: composition.width,
                    height: composition.height,
                    pixel_format: SoftwarePixelFormat::Bgra,
                    pixels,
                })
            } else {
                captured
            };
            let encode_started_at = Instant::now();
            let encode_stats = encoder.write_frame(frame, captured).await?;
            telemetry.encoder_submit_ms += encode_started_at.elapsed().as_millis();
            record_encode_stats(telemetry, encode_stats);
            telemetry.frames_encoded += 1;
            emit_frame_encoded_event(&mut event_sink, frame, telemetry.frames_encoded).await?;
            needs_initial_paint_settle = false;
        }
        Ok::<(), anyhow::Error>(())
    }
    .await;

    match render_result {
        Ok(()) => encoder.finish().await.map_err(Into::into),
        Err(error) => {
            let _ = encoder.abort().await;
            Err(error)
        }
    }
}

fn record_captured_frame(
    telemetry: &mut crate::telemetry::RenderTelemetry,
    captured: &CapturedFrame,
) {
    telemetry.record_capture_surface_metadata(&captured.capture_metadata());
}

async fn emit_frame_rendered_event(
    event_sink: &mut Option<&mut RendererEventSink>,
    frame: u32,
    telemetry: &crate::telemetry::RenderTelemetry,
) -> anyhow::Result<()> {
    let Some(sink) = event_sink.as_deref_mut() else {
        return Ok(());
    };
    sink.emit(RendererEvent::FrameRendered {
        frame,
        capture_backend: telemetry.capture_backend.clone(),
        surface_format_in: telemetry.surface_format_in.clone(),
    })
    .await
}

async fn emit_frame_encoded_event(
    event_sink: &mut Option<&mut RendererEventSink>,
    frame: u32,
    frames_encoded: u32,
) -> anyhow::Result<()> {
    let Some(sink) = event_sink.as_deref_mut() else {
        return Ok(());
    };
    sink.emit(RendererEvent::FrameEncoded {
        frame,
        frames_encoded,
    })
    .await
}

pub async fn render_frame_range_to_chunk(
    composition: &CompositionManifest,
    range: FrameRange,
    paint_state: PaintState,
    browser: &impl BrowserDriver,
    chunk_output: &Path,
) -> anyhow::Result<()> {
    if let Some(parent) = chunk_output
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        tokio::fs::create_dir_all(parent).await?;
    }

    let mut chunk = File::create(chunk_output).await?;
    render_frame_range_to_writer(composition, range, paint_state, browser, &mut chunk).await?;
    chunk.flush().await?;
    Ok(())
}

pub async fn render_frame_range_to_writer<W>(
    composition: &CompositionManifest,
    range: FrameRange,
    paint_state: PaintState,
    browser: &impl BrowserDriver,
    writer: &mut W,
) -> anyhow::Result<()>
where
    W: AsyncWrite + Unpin,
{
    let context = render_context(composition);
    let mut needs_initial_paint_settle = browser.requires_initial_post_render_paint_settle();

    for frame in range.frames() {
        let bgra = render_one_frame(
            &context,
            frame,
            &paint_state,
            browser,
            None,
            needs_initial_paint_settle,
            false,
        )
        .await?
        .into_bgra()?;
        writer.write_all(&bgra).await?;
        needs_initial_paint_settle = false;
    }

    Ok(())
}

pub async fn render_frame_assignment_to_writer<W>(
    composition: &CompositionManifest,
    assignment: StridedFrameAssignment,
    paint_state: PaintState,
    browser: &impl BrowserDriver,
    writer: &mut W,
) -> anyhow::Result<()>
where
    W: AsyncWrite + Unpin,
{
    let context = render_context(composition);
    let mut needs_initial_paint_settle = browser.requires_initial_post_render_paint_settle();

    for frame in assignment.frames() {
        let bgra = render_one_frame(
            &context,
            frame,
            &paint_state,
            browser,
            None,
            needs_initial_paint_settle,
            false,
        )
        .await?
        .into_bgra()?;
        writer.write_all(&bgra).await?;
        needs_initial_paint_settle = false;
    }

    Ok(())
}

pub(crate) fn render_context(composition: &CompositionManifest) -> RenderContext {
    render_context_with_input_props(composition, None)
}

pub(crate) fn render_context_with_input_props(
    composition: &CompositionManifest,
    input_props: Option<&Value>,
) -> RenderContext {
    RenderContext {
        composition_id: composition.id.clone(),
        width: composition.width,
        height: composition.height,
        fps: composition.fps,
        duration_frames: composition.duration_frames,
        target: composition.target.clone(),
        input_props: input_props.cloned(),
        render_session: None,
    }
}

async fn render_one_frame(
    context: &RenderContext,
    frame: u32,
    paint_state: &PaintState,
    browser: &impl BrowserDriver,
    mut telemetry: Option<&mut crate::telemetry::RenderTelemetry>,
    needs_initial_paint_settle: bool,
    capture_probe: bool,
) -> anyhow::Result<CapturedFrame> {
    let mut request_context = context.clone();
    request_context.render_session = browser.render_session();
    let context = &request_context;
    let script = seek_frame_script(frame, context)?;
    let _ = paint_state.take_last_frame();
    let script_started = Instant::now();
    let script_result = browser.render_frame(&script, frame);
    if let Some(report) = telemetry.as_deref_mut() {
        report.browser_script_wait_ms += script_started.elapsed().as_millis();
    }
    script_result?;
    let _ = paint_state.take_last_frame();
    if needs_initial_paint_settle {
        let settle_started = Instant::now();
        let settle_result =
            wait_for_post_render_paint_before_capture_generation(frame, paint_state, browser).await;
        if let Some(report) = telemetry.as_deref_mut() {
            report.initial_post_render_paint_wait_ms += settle_started.elapsed().as_millis();
        }
        settle_result?;
    } else {
        paint_state.request_paint_observation();
        browser.invalidate_for_next_capture()?;
        let _ = paint_state.take_last_frame();
    }
    let generation = paint_state.begin_frame_capture();
    let capture_started = Instant::now();
    let mut capture_generation_paints = 0;

    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let copy_owned_texture = capture_generation_paints >= CAPTURE_GENERATION_SETTLE_PAINTS;
        request_paint_and_wait(frame, paint_state, browser, deadline, copy_owned_texture).await?;
        if let Some(mut accelerated_frame) = paint_state.take_last_frame() {
            if let Some(report) = telemetry.as_deref_mut() {
                report.capture_generation_paints_observed += 1;
            }
            if !accelerated_frame_is_current(
                &accelerated_frame,
                generation,
                context,
                frame,
                telemetry.as_deref_mut(),
            ) {
                continue;
            }

            capture_generation_paints += 1;
            if capture_generation_paints <= CAPTURE_GENERATION_SETTLE_PAINTS {
                if let Some(report) = telemetry.as_deref_mut() {
                    report.capture_generation_settle_paints_discarded += 1;
                }
                tracing::debug!(
                    frame,
                    generation,
                    "discarding initial capture-generation paint before accepting frame"
                );
                continue;
            }

            if let Some(report) = telemetry.as_deref_mut() {
                report.capture_generation_wait_ms += capture_started.elapsed().as_millis();
            }
            return capture_current_accelerated_frame(
                &mut accelerated_frame,
                frame,
                capture_probe.then_some(()).and(telemetry.as_deref_mut()),
            );
        }
    }
}

async fn request_paint_and_wait(
    frame: u32,
    paint_state: &PaintState,
    browser: &impl BrowserDriver,
    deadline: Instant,
    copy_owned_texture: bool,
) -> anyhow::Result<()> {
    if let Some(error) = paint_state.take_paint_error() {
        return Err(anyhow::anyhow!(error));
    }
    let sequence = paint_state.current_paint_sequence();
    loop {
        if let Some(error) = paint_state.take_paint_error() {
            return Err(anyhow::anyhow!(error));
        }
        if paint_state.current_paint_sequence() != sequence {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(RendererError::PaintTimeout(frame).into());
        }

        if copy_owned_texture {
            paint_state.request_owned_texture_copy();
        } else {
            paint_state.request_paint_observation();
        }
        browser.request_paint()?;
        let retry_deadline =
            std::cmp::min(deadline, Instant::now() + PAINT_REINVALIDATION_INTERVAL);
        if wait_for_paint_after_sequence(paint_state, browser, sequence, retry_deadline).await {
            return Ok(());
        }
        if retry_deadline >= deadline {
            return Err(RendererError::PaintTimeout(frame).into());
        }

        tracing::debug!(
            frame,
            retry_interval_ms = PAINT_REINVALIDATION_INTERVAL.as_millis(),
            "paint request produced no callback; re-invalidating within capture deadline"
        );
    }
}

fn install_encoder_owned_texture_pool(
    paint_state: &PaintState,
    encoder: &VideoEncoder,
) -> anyhow::Result<()> {
    #[cfg(windows)]
    if let VideoEncoder::D3D11(encoder) = encoder {
        paint_state.install_owned_texture_pool(encoder.owned_texture_pool())?;
    }
    #[cfg(not(windows))]
    let _ = (paint_state, encoder);
    Ok(())
}

async fn wait_for_paint_after_sequence(
    paint_state: &PaintState,
    browser: &impl BrowserDriver,
    sequence: u64,
    deadline: Instant,
) -> bool {
    let paint_event = paint_state.wait_for_paint_after(sequence, deadline);
    tokio::pin!(paint_event);

    loop {
        browser.pump();
        if paint_state.current_paint_sequence() != sequence {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }

        tokio::select! {
            changed = &mut paint_event => {
                return changed;
            }
            _ = yield_now() => {}
        }
    }
}

async fn wait_for_post_render_paint_before_capture_generation(
    frame: u32,
    paint_state: &PaintState,
    browser: &impl BrowserDriver,
) -> anyhow::Result<()> {
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut settled_paints = 0;

    loop {
        request_paint_and_wait(frame, paint_state, browser, deadline, false).await?;
        if paint_state.take_last_frame().is_some() {
            settled_paints += 1;
            if settled_paints >= INITIAL_POST_RENDER_SETTLE_PAINTS {
                return Ok(());
            }
        }
    }
}

#[cfg(test)]
fn read_bgra_from_accelerated_frame(frame: &mut AcceleratedFrame) -> anyhow::Result<Vec<u8>> {
    captured_frame_from_accelerated_frame(frame)?.into_bgra()
}

fn captured_frame_from_accelerated_frame(
    frame: &mut AcceleratedFrame,
) -> anyhow::Result<CapturedFrame> {
    if let Some(pixels) = frame.bgra.take() {
        return Ok(CapturedFrame::BgraSoftware(SoftwareFrame {
            capture_backend: frame.software_capture_backend,
            width: frame.width,
            height: frame.height,
            pixel_format: SoftwarePixelFormat::Bgra,
            pixels,
        }));
    }

    if let Some(owned_texture) = frame.owned_texture.take() {
        return Ok(CapturedFrame::GpuSurface(GpuSurfaceFrame {
            width: frame.width,
            height: frame.height,
            texture_width: frame.width,
            texture_height: frame.height,
            source_rect: TextureSourceRect::full(frame.width, frame.height),
            source_format: SurfaceFormat::Bgra,
            platform_surface: PlatformSurface::WindowsD3D11(WindowsD3D11Surface { owned_texture }),
        }));
    }

    Err(anyhow::anyhow!("capture.accelerated_readback_unavailable"))
}

fn accelerated_frame_is_current(
    accelerated_frame: &AcceleratedFrame,
    generation: u64,
    context: &RenderContext,
    frame: u32,
    telemetry: Option<&mut crate::telemetry::RenderTelemetry>,
) -> bool {
    if accelerated_frame.generation != generation {
        if let Some(telemetry) = telemetry {
            telemetry.stale_frames += 1;
        }
        tracing::debug!(
            frame,
            actual_generation = accelerated_frame.generation,
            expected_generation = generation,
            "ignoring paint from a previous capture generation"
        );
        return false;
    }
    if accelerated_frame.width != context.width || accelerated_frame.height != context.height {
        if let Some(telemetry) = telemetry {
            telemetry.dropped_frames += 1;
        }
        tracing::debug!(
            frame,
            actual_width = accelerated_frame.width,
            actual_height = accelerated_frame.height,
            expected_width = context.width,
            expected_height = context.height,
            "ignoring paint with non-matching dimensions"
        );
        return false;
    }

    true
}

fn capture_current_accelerated_frame(
    accelerated_frame: &mut AcceleratedFrame,
    frame: u32,
    capture_probe_telemetry: Option<&mut crate::telemetry::RenderTelemetry>,
) -> anyhow::Result<CapturedFrame> {
    tracing::debug!(
        frame,
        color_type = %accelerated_frame.color_type_debug,
        platform_handle = %accelerated_frame.platform_handle_debug,
        "captured accelerated paint for requested frame"
    );

    match captured_frame_from_accelerated_frame(accelerated_frame) {
        Ok(captured) => Ok(captured),
        Err(error) if is_accelerated_readback_unavailable(&error) => {
            if let Some(telemetry) = capture_probe_telemetry {
                telemetry.capture_backend = Some("electron_accelerated_paint".to_string());
                telemetry.surface_format_in = Some(
                    accelerated_paint_surface_format_label(&accelerated_frame.color_type_debug)
                        .to_string(),
                );
                telemetry.frames_rendered = 1;
            }
            Err(anyhow::anyhow!(
                "capture.accelerated_paint_unavailable: accelerated paint did not provide a supported GPU capture backend"
            ))
        }
        Err(error) => Err(error),
    }
}

fn is_accelerated_readback_unavailable(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .to_string()
            .contains("capture.accelerated_readback_unavailable")
    })
}

fn accelerated_paint_surface_format_label(color_type_debug: &str) -> &'static str {
    let color_type = color_type_debug.to_ascii_uppercase();
    if color_type.contains("BGRA") {
        "bgra"
    } else if color_type.contains("RGBA") {
        "rgba"
    } else {
        "unknown"
    }
}

fn record_encode_stats(telemetry: &mut crate::telemetry::RenderTelemetry, stats: FrameEncodeStats) {
    telemetry.gpu_import_ms += stats.gpu_import_ms;
    telemetry.gpu_conversion_ms += stats.gpu_conversion_ms;
    telemetry.gpu_sync_wait_ms += stats.gpu_sync_wait_ms;
    telemetry.packet_write_ms += stats.packet_write_ms;
}

#[cfg(test)]
mod tests {
    mod test_support;

    use super::*;
    use crate::scheduler::FrameRange;
    use crate::surface::TextureSourceRect;
    use std::fs;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use std::time::{SystemTime, UNIX_EPOCH};
    use test_support::*;
    use velocast_protocol::{CompositionManifest, RenderContext};

    #[test]
    fn returns_get_compositions_protocol_script() {
        assert_eq!(
            get_compositions_script(),
            "window.__velocast.getCompositions()"
        );
    }

    #[test]
    fn builds_seek_frame_script_with_serialized_context() {
        let script = seek_frame_script(
            4,
            &RenderContext {
                composition_id: "hero".to_string(),
                width: 1200,
                height: 630,
                fps: 30,
                duration_frames: 90,
                target: Some("#hero".to_string()),
                input_props: None,
                render_session: None,
            },
        )
        .unwrap();

        assert!(script.contains("window.__velocast.seekFrame(\"hero\", 4"));
        assert!(script.contains("\"compositionId\":\"hero\""));
        assert!(!script.contains("renderFrame"));
        assert!(!script.contains("dataset.velocastRendering"));
        assert!(!script.contains("document.querySelector(selector)"));
    }

    #[test]
    fn selects_composition_by_id() {
        let selected = select_composition(&[manifest("hero"), manifest("other")], "hero").unwrap();

        assert_eq!(selected.id, "hero");
    }

    #[test]
    fn reports_missing_composition_id() {
        let error = select_composition(&[manifest("hero")], "missing").unwrap_err();

        assert_eq!(error.to_string(), "composition missing was not found");
    }

    #[test]
    fn selects_url_composition_by_selector_target() {
        let selected =
            select_url_composition(&[manifest("hero"), manifest("other")], "#hero").unwrap();

        assert_eq!(selected.id, "hero");
    }

    #[test]
    fn reports_missing_url_selector() {
        let error = select_url_composition(&[manifest("hero")], "#missing").unwrap_err();

        assert_eq!(
            error.to_string(),
            "selector #missing was not found in composition metadata"
        );
    }

    #[test]
    fn records_portable_gpu_surface_capture_backend() {
        let mut telemetry =
            crate::telemetry::RenderTelemetry::new(crate::telemetry::RenderModeLabel::ReferenceGpu);
        let captured = CapturedFrame::GpuSurface(crate::surface::GpuSurfaceFrame {
            width: 1200,
            height: 630,
            texture_width: 1200,
            texture_height: 630,
            source_rect: crate::surface::TextureSourceRect::full(1200, 630),
            source_format: crate::surface::SurfaceFormat::Bgra,
            platform_surface: crate::surface::PlatformSurface::WindowsD3D11(
                crate::surface::WindowsD3D11Surface {
                    owned_texture:
                        crate::capture::windows_d3d11::OwnedTextureLease::borrowed_for_test(42),
                },
            ),
        });

        record_captured_frame(&mut telemetry, &captured);

        assert_eq!(
            telemetry.capture_backend.as_deref(),
            Some("electron_d3d11_shared_texture")
        );
        assert_eq!(telemetry.surface_format_in.as_deref(), Some("bgra"));
    }

    #[test]
    fn records_portable_software_capture_backend() {
        let mut telemetry =
            crate::telemetry::RenderTelemetry::new(crate::telemetry::RenderModeLabel::ReferenceGpu);
        let captured = CapturedFrame::BgraSoftware(crate::surface::SoftwareFrame {
            capture_backend: "electron_software_bgra",
            width: 1,
            height: 1,
            pixel_format: crate::surface::SoftwarePixelFormat::Bgra,
            pixels: vec![0, 0, 0, 255],
        });

        record_captured_frame(&mut telemetry, &captured);

        assert_eq!(
            telemetry.capture_backend.as_deref(),
            Some("electron_software_bgra")
        );
        assert_eq!(telemetry.surface_format_in.as_deref(), Some("bgra"));
    }

    #[test]
    fn electron_software_handoff_preserves_capture_provenance_in_telemetry() {
        let state = PaintState::default();
        state
            .store_software_frame("electron_software_bgra", 7, 1, 1, vec![0, 0, 0, 255])
            .unwrap();
        let mut frame = state.take_last_frame().unwrap();
        let captured = captured_frame_from_accelerated_frame(&mut frame).unwrap();
        assert_eq!(
            captured.capture_metadata().capture_backend,
            "electron_software_bgra"
        );
        let mut telemetry =
            crate::telemetry::RenderTelemetry::new(crate::telemetry::RenderModeLabel::ReferenceGpu);
        record_captured_frame(&mut telemetry, &captured);
        assert_eq!(
            telemetry.capture_backend.as_deref(),
            Some("electron_software_bgra")
        );
        assert_eq!(captured.into_bgra().unwrap(), vec![0, 0, 0, 255]);
    }

    #[test]
    fn builds_url_composition_from_selector_measurement() {
        let composition = composition_from_selector_measurement(
            "#hero",
            SelectorMeasurement {
                width: 642.4,
                height: 361.2,
            },
        )
        .unwrap();

        assert_eq!(composition.id, "selector:#hero");
        assert_eq!(composition.width, 643);
        assert_eq!(composition.height, 362);
        assert_eq!(composition.fps, 30);
        assert_eq!(composition.duration_frames, 1);
        assert_eq!(composition.target.as_deref(), Some("#hero"));
    }

    #[test]
    fn readback_boundary_rejects_accelerated_frames_without_readback_pixels() {
        let frame = AcceleratedFrame {
            software_capture_backend: "electron_software_bgra",
            generation: 0,
            width: 2,
            height: 3,
            texture_width: 2,
            texture_height: 3,
            source_rect: TextureSourceRect::full(2, 3),
            color_type_debug: "format=BGRA".to_string(),
            platform_handle_debug: "d3d11".to_string(),
            owned_texture: None,
            bgra: None,
        };

        let mut frame = frame;
        let error = read_bgra_from_accelerated_frame(&mut frame).unwrap_err();

        assert_eq!(
            error.to_string(),
            "capture.accelerated_readback_unavailable"
        );
    }

    #[test]
    fn readback_boundary_uses_software_pixels_when_available() {
        let frame = AcceleratedFrame {
            software_capture_backend: "electron_software_bgra",
            generation: 0,
            width: 1,
            height: 1,
            texture_width: 1,
            texture_height: 1,
            source_rect: TextureSourceRect::full(1, 1),
            color_type_debug: "format=software-bgra".to_string(),
            platform_handle_debug: "electron-on-paint".to_string(),
            owned_texture: None,
            bgra: Some(vec![9, 8, 7, 6]),
        };

        let mut frame = frame;
        let bgra = read_bgra_from_accelerated_frame(&mut frame).unwrap();

        assert_eq!(bgra, vec![9, 8, 7, 6]);
    }

    #[test]
    fn read_bgra_from_software_frame() {
        let mut frame = AcceleratedFrame {
            software_capture_backend: "electron_software_bgra",
            generation: 1,
            width: 1,
            height: 1,
            texture_width: 1,
            texture_height: 1,
            source_rect: TextureSourceRect::full(1, 1),
            color_type_debug: "software_bgra".to_string(),
            platform_handle_debug: "software".to_string(),
            owned_texture: None,
            bgra: Some(vec![9, 8, 7, 255]),
        };

        assert_eq!(
            read_bgra_from_accelerated_frame(&mut frame).unwrap(),
            vec![9, 8, 7, 255]
        );
    }

    #[test]
    fn readback_boundary_moves_cached_bgra_without_cloning() {
        let pixels = vec![9, 8, 7, 6];
        let original_ptr = pixels.as_ptr();
        let mut frame = AcceleratedFrame {
            software_capture_backend: "electron_software_bgra",
            generation: 0,
            width: 1,
            height: 1,
            texture_width: 1,
            texture_height: 1,
            source_rect: TextureSourceRect::full(1, 1),
            color_type_debug: "format=software-bgra".to_string(),
            platform_handle_debug: "electron-on-paint".to_string(),
            owned_texture: None,
            bgra: Some(pixels),
        };

        let bgra = read_bgra_from_accelerated_frame(&mut frame).unwrap();

        assert_eq!(bgra.as_ptr(), original_ptr);
        assert!(frame.bgra.is_none());
    }

    #[test]
    fn required_acceleration_defaults_encoder_pixel_format_to_nv12() {
        let mut job = render_job();
        job.acceleration = velocast_protocol::RendererAcceleration::Required;
        job.pixel_format = None;
        let composition = composition_manifest();
        let output = std::path::Path::new("out.mp4");

        let settings = encoder_settings_for_job(
            &job,
            &composition,
            output,
            EncoderExecutionContext::Reference,
        )
        .unwrap();

        assert_eq!(settings.pixel_format, "nv12");
        assert_eq!(
            settings.backend,
            crate::encoder::EncoderBackendPreference::HardwareRequired
        );
    }

    #[test]
    fn required_reference_output_expectation_matches_job_and_composition() {
        let mut job = render_job();
        job.codec = "h264".to_string();
        job.pixel_format = None;
        job.acceleration = velocast_protocol::RendererAcceleration::Required;
        let composition = CompositionManifest {
            width: 3840,
            height: 2160,
            fps: 60,
            duration_frames: 240,
            ..composition_manifest()
        };

        let expected = expected_video_output_for_job(&job, &composition, None);

        assert_eq!(expected.width, 3840);
        assert_eq!(expected.height, 2160);
        assert_eq!(expected.fps, 60);
        assert_eq!(expected.frame_count, 240);
        assert_eq!(expected.codec_name, "h264");
        assert_eq!(
            expected.pix_fmts,
            vec![
                "yuv420p".to_string(),
                "nv12".to_string(),
                "yuvj420p".to_string()
            ]
        );
    }

    #[test]
    fn reference_output_uses_activated_format_but_never_weakens_explicit_request() {
        let mut job = render_job();
        job.acceleration = RendererAcceleration::Auto;
        job.pixel_format = None;
        let composition = composition_manifest();
        let actual_gpu = expected_video_output_for_job(&job, &composition, Some("nv12"));
        assert_eq!(
            actual_gpu.pix_fmts,
            vec![
                "yuv420p".to_owned(),
                "nv12".to_owned(),
                "yuvj420p".to_owned()
            ]
        );
        let actual_software = expected_video_output_for_job(&job, &composition, Some("yuv444p"));
        assert_eq!(actual_software.pix_fmts, vec!["yuv444p".to_owned()]);
        job.pixel_format = Some("yuv444p".to_owned());
        let explicit = expected_video_output_for_job(&job, &composition, Some("nv12"));
        assert_eq!(explicit.pix_fmts, vec!["yuv444p".to_owned()]);
        let settings = encoder_settings_for_job(
            &job,
            &composition,
            Path::new("output.mp4"),
            EncoderExecutionContext::Reference,
        )
        .unwrap();
        assert_eq!(
            settings.backend,
            crate::encoder::EncoderBackendPreference::Software
        );
    }

    #[test]
    fn encoder_settings_for_job_carries_explicit_bitrate() {
        let mut job = render_job();
        job.bitrate_bps = Some(72_000_000);
        let composition = composition_manifest();
        let output = std::path::Path::new("out.mp4");

        let settings = encoder_settings_for_job(
            &job,
            &composition,
            output,
            EncoderExecutionContext::Reference,
        )
        .unwrap();

        assert_eq!(settings.bitrate_bps, Some(72_000_000));
    }

    #[test]
    fn off_acceleration_defaults_encoder_pixel_format_to_yuv444p() {
        let mut job = render_job();
        job.acceleration = velocast_protocol::RendererAcceleration::Off;
        job.pixel_format = None;
        let composition = composition_manifest();
        let output = std::path::Path::new("out.mp4");

        let settings = encoder_settings_for_job(
            &job,
            &composition,
            output,
            EncoderExecutionContext::Reference,
        )
        .unwrap();

        assert_eq!(settings.pixel_format, "yuv444p");
        assert_eq!(
            settings.backend,
            crate::encoder::EncoderBackendPreference::Software
        );
    }

    #[test]
    fn required_acceleration_rejects_yuv444p() {
        let mut job = render_job();
        job.acceleration = velocast_protocol::RendererAcceleration::Required;
        job.pixel_format = Some("yuv444p".to_string());
        let composition = composition_manifest();
        let output = std::path::Path::new("out.mp4");

        let error = encoder_settings_for_job(
            &job,
            &composition,
            output,
            EncoderExecutionContext::Reference,
        )
        .unwrap_err();

        assert!(error.to_string().contains("supports nv12/yuv420p"));
    }

    #[test]
    fn capture_boundary_returns_gpu_frame_when_owned_texture_is_available() {
        let mut frame = AcceleratedFrame {
            software_capture_backend: "electron_software_bgra",
            generation: 0,
            width: 1920,
            height: 1080,
            texture_width: 1920,
            texture_height: 1080,
            source_rect: TextureSourceRect::full(1920, 1080),
            color_type_debug: "format=BGRA".to_string(),
            platform_handle_debug: "d3d11".to_string(),
            owned_texture: Some(
                crate::capture::windows_d3d11::OwnedTextureLease::borrowed_for_test(42),
            ),
            bgra: None,
        };

        let captured = captured_frame_from_accelerated_frame(&mut frame).unwrap();

        let CapturedFrame::GpuSurface(GpuSurfaceFrame {
            width,
            height,
            platform_surface: PlatformSurface::WindowsD3D11(WindowsD3D11Surface { owned_texture }),
            ..
        }) = captured
        else {
            panic!("expected owned D3D11 texture frame");
        };
        assert_eq!(width, 1920);
        assert_eq!(height, 1080);
        assert_eq!(owned_texture.slot_index(), 42);
    }

    #[test]
    fn captured_frame_moves_owned_texture_lease_once() {
        let mut frame = AcceleratedFrame {
            software_capture_backend: "electron_software_bgra",
            generation: 0,
            width: 1920,
            height: 1080,
            texture_width: 1920,
            texture_height: 1080,
            source_rect: TextureSourceRect::full(1920, 1080),
            color_type_debug: "format=BGRA".to_string(),
            platform_handle_debug: "d3d11".to_string(),
            owned_texture: Some(
                crate::capture::windows_d3d11::OwnedTextureLease::borrowed_for_test(42),
            ),
            bgra: None,
        };

        let captured = captured_frame_from_accelerated_frame(&mut frame).unwrap();

        assert!(matches!(
            captured,
            CapturedFrame::GpuSurface(GpuSurfaceFrame {
                width: 1920,
                height: 1080,
                ..
            })
        ));
        assert!(frame.owned_texture.is_none());
    }

    #[test]
    fn capture_probe_records_software_failure_context() {
        let mut telemetry =
            crate::telemetry::RenderTelemetry::new(crate::telemetry::RenderModeLabel::ReferenceGpu);
        telemetry.capture_probe = Some("accelerated_paint".to_string());
        let mut frame = AcceleratedFrame {
            software_capture_backend: "electron_software_bgra",
            generation: 1,
            width: 1,
            height: 1,
            texture_width: 1,
            texture_height: 1,
            source_rect: TextureSourceRect::full(1, 1),
            color_type_debug: "software".to_string(),
            platform_handle_debug: "none".to_string(),
            owned_texture: None,
            bgra: Some(vec![0, 0, 0, 255]),
        };

        let error = record_capture_probe_frame_for_test(&mut frame, &mut telemetry)
            .unwrap_err()
            .to_string();

        assert_eq!(
            error,
            "capture.accelerated_paint_unavailable: accelerated paint probe received software BGRA paint"
        );
        assert_eq!(
            telemetry.capture_backend.as_deref(),
            Some("electron_software_bgra")
        );
        assert_eq!(telemetry.surface_format_in.as_deref(), Some("bgra"));
        assert_eq!(telemetry.frames_rendered, 1);
        assert_eq!(telemetry.cpu_readback_frames, 0);
        assert_eq!(telemetry.frames_encoded, 0);
    }

    #[test]
    fn bgra_fallback_moves_cached_pixels_from_captured_frame() {
        let pixels = vec![1, 2, 3, 4];
        let original_ptr = pixels.as_ptr();
        let captured = CapturedFrame::BgraSoftware(SoftwareFrame {
            capture_backend: "electron_software_bgra",
            width: 1,
            height: 1,
            pixel_format: SoftwarePixelFormat::Bgra,
            pixels,
        });

        let bgra = captured.into_bgra().unwrap();

        assert_eq!(bgra.as_ptr(), original_ptr);
    }

    #[test]
    fn software_bgra_conversion_does_not_increment_readback_counter() {
        let captured = CapturedFrame::BgraSoftware(SoftwareFrame {
            capture_backend: "electron_software_bgra",
            width: 1,
            height: 1,
            pixel_format: SoftwarePixelFormat::Bgra,
            pixels: vec![0, 0, 0, 255],
        });
        let mut telemetry =
            crate::telemetry::RenderTelemetry::new(crate::telemetry::RenderModeLabel::ReferenceGpu);

        let bgra = captured.into_bgra_with_telemetry(&mut telemetry).unwrap();

        assert_eq!(bgra, vec![0, 0, 0, 255]);
        assert_eq!(telemetry.cpu_readback_frames, 0);
    }

    #[test]
    fn serial_temp_output_path_lives_next_to_final_output() {
        let path = serial_temp_output_path_for(Path::new("renders/product-hero.mp4"), 42);

        assert_eq!(
            path,
            Path::new("renders/.velocast/tmp/product-hero-42/product-hero.final.mp4")
        );
    }

    #[test]
    fn video_capture_and_encoding_modules_do_not_reference_png_intermediates() {
        // main.rs also dispatches the public single-frame PNG export. That
        // intentional output must not be confused with intermediate video frames.
        // Direct surface delivery is separately exercised by FrameEncoder tests
        // and the native capture/encoder telemetry acceptance gates.
        let sources = [
            ("args.rs", include_str!("args.rs")),
            ("electron_app.rs", include_str!("electron_app.rs")),
            ("encoder.rs", include_str!("encoder.rs")),
            ("errors.rs", include_str!("errors.rs")),
            ("frame_loop.rs", include_str!("frame_loop.rs")),
            ("parallel.rs", include_str!("parallel.rs")),
            ("paint_state.rs", include_str!("paint_state.rs")),
            ("scheduler.rs", include_str!("scheduler.rs")),
        ];
        let extension = [".", "p", "n", "g"].concat();
        let mime = ["image/", "p", "n", "g"].concat();

        for (path, source) in sources {
            assert!(
                !source.contains(&extension),
                "{path} references PNG frame files"
            );
            assert!(
                !source.contains(&mime),
                "{path} references PNG frame MIME data"
            );
        }
    }

    #[test]
    fn frame_loop_does_not_use_fixed_sleep_polling() {
        let source = include_str!("frame_loop.rs");

        let forbidden_sleep = ["s", "leep("];
        let forbidden_millis = ["from_", "millis(4)"];

        assert!(!source.contains(&forbidden_sleep.concat()));
        assert!(!source.contains(&forbidden_millis.concat()));
        assert!(source.contains("wait_for_paint_after"));
    }

    #[test]
    fn frame_loop_browser_fixtures_live_in_test_support_module() {
        let frame_loop_source = include_str!("frame_loop.rs");
        let test_support_source = include_str!("frame_loop/tests/test_support.rs");
        let fake_browser_definition = ["struct ", "FakeBrowser"].concat();
        let recording_encoder_definition = ["struct ", "RecordingEncoder"].concat();

        let module_decl = ["mod ", "test_", "support", ";"].concat();

        assert!(frame_loop_source
            .lines()
            .any(|line| line.trim() == module_decl));
        assert!(!frame_loop_source.contains(&fake_browser_definition));
        assert!(!frame_loop_source.contains(&recording_encoder_definition));
        assert!(test_support_source.contains(&fake_browser_definition));
        assert!(test_support_source.contains(&recording_encoder_definition));
    }

    #[test]
    fn serial_renderer_uses_video_encoder_boundary() {
        let source = include_str!("frame_loop.rs");
        let forbidden = ["FfmpegEncoder", "::spawn"].concat();

        assert!(source.contains("VideoEncoder::spawn_with_report"));
        assert!(!source.contains(&forbidden));
    }

    #[tokio::test]
    async fn renders_frame_range_to_raw_bgra_chunk() {
        let paint_state = PaintState::default();
        let browser = FakeBrowser::new(paint_state.clone());
        let path = temp_chunk_path();
        let composition = manifest("hero");

        render_frame_range_to_chunk(
            &composition,
            FrameRange::new(2, 5),
            paint_state,
            &browser,
            &path,
        )
        .await
        .unwrap();

        assert_eq!(browser.frames(), vec![2, 3, 4]);
        assert_eq!(
            fs::read(&path).unwrap(),
            vec![2, 0, 0, 255, 3, 0, 0, 255, 4, 0, 0, 255]
        );
        fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn preparation_without_paint_still_requires_fresh_settled_capture_frames() {
        let paint_state = PaintState::default();
        let browser = NonblockingPreparationBrowser::new(paint_state.clone());
        let context = render_context(&manifest("hero"));
        let mut telemetry =
            crate::telemetry::RenderTelemetry::new(crate::telemetry::RenderModeLabel::ReferenceGpu);
        let mut pixels = Vec::new();

        for frame in 26..29 {
            let captured = render_one_frame(
                &context,
                frame,
                &paint_state,
                &browser,
                Some(&mut telemetry),
                false,
                false,
            )
            .await
            .unwrap();
            pixels.extend(captured.into_bgra().unwrap());
        }

        assert_eq!(pixels, vec![26, 0, 0, 255, 27, 0, 0, 255, 28, 0, 0, 255]);
        assert_eq!(browser.preparations(), 3);
        assert_eq!(paint_state.current_generation(), 3);
        // Every frame rejects a prior generation and wrong viewport, discards
        // two current-generation settling paints, then asks for the copy.
        assert_eq!(
            browser.capture_copy_intents(),
            [false, false, false, false, true].repeat(3)
        );
        assert_eq!(telemetry.stale_frames, 3);
        assert_eq!(telemetry.dropped_frames, 3);
        assert_eq!(telemetry.capture_generation_paints_observed, 15);
        assert_eq!(telemetry.capture_generation_settle_paints_discarded, 6);
    }

    #[tokio::test]
    async fn ignores_stale_paint_before_rendering_frame() {
        let paint_state = PaintState::default();
        paint_state.store_accelerated_frame(AcceleratedFrame {
            software_capture_backend: "electron_software_bgra",
            generation: paint_state.current_generation(),
            width: 1,
            height: 1,
            texture_width: 1,
            texture_height: 1,
            source_rect: TextureSourceRect::full(1, 1),
            color_type_debug: "format=software-bgra".to_string(),
            platform_handle_debug: "stale-preview".to_string(),
            owned_texture: None,
            bgra: Some(vec![72, 0, 0, 255]),
        });
        let browser = DelayedPaintBrowser::new(paint_state.clone());
        let path = temp_chunk_path();
        let composition = manifest("hero");

        render_frame_range_to_chunk(
            &composition,
            FrameRange::new(0, 1),
            paint_state,
            &browser,
            &path,
        )
        .await
        .unwrap();

        assert_eq!(browser.frames(), vec![0]);
        assert_eq!(fs::read(&path).unwrap(), vec![0, 0, 0, 255]);
        fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn ignores_stale_paint_that_arrives_during_render_frame() {
        let paint_state = PaintState::default();
        let browser = StaleDuringRenderBrowser::new(paint_state.clone());
        let path = temp_chunk_path();
        let composition = manifest("hero");

        render_frame_range_to_chunk(
            &composition,
            FrameRange::new(0, 1),
            paint_state,
            &browser,
            &path,
        )
        .await
        .unwrap();

        assert_eq!(browser.frames(), vec![0]);
        assert_eq!(fs::read(&path).unwrap(), vec![0, 0, 0, 255]);
        fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn waits_for_delayed_post_request_paint_before_using_render_frame_paint() {
        let paint_state = PaintState::default();
        let browser = SlowPostRequestPaintBrowser::new(paint_state.clone());
        let path = temp_chunk_path();
        let composition = manifest("hero");

        render_frame_range_to_chunk(
            &composition,
            FrameRange::new(0, 1),
            paint_state,
            &browser,
            &path,
        )
        .await
        .unwrap();

        assert_eq!(browser.frames(), vec![0]);
        assert_eq!(fs::read(&path).unwrap(), vec![0, 0, 0, 255]);
        fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn waits_for_post_request_paint_when_render_frame_also_paints() {
        let paint_state = PaintState::default();
        let browser = PaintDuringRenderBrowser::new(paint_state.clone());
        let path = temp_chunk_path();
        let composition = manifest("hero");

        render_frame_range_to_chunk(
            &composition,
            FrameRange::new(0, 1),
            paint_state,
            &browser,
            &path,
        )
        .await
        .unwrap();

        assert_eq!(browser.frames(), vec![0]);
        assert_eq!(fs::read(&path).unwrap(), vec![0, 0, 0, 255]);
        fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn drains_stale_post_render_surface_before_capture_generation() {
        let paint_state = PaintState::default();
        let browser = StaleFirstPostRenderPaintBrowser::new(paint_state.clone());
        let path = temp_chunk_path();
        let composition = manifest("hero");

        render_frame_range_to_chunk(
            &composition,
            FrameRange::new(2, 3),
            paint_state,
            &browser,
            &path,
        )
        .await
        .unwrap();

        assert_eq!(browser.frames(), vec![2]);
        assert_eq!(fs::read(&path).unwrap(), vec![2, 0, 0, 255]);
        fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn waits_for_late_initial_preview_paint_before_first_capture_generation() {
        let paint_state = PaintState::default();
        let browser = LateInitialPreviewPaintBrowser::new(paint_state.clone());
        let path = temp_chunk_path();
        let composition = manifest("hero");

        render_frame_range_to_chunk(
            &composition,
            FrameRange::new(0, 2),
            paint_state,
            &browser,
            &path,
        )
        .await
        .unwrap();

        assert_eq!(browser.frames(), vec![0, 1]);
        assert_eq!(fs::read(&path).unwrap(), vec![0, 0, 0, 255, 1, 0, 0, 255]);
        fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn waits_for_reordered_initial_preview_paint_before_first_capture_generation() {
        let paint_state = PaintState::default();
        let browser = ReorderedInitialPreviewPaintBrowser::new(paint_state.clone());
        let path = temp_chunk_path();
        let composition = manifest("hero");

        render_frame_range_to_chunk(
            &composition,
            FrameRange::new(0, 1),
            paint_state,
            &browser,
            &path,
        )
        .await
        .unwrap();

        assert_eq!(browser.frames(), vec![0]);
        assert_eq!(fs::read(&path).unwrap(), vec![0, 0, 0, 255]);
        fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn waits_for_multiple_initial_preview_paints_before_first_capture_generation() {
        let paint_state = PaintState::default();
        let browser = MultipleInitialPreviewPaintBrowser::new(paint_state.clone());
        let path = temp_chunk_path();
        let composition = manifest("hero");

        render_frame_range_to_chunk(
            &composition,
            FrameRange::new(180, 181),
            paint_state,
            &browser,
            &path,
        )
        .await
        .unwrap();

        assert_eq!(browser.frames(), vec![180]);
        assert_eq!(fs::read(&path).unwrap(), vec![180, 0, 0, 255]);
        fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn does_not_fallback_to_stale_render_frame_paint_before_target_paint_arrives() {
        let paint_state = PaintState::default();
        let browser = VerySlowPostRequestPaintBrowser::new(paint_state.clone());
        let path = temp_chunk_path();
        let composition = manifest("hero");

        render_frame_range_to_chunk(
            &composition,
            FrameRange::new(0, 1),
            paint_state,
            &browser,
            &path,
        )
        .await
        .unwrap();

        assert_eq!(browser.frames(), vec![0]);
        assert_eq!(fs::read(&path).unwrap(), vec![0, 0, 0, 255]);
        fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn reissues_paint_request_when_the_first_request_has_no_callback() {
        let paint_state = PaintState::default();
        let browser = SecondRequestPaintBrowser::new(paint_state.clone());
        let path = temp_chunk_path();
        let composition = manifest("hero");

        render_frame_range_to_chunk(
            &composition,
            FrameRange::new(0, 1),
            paint_state,
            &browser,
            &path,
        )
        .await
        .unwrap();

        assert_eq!(browser.frames(), vec![0]);
        assert_eq!(browser.requests(), 4);
        assert_eq!(fs::read(&path).unwrap(), vec![0, 0, 0, 255]);
        fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn ignores_same_size_stale_paint_that_arrives_after_render_frame() {
        let paint_state = PaintState::default();
        let browser = SameSizeStaleAfterRenderBrowser::new(paint_state.clone());
        let path = temp_chunk_path();
        let composition = manifest("hero");

        render_frame_range_to_chunk(
            &composition,
            FrameRange::new(0, 1),
            paint_state,
            &browser,
            &path,
        )
        .await
        .unwrap();

        assert_eq!(browser.frames(), vec![0]);
        assert_eq!(fs::read(&path).unwrap(), vec![0, 0, 0, 255]);
        fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn ignores_delayed_previous_paint_tagged_with_current_generation() {
        let paint_state = PaintState::default();
        let browser = DelayedPreviousPaintTaggedCurrentBrowser::new(paint_state.clone(), 1);
        let path = temp_chunk_path();
        let composition = manifest("hero");

        render_frame_range_to_chunk(
            &composition,
            FrameRange::new(26, 28),
            paint_state,
            &browser,
            &path,
        )
        .await
        .unwrap();

        assert_eq!(browser.frames(), vec![26, 27]);
        assert_eq!(fs::read(&path).unwrap(), vec![26, 0, 0, 255, 27, 0, 0, 255]);
        fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn ignores_multiple_delayed_previous_paints_tagged_with_current_generation() {
        let paint_state = PaintState::default();
        let browser = DelayedPreviousPaintTaggedCurrentBrowser::new(paint_state.clone(), 2);
        let path = temp_chunk_path();
        let composition = manifest("hero");

        render_frame_range_to_chunk(
            &composition,
            FrameRange::new(26, 28),
            paint_state,
            &browser,
            &path,
        )
        .await
        .unwrap();

        assert_eq!(browser.frames(), vec![26, 27]);
        assert_eq!(fs::read(&path).unwrap(), vec![26, 0, 0, 255, 27, 0, 0, 255]);
        fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn ignores_paint_from_previous_viewport_size() {
        let paint_state = PaintState::default();
        let browser = MismatchedPaintBrowser::new(paint_state.clone());
        let path = temp_chunk_path();
        let composition = manifest("hero");

        render_frame_range_to_chunk(
            &composition,
            FrameRange::new(0, 1),
            paint_state,
            &browser,
            &path,
        )
        .await
        .unwrap();

        assert_eq!(browser.frames(), vec![0]);
        assert_eq!(fs::read(&path).unwrap(), vec![0, 0, 0, 255]);
        fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn aborts_encoder_when_frame_capture_fails() {
        for range in [None, Some(FrameRange::new(4, 6))] {
            let paint_state = PaintState::default();
            let browser = FailingRenderBrowser;
            let composition = manifest("hero");
            let writes = Arc::new(AtomicUsize::new(0));
            let encoder = RecordingEncoder::with_writes(writes.clone());
            let aborted = encoder.aborted.clone();
            let finished = encoder.finished.clone();
            let mut telemetry = crate::telemetry::RenderTelemetry::new(
                crate::telemetry::RenderModeLabel::ReferenceGpu,
            );

            let result = match range {
                Some(range) => {
                    render_frame_range_with_encoder(
                        &composition,
                        range,
                        paint_state,
                        &browser,
                        encoder,
                        false,
                        &mut telemetry,
                    )
                    .await
                }
                None => {
                    render_frames_with_encoder(
                        &composition,
                        paint_state,
                        &browser,
                        encoder,
                        false,
                        &mut telemetry,
                        None,
                    )
                    .await
                }
            };

            assert_eq!(result.unwrap_err().to_string(), "render script failed");
            assert!(aborted.load(Ordering::SeqCst));
            assert!(!finished.load(Ordering::SeqCst));
            assert_eq!(writes.load(Ordering::SeqCst), 0);
            assert_eq!(telemetry.frames_rendered, 0);
            assert_eq!(telemetry.frames_encoded, 0);
        }
    }

    #[tokio::test]
    async fn aborts_encoder_when_a_later_frame_write_fails() {
        for (range, expected_frames) in [
            (None, vec![0, 1]),
            (Some(FrameRange::new(4, 7)), vec![4, 5]),
        ] {
            let paint_state = PaintState::default();
            let browser = FakeBrowser::new(paint_state.clone());
            let mut composition = manifest("hero");
            composition.duration_frames = 8;
            let writes = Arc::new(AtomicUsize::new(0));
            let encoder = RecordingEncoder::with_writes(writes.clone()).failing_after(1);
            let aborted = encoder.aborted.clone();
            let finished = encoder.finished.clone();
            let mut telemetry = crate::telemetry::RenderTelemetry::new(
                crate::telemetry::RenderModeLabel::ReferenceGpu,
            );

            let result = match range {
                Some(range) => {
                    render_frame_range_with_encoder(
                        &composition,
                        range,
                        paint_state,
                        &browser,
                        encoder,
                        false,
                        &mut telemetry,
                    )
                    .await
                }
                None => {
                    render_frames_with_encoder(
                        &composition,
                        paint_state,
                        &browser,
                        encoder,
                        false,
                        &mut telemetry,
                        None,
                    )
                    .await
                }
            };

            assert_eq!(result.unwrap_err().to_string(), "frame encode failed");
            assert!(aborted.load(Ordering::SeqCst));
            assert!(!finished.load(Ordering::SeqCst));
            assert_eq!(writes.load(Ordering::SeqCst), 1);
            assert_eq!(browser.frames(), expected_frames);
            assert_eq!(telemetry.frames_rendered, 2);
            assert_eq!(telemetry.frames_encoded, 1);
        }
    }

    #[tokio::test]
    async fn aborts_encoder_when_frame_event_write_fails() {
        let paint_state = PaintState::default();
        let browser = FakeBrowser::new(paint_state.clone());
        let composition = manifest("hero");
        let writes = Arc::new(AtomicUsize::new(0));
        let encoder = RecordingEncoder::with_writes(writes.clone());
        let aborted = encoder.aborted.clone();
        let finished = encoder.finished.clone();
        let mut telemetry =
            crate::telemetry::RenderTelemetry::new(crate::telemetry::RenderModeLabel::ReferenceGpu);
        // A read-only file exercises the real event writer's failure path on every platform.
        let file = tokio::fs::File::open(Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml"))
            .await
            .unwrap();
        let mut event_sink = RendererEventSink::Jsonl(file);

        let error = render_frames_with_encoder(
            &composition,
            paint_state,
            &browser,
            encoder,
            false,
            &mut telemetry,
            Some(&mut event_sink),
        )
        .await
        .unwrap_err();

        assert!(error.downcast_ref::<std::io::Error>().is_some());
        assert!(aborted.load(Ordering::SeqCst));
        assert!(!finished.load(Ordering::SeqCst));
        assert_eq!(writes.load(Ordering::SeqCst), 0);
        assert_eq!(browser.frames(), vec![0]);
        assert_eq!(telemetry.frames_rendered, 1);
        assert_eq!(telemetry.frames_encoded, 0);
    }

    #[tokio::test]
    async fn segment_encoder_records_raw_fallback_telemetry() {
        let paint_state = PaintState::default();
        let browser = FakeBrowser::new(paint_state.clone());
        let composition = manifest("hero");
        let writes = Arc::new(AtomicUsize::new(0));
        let encoder = RecordingEncoder::with_writes(writes.clone());
        let aborted = encoder.aborted.clone();
        let finished = encoder.finished.clone();
        let mut telemetry = crate::telemetry::RenderTelemetry::new(
            crate::telemetry::RenderModeLabel::ParallelSegments,
        );

        render_frame_range_with_encoder(
            &composition,
            FrameRange::new(2, 5),
            paint_state,
            &browser,
            encoder,
            true,
            &mut telemetry,
        )
        .await
        .unwrap();

        assert_eq!(browser.frames(), vec![2, 3, 4]);
        assert_eq!(writes.load(Ordering::SeqCst), 3);
        assert!(finished.load(Ordering::SeqCst));
        assert!(!aborted.load(Ordering::SeqCst));
        assert_eq!(telemetry.frames_rendered, 3);
        assert_eq!(telemetry.frames_encoded, 3);
        assert_eq!(telemetry.cpu_readback_frames, 0);
        assert_eq!(
            telemetry.capture_backend.as_deref(),
            Some("electron_software_bgra")
        );
        assert_eq!(telemetry.surface_format_in.as_deref(), Some("bgra"));
        assert_eq!(telemetry.conversion_backend, None);
    }

    #[tokio::test]
    async fn segment_encoder_records_direct_telemetry_without_cpu_readback() {
        let paint_state = PaintState::default();
        let browser = FakeBrowser::new(paint_state.clone());
        let composition = manifest("hero");
        let writes = Arc::new(AtomicUsize::new(0));
        let encoder = RecordingEncoder::with_writes(writes.clone());
        let aborted = encoder.aborted.clone();
        let finished = encoder.finished.clone();
        let mut telemetry = crate::telemetry::RenderTelemetry::new(
            crate::telemetry::RenderModeLabel::ParallelSegments,
        );

        render_frame_range_with_encoder(
            &composition,
            FrameRange::new(2, 5),
            paint_state,
            &browser,
            encoder,
            false,
            &mut telemetry,
        )
        .await
        .unwrap();

        assert_eq!(browser.frames(), vec![2, 3, 4]);
        assert_eq!(writes.load(Ordering::SeqCst), 3);
        assert!(finished.load(Ordering::SeqCst));
        assert!(!aborted.load(Ordering::SeqCst));
        assert_eq!(telemetry.frames_rendered, 3);
        assert_eq!(telemetry.frames_encoded, 3);
        assert_eq!(telemetry.cpu_readback_frames, 0);
        assert_eq!(
            telemetry.capture_backend.as_deref(),
            Some("electron_software_bgra")
        );
        assert_eq!(telemetry.surface_format_in.as_deref(), Some("bgra"));
        assert_eq!(telemetry.conversion_backend, None);
    }

    #[tokio::test]
    async fn frame_loop_emits_jsonl_frame_render_and_encode_events() {
        let paint_state = PaintState::default();
        let browser = FakeBrowser::new(paint_state.clone());
        let mut composition = manifest("hero");
        composition.duration_frames = 2;
        let writes = Arc::new(AtomicUsize::new(0));
        let encoder = RecordingEncoder::with_writes(writes.clone());
        let aborted = encoder.aborted.clone();
        let finished = encoder.finished.clone();
        let mut telemetry =
            crate::telemetry::RenderTelemetry::new(crate::telemetry::RenderModeLabel::ReferenceGpu);
        let path = std::env::temp_dir().join(format!(
            "velocast-frame-loop-events-{}.jsonl",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut event_sink = RendererEventSink::jsonl(&path).await.unwrap();

        render_frames_with_encoder(
            &composition,
            paint_state,
            &browser,
            encoder,
            false,
            &mut telemetry,
            Some(&mut event_sink),
        )
        .await
        .unwrap();
        event_sink.flush().await.unwrap();

        let text = fs::read_to_string(&path).unwrap();
        let events = text
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            events
                .iter()
                .map(|event| (
                    event["event"].as_str().unwrap(),
                    event["frame"].as_u64().unwrap(),
                    event["frames_encoded"].as_u64(),
                ))
                .collect::<Vec<_>>(),
            vec![
                ("frame_rendered", 0, None),
                ("frame_encoded", 0, Some(1)),
                ("frame_rendered", 1, None),
                ("frame_encoded", 1, Some(2)),
            ]
        );
        assert_eq!(browser.frames(), vec![0, 1]);
        assert_eq!(writes.load(Ordering::SeqCst), 2);
        assert_eq!(telemetry.frames_rendered, 2);
        assert_eq!(telemetry.frames_encoded, 2);
        assert!(finished.load(Ordering::SeqCst));
        assert!(!aborted.load(Ordering::SeqCst));
        fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn render_loop_records_stale_paint_rejections() {
        let paint_state = PaintState::default();
        let browser = StaleThenCurrentPaintBrowser::new(paint_state.clone());
        let composition = manifest("hero");
        let writes = Arc::new(AtomicUsize::new(0));
        let encoder = RecordingEncoder::with_writes(writes.clone());
        let mut telemetry =
            crate::telemetry::RenderTelemetry::new(crate::telemetry::RenderModeLabel::ReferenceGpu);

        render_frame_range_with_encoder(
            &composition,
            FrameRange::new(4, 5),
            paint_state,
            &browser,
            encoder,
            false,
            &mut telemetry,
        )
        .await
        .unwrap();

        assert_eq!(browser.frames(), vec![4]);
        assert_eq!(writes.load(Ordering::SeqCst), 1);
        assert_eq!(telemetry.stale_frames, 1);
        assert_eq!(telemetry.dropped_frames, 0);
        assert_eq!(telemetry.capture_generation_paints_observed, 4);
        assert_eq!(telemetry.capture_generation_settle_paints_discarded, 2);
    }

    #[tokio::test]
    async fn render_loop_records_dropped_dimension_mismatch_paints() {
        let paint_state = PaintState::default();
        let browser = MismatchedThenCurrentPaintBrowser::new(paint_state.clone());
        let composition = manifest("hero");
        let writes = Arc::new(AtomicUsize::new(0));
        let encoder = RecordingEncoder::with_writes(writes.clone());
        let mut telemetry =
            crate::telemetry::RenderTelemetry::new(crate::telemetry::RenderModeLabel::ReferenceGpu);

        render_frame_range_with_encoder(
            &composition,
            FrameRange::new(4, 5),
            paint_state,
            &browser,
            encoder,
            false,
            &mut telemetry,
        )
        .await
        .unwrap();

        assert_eq!(browser.frames(), vec![4]);
        assert_eq!(writes.load(Ordering::SeqCst), 1);
        assert_eq!(telemetry.stale_frames, 0);
        assert_eq!(telemetry.dropped_frames, 1);
    }

    #[tokio::test]
    async fn render_loop_records_encoder_stage_stats() {
        use crate::encoder::FrameEncodeStats;

        let paint_state = PaintState::default();
        let browser = FakeBrowser::new(paint_state.clone());
        let composition = manifest("hero");
        let writes = Arc::new(AtomicUsize::new(0));
        let encoder = StatsEncoder {
            stats: FrameEncodeStats {
                gpu_import_ms: 3,
                gpu_conversion_ms: 7,
                gpu_sync_wait_ms: 5,
                packet_write_ms: 11,
            },
            writes: writes.clone(),
        };
        let mut telemetry =
            crate::telemetry::RenderTelemetry::new(crate::telemetry::RenderModeLabel::ReferenceGpu);

        render_frame_range_with_encoder(
            &composition,
            FrameRange::new(4, 6),
            paint_state,
            &browser,
            encoder,
            false,
            &mut telemetry,
        )
        .await
        .unwrap();

        assert_eq!(writes.load(Ordering::SeqCst), 2);
        assert_eq!(telemetry.gpu_import_ms, 6);
        assert_eq!(telemetry.gpu_conversion_ms, 14);
        assert_eq!(telemetry.gpu_sync_wait_ms, 10);
        assert_eq!(telemetry.packet_write_ms, 22);
    }
}
