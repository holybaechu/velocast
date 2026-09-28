//! Browser-owned encoding and muxing; Rust retains scheduling and publication.
use crate::browser_protocol::BrowserDriver;
use crate::events::{RendererEvent, RendererEventSink};
use crate::native_browser::NativeBrowser;
use crate::render_job::RenderJobResources;
use crate::telemetry::{AudioTelemetry, RenderTelemetry, WebCodecsTelemetry};
use anyhow::{ensure, Context};
use serde_json::{json, Value};
use std::path::Path;
use std::time::Instant;
use velocast_protocol::{CompositionManifest, RenderJob, RendererAcceleration};

pub(crate) fn codec(job: &RenderJob) -> anyhow::Result<&'static str> {
    Ok(velocast_renderer_policy::codec::RequestedVideoCodec::parse(&job.codec)?.canonical_label())
}
pub(crate) fn validate_job(job: &RenderJob) -> anyhow::Result<()> {
    ensure!(job.acceleration!=RendererAcceleration::Required,"encoder.hardware_guarantee_unsupported: WebCodecs exposes acceleration preferences; use auto or off");
    ensure!(
        job.capture_probe.is_none(),
        "capture.probe_retired: use WebCodecs render validation"
    );
    codec(job)?;
    ensure!(
        job.pixel_format
            .as_deref()
            .is_none_or(|format| matches!(format, "nv12" | "yuv420p")),
        "encoder.pixel_format_unsupported: current WebCodecs output supports 8-bit 4:2:0"
    );
    ensure!(
        Path::new(&job.output)
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("mp4")),
        "encoder.container_unsupported: use MP4 output"
    );
    Ok(())
}
pub(crate) fn validate_geometry(composition: &CompositionManifest) -> anyhow::Result<()> {
    ensure!(composition.width > 0 && composition.height > 0 && composition.width <= 4096 && composition.height <= 4096
        && composition.width % 2 == 0 && composition.height % 2 == 0 && (1..=120).contains(&composition.fps),
        "encoder.geometry_unsupported: current media runtime requires even dimensions up to 4096 and 1–120 fps");
    Ok(())
}
pub(crate) async fn render(
    job: &RenderJob,
    composition: &CompositionManifest,
    browser: &NativeBrowser,
    output: &Path,
    audio: Option<&Value>,
    resources: &mut RenderJobResources,
    report: &mut RenderTelemetry,
    events: &mut RendererEventSink,
) -> anyhow::Result<()> {
    validate_job(job)?;
    validate_geometry(composition)?;
    let codec = codec(job)?;
    let bitrate = job.bitrate_bps.unwrap_or(8_000_000);
    let hardware = if job.acceleration == RendererAcceleration::Off {
        "prefer-software"
    } else {
        "prefer-hardware"
    };
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
        "output.invalid_range"
    );
    report.frames_expected = end - start;
    let opened=browser.host_request(json!({"method":"webcodecs-open","settings":{"width":composition.width,"height":composition.height,"fps":composition.fps,"bitrate":bitrate,"codec":codec,"hardwareAcceleration":hardware,"pixelFormat":job.pixel_format,"outputPath":std::path::absolute(output)?},"audio":audio}))?;
    report.capture_backend = Some("electron_shared_texture".into());
    report.conversion_backend = Some("chromium_webcodecs".into());
    report.encoder_backend = Some(format!("electron_webcodecs_{codec}"));
    report.surface_format_encoder = Some("yuv420p".into());
    report.requested_codec = Some(codec.into());
    report.selected_codec = Some(codec.into());
    report.target_bitrate_bps = Some(bitrate);
    report.webcodecs = Some(WebCodecsTelemetry {
        codec: opened["config"]["codec"].as_str().unwrap_or(codec).into(),
        hardware_acceleration: opened["config"]["hardwareAcceleration"]
            .as_str()
            .unwrap_or(hardware)
            .into(),
        hardware_encoder_verified: false,
        uncompressed_readback_verified: false,
        color_space: None,
    });
    let mut context = crate::frame_loop::render_context(composition);
    context.render_session = browser.render_session();
    for (index, frame) in (start..end).enumerate() {
        resources.check_cancellation()?;
        resources.check_workers().await?;
        let now = Instant::now();
        browser.render_frame(
            &crate::frame_loop::seek_frame_script(frame, &context)?,
            frame,
        )?;
        report.browser_script_wait_ms += now.elapsed().as_millis();
        let captured = browser.host_request(json!({"method":"webcodecs-frame","index":index}))?;
        ensure!(
            captured["index"].as_u64() == Some(index as u64)
                && captured["frames"].as_u64() == Some(index as u64 + 1)
                && captured["width"].as_u64() == Some(composition.width as u64)
                && captured["height"].as_u64() == Some(composition.height as u64),
            "webcodecs.invalid_frame_response"
        );
        report.frame_render_wait_ms += now.elapsed().as_millis();
        report.surface_format_in = Some(
            captured["pixelFormat"]
                .as_str()
                .context("webcodecs.invalid_surface_format")?
                .into(),
        );
        report.capture_backend = Some(
            captured["captureBackend"]
                .as_str()
                .unwrap_or("electron_shared_texture")
                .into(),
        );
        if captured["cpuReadback"].as_bool() == Some(true) {
            report.cpu_readback_frames += 1;
        }
        report.frames_rendered += 1;
        report.frames_encoded += 1;
        events
            .emit(RendererEvent::FrameRendered {
                frame,
                capture_backend: report.capture_backend.clone(),
                surface_format_in: report.surface_format_in.clone(),
            })
            .await?;
        events
            .emit(RendererEvent::FrameEncoded {
                frame,
                frames_encoded: report.frames_encoded,
            })
            .await?;
    }
    let now = Instant::now();
    let finished = browser.host_request(json!({"method":"webcodecs-finish"}))?;
    report.mux_or_remux_ms += now.elapsed().as_millis();
    crate::output_media::validate_video(&finished, composition, end - start)?;
    crate::output_media::validate_codec(&finished, codec)?;
    if let Some(facts) = report.webcodecs.as_mut() {
        facts.color_space = finished
            .get("colorSpace")
            .cloned()
            .or_else(|| finished["video"].get("colorSpace").cloned());
    }
    if let Some(audio) = audio {
        record_audio(audio, &finished, report)?;
    }
    resources.check_cancellation()?;
    Ok(())
}
pub(crate) fn record_audio(
    audio: &Value,
    metadata: &Value,
    report: &mut RenderTelemetry,
) -> anyhow::Result<()> {
    let sound = &metadata["audio"];
    let plan = &audio["plan"];
    let rate = plan["sampleRate"]
        .as_u64()
        .context("audio.invalid_sample_rate")?;
    let samples = plan["durationSamples"]
        .as_u64()
        .context("audio.invalid_sample_count")?;
    let encoded_rate = sound["sampleRate"]
        .as_u64()
        .context("audio.invalid_output_sample_rate")?;
    let encoded_codec = sound["codec"]
        .as_str()
        .context("audio.invalid_output_codec")?;
    ensure!(
        sound["channels"].as_u64() == Some(2)
            && match encoded_codec {
                "aac" => encoded_rate == rate,
                "opus" => encoded_rate == 48000,
                _ => false,
            },
        "audio.invalid_output_format"
    );
    ensure!(
        sound["duration"]
            .as_f64()
            .is_some_and(|duration| (duration - samples as f64 / rate as f64).abs()
                <= 2048.0 / encoded_rate as f64),
        "audio.invalid_output_duration: expected {:.9}s from {samples} samples at {rate}Hz; received {}s ({encoded_codec}, {encoded_rate}Hz)",
        samples as f64 / rate as f64,
        sound["duration"]
    );
    report.audio = Some(AudioTelemetry {
        sample_rate: rate,
        duration_samples: samples,
        codec: Some(encoded_codec.into()),
        encoded_sample_rate: Some(encoded_rate),
        codec_fallback_used: sound["fallbackUsed"].as_bool().unwrap_or(false),
        pcm_sha256: sound["pcmSha256"]
            .as_str()
            .filter(|hash| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .context("audio.invalid_pcm_digest")?
            .into(),
        mix_ms: metadata["audioMixMs"].as_u64().unwrap_or(0) as u128,
        mux_ms: report.mux_or_remux_ms,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn job() -> RenderJob {
        serde_json::from_value(json!({"mode":"composition","serve_url":"http://localhost","output":"movie.mp4","codec":"h264"})).unwrap()
    }
    #[test]
    fn strict_hardware_cannot_be_promised() {
        let mut j = job();
        j.acceleration = RendererAcceleration::Required;
        assert!(validate_job(&j)
            .unwrap_err()
            .to_string()
            .starts_with("encoder.hardware_guarantee_unsupported"));
        j.acceleration = RendererAcceleration::Off;
        validate_job(&j).unwrap();
    }
    #[test]
    fn codec_names_are_runtime_independent() {
        let mut j = job();
        for codec in ["h264", "hevc", "av1"] {
            j.codec = codec.into();
            validate_job(&j).unwrap();
        }
        j.codec = "vendor_encoder".into();
        assert!(validate_job(&j).is_err());
    }
    #[test]
    fn opus_output_preserves_authored_audio_clock() {
        let audio = json!({"plan":{"sampleRate":44100,"durationSamples":44100}});
        let mut metadata = json!({"audio":{"codec":"opus","sampleRate":48000,
            "channels":2,"duration":1.0,"fallbackUsed":true,"pcmSha256":"a".repeat(64)}});
        let mut report =
            RenderTelemetry::new(crate::telemetry::RenderModeLabel::ReferenceWebCodecs);
        record_audio(&audio, &metadata, &mut report).unwrap();
        let sound = report.audio.unwrap();
        assert_eq!(sound.sample_rate, 44100);
        assert_eq!(sound.duration_samples, 44100);
        assert_eq!(sound.encoded_sample_rate, Some(48000));
        assert!(sound.codec_fallback_used);
        metadata["audio"]["duration"] = json!(0.5);
        let mut report =
            RenderTelemetry::new(crate::telemetry::RenderModeLabel::ReferenceWebCodecs);
        assert!(record_audio(&audio, &metadata, &mut report).is_err());
    }
}
