//! Opt-in native encoder hosted beside Electron capture. Pixel handles never
//! leave Electron; this coordinator sends generation-bound lease tokens only.
use anyhow::{ensure, Context};
use serde_json::{json, Value};
use velocast_protocol::{
    CompositionManifest, RenderJob, RenderOperation, RendererAcceleration, RendererAssemblyMode,
    RendererConcurrency,
};

use crate::encoder::FrameEncodeStats;
use crate::errors::RendererError;
use crate::events::RendererEventSink;
use crate::frame_loop::FrameEncoder;
use crate::native_browser::NativeBrowser;
use crate::pipeline::render_plan::RenderPipelinePlan;
use crate::surface::{CapturedFrame, PlatformSurface};
use crate::telemetry::RenderTelemetry;

pub(crate) fn enabled() -> bool {
    std::env::var("VELOCAST_NATIVE_NV12").is_ok_and(|value| value == "1")
}

pub(crate) fn validate_selection(job: &RenderJob) -> anyhow::Result<()> {
    match std::env::var("VELOCAST_NATIVE_NV12") {
        Err(std::env::VarError::NotPresent) => return Ok(()),
        Ok(value) if value.is_empty() || value == "0" => return Ok(()),
        Ok(value) if value == "1" => {}
        _ => anyhow::bail!("native_nv12.invalid_selection: VELOCAST_NATIVE_NV12 must be 0 or 1"),
    }
    ensure!(cfg!(windows), "native_nv12.platform_unsupported: Linux GPU import is not validated; use vulkan-probe for capability diagnostics");
    validate_job(job)?;
    let addon = std::env::var_os("VELOCAST_NATIVE_ENCODER_ADDON").context(
        "native_nv12.addon_missing: set VELOCAST_NATIVE_ENCODER_ADDON to the built .node file",
    )?;
    let addon = std::path::Path::new(&addon);
    ensure!(
        addon.is_absolute() && addon.is_file(),
        "native_nv12.addon_missing: addon must be an existing absolute file"
    );
    Ok(())
}

fn validate_job(job: &RenderJob) -> anyhow::Result<()> {
    ensure!(
        std::path::Path::new(&job.output)
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("mp4")),
        "native_nv12.container_unsupported: the initial native addon writes MP4 output"
    );
    ensure!(job.operation == RenderOperation::Render && job.capture_probe.is_none(),
        "native_nv12.operation_unsupported: the native NV12 route currently supports video rendering only");
    ensure!(job.acceleration == RendererAcceleration::Required,
        "native_nv12.acceleration_required: use --acceleration required; this explicit route never falls back to CPU capture");
    ensure!(
        matches!(job.codec.to_ascii_lowercase().as_str(), "h264"),
        "native_nv12.codec_unsupported: the initial native addon supports logical codec h264"
    );
    ensure!(
        job.pixel_format
            .as_deref()
            .is_none_or(|format| matches!(format, "nv12" | "yuv420p")),
        "native_nv12.pixel_format_unsupported: native capture requires NV12 / 8-bit 4:2:0 output"
    );
    ensure!(
        !matches!(&job.concurrency, Some(RendererConcurrency::Workers(count)) if count.get() != 1)
            && job.assembly_mode != RendererAssemblyMode::Segments,
        "native_nv12.parallel_unsupported: use --concurrency 1 --assembly reference"
    );
    ensure!(!matches!(job.mode, velocast_protocol::RenderMode::CompositionWorker),
        "native_nv12.worker_unsupported: native addon encoding currently requires a reference coordinator");
    Ok(())
}

pub(crate) async fn render(
    job: &RenderJob,
    composition: &CompositionManifest,
    plan: &RenderPipelinePlan,
    browser: &NativeBrowser,
    telemetry: &mut RenderTelemetry,
    events: Option<&mut RendererEventSink>,
) -> anyhow::Result<()> {
    validate_job(job)?;
    let start = job
        .output_range
        .as_ref()
        .map_or(0, |range| range.start_frame);
    let end = job
        .output_range
        .as_ref()
        .map_or(composition.duration_frames, |range| range.end_frame);
    let expected = end
        .checked_sub(start)
        .filter(|count| *count > 0)
        .context("native_nv12.invalid_range")?;
    let settings = &plan.backend.encoder_plan.settings;
    let response = browser.native_encoder_request(json!({
        "method":"beginNativeEncode", "config": {
            "width":composition.width, "height":composition.height, "fps":composition.fps,
            "codec":"h264", "output":plan.output.temp_output,
            "bitrateBps":settings.d3d11_target_bitrate_bps(), "expectedFrames":expected
        }
    }))?;
    let mut encoder = HostEncoder {
        browser,
        expected,
        next_pts: 0,
        finished: false,
    };
    let report = &response["report"];
    validate_report(report, None)?;
    telemetry.encoder_backend = Some(
        report["encoder"]
            .as_str()
            .context("native_nv12.invalid_encoder_report")?
            .to_owned(),
    );
    telemetry.conversion_backend = Some("d3d11_nv12_copy".to_owned());
    telemetry.surface_format_encoder = Some("nv12".to_owned());
    telemetry.requested_codec = Some("h264".to_owned());
    telemetry.selected_codec = Some("h264".to_owned());
    telemetry.target_bitrate_bps = report["bitrateBps"].as_u64();
    // Drop aborts if metadata validation failed after the host opened a file.
    encoder.expected = expected;
    crate::frame_loop::render_scheduled_frames_with_encoder(
        composition,
        start..end,
        browser.paint_state(),
        browser,
        encoder,
        false,
        telemetry,
        events,
    )
    .await?;
    crate::frame_loop::validate_required_reference_output(
        &plan.output.temp_output,
        job,
        composition,
        Some("nv12"),
    )
    .await?;
    if job.output_range.is_some() {
        crate::output_media::validate_rebased_video(&plan.output.temp_output).await?;
    }
    Ok(())
}

fn validate_report(report: &Value, expected: Option<u32>) -> anyhow::Result<()> {
    ensure!(
        matches!(
            report["encoder"].as_str(),
            Some("h264_qsv" | "h264_nvenc" | "h264_amf")
        ),
        "native_nv12.invalid_encoder_report: host did not open a supported hardware H.264 encoder"
    );
    ensure!(report["cpuReadbackFrames"].as_u64() == Some(0),
        "native_nv12.readback_detected: addon must explicitly report zero uncompressed CPU readback");
    if let Some(expected) = expected {
        ensure!(
            report["submittedFrames"].as_u64() == Some(u64::from(expected))
                && report["gpuCopies"].as_u64() == Some(u64::from(expected)),
            "native_nv12.frame_count_mismatch: addon did not consume the complete schedule"
        );
    }
    Ok(())
}

struct HostEncoder<'a> {
    browser: &'a NativeBrowser,
    expected: u32,
    next_pts: u32,
    finished: bool,
}

impl FrameEncoder for HostEncoder<'_> {
    async fn write_frame(
        &mut self,
        frame: u32,
        captured: CapturedFrame,
    ) -> anyhow::Result<FrameEncodeStats> {
        let CapturedFrame::GpuSurface(surface) = captured else {
            anyhow::bail!("native_nv12.unexpected_software_frame");
        };
        let PlatformSurface::ElectronNativeNv12 {
            texture_id,
            generation,
        } = surface.platform_surface
        else {
            anyhow::bail!("native_nv12.unexpected_surface");
        };
        ensure!(self.next_pts < self.expected, "native_nv12.too_many_frames");
        let response = self.browser.native_encoder_request(json!({
            "method":"encodeNativeFrame", "textureId":texture_id,
            "generation":generation, "frame":frame, "pts":self.next_pts,
        }))?;
        self.next_pts += 1;
        let stats = &response["stats"];
        Ok(FrameEncodeStats {
            gpu_import_ms: milliseconds(&stats["gpuImportMs"]),
            gpu_conversion_ms: 0,
            gpu_sync_wait_ms: milliseconds(&stats["gpuSyncWaitMs"]),
            packet_write_ms: milliseconds(&stats["packetWriteMs"]),
        })
    }

    async fn finish(mut self) -> Result<(), RendererError> {
        let result = (|| {
            ensure!(
                self.next_pts == self.expected,
                "native_nv12.incomplete_schedule"
            );
            let response = self
                .browser
                .native_encoder_request(json!({"method":"finishNativeEncode"}))?;
            validate_report(&response["report"], Some(self.expected))
        })();
        if result.is_ok() {
            self.finished = true;
        }
        result.map_err(|error: anyhow::Error| RendererError::FfmpegInit(error.to_string()))
    }

    async fn abort(mut self) -> Result<(), RendererError> {
        let result = self
            .browser
            .native_encoder_request(json!({"method":"abortNativeEncode"}));
        self.finished = true;
        result
            .map(|_| ())
            .map_err(|error| RendererError::FfmpegInit(error.to_string()))
    }
}

impl Drop for HostEncoder<'_> {
    fn drop(&mut self) {
        if !self.finished {
            let _ = self
                .browser
                .native_encoder_request(json!({"method":"abortNativeEncode"}));
        }
    }
}

fn milliseconds(value: &Value) -> u128 {
    value
        .as_f64()
        .filter(|v| v.is_finite() && *v >= 0.0)
        .map(|v| v.ceil() as u128)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn job() -> RenderJob {
        serde_json::from_value(json!({"mode":"composition","serve_url":"http://127.0.0.1:1234", "output":"out.mp4", "codec":"h264", "acceleration":"required"})).unwrap()
    }
    #[test]
    fn rejects_unsupported_requests_before_opening_addon() {
        let mut request = job();
        validate_job(&request).unwrap();
        request.acceleration = RendererAcceleration::Off;
        assert!(validate_job(&request)
            .unwrap_err()
            .to_string()
            .contains("acceleration_required"));
        request.acceleration = RendererAcceleration::Required;
        request.codec = "hevc".into();
        assert!(validate_job(&request)
            .unwrap_err()
            .to_string()
            .contains("codec_unsupported"));
        request.codec = "h264".into();
        request.pixel_format = Some("yuv444p".into());
        assert!(validate_job(&request)
            .unwrap_err()
            .to_string()
            .contains("pixel_format_unsupported"));
    }
    #[test]
    fn report_must_prove_complete_hardware_submission() {
        let mut report =
            json!({"encoder":"h264_qsv","cpuReadbackFrames":0,"submittedFrames":3,"gpuCopies":3});
        validate_report(&report, Some(3)).unwrap();
        assert!(validate_report(&report, Some(4)).is_err());
        report["cpuReadbackFrames"] = json!(1);
        assert!(validate_report(&report, Some(3)).is_err());
        report["cpuReadbackFrames"] = json!(0);
        report["encoder"] = json!("libx264");
        assert!(validate_report(&report, Some(3)).is_err());
    }

    #[test]
    fn addon_fractional_timings_are_not_discarded() {
        assert_eq!(milliseconds(&json!(0.6)), 1);
        assert_eq!(milliseconds(&json!(12.2)), 13);
        assert_eq!(milliseconds(&Value::Null), 0);
        assert_eq!(milliseconds(&json!(-3)), 0);
    }
}
