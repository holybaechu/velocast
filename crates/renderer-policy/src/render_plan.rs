use std::path::{Path, PathBuf};

use serde::Serialize;
use velocast_protocol::{
    CompositionManifest, RenderJob, RendererAcceleration, RendererAssemblyMode,
};

use crate::backend_registry::{backend_descriptor, BackendKind, BackendSelectionDiagnostic};
use crate::browser_surface::BrowserSurfaceMode;
use crate::codec::RequestedVideoCodec;
use crate::encoder_plan::{EncoderCapabilities, EncoderPlan};
use crate::scheduler::{chunk_frame_ranges, resolve_effective_concurrency, FrameRange};
use crate::settings::{
    hardware_preserves_requested_pixel_format, EncoderBackendPreference, EncoderExecutionContext,
    EncoderSettings,
};

const AUTO_SEGMENT_MIN_FRAMES: u32 = 60;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RenderPipelineRoute {
    SerialReference,
    ParallelSegments,
    #[allow(dead_code)]
    StreamedBgraWorkers,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SegmentProbeTier {
    None,
    FinalOutputAndBoundaryHashes,
    SegmentsAndFinalDeep,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RenderPipelineCaptureMode {
    SoftwareBgra,
    AcceleratedGpuSurface,
    WindowsD3D11SharedTexture,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RenderPipelineConversionMode {
    Software,
    CpuBgraReadback,
    D3D11VideoProcessor,
    D3D11Shader,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RenderPipelineEncoderMode {
    RawBgraFfmpegStdin,
    WindowsD3D11Ffmpeg,
}

impl RenderPipelineRoute {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SerialReference => "serial_reference",
            Self::ParallelSegments => "parallel_segments",
            Self::StreamedBgraWorkers => "streamed_bgra_workers",
        }
    }
}

impl SegmentProbeTier {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::FinalOutputAndBoundaryHashes => "final_output_and_boundary_hashes",
            Self::SegmentsAndFinalDeep => "segments_and_final_deep",
        }
    }
}

impl RenderPipelineCaptureMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SoftwareBgra => "software_bgra",
            Self::AcceleratedGpuSurface => "accelerated_gpu_surface",
            Self::WindowsD3D11SharedTexture => "windows_d3_d11_shared_texture",
        }
    }
}

impl RenderPipelineConversionMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Software => "software",
            Self::CpuBgraReadback => "cpu_bgra_readback",
            Self::D3D11VideoProcessor => "d3_d11_video_processor",
            Self::D3D11Shader => "d3_d11_shader",
        }
    }
}

impl RenderPipelineEncoderMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RawBgraFfmpegStdin => "raw_bgra_ffmpeg_stdin",
            Self::WindowsD3D11Ffmpeg => "windows_d3_d11_ffmpeg",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderPipelineOutputPaths {
    pub final_output: PathBuf,
    pub chunk_dir: PathBuf,
    pub temp_output: PathBuf,
    pub concat_file: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderPipelineSegmentPlan {
    pub index: usize,
    pub range: FrameRange,
    pub output: PathBuf,
    pub telemetry_report: PathBuf,
    pub worker_report: Option<PathBuf>,
    pub expected_frame_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderPipelineBackendPlan {
    pub browser_surface_mode: BrowserSurfaceMode,
    pub selected_backend: BackendKind,
    pub software_fallback: bool,
    pub capture_mode: RenderPipelineCaptureMode,
    pub conversion_mode: RenderPipelineConversionMode,
    pub encoder_mode: RenderPipelineEncoderMode,
    pub encoder_backend: String,
    pub encoder_plan: EncoderPlan,
    pub backend_diagnostics: Vec<BackendSelectionDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderPipelinePlan {
    pub route: RenderPipelineRoute,
    pub effective_concurrency: u32,
    pub output: RenderPipelineOutputPaths,
    pub segments: Vec<RenderPipelineSegmentPlan>,
    pub probe_tier: SegmentProbeTier,
    pub event_log_path: Option<PathBuf>,
    pub backend: RenderPipelineBackendPlan,
}

impl RenderPipelinePlan {
    pub fn for_coordinator(
        job: &RenderJob,
        composition: &CompositionManifest,
        available_workers: u32,
        process_id: u32,
        browser_surface_mode: BrowserSurfaceMode,
        capabilities: &EncoderCapabilities,
    ) -> anyhow::Result<Self> {
        let requested_effective_concurrency = resolve_effective_concurrency(
            job.concurrency.as_ref(),
            composition.max_concurrency,
            available_workers,
            composition.duration_frames,
        );
        let route = resolve_route(
            job.assembly_mode,
            requested_effective_concurrency,
            composition.duration_frames,
        )?;
        let effective_concurrency = match route {
            RenderPipelineRoute::SerialReference => 1,
            RenderPipelineRoute::ParallelSegments | RenderPipelineRoute::StreamedBgraWorkers => {
                requested_effective_concurrency
            }
        };
        let output = render_output_paths(Path::new(&job.output), process_id);
        let segments = if route == RenderPipelineRoute::ParallelSegments {
            segment_plans(job, composition, &output.chunk_dir, effective_concurrency)
        } else {
            Vec::new()
        };
        let backend = backend_plan_for_job(
            job,
            composition,
            route,
            &output,
            &segments,
            browser_surface_mode,
            capabilities,
        )?;

        Ok(Self {
            route,
            effective_concurrency,
            output,
            segments,
            probe_tier: probe_tier_for_job(job),
            event_log_path: job.event_log_path.as_ref().map(PathBuf::from),
            backend,
        })
    }
}

pub fn encoder_settings_for_job(
    job: &RenderJob,
    composition: &CompositionManifest,
    output: &Path,
    execution_context: EncoderExecutionContext,
) -> anyhow::Result<EncoderSettings> {
    let pixel_format = job
        .pixel_format
        .as_deref()
        .unwrap_or(match job.acceleration {
            RendererAcceleration::Required | RendererAcceleration::Auto => "nv12",
            RendererAcceleration::Off => "yuv444p",
        });

    if job.acceleration == RendererAcceleration::Required
        && !hardware_preserves_requested_pixel_format(pixel_format)
    {
        return Err(anyhow::anyhow!(
            "accelerated rendering currently supports nv12/yuv420p output, but {pixel_format} was requested.\nUse --pixel-format nv12, or use --acceleration off for the software BGRA path."
        ));
    }

    let mut settings = EncoderSettings::new(
        composition.width,
        composition.height,
        composition.fps,
        &job.codec,
        pixel_format,
        &output.to_string_lossy(),
    );
    if let Some(bitrate_bps) = job.bitrate_bps {
        settings = settings.with_bitrate_bps(bitrate_bps);
    }
    settings.execution_context = execution_context;
    settings.backend = match job.acceleration {
        RendererAcceleration::Required => EncoderBackendPreference::HardwareRequired,
        RendererAcceleration::Auto
            if job.pixel_format.is_some()
                && !hardware_preserves_requested_pixel_format(pixel_format) =>
        {
            EncoderBackendPreference::Software
        }
        RendererAcceleration::Auto => EncoderBackendPreference::Auto,
        RendererAcceleration::Off => EncoderBackendPreference::Software,
    };

    Ok(settings)
}

fn resolve_route(
    assembly_mode: RendererAssemblyMode,
    requested_effective_concurrency: u32,
    duration_frames: u32,
) -> anyhow::Result<RenderPipelineRoute> {
    match assembly_mode {
        RendererAssemblyMode::Segments => Ok(RenderPipelineRoute::ParallelSegments),
        RendererAssemblyMode::Reference => {
            if requested_effective_concurrency > 1 {
                Err(anyhow::anyhow!(
                    "reference assembly mode cannot run with concurrency greater than 1"
                ))
            } else {
                Ok(RenderPipelineRoute::SerialReference)
            }
        }
        RendererAssemblyMode::Auto => {
            if requested_effective_concurrency > 1 && duration_frames >= AUTO_SEGMENT_MIN_FRAMES {
                Ok(RenderPipelineRoute::ParallelSegments)
            } else {
                Ok(RenderPipelineRoute::SerialReference)
            }
        }
    }
}

fn render_output_paths(output: &Path, process_id: u32) -> RenderPipelineOutputPaths {
    let chunk_dir = crate::paths::temp_chunk_dir_for_output(output, process_id);
    let temp_output = crate::paths::temp_output_path_for(output, &chunk_dir);
    RenderPipelineOutputPaths {
        final_output: output.to_path_buf(),
        concat_file: chunk_dir.join("segments.txt"),
        chunk_dir,
        temp_output,
    }
}

fn segment_plans(
    job: &RenderJob,
    composition: &CompositionManifest,
    chunk_dir: &Path,
    effective_concurrency: u32,
) -> Vec<RenderPipelineSegmentPlan> {
    let ranges = chunk_frame_ranges(composition.duration_frames, effective_concurrency);
    let outputs = crate::paths::segment_paths(&ranges, chunk_dir);
    ranges
        .into_iter()
        .zip(outputs)
        .enumerate()
        .map(|(index, (range, output))| RenderPipelineSegmentPlan {
            index,
            expected_frame_count: range.end.saturating_sub(range.start),
            telemetry_report: crate::paths::segment_report_path_for(&output),
            worker_report: (job.acceleration == RendererAcceleration::Required)
                .then(|| crate::paths::segment_worker_report_path_for(&output)),
            range,
            output,
        })
        .collect()
}

fn probe_tier_for_job(job: &RenderJob) -> SegmentProbeTier {
    if job.verify_segments {
        SegmentProbeTier::SegmentsAndFinalDeep
    } else if job.acceleration == RendererAcceleration::Required {
        SegmentProbeTier::FinalOutputAndBoundaryHashes
    } else {
        SegmentProbeTier::None
    }
}

fn backend_plan_for_job(
    job: &RenderJob,
    composition: &CompositionManifest,
    route: RenderPipelineRoute,
    output: &RenderPipelineOutputPaths,
    segments: &[RenderPipelineSegmentPlan],
    browser_surface_mode: BrowserSurfaceMode,
    capabilities: &EncoderCapabilities,
) -> anyhow::Result<RenderPipelineBackendPlan> {
    let encoder_output = planned_encoder_output(route, output, segments);
    let encoder_settings = encoder_settings_for_job(
        job,
        composition,
        encoder_output,
        encoder_execution_context_for_route(route),
    )?;
    let encoder_plan = EncoderPlan::resolve(encoder_settings, capabilities)?;
    let selected = &encoder_plan.selected;
    let backend_diagnostics = encoder_plan.diagnostics.clone();
    let capture_mode = capture_mode_for(browser_surface_mode, selected.kind);
    let conversion_mode = conversion_mode_for(capture_mode, selected.kind);
    let encoder_mode = encoder_mode_for(selected.kind);
    let encoder_backend = encoder_backend_label(selected.kind, &encoder_plan.settings.codec);

    Ok(RenderPipelineBackendPlan {
        browser_surface_mode,
        selected_backend: selected.kind,
        software_fallback: selected.software_fallback,
        capture_mode,
        conversion_mode,
        encoder_mode,
        encoder_backend,
        encoder_plan,
        backend_diagnostics,
    })
}

fn planned_encoder_output<'a>(
    route: RenderPipelineRoute,
    output: &'a RenderPipelineOutputPaths,
    segments: &'a [RenderPipelineSegmentPlan],
) -> &'a Path {
    match route {
        RenderPipelineRoute::SerialReference => &output.temp_output,
        RenderPipelineRoute::ParallelSegments => segments
            .first()
            .map(|segment| segment.output.as_path())
            .unwrap_or(output.final_output.as_path()),
        RenderPipelineRoute::StreamedBgraWorkers => &output.final_output,
    }
}

fn encoder_execution_context_for_route(route: RenderPipelineRoute) -> EncoderExecutionContext {
    match route {
        RenderPipelineRoute::SerialReference => EncoderExecutionContext::Reference,
        RenderPipelineRoute::ParallelSegments => EncoderExecutionContext::SegmentWorker,
        RenderPipelineRoute::StreamedBgraWorkers => EncoderExecutionContext::StreamedBgraWorker,
    }
}

fn capture_mode_for(
    browser_surface_mode: BrowserSurfaceMode,
    selected_backend: BackendKind,
) -> RenderPipelineCaptureMode {
    if browser_surface_mode == BrowserSurfaceMode::Software {
        return RenderPipelineCaptureMode::SoftwareBgra;
    }

    match selected_backend {
        BackendKind::WindowsD3D11Amf
        | BackendKind::WindowsD3D11Nvenc
        | BackendKind::WindowsD3D11Qsv
        | BackendKind::WindowsD3D11Mf => RenderPipelineCaptureMode::WindowsD3D11SharedTexture,
        BackendKind::SoftwareBgraFfmpeg => RenderPipelineCaptureMode::AcceleratedGpuSurface,
    }
}

fn conversion_mode_for(
    capture_mode: RenderPipelineCaptureMode,
    selected_backend: BackendKind,
) -> RenderPipelineConversionMode {
    match selected_backend {
        BackendKind::WindowsD3D11Amf
        | BackendKind::WindowsD3D11Nvenc
        | BackendKind::WindowsD3D11Qsv
        | BackendKind::WindowsD3D11Mf => RenderPipelineConversionMode::D3D11VideoProcessor,
        BackendKind::SoftwareBgraFfmpeg => match capture_mode {
            RenderPipelineCaptureMode::SoftwareBgra => RenderPipelineConversionMode::Software,
            RenderPipelineCaptureMode::AcceleratedGpuSurface
            | RenderPipelineCaptureMode::WindowsD3D11SharedTexture => {
                RenderPipelineConversionMode::CpuBgraReadback
            }
        },
    }
}

fn encoder_mode_for(selected_backend: BackendKind) -> RenderPipelineEncoderMode {
    match selected_backend {
        BackendKind::WindowsD3D11Amf
        | BackendKind::WindowsD3D11Nvenc
        | BackendKind::WindowsD3D11Qsv
        | BackendKind::WindowsD3D11Mf => RenderPipelineEncoderMode::WindowsD3D11Ffmpeg,
        BackendKind::SoftwareBgraFfmpeg => RenderPipelineEncoderMode::RawBgraFfmpegStdin,
    }
}

fn encoder_backend_label(selected_backend: BackendKind, codec: &str) -> String {
    let requested_codec = RequestedVideoCodec::parse(codec).ok();
    let label = match selected_backend {
        BackendKind::WindowsD3D11Amf => {
            requested_codec.map(|codec| format!("{}_amf", codec.canonical_label()))
        }
        BackendKind::WindowsD3D11Nvenc => {
            requested_codec.map(|codec| format!("{}_nvenc", codec.canonical_label()))
        }
        BackendKind::WindowsD3D11Qsv => {
            requested_codec.map(|codec| format!("{}_qsv", codec.canonical_label()))
        }
        BackendKind::WindowsD3D11Mf => {
            requested_codec.map(|codec| format!("{}_mf", codec.canonical_label()))
        }
        BackendKind::SoftwareBgraFfmpeg => None,
    };
    label.unwrap_or_else(|| {
        let descriptor = backend_descriptor(selected_backend);
        descriptor
            .encoder_backend
            .unwrap_or(descriptor.telemetry_label)
            .to_string()
    })
}

#[cfg(test)]
mod render_plan_tests {
    use crate::backend_registry::BackendKind;
    use crate::browser_surface::BrowserSurfaceMode;
    use crate::render_plan::{
        RenderPipelineCaptureMode, RenderPipelineConversionMode, RenderPipelineEncoderMode,
        RenderPipelinePlan, RenderPipelineRoute, SegmentProbeTier,
    };
    use crate::settings::{EncoderBackendPreference, EncoderExecutionContext};
    use std::num::NonZeroU32;
    use std::path::Path;
    use velocast_protocol::{
        CompositionManifest, RenderJob, RenderMode, RendererAcceleration, RendererAssemblyMode,
        RendererConcurrency,
    };

    fn composition(duration_frames: u32) -> CompositionManifest {
        CompositionManifest {
            id: "hero".to_string(),
            width: 1920,
            height: 1080,
            fps: 30,
            duration_frames,
            target: Some("#hero".to_string()),
            url: None,
            max_concurrency: NonZeroU32::new(4),
        }
    }

    fn render_job() -> RenderJob {
        RenderJob {
            operation: velocast_protocol::RenderOperation::Render,
            output_frame: None,
            output_range: None,
            result_path: None,
            render_session: None,
            mode: RenderMode::Composition,
            composition_id: Some("hero".to_string()),
            composition: None,
            serve_url: "http://127.0.0.1:4545".to_string(),
            selector: None,
            output: "renders/hero.mp4".to_string(),
            codec: "h264".to_string(),
            pixel_format: None,
            bitrate_bps: Some(12_000_000),
            acceleration: RendererAcceleration::Required,
            concurrency: Some(RendererConcurrency::Workers(NonZeroU32::new(3).unwrap())),
            assembly_mode: RendererAssemblyMode::Segments,
            capture_probe: None,
            report_path: Some("renders/hero.report.json".to_string()),
            worker_report_path: None,
            verify_segments: true,
            input_props_path: None,
            frame_start: None,
            frame_end: None,
            frame_step: None,
            chunk_output: None,
            event_log_path: Some("renders/hero.events.jsonl".to_string()),
        }
    }

    fn expected_required_gpu_backend_plan() -> (
        BackendKind,
        RenderPipelineCaptureMode,
        RenderPipelineConversionMode,
        RenderPipelineEncoderMode,
        &'static str,
    ) {
        (
            BackendKind::WindowsD3D11Amf,
            RenderPipelineCaptureMode::WindowsD3D11SharedTexture,
            RenderPipelineConversionMode::D3D11VideoProcessor,
            RenderPipelineEncoderMode::WindowsD3D11Ffmpeg,
            "h264_amf",
        )
    }

    #[test]
    fn full_render_pipeline_plan_materializes_segment_paths_reports_and_probe_tier() {
        let (
            expected_backend,
            expected_capture_mode,
            expected_conversion_mode,
            expected_encoder_mode,
            expected_encoder_backend,
        ) = expected_required_gpu_backend_plan();
        let plan = RenderPipelinePlan::for_coordinator(
            &render_job(),
            &composition(90),
            8,
            42,
            BrowserSurfaceMode::Accelerated,
            &crate::encoder_plan::EncoderCapabilities::windows(),
        )
        .expect("segment plan");

        assert_eq!(plan.route, RenderPipelineRoute::ParallelSegments);
        assert_eq!(plan.effective_concurrency, 3);
        assert_eq!(plan.output.final_output, Path::new("renders/hero.mp4"));
        assert_eq!(
            plan.output.temp_output,
            Path::new("renders/.velocast/tmp/hero-42/hero.final.mp4")
        );
        assert_eq!(plan.segments.len(), 3);
        assert_eq!(plan.segments[0].range.start, 0);
        assert_eq!(plan.segments[0].range.end, 30);
        assert_eq!(
            plan.segments[0].output,
            Path::new("renders/.velocast/tmp/hero-42/segment-0000.mp4")
        );
        assert_eq!(
            plan.segments[0].telemetry_report,
            Path::new("renders/.velocast/tmp/hero-42/segment-0000.report.json")
        );
        assert_eq!(
            plan.segments[0].worker_report.as_deref(),
            Some(Path::new(
                "renders/.velocast/tmp/hero-42/segment-0000.worker-report.json"
            ))
        );
        assert_eq!(plan.probe_tier, SegmentProbeTier::SegmentsAndFinalDeep);
        assert_eq!(
            plan.backend.browser_surface_mode,
            BrowserSurfaceMode::Accelerated
        );
        assert_eq!(plan.backend.selected_backend, expected_backend);
        assert!(!plan.backend.software_fallback);
        assert_eq!(plan.backend.capture_mode, expected_capture_mode);
        assert_eq!(plan.backend.conversion_mode, expected_conversion_mode);
        assert_eq!(plan.backend.encoder_mode, expected_encoder_mode);
        assert_eq!(plan.backend.encoder_backend, expected_encoder_backend);
        assert_eq!(
            plan.backend.encoder_plan.settings.execution_context,
            EncoderExecutionContext::SegmentWorker
        );
        assert_eq!(
            plan.backend.encoder_plan.settings.backend,
            EncoderBackendPreference::HardwareRequired
        );
        assert_eq!(
            plan.event_log_path.as_deref(),
            Some(Path::new("renders/hero.events.jsonl"))
        );
    }

    #[test]
    fn reference_plan_rejects_parallel_concurrency_before_runtime_execution() {
        let mut job = render_job();
        job.assembly_mode = RendererAssemblyMode::Reference;

        let error = RenderPipelinePlan::for_coordinator(
            &job,
            &composition(90),
            8,
            42,
            BrowserSurfaceMode::Accelerated,
            &crate::encoder_plan::EncoderCapabilities::windows(),
        )
        .unwrap_err()
        .to_string();

        assert_eq!(
            error,
            "reference assembly mode cannot run with concurrency greater than 1"
        );
    }
}

#[cfg(test)]
mod wire_label_tests {
    use super::*;
    #[test]
    fn explicit_labels_preserve_existing_serialized_plan_values() {
        assert_eq!(
            serde_json::to_value(RenderPipelineRoute::SerialReference).unwrap(),
            RenderPipelineRoute::SerialReference.as_str()
        );
        assert_eq!(
            serde_json::to_value(RenderPipelineRoute::ParallelSegments).unwrap(),
            RenderPipelineRoute::ParallelSegments.as_str()
        );
        assert_eq!(
            serde_json::to_value(RenderPipelineRoute::StreamedBgraWorkers).unwrap(),
            RenderPipelineRoute::StreamedBgraWorkers.as_str()
        );
        assert_eq!(
            serde_json::to_value(SegmentProbeTier::None).unwrap(),
            SegmentProbeTier::None.as_str()
        );
        assert_eq!(
            serde_json::to_value(SegmentProbeTier::FinalOutputAndBoundaryHashes).unwrap(),
            SegmentProbeTier::FinalOutputAndBoundaryHashes.as_str()
        );
        assert_eq!(
            serde_json::to_value(SegmentProbeTier::SegmentsAndFinalDeep).unwrap(),
            SegmentProbeTier::SegmentsAndFinalDeep.as_str()
        );
        assert_eq!(
            serde_json::to_value(RenderPipelineCaptureMode::SoftwareBgra).unwrap(),
            RenderPipelineCaptureMode::SoftwareBgra.as_str()
        );
        assert_eq!(
            serde_json::to_value(RenderPipelineCaptureMode::AcceleratedGpuSurface).unwrap(),
            RenderPipelineCaptureMode::AcceleratedGpuSurface.as_str()
        );
        assert_eq!(
            serde_json::to_value(RenderPipelineCaptureMode::WindowsD3D11SharedTexture).unwrap(),
            RenderPipelineCaptureMode::WindowsD3D11SharedTexture.as_str()
        );
        assert_eq!(
            serde_json::to_value(RenderPipelineConversionMode::Software).unwrap(),
            RenderPipelineConversionMode::Software.as_str()
        );
        assert_eq!(
            serde_json::to_value(RenderPipelineConversionMode::CpuBgraReadback).unwrap(),
            RenderPipelineConversionMode::CpuBgraReadback.as_str()
        );
        assert_eq!(
            serde_json::to_value(RenderPipelineConversionMode::D3D11VideoProcessor).unwrap(),
            RenderPipelineConversionMode::D3D11VideoProcessor.as_str()
        );
        assert_eq!(
            serde_json::to_value(RenderPipelineEncoderMode::RawBgraFfmpegStdin).unwrap(),
            RenderPipelineEncoderMode::RawBgraFfmpegStdin.as_str()
        );
        assert_eq!(
            serde_json::to_value(RenderPipelineEncoderMode::WindowsD3D11Ffmpeg).unwrap(),
            RenderPipelineEncoderMode::WindowsD3D11Ffmpeg.as_str()
        );
    }
}
