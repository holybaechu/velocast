//! Opt-in Electron-owned capture/encode experiment. Native retains scheduling,
//! audio, cancellation, validation, and transactional output publication.
use std::path::Path;
use std::time::Instant;

use anyhow::{ensure, Context};
use serde_json::json;
use velocast_protocol::{
    CompositionManifest, RenderJob, RenderMode, RenderOperation, RendererAcceleration,
    RendererAssemblyMode, RendererConcurrency,
};

use crate::browser_protocol::BrowserDriver;
use crate::events::{RendererEvent, RendererEventSink};
use crate::native_browser::NativeBrowser;
use crate::render_job::{RenderJobResources, WorkerCommand};
use crate::telemetry::{RenderTelemetry, WebCodecsTelemetry};

pub(crate) fn requested(job: &RenderJob) -> anyhow::Result<bool> {
    let selected = match std::env::var("VELOCAST_EXPERIMENTAL_ENCODER") {
        Ok(value) => parse_selector(&value)?,
        Err(std::env::VarError::NotPresent) => false,
        Err(error) => return Err(error).context("webcodecs.invalid_selector"),
    };
    // Inspection and PNG retain their existing portable paths with the same env.
    if !selected || job.operation != RenderOperation::Render {
        return Ok(false);
    }
    validate_job(job)?;
    Ok(true)
}

fn parse_selector(value: &str) -> anyhow::Result<bool> {
    match value {
        "" => Ok(false),
        "webcodecs" => Ok(true),
        _ => anyhow::bail!(
            "webcodecs.invalid_selector: VELOCAST_EXPERIMENTAL_ENCODER must be webcodecs or unset"
        ),
    }
}

fn validate_job(job: &RenderJob) -> anyhow::Result<()> {
    ensure!(job.acceleration == RendererAcceleration::Auto,
        "webcodecs.acceleration_unsupported: use --acceleration auto; WebCodecs cannot guarantee required hardware, and shared textures require GPU capture");
    ensure!(
        job.mode != RenderMode::CompositionWorker
            && job.capture_probe.is_none()
            && !matches!(&job.concurrency, Some(RendererConcurrency::Workers(count)) if count.get() != 1)
            && job.assembly_mode != RendererAssemblyMode::Segments,
        "webcodecs.parallel_unsupported: use --concurrency 1 --assembly reference"
    );
    ensure!(
        job.codec == "h264",
        "webcodecs.codec_unsupported: this experiment requires --codec h264"
    );
    ensure!(
        job.pixel_format
            .as_deref()
            .is_none_or(|format| matches!(format, "nv12" | "yuv420p")),
        "webcodecs.pixel_format_unsupported: only 8-bit 4:2:0 output is supported"
    );
    ensure!(
        Path::new(&job.output)
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("mp4")),
        "webcodecs.container_unsupported: this experiment requires MP4 output"
    );
    Ok(())
}

pub(crate) async fn render(
    job: &RenderJob,
    composition: &CompositionManifest,
    browser: &NativeBrowser,
    output: &Path,
    resources: &mut RenderJobResources,
    telemetry: &mut RenderTelemetry,
    events: &mut RendererEventSink,
) -> anyhow::Result<()> {
    let bitrate = job.bitrate_bps.unwrap_or(8_000_000);
    let opened = browser.webcodecs_request(json!({"method":"webcodecs-open", "settings": {
        "width":composition.width, "height":composition.height, "fps":composition.fps, "bitrate":bitrate
    }}))?;
    let codec = opened["config"]["codec"]
        .as_str()
        .context("webcodecs.invalid_config_response")?;
    telemetry.mode = crate::telemetry::RenderModeLabel::ExperimentalWebCodecs;
    telemetry.capture_backend = Some("electron_shared_texture_webcodecs".into());
    telemetry.conversion_backend = Some("chromium_webcodecs".into());
    telemetry.encoder_backend = Some("electron_webcodecs_h264".into());
    telemetry.surface_format_encoder = Some("yuv420p".into());
    telemetry.requested_codec = Some("h264".into());
    telemetry.selected_codec = Some("h264".into());
    telemetry.target_bitrate_bps = Some(bitrate);
    telemetry.webcodecs = Some(WebCodecsTelemetry {
        codec: codec.to_owned(),
        hardware_acceleration: "prefer-hardware".into(),
        hardware_encoder_verified: false,
        uncompressed_readback_verified: false,
        color_space: None,
    });
    events
        .emit(RendererEvent::PipelinePlanResolved {
            route: "experimental_webcodecs".into(),
            effective_concurrency: 1,
            probe_tier: "webcodecs_config".into(),
            segment_count: 0,
            capture_mode: "electron_shared_texture".into(),
            conversion_mode: "chromium_webcodecs".into(),
            encoder_mode: "webcodecs".into(),
            planned_encoder_backend: "electron_webcodecs_h264".into(),
            encoder_backend: "electron_webcodecs_h264".into(),
        })
        .await?;
    let start = job
        .output_range
        .as_ref()
        .map_or(0, |range| range.start_frame);
    let end = job
        .output_range
        .as_ref()
        .map_or(composition.duration_frames, |range| range.end_frame);
    ensure!(
        start < end && end <= composition.duration_frames,
        "webcodecs.invalid_range"
    );
    telemetry.frames_expected = end - start;
    let mut context = crate::frame_loop::render_context(composition);
    context.render_session = browser.render_session();
    for (index, frame) in (start..end).enumerate() {
        resources.check_cancellation()?;
        let started = Instant::now();
        browser.render_frame(
            &crate::frame_loop::seek_frame_script(frame, &context)?,
            frame,
        )?;
        telemetry.browser_script_wait_ms += started.elapsed().as_millis();
        let captured =
            browser.webcodecs_request(json!({"method":"webcodecs-frame", "index":index}))?;
        ensure!(
            captured["index"].as_u64() == Some(index as u64)
                && captured["frames"].as_u64() == Some(index as u64 + 1)
                && captured["width"].as_u64() == Some(u64::from(composition.width))
                && captured["height"].as_u64() == Some(u64::from(composition.height)),
            "webcodecs.invalid_frame_response"
        );
        telemetry.frame_render_wait_ms += started.elapsed().as_millis();
        telemetry.surface_format_in = Some(
            captured["pixelFormat"]
                .as_str()
                .filter(|format| matches!(*format, "bgra" | "rgba"))
                .context("webcodecs.invalid_surface_format")?
                .into(),
        );
        telemetry.frames_rendered += 1;
        telemetry.frames_encoded += 1;
        events
            .emit(RendererEvent::FrameRendered {
                frame,
                capture_backend: telemetry.capture_backend.clone(),
                surface_format_in: telemetry.surface_format_in.clone(),
            })
            .await?;
        events
            .emit(RendererEvent::FrameEncoded {
                frame,
                frames_encoded: telemetry.frames_encoded,
            })
            .await?;
    }
    let finished = browser.webcodecs_request(json!({"method":"webcodecs-finish"}))?;
    let color_filter = h264_color_metadata(&finished["colorSpace"])?;
    telemetry
        .webcodecs
        .as_mut()
        .expect("opened WebCodecs session")
        .color_space = Some(finished["colorSpace"].clone());
    telemetry.surface_format_encoder = Some(
        if finished["colorSpace"]["fullRange"] == true {
            "yuvj420p"
        } else {
            "yuv420p"
        }
        .into(),
    );
    ensure!(
        finished["frames"].as_u64() == Some(u64::from(end - start)),
        "webcodecs.frame_count_mismatch"
    );
    let stream = browser.webcodecs_stream()?;
    let metadata = std::fs::symlink_metadata(&stream)?;
    ensure!(
        metadata.is_file()
            && metadata.len() > 0
            && finished["bytes"].as_u64() == Some(metadata.len()),
        "webcodecs.invalid_bitstream"
    );
    let started = Instant::now();
    let mut command = tokio::process::Command::new("ffmpeg");
    command
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-y",
            "-fflags",
            "+genpts",
            "-r",
            &composition.fps.to_string(),
            "-f",
            "h264",
            "-i",
        ])
        .arg(&stream)
        .args([
            "-map",
            "0:v:0",
            "-c:v",
            "copy",
            "-an",
            "-movflags",
            "+faststart",
        ])
        .args(["-bsf:v", &color_filter])
        .arg(output)
        .stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.as_std_mut().creation_flags(0x08000000);
    }
    resources.spawn_workers(vec![WorkerCommand {
        start,
        end,
        capture_stdout: false,
        command,
    }])?;
    resources
        .wait_for_workers()
        .await
        .context("webcodecs.mux_failed")?;
    telemetry.mux_or_remux_ms += started.elapsed().as_millis();
    let probe = crate::segment_muxer::probe_segment(output).await?;
    crate::segment_muxer::validate_final_output(
        &probe,
        &crate::segment_muxer::ExpectedVideoOutput {
            width: composition.width,
            height: composition.height,
            fps: composition.fps,
            frame_count: end - start,
            codec_name: "h264".into(),
            pix_fmts: crate::segment_muxer::expected_stream_pix_fmts(
                job.pixel_format.as_deref().unwrap_or("nv12"),
            ),
        },
    )?;
    crate::output_media::validate_rebased_video(output).await?;
    resources.check_cancellation()?;
    Ok(())
}

fn h264_color_metadata(color: &serde_json::Value) -> anyhow::Result<String> {
    // WebCodecs reports decoder color metadata separately. Hardware Annex B
    // output can omit VUI tags; preserve the reported conversion, not a guess
    // based on resolution or the pre-conversion RGB texture's color space.
    let primaries = match color["primaries"].as_str() {
        Some("bt709") => 1,
        Some("bt470bg") => 5,
        Some("smpte170m") => 6,
        _ => anyhow::bail!("webcodecs.unsupported_color: missing or unsupported SDR primaries"),
    };
    let transfer = match color["transfer"].as_str() {
        Some("bt709") => 1,
        Some("smpte170m") => 6,
        Some("iec61966-2-1") => 13,
        _ => anyhow::bail!("webcodecs.unsupported_color: missing or unsupported SDR transfer"),
    };
    let matrix = match color["matrix"].as_str() {
        Some("bt709") => 1,
        Some("bt470bg") => 5,
        Some("smpte170m") => 6,
        _ => anyhow::bail!("webcodecs.unsupported_color: missing or unsupported YUV matrix"),
    };
    let full = u8::from(
        color["fullRange"]
            .as_bool()
            .context("webcodecs.unsupported_color: missing range")?,
    );
    Ok(format!("h264_metadata=colour_primaries={primaries}:transfer_characteristics={transfer}:matrix_coefficients={matrix}:video_full_range_flag={full}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mux_tags_follow_reported_decoder_color_and_reject_unknown_values() {
        assert_eq!(h264_color_metadata(&json!({"primaries":"bt709", "transfer":"bt709", "matrix":"bt709", "fullRange":false})).unwrap(),
            "h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0");
        assert!(h264_color_metadata(&json!({})).is_err());
        assert!(h264_color_metadata(&json!({"primaries":"bt2020", "transfer":"pq", "matrix":"bt2020-ncl", "fullRange":false})).is_err());
    }

    #[test]
    fn selector_is_explicit() {
        assert!(!parse_selector("").unwrap());
        assert!(parse_selector("webcodecs").unwrap());
        assert!(parse_selector("typo").is_err());
    }

    #[test]
    fn experimental_job_rejects_guarantees_and_routes_it_cannot_satisfy() {
        let mut job: RenderJob = serde_json::from_value(json!({
            "serve_url":"http://localhost:3000", "output":"movie.mp4", "codec":"h264",
            "acceleration":"auto", "mode":"composition"
        }))
        .unwrap();
        validate_job(&job).unwrap();
        job.acceleration = RendererAcceleration::Required;
        assert!(validate_job(&job)
            .unwrap_err()
            .to_string()
            .contains("acceleration_unsupported"));
        job.acceleration = RendererAcceleration::Off;
        assert!(validate_job(&job).is_err());
        job.acceleration = RendererAcceleration::Auto;
        job.assembly_mode = RendererAssemblyMode::Segments;
        assert!(validate_job(&job)
            .unwrap_err()
            .to_string()
            .contains("parallel_unsupported"));
        job.assembly_mode = RendererAssemblyMode::Reference;
        job.pixel_format = Some("yuv444p".into());
        assert!(validate_job(&job)
            .unwrap_err()
            .to_string()
            .contains("pixel_format_unsupported"));
        job.pixel_format = None;
        job.codec = "h264_nvenc".into();
        assert!(validate_job(&job)
            .unwrap_err()
            .to_string()
            .contains("codec_unsupported"));
    }
}
