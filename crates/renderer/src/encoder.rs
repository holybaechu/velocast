use std::path::Path;
use std::process::Stdio;
use std::time::Instant;

use tokio::fs::File;
use tokio::io::{self, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, Command};

use crate::errors::RendererError;
use crate::pipeline::backend_registry::{BackendDiagnosticCode, BackendKind};
use crate::pipeline::encoder_backends::plan_encoder;
use crate::telemetry::BackendDiagnosticTelemetry;
use velocast_renderer_policy::encoder_plan::{
    EncoderCandidatePlan, EncoderOpenFailure, EncoderPlan,
};

#[cfg(test)]
pub use velocast_renderer_policy::settings::EncoderBackendPreference;
pub use velocast_renderer_policy::settings::{EncoderExecutionContext, EncoderSettings};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FrameEncodeStats {
    pub gpu_import_ms: u128,
    pub gpu_conversion_ms: u128,
    pub gpu_sync_wait_ms: u128,
    pub packet_write_ms: u128,
}

pub type FfmpegEncoder = RawBgraFfmpegStdinEncoder;

pub struct RawBgraFfmpegStdinEncoder {
    child: Child,
    stdin: ChildStdin,
}

impl RawBgraFfmpegStdinEncoder {
    pub fn spawn(
        width: u32,
        height: u32,
        fps: u32,
        codec: &str,
        pixel_format: &str,
        bitrate_bps: Option<u64>,
        output: &str,
    ) -> Result<Self, RendererError> {
        let child = spawn_ffmpeg(width, height, fps, codec, pixel_format, bitrate_bps, output)?;
        Self::from_child(child)
    }

    pub async fn write_bgra_frame(&mut self, frame: &[u8]) -> io::Result<()> {
        self.stdin.write_all(frame).await
    }

    pub async fn write_frame(
        &mut self,
        frame: crate::surface::CapturedFrame,
    ) -> io::Result<FrameEncodeStats> {
        let bgra = match frame {
            crate::surface::CapturedFrame::BgraSoftware(frame) => {
                frame.validate().map_err(|error| {
                    io::Error::new(io::ErrorKind::InvalidInput, error.to_string())
                })?;
                frame.pixels
            }
            frame => frame
                .into_bgra()
                .map_err(|error| io::Error::other(error.to_string()))?,
        };
        let write_started_at = Instant::now();
        self.write_bgra_frame(&bgra).await?;
        Ok(FrameEncodeStats {
            packet_write_ms: write_started_at.elapsed().as_millis(),
            ..FrameEncodeStats::default()
        })
    }

    #[allow(dead_code)]
    pub async fn write_bgra_file(&mut self, path: &Path) -> io::Result<u64> {
        let mut file = File::open(path)
            .await
            .map_err(|error| chunk_io_error(path, "open", error))?;
        tokio::io::copy(&mut file, &mut self.stdin)
            .await
            .map_err(|error| chunk_io_error(path, "stream", error))
    }

    pub async fn finish(self) -> Result<(), RendererError> {
        let Self { mut child, stdin } = self;
        drop(stdin);

        let status = child.wait().await.map_err(map_spawn_or_wait_error)?;
        if status.success() {
            return Ok(());
        }

        Err(RendererError::FfmpegExited(status.code().unwrap_or(-1)))
    }

    pub async fn abort(self) -> Result<(), RendererError> {
        let Self { mut child, stdin } = self;
        drop(stdin);

        match child.kill().await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::InvalidInput => Ok(()),
            Err(error) => Err(map_spawn_or_wait_error(error)),
        }
    }

    fn from_child(mut child: Child) -> Result<Self, RendererError> {
        let stdin = child.stdin.take().ok_or(RendererError::FfmpegExited(-1))?;
        Ok(Self { child, stdin })
    }
}

pub enum VideoEncoder {
    #[cfg(windows)]
    D3D11(crate::encode::windows::D3D11FfmpegHardwareEncoder),
    RawBgra(Box<RawBgraFfmpegStdinEncoder>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncoderSpawnReport {
    pub encoder_backend: String,
    pub conversion_backend: Option<String>,
    pub surface_format_encoder: String,
    pub requested_codec: Option<String>,
    pub selected_codec: Option<String>,
    pub target_bitrate_bps: Option<u64>,
    pub fallback_used: bool,
    pub fallback_reason: Option<String>,
    pub backend_diagnostics: Vec<BackendDiagnosticTelemetry>,
}

impl EncoderSpawnReport {
    pub fn raw_bgra(settings: &EncoderSettings) -> Self {
        Self {
            encoder_backend: "raw_bgra_ffmpeg_stdin".to_string(),
            conversion_backend: None,
            surface_format_encoder: settings.pixel_format.clone(),
            requested_codec: None,
            selected_codec: None,
            target_bitrate_bps: settings.bitrate_bps,
            fallback_used: false,
            fallback_reason: None,
            backend_diagnostics: Vec::new(),
        }
    }

    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn d3d11(
        codec_name: impl Into<String>,
        settings: &EncoderSettings,
        conversion_backend: &'static str,
    ) -> Self {
        let encoder_backend = codec_name.into();
        let requested_codec = crate::encode::codec::ParsedVideoCodec::parse(&settings.codec)
            .ok()
            .map(|parsed| parsed.codec.canonical_label().to_string());
        let selected_codec = crate::encode::windows::codecs::selected_codec_label(&encoder_backend)
            .map(str::to_string)
            .or_else(|| requested_codec.clone());
        Self {
            encoder_backend,
            conversion_backend: Some(conversion_backend.to_string()),
            surface_format_encoder: "nv12".to_string(),
            requested_codec,
            selected_codec,
            target_bitrate_bps: Some(settings.d3d11_target_bitrate_bps()),
            fallback_used: false,
            fallback_reason: None,
            backend_diagnostics: Vec::new(),
        }
    }

    #[cfg(test)]
    pub fn fallback_to_raw(settings: &EncoderSettings, reason: impl Into<String>) -> Self {
        Self::fallback_to_raw_with_backend_diagnostics(settings, reason, Vec::new())
    }

    pub fn fallback_to_raw_with_backend_diagnostics(
        settings: &EncoderSettings,
        reason: impl Into<String>,
        backend_diagnostics: Vec<BackendDiagnosticTelemetry>,
    ) -> Self {
        Self {
            fallback_used: true,
            fallback_reason: Some(reason.into()),
            backend_diagnostics,
            ..Self::raw_bgra(settings)
        }
    }
}

pub struct SpawnedVideoEncoder {
    pub encoder: VideoEncoder,
    pub report: EncoderSpawnReport,
}

impl VideoEncoder {
    #[allow(dead_code)]
    pub fn spawn(settings: EncoderSettings) -> Result<Self, RendererError> {
        Self::spawn_with_report(settings).map(|spawned| spawned.encoder)
    }

    pub fn spawn_with_report(
        settings: EncoderSettings,
    ) -> Result<SpawnedVideoEncoder, RendererError> {
        Self::spawn_plan(plan_encoder(settings)?)
    }

    pub fn spawn_plan(plan: EncoderPlan) -> Result<SpawnedVideoEncoder, RendererError> {
        let settings = plan.settings.clone();
        Self::spawn_plan_with(plan, |candidate| open_planned_encoder(&settings, candidate))
    }

    fn spawn_plan_with(
        plan: EncoderPlan,
        open: impl FnMut(&EncoderCandidatePlan) -> Result<(Self, EncoderSpawnReport), RendererError>,
    ) -> Result<SpawnedVideoEncoder, RendererError> {
        match plan.activate(open) {
            Ok(opened) => {
                let (encoder, mut report) = opened.value;
                let mut diagnostics = backend_diagnostics_for_plan(&plan);
                for failure in &opened.failures {
                    record_hardware_open_failure(&mut diagnostics, failure.kind, &failure.error);
                }
                if opened.kind == BackendKind::SoftwareBgraFfmpeg && !opened.failures.is_empty() {
                    let error = hardware_open_error(&opened.failures);
                    tracing::info!(
                        ?error,
                        "hardware encoder unavailable; falling back to software BGRA stdin"
                    );
                    report = EncoderSpawnReport::fallback_to_raw_with_backend_diagnostics(
                        &plan.settings,
                        format!("hardware encoder unavailable: {error}"),
                        diagnostics,
                    );
                }
                Ok(SpawnedVideoEncoder { encoder, report })
            }
            Err(mut failures) => {
                if failures
                    .last()
                    .is_some_and(|failure| failure.kind == BackendKind::SoftwareBgraFfmpeg)
                {
                    return Err(failures.pop().expect("software opening failed").error);
                }
                Err(hardware_open_error(&failures))
            }
        }
    }

    pub async fn write_frame(
        &mut self,
        _absolute_frame: u32,
        frame: crate::surface::CapturedFrame,
    ) -> anyhow::Result<FrameEncodeStats> {
        match self {
            #[cfg(windows)]
            VideoEncoder::D3D11(encoder) => encoder.write_frame(frame).await,
            VideoEncoder::RawBgra(encoder) => encoder.write_frame(frame).await.map_err(Into::into),
        }
    }

    pub async fn finish(self) -> Result<(), RendererError> {
        match self {
            #[cfg(windows)]
            VideoEncoder::D3D11(encoder) => encoder.finish().await,
            VideoEncoder::RawBgra(encoder) => (*encoder).finish().await,
        }
    }

    pub async fn abort(self) -> Result<(), RendererError> {
        match self {
            #[cfg(windows)]
            VideoEncoder::D3D11(encoder) => encoder.abort().await,
            VideoEncoder::RawBgra(encoder) => (*encoder).abort().await,
        }
    }
}

fn backend_diagnostics_for_plan(plan: &EncoderPlan) -> Vec<BackendDiagnosticTelemetry> {
    plan.diagnostics
        .iter()
        .map(BackendDiagnosticTelemetry::from_selection_diagnostic)
        .collect()
}

fn record_hardware_open_failure(
    diagnostics: &mut Vec<BackendDiagnosticTelemetry>,
    kind: BackendKind,
    error: &RendererError,
) {
    let backend = kind.telemetry_label();
    let unavailable_code = runtime_hardware_failure_code(error);
    let unavailable_reason = runtime_hardware_failure_reason(error);
    if let Some(diagnostic) = diagnostics
        .iter_mut()
        .find(|diagnostic| diagnostic.backend == backend)
    {
        diagnostic.available = false;
        diagnostic.unavailable_code = Some(unavailable_code.as_str().to_string());
        diagnostic.unavailable_reason = Some(unavailable_reason);
    } else {
        diagnostics.push(BackendDiagnosticTelemetry {
            backend: backend.to_string(),
            available: false,
            unavailable_code: Some(unavailable_code.as_str().to_string()),
            unavailable_reason: Some(unavailable_reason),
        });
    }
}

fn hardware_open_error(failures: &[EncoderOpenFailure<RendererError>]) -> RendererError {
    let message = failures
        .iter()
        .map(|failure| failure.error.to_string())
        .collect::<Vec<_>>()
        .join("; ");
    RendererError::RequiredAccelerationUnavailable(format!(
        "no selected hardware encoder backend could open: {message}"
    ))
}

fn runtime_hardware_failure_code(error: &RendererError) -> BackendDiagnosticCode {
    let message = error.to_string();
    if let Some(detail) = runtime_hardware_failure_detail(error) {
        if let Some(code) = leading_runtime_hardware_failure_code(detail) {
            return code;
        }
    }
    if let Some(code) = leading_runtime_hardware_failure_code(&message) {
        return code;
    }
    if message.contains("gpu.convert_failed") {
        BackendDiagnosticCode::GpuConvertFailed
    } else if message.contains("encoder.ffmpeg_packet_write_failed") {
        BackendDiagnosticCode::EncoderFfmpegPacketWriteFailed
    } else if message.contains("encoder.ffmpeg_finish_failed") {
        BackendDiagnosticCode::EncoderFfmpegFinishFailed
    } else if message.contains("encoder.ffmpeg_open_failed")
        || message.contains("FFmpeg could not open")
    {
        BackendDiagnosticCode::EncoderFfmpegOpenFailed
    } else if message.contains("gpu.import_failed") || message.contains("gpu.import_unavailable") {
        BackendDiagnosticCode::GpuImportUnavailable
    } else {
        BackendDiagnosticCode::EncoderHardwareUnavailable
    }
}

fn runtime_hardware_failure_detail(error: &RendererError) -> Option<&str> {
    match error {
        RendererError::FfmpegInit(message)
        | RendererError::RequiredAccelerationUnavailable(message)
        | RendererError::WorkerFailed { message, .. } => Some(message.as_str()),
        _ => None,
    }
}

fn leading_runtime_hardware_failure_code(message: &str) -> Option<BackendDiagnosticCode> {
    let (code, _) = message.trim_start().split_once(':')?;
    canonical_runtime_hardware_failure_code(code.trim())
}

fn canonical_runtime_hardware_failure_code(code: &str) -> Option<BackendDiagnosticCode> {
    if code == "gpu.import_failed" {
        return Some(BackendDiagnosticCode::GpuImportUnavailable);
    }
    BackendDiagnosticCode::from_str(code)
}

fn runtime_hardware_failure_reason(error: &RendererError) -> String {
    format!("{}: {error}", runtime_hardware_failure_code(error).as_str())
}

fn open_planned_encoder(
    settings: &EncoderSettings,
    candidate: &EncoderCandidatePlan,
) -> Result<(VideoEncoder, EncoderSpawnReport), RendererError> {
    match candidate {
        EncoderCandidatePlan::WindowsD3D11 { kind } => {
            try_spawn_windows_hardware_with_report(settings, *kind)
        }
        EncoderCandidatePlan::Software => {
            Ok((spawn_raw(settings)?, EncoderSpawnReport::raw_bgra(settings)))
        }
    }
}

fn try_spawn_windows_hardware_with_report(
    settings: &EncoderSettings,
    selected_backend: BackendKind,
) -> Result<(VideoEncoder, EncoderSpawnReport), RendererError> {
    #[cfg(windows)]
    {
        let spawned = crate::encode::windows::D3D11FfmpegHardwareEncoder::spawn_for_backend(
            settings,
            selected_backend,
        )?;
        let report = EncoderSpawnReport::d3d11(
            spawned.codec_name().to_string(),
            settings,
            spawned.conversion_backend_name(),
        );
        return Ok((VideoEncoder::D3D11(spawned), report));
    }

    #[cfg(not(windows))]
    {
        let _ = selected_backend;
        let _ = settings;

        Err(RendererError::RequiredAccelerationUnavailable(
            "Windows D3D11 backend is unavailable on this platform".to_string(),
        ))
    }
}

fn spawn_raw(settings: &EncoderSettings) -> Result<VideoEncoder, RendererError> {
    RawBgraFfmpegStdinEncoder::spawn(
        settings.width,
        settings.height,
        settings.fps,
        &settings.codec,
        &settings.pixel_format,
        settings.bitrate_bps,
        &settings.output,
    )
    .map(Box::new)
    .map(VideoEncoder::RawBgra)
}

#[allow(dead_code)]
fn chunk_io_error(path: &Path, action: &str, error: io::Error) -> io::Error {
    io::Error::new(
        error.kind(),
        format!("failed to {action} BGRA chunk {}: {error}", path.display()),
    )
}

fn spawn_ffmpeg(
    width: u32,
    height: u32,
    fps: u32,
    codec: &str,
    pixel_format: &str,
    bitrate_bps: Option<u64>,
    output: &str,
) -> Result<Child, RendererError> {
    if let Some(parent) = Path::new(output)
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent).map_err(|_| RendererError::FfmpegExited(-1))?;
    }

    Command::new("ffmpeg")
        .args(ffmpeg_raw_bgra_args_with_bitrate(
            width,
            height,
            fps,
            codec,
            pixel_format,
            bitrate_bps,
            output,
        ))
        .stdin(Stdio::piped())
        .spawn()
        .map_err(map_spawn_or_wait_error)
}

fn map_spawn_or_wait_error(error: io::Error) -> RendererError {
    if error.kind() == io::ErrorKind::NotFound {
        RendererError::FfmpegMissing
    } else {
        RendererError::FfmpegExited(-1)
    }
}

#[cfg(test)]
pub(crate) fn ffmpeg_raw_bgra_args(
    width: u32,
    height: u32,
    fps: u32,
    codec: &str,
    pixel_format: &str,
    output: &str,
) -> Vec<String> {
    ffmpeg_raw_bgra_args_with_bitrate(width, height, fps, codec, pixel_format, None, output)
}

fn ffmpeg_raw_bgra_args_with_bitrate(
    width: u32,
    height: u32,
    fps: u32,
    codec: &str,
    pixel_format: &str,
    bitrate_bps: Option<u64>,
    output: &str,
) -> Vec<String> {
    let mut args = vec![
        "-y".to_owned(),
        "-f".to_owned(),
        "rawvideo".to_owned(),
        "-pix_fmt".to_owned(),
        "bgra".to_owned(),
        "-s".to_owned(),
        format!("{width}x{height}"),
        "-r".to_owned(),
        fps.to_string(),
        "-i".to_owned(),
        "-".to_owned(),
        "-an".to_owned(),
        "-c:v".to_owned(),
        codec.to_owned(),
    ];

    if let Some(bitrate_bps) = bitrate_bps {
        args.push("-b:v".to_owned());
        args.push(bitrate_bps.to_string());
    }

    args.extend([
        "-pix_fmt".to_owned(),
        pixel_format.to_owned(),
        output.to_owned(),
    ]);

    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io;
    #[cfg(windows)]
    use std::path::Path;
    #[cfg(windows)]
    use std::path::PathBuf;
    #[cfg(windows)]
    use std::process::Command;
    use std::process::Stdio;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tokio::process::Command as TokioCommand;

    #[test]
    fn builds_ffmpeg_args_for_raw_bgra_stdin() {
        let args = ffmpeg_raw_bgra_args(1920, 1080, 30, "libx264", "yuv444p", "out/hero.mp4");

        assert_eq!(
            args,
            [
                "-y",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "bgra",
                "-s",
                "1920x1080",
                "-r",
                "30",
                "-i",
                "-",
                "-an",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv444p",
                "out/hero.mp4"
            ]
        );
    }

    #[test]
    fn builds_ffmpeg_args_with_explicit_bitrate_for_raw_bgra_stdin() {
        let args = ffmpeg_raw_bgra_args_with_bitrate(
            1920,
            1080,
            30,
            "libx264",
            "yuv444p",
            Some(12_000_000),
            "out/hero.mp4",
        );

        assert!(args.windows(2).any(|pair| pair == ["-b:v", "12000000"]));
    }

    #[test]
    fn raw_encoder_spawn_reports_raw_backend() {
        let settings = EncoderSettings::new(1920, 1080, 30, "h264", "yuv444p", "out.mp4");
        let report = EncoderSpawnReport::raw_bgra(&settings);

        assert_eq!(report.encoder_backend, "raw_bgra_ffmpeg_stdin");
        assert_eq!(report.surface_format_encoder, "yuv444p");
        assert_eq!(report.requested_codec, None);
        assert_eq!(report.selected_codec, None);
        assert!(!report.fallback_used);
    }

    #[test]
    fn d3d11_spawn_report_records_requested_and_selected_codec_labels() {
        let settings = EncoderSettings::new(1920, 1080, 30, "hevc_nvenc", "nv12", "out.mp4");
        let report = EncoderSpawnReport::d3d11("hevc_nvenc", &settings, "d3d11_video_processor");

        assert_eq!(report.encoder_backend, "hevc_nvenc");
        assert_eq!(
            report.conversion_backend.as_deref(),
            Some("d3d11_video_processor")
        );
        assert_eq!(report.surface_format_encoder, "nv12");
        assert_eq!(report.requested_codec.as_deref(), Some("hevc"));
        assert_eq!(report.selected_codec.as_deref(), Some("hevc"));
    }

    #[test]
    fn d3d11_spawn_report_preserves_the_activated_shader_converter() {
        let settings = EncoderSettings::new(1920, 1080, 60, "h264", "nv12", "out.mp4");
        let report = EncoderSpawnReport::d3d11("h264_mf", &settings, "d3d11_shader_nv12");
        assert_eq!(
            report.conversion_backend.as_deref(),
            Some("d3d11_shader_nv12")
        );
        assert_eq!(report.surface_format_encoder, "nv12");
    }

    #[test]
    fn auto_hardware_failure_reports_fallback_reason() {
        let settings =
            EncoderSettings::new(1920, 1080, 30, "unsupported-hw-codec", "nv12", "out.mp4");
        let report = EncoderSpawnReport::fallback_to_raw(&settings, "hardware encoder unavailable");

        assert_eq!(report.encoder_backend, "raw_bgra_ffmpeg_stdin");
        assert_eq!(report.surface_format_encoder, "nv12");
        assert_eq!(report.requested_codec, None);
        assert_eq!(report.selected_codec, None);
        assert!(report.fallback_used);
        assert_eq!(
            report.fallback_reason.as_deref(),
            Some("hardware encoder unavailable")
        );
    }

    #[test]
    fn runtime_hardware_failure_classifier_returns_typed_backend_code() {
        let error = RendererError::FfmpegInit(
            "gpu.import_failed: D3D11 import failed after device-open diagnostic".to_string(),
        );

        assert_eq!(
            runtime_hardware_failure_code(&error),
            crate::pipeline::backend_registry::BackendDiagnosticCode::GpuImportUnavailable
        );
    }

    #[test]
    fn runtime_hardware_failure_classifier_reports_late_ffmpeg_write_failures() {
        let packet_error = RendererError::RequiredAccelerationUnavailable(
            "encoder.ffmpeg_packet_write_failed: av_interleaved_write_frame failed".to_string(),
        );
        let finish_error = RendererError::RequiredAccelerationUnavailable(
            "encoder.ffmpeg_finish_failed: av_write_trailer failed".to_string(),
        );

        assert_eq!(
            runtime_hardware_failure_code(&packet_error),
            crate::pipeline::backend_registry::BackendDiagnosticCode::EncoderFfmpegPacketWriteFailed
        );
        assert_eq!(
            runtime_hardware_failure_code(&finish_error),
            crate::pipeline::backend_registry::BackendDiagnosticCode::EncoderFfmpegFinishFailed
        );
    }

    #[test]
    fn auto_hardware_selection_fallback_report_preserves_error_and_raw_format() {
        let settings =
            EncoderSettings::new(1920, 1080, 30, "unsupported-hw-codec", "nv12", "out.mp4");
        let report = EncoderSpawnReport::fallback_to_raw(
            &settings,
            format!(
                "hardware encoder unavailable: {}",
                RendererError::FfmpegExited(-1)
            ),
        );

        assert_eq!(report.encoder_backend, "raw_bgra_ffmpeg_stdin");
        assert_eq!(report.surface_format_encoder, "nv12");
        assert!(report.fallback_used);
        assert_eq!(
            report.fallback_reason.as_deref(),
            Some("hardware encoder unavailable: ffmpeg exited with code -1")
        );
    }

    #[test]
    fn auto_encoder_preserves_yuv444p_quality_on_raw_path() {
        let settings = EncoderSettings::new(1920, 1080, 30, "h264", "yuv444p", "out.mp4");

        let report = EncoderSpawnReport::fallback_to_raw(&settings, "hardware unavailable");
        assert_eq!(report.surface_format_encoder, "yuv444p");
    }

    #[test]
    fn required_hardware_spawn_does_not_fall_back_when_path_is_disallowed() {
        let mut settings = EncoderSettings::new(1920, 1080, 30, "h264", "nv12", "out.mp4")
            .with_execution_context(EncoderExecutionContext::StreamedBgraWorker);
        settings.backend = EncoderBackendPreference::HardwareRequired;

        let Err(error) = VideoEncoder::spawn(settings) else {
            panic!("required hardware unexpectedly fell back to a software encoder");
        };

        assert!(matches!(
            error,
            RendererError::RequiredAccelerationPathUnsupported(_)
        ));
    }

    #[tokio::test]
    async fn successful_hardware_activation_keeps_required_report_free_of_probe_diagnostics() {
        let mut settings = EncoderSettings::new(1920, 1080, 30, "h264_mf", "nv12", "out.mp4");
        settings.backend = EncoderBackendPreference::HardwareRequired;
        let plan = EncoderPlan::resolve(
            settings.clone(),
            &velocast_renderer_policy::encoder_plan::EncoderCapabilities::windows(),
        )
        .unwrap();
        assert!(!plan.diagnostics.is_empty());
        let spawned = VideoEncoder::spawn_plan_with(plan, |_| {
            let encoder = FfmpegEncoder::from_child(stdin_sink_process()).unwrap();
            Ok((
                VideoEncoder::RawBgra(Box::new(encoder)),
                EncoderSpawnReport::d3d11("h264_mf", &settings, "d3d11_video_processor"),
            ))
        })
        .unwrap();
        assert!(spawned.report.backend_diagnostics.is_empty());
        assert!(!spawned.report.fallback_used);
        spawned.encoder.abort().await.unwrap();
    }

    #[tokio::test]
    async fn planned_software_is_not_reported_as_a_failed_hardware_activation() {
        let settings = EncoderSettings::new(1920, 1080, 30, "h264", "nv12", "out.mp4");
        let plan = EncoderPlan::resolve(
            settings.clone(),
            &velocast_renderer_policy::encoder_plan::EncoderCapabilities::software_only(),
        )
        .unwrap();
        let spawned = VideoEncoder::spawn_plan_with(plan, |candidate| {
            assert_eq!(candidate.kind(), BackendKind::SoftwareBgraFfmpeg);
            let encoder = FfmpegEncoder::from_child(stdin_sink_process()).unwrap();
            Ok((
                VideoEncoder::RawBgra(Box::new(encoder)),
                EncoderSpawnReport::raw_bgra(&settings),
            ))
        })
        .unwrap();
        assert!(!spawned.report.fallback_used);
        assert!(spawned.report.fallback_reason.is_none());
        assert!(spawned.report.backend_diagnostics.is_empty());
        spawned.encoder.abort().await.unwrap();
    }

    #[tokio::test]
    async fn software_fallback_reports_the_backend_that_actually_failed_to_open() {
        let settings = EncoderSettings::new(1920, 1080, 30, "h264_mf", "nv12", "out.mp4");
        let plan = EncoderPlan::resolve(
            settings.clone(),
            &velocast_renderer_policy::encoder_plan::EncoderCapabilities::windows(),
        )
        .unwrap();
        let spawned = VideoEncoder::spawn_plan_with(plan, |candidate| {
            if candidate.kind() != BackendKind::SoftwareBgraFfmpeg {
                return Err(RendererError::FfmpegInit(
                    "encoder.ffmpeg_open_failed: device busy".to_string(),
                ));
            }
            let encoder = FfmpegEncoder::from_child(stdin_sink_process()).unwrap();
            Ok((
                VideoEncoder::RawBgra(Box::new(encoder)),
                EncoderSpawnReport::raw_bgra(&settings),
            ))
        })
        .unwrap();
        assert!(spawned.report.fallback_used);
        assert!(spawned
            .report
            .fallback_reason
            .as_deref()
            .unwrap()
            .contains("device busy"));
        let diagnostic = spawned
            .report
            .backend_diagnostics
            .iter()
            .find(|diagnostic| diagnostic.backend == "windows_d3d11_mf")
            .unwrap();
        assert!(!diagnostic.available);
        assert_eq!(
            diagnostic.unavailable_code.as_deref(),
            Some("encoder.ffmpeg_open_failed")
        );
        spawned.encoder.abort().await.unwrap();
    }

    #[tokio::test]
    async fn writes_frame_and_finishes_with_tokio_process() {
        let child = stdin_sink_process();
        let mut encoder = FfmpegEncoder::from_child(child).unwrap();

        encoder.write_bgra_frame(&[0, 1, 2, 3]).await.unwrap();
        encoder.finish().await.unwrap();
    }

    #[tokio::test]
    async fn raw_encoder_writes_captured_bgra_frame() {
        let child = stdin_sink_process();
        let mut encoder = RawBgraFfmpegStdinEncoder::from_child(child).unwrap();

        encoder
            .write_frame(crate::surface::CapturedFrame::BgraSoftware(
                crate::surface::SoftwareFrame {
                    capture_backend: "electron_software_bgra",
                    width: 1,
                    height: 1,
                    pixel_format: crate::surface::SoftwarePixelFormat::Bgra,
                    pixels: vec![0, 1, 2, 3],
                },
            ))
            .await
            .unwrap();
        encoder.finish().await.unwrap();
    }

    #[tokio::test]
    async fn raw_encoder_rejects_mismatched_bgra_frame_len() {
        let child = stdin_sink_process();
        let mut encoder = RawBgraFfmpegStdinEncoder::from_child(child).unwrap();

        let error = encoder
            .write_frame(crate::surface::CapturedFrame::BgraSoftware(
                crate::surface::SoftwareFrame {
                    capture_backend: "electron_software_bgra",
                    width: 2,
                    height: 1,
                    pixel_format: crate::surface::SoftwarePixelFormat::Bgra,
                    pixels: vec![0, 1, 2, 3],
                },
            ))
            .await
            .unwrap_err();
        encoder.abort().await.unwrap();

        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(error.to_string().contains("BGRA frame length"));
    }

    #[tokio::test]
    async fn writes_bgra_file_to_encoder_stdin() {
        let path = std::env::temp_dir().join(format!(
            "velocast-raw-chunk-{}.bgra",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::write(&path, [1_u8, 2, 3, 4]).unwrap();

        let child = stdin_sink_process();
        let mut encoder = FfmpegEncoder::from_child(child).unwrap();

        let bytes = encoder.write_bgra_file(&path).await.unwrap();
        encoder.finish().await.unwrap();
        fs::remove_file(&path).unwrap();

        assert_eq!(bytes, 4);
    }

    #[tokio::test]
    async fn reports_chunk_path_when_bgra_file_is_missing() {
        let path = std::env::temp_dir().join(format!(
            "velocast-missing-chunk-{}.bgra",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let child = stdin_sink_process();
        let mut encoder = FfmpegEncoder::from_child(child).unwrap();

        let error = encoder.write_bgra_file(&path).await.unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::NotFound);
        assert!(error.to_string().contains(&path.display().to_string()));
    }

    #[tokio::test]
    async fn abort_terminates_encoder_child() {
        let child = stdin_sink_process();
        let encoder = FfmpegEncoder::from_child(child).unwrap();

        encoder.abort().await.unwrap();
    }

    #[test]
    fn d3d11_backend_source_declares_ffmpeg_hardware_contexts() {
        let backend = include_str!("encode/windows/d3d11/backend.rs");
        let frames = include_str!("encode/windows/d3d11/frames.rs");

        assert!(backend.contains("AVHWDeviceContext"));
        assert!(frames.contains("AVHWFramesContext"));
        assert!(!backend.contains("not implemented in this build"));
        assert!(!frames.contains("not implemented in this build"));
    }

    #[test]
    fn d3d11_backend_uses_encoder_owned_nv12_surfaces() {
        let frames = include_str!("encode/windows/d3d11/frames.rs");
        let converter = include_str!("encode/windows/d3d11/converter.rs");

        assert!(frames.contains("AV_PIX_FMT_NV12"));
        assert!(frames.contains("av_hwframe_get_buffer"));
        assert!(frames.contains("D3D11VideoProcessorConverter"));
        assert!(converter.contains("VideoProcessorBlt"));
        assert!(!frames
            .contains("(*frames_context).sw_format = ffmpeg::AVPixelFormat::AV_PIX_FMT_BGRA"));
        assert!(!frames
            .contains("(*codec_context).sw_pix_fmt = ffmpeg::AVPixelFormat::AV_PIX_FMT_BGRA"));
        assert!(!frames.contains("fn create_frame_from_texture"));
    }

    #[test]
    fn d3d11_backend_tries_next_hardware_encoder_when_one_fails_to_open() {
        let source = include_str!("encode/windows/d3d11/backend.rs");

        assert!(source.contains("try_spawn_with_codec"));
        assert!(source.contains("last_error"));
        assert!(source.contains("failed to initialize D3D11 FFmpeg hardware encoder candidate"));
    }

    #[test]
    fn d3d11_backend_uses_on_demand_encoder_textures() {
        let source = include_str!("encode/windows/d3d11/frames.rs");

        assert!(source.contains("const ENCODER_FRAME_POOL_SIZE: i32 = 0"));
    }

    #[test]
    fn d3d11_backend_caches_video_processor_views() {
        let source = include_str!("encode/windows/d3d11/converter.rs");

        assert!(source.contains("input_views"));
        assert!(source.contains("cached_input_view"));
        assert!(source.contains("output_views"));
        assert!(source.contains("cached_output_view"));
    }

    #[test]
    fn d3d11_backend_bounds_output_view_cache() {
        let source = include_str!("encode/windows/d3d11/converter.rs");

        assert!(source.contains("MAX_CACHED_OUTPUT_VIEWS"));
        assert!(source.contains("if output_views.len() >= MAX_CACHED_OUTPUT_VIEWS"));
    }

    #[test]
    fn d3d11_backend_initializes_com_as_mta_for_media_foundation() {
        let device = include_str!("encode/windows/d3d11/device.rs");
        let main = include_str!("main.rs");

        assert!(device.contains("CoInitializeEx"));
        assert!(device.contains("COINIT_MULTITHREADED"));
        assert!(main.contains("initialize_com_for_d3d11_encoding"));
    }

    #[test]
    fn d3d11_backend_forces_media_foundation_hardware_encoding() {
        let source = include_str!("encode/windows/d3d11/frames.rs");

        assert!(source.contains("hw_encoding"));
        assert!(source.contains("av_dict_set"));
    }

    #[test]
    fn d3d11_backend_sets_bitrate_before_opening_encoder() {
        let source = include_str!("encode/windows/d3d11/frames.rs");

        assert!(source.contains("d3d11_target_bitrate_bps"));
        assert!(source.contains("(*codec_context).bit_rate"));
        assert!(source.contains("(*codec_context).rc_max_rate"));
    }

    #[test]
    fn d3d11_backend_defers_packet_draining_behind_bounded_backpressure() {
        let source = include_str!("encode/windows/d3d11/backend.rs");

        assert!(source.contains("MAX_PENDING_ENCODER_FRAMES"));
        assert!(source.contains("drain_packets_until_pending_at_most"));
        assert!(!source.contains(
            "self.pending_frames.push_back(frame);\n            let packet_write_ms = self.drain_packets()?;"
        ));
    }

    #[test]
    fn media_foundation_segment_encode_also_uses_target_bitrate_policy() {
        let source = include_str!("encode/windows/d3d11/frames.rs");

        assert!(!source
            .contains("settings.execution_context == EncoderExecutionContext::SegmentWorker"));
        assert!(!source.contains(r#"set_codec_option(&mut options, "rate_control", "pc_vbr")"#));
        assert!(!source.contains(r#"set_codec_option(&mut options, "quality", "100")"#));
    }

    #[cfg(windows)]
    fn repo_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .unwrap()
            .to_path_buf()
    }

    #[cfg(windows)]
    fn unique_temp_dir(prefix: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "{}-{}",
            prefix,
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[cfg(windows)]
    fn ps_single_quote(path: &Path) -> String {
        format!("'{}'", path.display().to_string().replace('\'', "''"))
    }

    #[cfg(windows)]
    fn stdin_sink_process() -> tokio::process::Child {
        TokioCommand::new("cmd")
            .args(["/C", "more > NUL"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    }

    #[cfg(not(windows))]
    fn stdin_sink_process() -> tokio::process::Child {
        TokioCommand::new("cat")
            .arg("-")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    }

    #[test]
    fn windows_gpu_pipeline_verifier_reports_output_bitrate() {
        let source = include_str!("../../../scripts/verify-windows-gpu-pipeline.ps1");

        assert!(source.contains("bit_rate"));
    }

    #[test]
    fn windows_gpu_pipeline_verifier_accepts_encoder_family() {
        let source = include_str!("../../../scripts/verify-windows-gpu-pipeline.ps1");

        assert!(source.contains("Assert-WindowsHardwareEncoderBackend"));
        assert!(source.contains("[string]$Codec = \"h264\""));
        assert!(source.contains("--codec"));
        assert!(source.contains("h264_amf"));
        assert!(source.contains("h264_nvenc"));
        assert!(source.contains("h264_qsv"));
        assert!(source.contains("h264_mf"));
        assert!(!source.contains("-Expected \"h264_mf\""));
    }

    #[test]
    fn d3d11_verification_script_asserts_real_hardware_smoke_path() {
        let source = include_str!("../../../scripts/verify-d3d11-encoder.ps1");

        assert!(source.contains("RunSmoke"));
        assert!(source.contains("using D3D11 FFmpeg hardware encoder"));
        assert!(source.contains("ffprobe"));
    }

    #[test]
    fn windows_gpu_pipeline_verifier_checks_telemetry_and_segment_mode() {
        let source = include_str!("../../../scripts/verify-windows-gpu-pipeline.ps1");

        assert!(source.contains("--report"));
        assert!(source.contains("--assembly"));
        assert!(source.contains("cpu_readback_frames"));
        assert!(source.contains("fallback_used"));
        assert!(source.contains("segments"));
        assert!(source.contains("ffprobe"));
        assert!(source.contains("Reference rendered frame count mismatch"));
        assert!(source.contains("Assert-ReferenceGpuTelemetryReport"));
        assert!(source.contains("Segment rendered frame count mismatch"));
        assert!(source.contains("Assert-SegmentCoordinatorReport"));
        assert!(source.contains("parallel_segments"));
        assert!(source.contains("Invoke-Ffprobe"));
        assert!(source.contains("CARGO_TARGET_DIR"));
        assert!(source.contains("VELOCAST_RENDERER_BINARY"));
    }

    #[test]
    fn windows_gpu_pipeline_verifier_checks_decoding_and_separates_motion_oracle() {
        let source = include_str!("../../../scripts/verify-windows-gpu-pipeline.ps1");
        let validator = include_str!("../../../scripts/windows-frame-validation.ps1");

        assert!(source.contains("Assert-MediaToolsAvailable"));
        assert!(source.contains("Assert-DecodedFrames"));
        assert!(source.contains("framemd5"));
        assert!(source.contains("StandardOutput.ReadLine()"));
        assert!(source.contains("StandardError.ReadToEndAsync"));
        assert!(validator.contains("-OnFrameLine"));
        assert!(validator.contains("decoded frame count mismatch"));
        assert!(validator.contains("Assert-ExpectedFrameDifferences"));
        assert!(validator.contains("ExpectedDifferentFrames = @()"));
        assert!(!validator.contains("adjacent duplicate decoded frame"));
        assert!(!source.contains("skipped decoded frame hash validation"));
        assert!(!source.contains("skipped output metadata validation"));
        assert!(!source.contains("StandardOutput.ReadToEnd"));
    }

    #[test]
    fn windows_gpu_pipeline_verifier_caches_media_tool_probes() {
        let source = include_str!("../../../scripts/verify-windows-gpu-pipeline.ps1");

        assert!(source.contains("function Resolve-MediaToolAvailability"));
        assert!(source.contains("$mediaTools = Resolve-MediaToolAvailability"));
        assert!(source.contains("Assert-MediaToolsAvailable -MediaTools $mediaTools"));
        assert!(source.contains("ffprobe is required for Windows GPU output metadata validation"));
        assert!(source.contains("ffmpeg is required for Windows GPU decoded frame hash validation"));
        assert!(!source.contains("-FfprobeAvailable"));
        assert!(!source.contains("-FfmpegAvailable"));
    }

    #[test]
    fn windows_gpu_pipeline_verifier_checks_media_tools_before_cargo_work() {
        let source = include_str!("../../../scripts/verify-windows-gpu-pipeline.ps1");

        let media_preflight = source
            .find("Assert-MediaToolsAvailable -MediaTools $mediaTools")
            .expect("Windows verifier should assert media tools are available");
        let cargo_work = source
            .find("-FilePath \"cargo\"")
            .expect("Windows verifier should run cargo");

        assert!(
            media_preflight < cargo_work,
            "Windows verifier should fail on missing ffprobe/ffmpeg before starting cargo work"
        );
    }

    #[test]
    fn d3d11_verification_script_can_bootstrap_repo_local_vcpkg() {
        let source = include_str!("../../../scripts/accelerated-rendering-common.ps1");

        assert!(source.contains("InstallVcpkg"));
        assert!(source.contains(".tools"));
        assert!(source.contains("bootstrap-vcpkg.bat"));
        assert!(source.contains("vcpkg.exe install"));
    }

    #[test]
    fn d3d11_verification_script_checks_cargo_exit_codes() {
        let source = include_str!("../../../scripts/verify-d3d11-encoder.ps1");

        assert!(source.contains("Invoke-Native"));
        assert!(source.contains("-FilePath \"cargo\""));
        assert!(source.contains("-WorkingDirectory $repoRoot"));
    }

    #[test]
    fn d3d11_verification_script_resolves_libclang_for_bindgen() {
        let source = include_str!("../../../scripts/accelerated-rendering-common.ps1");

        assert!(source.contains("Find-LibclangPath"));
        assert!(source.contains("LIBCLANG_PATH"));
    }

    #[test]
    fn d3d11_verification_script_captures_smoke_process_output() {
        let source = include_str!("../../../scripts/accelerated-rendering-common.ps1");
        let verifier = include_str!("../../../scripts/verify-d3d11-encoder.ps1");

        assert!(source.contains("Invoke-NativeCapture"));
        assert!(source.contains("Join-NativeArgumentString"));
        assert!(source.contains("ExitCode"));
        assert!(!verifier.contains("$rendererOutput = cargo run"));
    }

    #[test]
    fn accelerated_setup_script_writes_env_file() {
        let source = include_str!("../../../scripts/setup-accelerated-rendering.ps1");

        assert!(source.contains("accelerated-env.ps1"));
        assert!(source.contains("Write-AcceleratedRenderingEnvFile"));
        assert!(source.contains(".tools\\vcpkg"));
    }

    #[test]
    fn d3d11_verifier_reuses_accelerated_common_helpers() {
        let source = include_str!("../../../scripts/verify-d3d11-encoder.ps1");

        assert!(source.contains("accelerated-rendering-common.ps1"));
        assert!(source.contains("Initialize-AcceleratedRenderingEnvironment"));
    }

    #[test]
    fn accelerated_common_native_helpers_honor_working_directory() {
        #[cfg(windows)]
        {
            let repo_root = repo_root();
            let test_root = unique_temp_dir("velocast-native-helper-cwd");
            let work_dir = test_root.join("work");
            fs::create_dir_all(&work_dir).unwrap();

            let common_script = repo_root.join("scripts/accelerated-rendering-common.ps1");
            let script = format!(
                r#"
$ErrorActionPreference = "Stop"
. {common_script}
$before = (Get-Location).Path
$expectedWorkDir = (Resolve-Path -LiteralPath {work_dir}).Path
Invoke-Native -FilePath "powershell" -Arguments @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "Set-Content -LiteralPath native-marker.txt -Value ok") -WorkingDirectory {work_dir}
if (-not (Test-Path -LiteralPath (Join-Path $expectedWorkDir "native-marker.txt"))) {{ throw "Invoke-Native did not run in working directory" }}
if ((Get-Location).Path -ne $before) {{ throw "Invoke-Native did not restore cwd" }}
$capture = Invoke-NativeCapture -FilePath "powershell" -Arguments @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "Set-Content -LiteralPath capture-marker.txt -Value ok; Write-Output capture-ok") -WorkingDirectory {work_dir}
if ($capture.ExitCode -ne 0) {{ throw "Invoke-NativeCapture exit code $($capture.ExitCode)" }}
if (-not (Test-Path -LiteralPath (Join-Path $expectedWorkDir "capture-marker.txt"))) {{ throw "Invoke-NativeCapture did not run in working directory" }}
if ($capture.Output.Trim() -ne "capture-ok") {{ throw "Invoke-NativeCapture output mismatch: $($capture.Output)" }}
if ((Get-Location).Path -ne $before) {{ throw "Invoke-NativeCapture did not restore cwd" }}
"#,
                common_script = ps_single_quote(&common_script),
                work_dir = ps_single_quote(&work_dir),
            );

            let output = Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    &script,
                ])
                .output()
                .unwrap();

            let _ = fs::remove_dir_all(&test_root);
            assert!(
                output.status.success(),
                "PowerShell helper behavior check failed\nstdout:\n{}\nstderr:\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }

        #[cfg(not(windows))]
        {
            let source = include_str!("../../../scripts/accelerated-rendering-common.ps1");

            assert!(source.contains("Push-Location -LiteralPath $resolvedWorkingDirectory"));
            assert!(source.contains("Pop-Location"));
            assert!(source.contains("-WorkingDirectory $resolvedWorkingDirectory"));
        }
    }

    #[test]
    fn d3d11_verifier_resolves_smoke_output_under_repo_root() {
        #[cfg(windows)]
        {
            let repo_root = repo_root();
            let test_root = unique_temp_dir("velocast-smoke-output-path");
            fs::create_dir_all(&test_root).unwrap();

            let fake_repo = test_root.join("fake-repo");
            fs::create_dir_all(&fake_repo).unwrap();
            let absolute_output = test_root.join("absolute-output.mp4");
            let common_script = repo_root.join("scripts/accelerated-rendering-common.ps1");
            let script = format!(
                r#"
$ErrorActionPreference = "Stop"
. {common_script}
$expectedRelative = [System.IO.Path]::GetFullPath((Join-Path {fake_repo} "renders/d3d11-smoke.mp4"))
$expectedAbsolute = [System.IO.Path]::GetFullPath({absolute_output})
$relative = Resolve-SmokeOutputPath -RepoRoot {fake_repo} -Output "renders/d3d11-smoke.mp4"
if ($relative -ne $expectedRelative) {{ throw "relative smoke output resolved incorrectly: $relative" }}
$absolute = Resolve-SmokeOutputPath -RepoRoot {fake_repo} -Output {absolute_output}
if ($absolute -ne $expectedAbsolute) {{ throw "absolute smoke output resolved incorrectly: $absolute" }}
"#,
                common_script = ps_single_quote(&common_script),
                fake_repo = ps_single_quote(&fake_repo),
                absolute_output = ps_single_quote(&absolute_output),
            );

            let output = Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    &script,
                ])
                .output()
                .unwrap();

            let _ = fs::remove_dir_all(&test_root);
            assert!(
                output.status.success(),
                "PowerShell smoke path behavior check failed\nstdout:\n{}\nstderr:\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }

        #[cfg(not(windows))]
        {
            let source = include_str!("../../../scripts/accelerated-rendering-common.ps1");
            let verifier = include_str!("../../../scripts/verify-d3d11-encoder.ps1");

            assert!(source.contains("Join-Path $RepoRoot $Output"));
            assert!(verifier.contains("output = $smokeOutputPath"));
            assert!(verifier.contains("Test-Path -LiteralPath $smokeOutputPath"));
            assert!(verifier.contains("Get-Item -LiteralPath $smokeOutputPath"));
        }
    }
}
