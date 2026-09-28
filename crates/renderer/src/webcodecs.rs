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
pub(crate) fn container(job: &RenderJob) -> anyhow::Result<&'static str> {
    let extension = Path::new(&job.output)
        .extension()
        .and_then(|value| value.to_str())
        .context("encoder.container_unsupported: output must use .mp4, .mov, .webm, or .mkv")?;
    let container = match extension.to_ascii_lowercase().as_str() {
        "mp4" => "mp4",
        "mov" => "mov",
        "webm" => "webm",
        "mkv" => "mkv",
        _ => anyhow::bail!(
            "encoder.container_unsupported: output must use .mp4, .mov, .webm, or .mkv"
        ),
    };
    ensure!(
        job.container
            .as_deref()
            .is_none_or(|explicit| explicit == container),
        "encoder.container_mismatch: requested container must match output extension"
    );
    Ok(container)
}
pub(crate) fn audio_codec(job: &RenderJob) -> anyhow::Result<&'static str> {
    let codec = match job.audio_codec.as_deref().unwrap_or("auto") {
        "auto" if matches!(container(job)?, "webm" | "mkv") => "opus",
        "auto" => "aac",
        "aac" => "aac",
        "opus" => "opus",
        "mp3" => "mp3",
        "flac" => "flac",
        "vorbis" => "vorbis",
        "pcm-s16" => "pcm-s16",
        "pcm-s24" => "pcm-s24",
        "pcm-f32" => "pcm-f32",
        _ => anyhow::bail!("audio.codec_unsupported: use auto, aac, opus, mp3, flac, vorbis, pcm-s16, pcm-s24, or pcm-f32"),
    };
    ensure!(
        container(job)? != "webm" || matches!(codec, "opus" | "vorbis"),
        "audio.container_codec_unsupported: WebM supports opus or vorbis"
    );
    Ok(codec)
}
pub(crate) fn validate_job(job: &RenderJob) -> anyhow::Result<()> {
    ensure!(job.acceleration!=RendererAcceleration::Required,"encoder.hardware_guarantee_unsupported: WebCodecs exposes acceleration preferences; use auto or off");
    ensure!(
        job.capture_probe.is_none(),
        "capture.probe_retired: use WebCodecs render validation"
    );
    let codec = codec(job)?;
    let container = container(job)?;
    audio_codec(job)?;
    ensure!(
        container != "webm" || matches!(codec, "vp8" | "vp9" | "av1"),
        "encoder.container_codec_unsupported: WebM supports vp8, vp9, or av1"
    );
    ensure!(
        job.media_backend
            .as_deref()
            .is_none_or(|backend| matches!(backend, "auto" | "webcodecs" | "native")),
        "encoder.backend_unsupported: use auto, webcodecs, or native"
    );
    ensure!(
        job.video_profile.as_deref().is_none_or(|profile| {
            profile == "auto" || (codec == "prores" && matches!(profile, "standard" | "hq"))
        }),
        "encoder.profile_unsupported: prores supports standard or hq; other codecs use auto"
    );
    ensure!(
        job.pixel_format
            .as_deref()
            .is_none_or(|format| if codec == "prores" { format == "yuv422p10le" } else { matches!(format, "nv12" | "yuv420p") }),
        "encoder.pixel_format_unsupported: prores requires yuv422p10le; other codecs require 8-bit 4:2:0"
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
    let container = container(job)?;
    let audio_codec = audio_codec(job)?;
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
    let opened = browser.host_request(json!({
        "method": "webcodecs-open",
        "settings": {
            "width": composition.width,
            "height": composition.height,
            "fps": composition.fps,
            "bitrate": bitrate,
            "codec": codec,
            "container": container,
            "audioCodec": audio_codec,
            "mediaBackend": job.media_backend.as_deref().unwrap_or("auto"),
            "videoProfile": job.video_profile,
            "hardwareAcceleration": hardware,
            "pixelFormat": job.pixel_format,
            "outputPath": std::path::absolute(output)?,
        },
        "audio": audio,
    }))?;
    let backend = opened["config"]["backend"]
        .as_str()
        .context("encoder.invalid_open_backend")?;
    ensure!(
        matches!(backend, "webcodecs" | "native"),
        "encoder.invalid_open_backend"
    );
    report.mode = if backend == "native" {
        crate::telemetry::RenderModeLabel::ReferenceNative
    } else {
        crate::telemetry::RenderModeLabel::ReferenceWebCodecs
    };
    ensure!(
        job.media_backend
            .as_deref()
            .is_none_or(|requested| requested == "auto" || requested == backend),
        "encoder.backend_mismatch: requested {}, received {backend}",
        job.media_backend.as_deref().unwrap_or("auto")
    );
    ensure!(
        opened["config"]["logicalCodec"].as_str() == Some(codec),
        "encoder.codec_mismatch: requested {codec}, received {}",
        opened["config"]["logicalCodec"]
    );
    let pixel_format = opened["config"]["pixelFormat"]
        .as_str()
        .context("encoder.invalid_open_pixel_format")?;
    ensure!(
        pixel_format
            == if codec == "prores" {
                "yuv422p10le"
            } else {
                "yuv420p"
            },
        "encoder.pixel_format_mismatch: received {pixel_format}"
    );
    report.capture_backend = Some(
        if browser.surface_mode() == crate::browser_surface::BrowserSurfaceMode::Bitmap {
            "electron_bitmap"
        } else {
            "electron_shared_texture"
        }
        .into(),
    );
    report.conversion_backend = Some(
        if backend == "webcodecs" {
            "chromium_webcodecs"
        } else {
            "mediabunny_native"
        }
        .into(),
    );
    report.encoder_backend = Some(format!("electron_{backend}_{codec}"));
    report.surface_format_encoder = Some(pixel_format.into());
    report.requested_codec = Some(codec.into());
    report.selected_codec = Some(codec.into());
    report.target_bitrate_bps = Some(bitrate);
    report.webcodecs = (backend == "webcodecs").then_some(WebCodecsTelemetry {
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
        let previous_encoded = report.frames_encoded;
        report.frames_encoded = if backend == "native" {
            let encoded = captured["encodedFrames"]
                .as_u64()
                .context("media.missing_encoded_count")?;
            ensure!(
                encoded >= u64::from(previous_encoded)
                    && encoded <= u64::from(report.frames_rendered),
                "media.invalid_encoded_count"
            );
            encoded as u32
        } else {
            previous_encoded + 1
        };
        events
            .emit(RendererEvent::FrameRendered {
                frame,
                capture_backend: report.capture_backend.clone(),
                surface_format_in: report.surface_format_in.clone(),
            })
            .await?;
        if report.frames_encoded > previous_encoded {
            events
                .emit(RendererEvent::FrameEncoded {
                    frame,
                    frames_encoded: report.frames_encoded,
                })
                .await?;
        }
    }
    let now = Instant::now();
    let finished = browser.host_request(json!({"method":"webcodecs-finish"}))?;
    report.mux_or_remux_ms += now.elapsed().as_millis();
    crate::output_media::validate_video(&finished, composition, end - start)?;
    crate::output_media::validate_codec(&finished, codec)?;
    crate::output_media::validate_container(&finished, container)?;
    // Packet production can lag native frame submission until finalization.
    if report.frames_encoded < end - start {
        report.frames_encoded = end - start;
        events
            .emit(RendererEvent::FrameEncoded {
                frame: end - 1,
                frames_encoded: report.frames_encoded,
            })
            .await?;
    }
    if let Some(facts) = report.webcodecs.as_mut() {
        facts.color_space = finished
            .get("colorSpace")
            .cloned()
            .or_else(|| finished["video"].get("colorSpace").cloned());
    }
    if let Some(audio) = audio {
        record_audio(audio, &finished, report, Some(audio_codec))?;
    }
    resources.check_cancellation()?;
    Ok(())
}
pub(crate) fn record_audio(
    audio: &Value,
    metadata: &Value,
    report: &mut RenderTelemetry,
    requested_codec: Option<&str>,
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
        requested_codec.is_none_or(|requested| requested == "auto" || requested == encoded_codec),
        "audio.codec_mismatch: requested {}, received {encoded_codec}",
        requested_codec.unwrap_or("auto")
    );
    ensure!(
        matches!(
            encoded_codec,
            "aac" | "opus" | "mp3" | "flac" | "vorbis" | "pcm-s16" | "pcm-s24" | "pcm-f32"
        ) && sound["channels"].as_u64() == Some(2)
            && encoded_rate > 0
            && (encoded_codec != "opus" || encoded_rate == 48000),
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
        for codec in ["h264", "hevc", "av1", "vp8", "vp9", "prores"] {
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
        record_audio(&audio, &metadata, &mut report, Some("opus")).unwrap();
        let sound = report.audio.unwrap();
        assert_eq!(sound.sample_rate, 44100);
        assert_eq!(sound.duration_samples, 44100);
        assert_eq!(sound.encoded_sample_rate, Some(48000));
        assert!(sound.codec_fallback_used);
        metadata["audio"]["duration"] = json!(0.5);
        let mut report =
            RenderTelemetry::new(crate::telemetry::RenderModeLabel::ReferenceWebCodecs);
        assert!(record_audio(&audio, &metadata, &mut report, Some("opus")).is_err());
    }
    #[test]
    fn containers_profiles_and_backend_requests_are_checked() {
        let mut j = job();
        for (container, codec) in [
            ("mp4", "h264"),
            ("mov", "prores"),
            ("webm", "vp9"),
            ("mkv", "vp8"),
        ] {
            j.output = format!("movie.{container}");
            j.container = Some(container.into());
            j.codec = codec.into();
            j.video_profile = (codec == "prores").then(|| "hq".into());
            j.pixel_format = (codec == "prores").then(|| "yuv422p10le".into());
            validate_job(&j).unwrap();
        }
        j.output = "movie.webm".into();
        j.codec = "h264".into();
        j.video_profile = None;
        j.pixel_format = None;
        assert!(validate_job(&j).is_err());
        j.codec = "vp9".into();
        j.container = Some("mp4".into());
        assert!(validate_job(&j).is_err());
        j.container = Some("webm".into());
        j.audio_codec = Some("aac".into());
        assert!(validate_job(&j).is_err());
        j.audio_codec = Some("vorbis".into());
        j.media_backend = Some("bogus".into());
        assert!(validate_job(&j).is_err());
    }
    #[test]
    fn explicit_audio_codec_must_match_metadata() {
        let audio = json!({"plan":{"sampleRate":44100,"durationSamples":44100}});
        let metadata = json!({"audio":{"codec":"flac","sampleRate":44100,"channels":2,"duration":1.0,"pcmSha256":"a".repeat(64)}});
        let mut report =
            RenderTelemetry::new(crate::telemetry::RenderModeLabel::ReferenceWebCodecs);
        record_audio(&audio, &metadata, &mut report, Some("flac")).unwrap();
        assert!(record_audio(&audio, &metadata, &mut report, Some("aac")).is_err());
    }
}
