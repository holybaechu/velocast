use serde::{Deserialize, Serialize};
use std::path::Path;
use tokio::io::AsyncWriteExt;

use crate::pipeline::backend_registry::{
    required_gpu_backend_for_telemetry, required_gpu_capture_backend_known,
    required_gpu_capture_probe_validation, required_gpu_conversion_backend_known,
    required_gpu_encoder_backend_known, BackendSelectionDiagnostic, CaptureProbeValidation,
};

const MIXED_SEGMENT_WORKERS: &str = "mixed_segment_workers";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Aggregate<T> {
    Empty,
    Single(T),
    Mixed,
}

impl<T: Eq> Aggregate<T> {
    pub fn merge(&mut self, value: Aggregate<T>) {
        match value {
            Self::Empty => self.merge_option(None),
            Self::Single(value) => self.merge_option(Some(value)),
            Self::Mixed => *self = Self::Mixed,
        }
    }

    pub fn merge_option(&mut self, value: Option<T>) {
        match self {
            Self::Empty => {
                if let Some(value) = value {
                    *self = Self::Single(value);
                }
            }
            Self::Single(current) => match value {
                Some(value) if current == &value => {}
                Some(_) | None => *self = Self::Mixed,
            },
            Self::Mixed => {}
        }
    }
}

macro_rules! pipeline_label {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq, Eq)]
        pub struct $name(String);

        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                Self(value.to_string())
            }
        }

        impl From<String> for $name {
            fn from(value: String) -> Self {
                Self(value)
            }
        }

        impl From<$name> for String {
            fn from(value: $name) -> Self {
                value.0
            }
        }
    };
}

pipeline_label!(CaptureBackendFact);
pipeline_label!(ConversionBackendFact);
pipeline_label!(EncoderBackendFact);
pipeline_label!(SurfaceFormatFact);
pipeline_label!(CodecFact);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelineFacts {
    pub capture_backend: Aggregate<CaptureBackendFact>,
    pub conversion_backend: Aggregate<ConversionBackendFact>,
    pub encoder_backend: Aggregate<EncoderBackendFact>,
    pub surface_format_in: Aggregate<SurfaceFormatFact>,
    pub surface_format_encoder: Aggregate<SurfaceFormatFact>,
    pub requested_codec: Aggregate<CodecFact>,
    pub selected_codec: Aggregate<CodecFact>,
    pub target_bitrate_bps: Aggregate<u64>,
}

impl PipelineFacts {
    pub fn from_telemetry(telemetry: &RenderTelemetry) -> Self {
        Self {
            capture_backend: aggregate_label(&telemetry.capture_backend),
            conversion_backend: aggregate_label(&telemetry.conversion_backend),
            encoder_backend: aggregate_label(&telemetry.encoder_backend),
            surface_format_in: aggregate_label(&telemetry.surface_format_in),
            surface_format_encoder: aggregate_label(&telemetry.surface_format_encoder),
            requested_codec: aggregate_label(&telemetry.requested_codec),
            selected_codec: aggregate_label(&telemetry.selected_codec),
            target_bitrate_bps: aggregate_value(telemetry.target_bitrate_bps),
        }
    }

    pub fn merge_worker_report(&mut self, worker: &RenderTelemetry) {
        self.capture_backend
            .merge(aggregate_label(&worker.capture_backend));
        self.conversion_backend
            .merge(aggregate_label(&worker.conversion_backend));
        self.encoder_backend
            .merge(aggregate_label(&worker.encoder_backend));
        self.surface_format_in
            .merge(aggregate_label(&worker.surface_format_in));
        self.surface_format_encoder
            .merge(aggregate_label(&worker.surface_format_encoder));
        self.requested_codec
            .merge(aggregate_label(&worker.requested_codec));
        self.selected_codec
            .merge(aggregate_label(&worker.selected_codec));
        self.target_bitrate_bps
            .merge(aggregate_value(worker.target_bitrate_bps));
    }

    pub fn apply_to_telemetry(&self, telemetry: &mut RenderTelemetry) {
        telemetry.capture_backend = aggregate_label_to_legacy(&self.capture_backend);
        telemetry.conversion_backend = aggregate_label_to_legacy(&self.conversion_backend);
        telemetry.encoder_backend = aggregate_label_to_legacy(&self.encoder_backend);
        telemetry.surface_format_in = aggregate_label_to_legacy(&self.surface_format_in);
        telemetry.surface_format_encoder = aggregate_label_to_legacy(&self.surface_format_encoder);
        telemetry.requested_codec = aggregate_label_to_legacy(&self.requested_codec);
        telemetry.selected_codec = aggregate_label_to_legacy(&self.selected_codec);
        telemetry.target_bitrate_bps = aggregate_value_to_option(&self.target_bitrate_bps);
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RenderModeLabel {
    CompositionInspection,
    FramePng,
    ReferenceGpu,
    ParallelSegments,
    StreamedBgraWorkers,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BackendDiagnosticTelemetry {
    pub backend: String,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

impl BackendDiagnosticTelemetry {
    pub fn from_selection_diagnostic(diagnostic: &BackendSelectionDiagnostic) -> Self {
        Self {
            backend: diagnostic.backend.to_string(),
            available: diagnostic.available,
            unavailable_code: diagnostic.unavailable_code().map(str::to_string),
            unavailable_reason: diagnostic.unavailable_reason().map(str::to_string),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AudioTelemetry {
    pub sample_rate: u64,
    pub duration_samples: u64,
    pub pcm_sha256: String,
    pub mix_ms: u128,
    pub mux_ms: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RenderTelemetry {
    pub mode: RenderModeLabel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio: Option<AudioTelemetry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capture_probe: Option<String>,
    pub capture_backend: Option<String>,
    pub conversion_backend: Option<String>,
    pub encoder_backend: Option<String>,
    pub surface_format_in: Option<String>,
    pub surface_format_encoder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_codec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_codec: Option<String>,
    pub target_bitrate_bps: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worker_backend_compatibility: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worker_backend_incompatibility_reason: Option<String>,
    pub cpu_readback_frames: u64,
    pub dropped_frames: u64,
    pub stale_frames: u64,
    pub fallback_used: bool,
    pub fallback_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub backend_diagnostics: Vec<BackendDiagnosticTelemetry>,
    pub frames_expected: u32,
    pub frames_rendered: u32,
    pub frames_encoded: u32,
    pub page_load_ms: u128,
    pub composition_discovery_ms: u128,
    pub frame_render_wait_ms: u128,
    // Diagnostic subdivisions of frame_render_wait_ms, not additional wall time.
    #[serde(default)]
    pub browser_script_wait_ms: u128,
    #[serde(default)]
    pub initial_post_render_paint_wait_ms: u128,
    #[serde(default)]
    pub capture_generation_wait_ms: u128,
    #[serde(default)]
    pub capture_generation_paints_observed: u64,
    #[serde(default)]
    pub capture_generation_settle_paints_discarded: u64,
    pub surface_queue_wait_ms: u128,
    pub gpu_import_ms: u128,
    pub gpu_conversion_ms: u128,
    pub gpu_sync_wait_ms: u128,
    pub encoder_submit_ms: u128,
    pub packet_write_ms: u128,
    pub mux_or_remux_ms: u128,
    pub total_wall_ms: u128,
    pub effective_fps_millis: u64,
    #[serde(skip)]
    pipeline_facts: Option<PipelineFacts>,
}

impl RenderTelemetry {
    pub fn new(mode: RenderModeLabel) -> Self {
        Self {
            mode,
            audio: None,
            capture_probe: None,
            capture_backend: None,
            conversion_backend: None,
            encoder_backend: None,
            surface_format_in: None,
            surface_format_encoder: None,
            requested_codec: None,
            selected_codec: None,
            target_bitrate_bps: None,
            worker_backend_compatibility: None,
            worker_backend_incompatibility_reason: None,
            cpu_readback_frames: 0,
            dropped_frames: 0,
            stale_frames: 0,
            fallback_used: false,
            fallback_reason: None,
            backend_diagnostics: Vec::new(),
            frames_expected: 0,
            frames_rendered: 0,
            frames_encoded: 0,
            page_load_ms: 0,
            composition_discovery_ms: 0,
            frame_render_wait_ms: 0,
            browser_script_wait_ms: 0,
            initial_post_render_paint_wait_ms: 0,
            capture_generation_wait_ms: 0,
            capture_generation_paints_observed: 0,
            capture_generation_settle_paints_discarded: 0,
            surface_queue_wait_ms: 0,
            gpu_import_ms: 0,
            gpu_conversion_ms: 0,
            gpu_sync_wait_ms: 0,
            encoder_submit_ms: 0,
            packet_write_ms: 0,
            mux_or_remux_ms: 0,
            total_wall_ms: 0,
            effective_fps_millis: 0,
            pipeline_facts: None,
        }
    }

    pub fn record_capture_surface_metadata(
        &mut self,
        metadata: &crate::surface::CapturedSurfaceMetadata,
    ) {
        merge_segment_field_value(&mut self.capture_backend, metadata.capture_backend);
        merge_segment_field_value(&mut self.surface_format_in, metadata.surface_format_in);
    }

    pub fn record_fallback(&mut self, reason: impl Into<String>) {
        self.fallback_used = true;
        if self.fallback_reason.is_none() {
            self.fallback_reason = Some(reason.into());
        }
    }

    pub fn record_backend_diagnostics(
        &mut self,
        diagnostics: impl IntoIterator<Item = BackendDiagnosticTelemetry>,
    ) {
        for diagnostic in diagnostics {
            if !self
                .backend_diagnostics
                .iter()
                .any(|existing| existing == &diagnostic)
            {
                self.backend_diagnostics.push(diagnostic);
            }
        }
    }

    pub fn record_worker_compatibility(&mut self) {
        self.worker_backend_compatibility = Some("compatible".to_string());
        self.worker_backend_incompatibility_reason = None;
    }

    pub fn record_worker_incompatibility(&mut self, reason: impl Into<String>) {
        self.worker_backend_compatibility = Some("incompatible".to_string());
        self.worker_backend_incompatibility_reason = Some(reason.into());
    }

    pub fn merge_segment_worker_report(&mut self, worker: &Self) {
        self.mode = RenderModeLabel::ParallelSegments;
        let mut facts = self
            .pipeline_facts
            .take()
            .unwrap_or_else(|| PipelineFacts::from_telemetry(self));
        facts.merge_worker_report(worker);
        facts.apply_to_telemetry(self);
        self.pipeline_facts = Some(facts);
        self.cpu_readback_frames += worker.cpu_readback_frames;
        self.dropped_frames += worker.dropped_frames;
        self.stale_frames += worker.stale_frames;
        self.frames_rendered += worker.frames_rendered;
        self.frames_encoded += worker.frames_encoded;
        self.page_load_ms += worker.page_load_ms;
        self.composition_discovery_ms += worker.composition_discovery_ms;
        self.frame_render_wait_ms += worker.frame_render_wait_ms;
        self.browser_script_wait_ms += worker.browser_script_wait_ms;
        self.initial_post_render_paint_wait_ms += worker.initial_post_render_paint_wait_ms;
        self.capture_generation_wait_ms += worker.capture_generation_wait_ms;
        self.capture_generation_paints_observed += worker.capture_generation_paints_observed;
        self.capture_generation_settle_paints_discarded +=
            worker.capture_generation_settle_paints_discarded;
        self.surface_queue_wait_ms += worker.surface_queue_wait_ms;
        self.gpu_import_ms += worker.gpu_import_ms;
        self.gpu_conversion_ms += worker.gpu_conversion_ms;
        self.gpu_sync_wait_ms += worker.gpu_sync_wait_ms;
        self.encoder_submit_ms += worker.encoder_submit_ms;
        self.packet_write_ms += worker.packet_write_ms;
        if worker.fallback_used {
            self.record_fallback(
                worker
                    .fallback_reason
                    .clone()
                    .unwrap_or_else(|| "segment worker fallback".to_string()),
            );
        }
        self.record_backend_diagnostics(worker.backend_diagnostics.iter().cloned());
    }

    pub fn validate_required_gpu_benchmark(&self) -> anyhow::Result<()> {
        if self.cpu_readback_frames > 0 {
            return Err(anyhow::anyhow!(
                "required GPU benchmark used {} CPU readback frame(s)",
                self.cpu_readback_frames
            ));
        }
        if self.fallback_used {
            return Err(anyhow::anyhow!(
                "required GPU benchmark fell back from the GPU path: {}",
                self.fallback_reason.as_deref().unwrap_or("unknown reason")
            ));
        }
        if let Some(diagnostic) = self.backend_diagnostics.first() {
            let code = diagnostic
                .unavailable_code
                .as_deref()
                .unwrap_or("available");
            return Err(anyhow::anyhow!(
                "required GPU benchmark report carried stale backend_diagnostics: backend={}, code={code}",
                diagnostic.backend
            ));
        }
        if self.frames_expected == 0 {
            return Err(anyhow::anyhow!(
                "required GPU benchmark expected positive frames_expected, got 0"
            ));
        }
        if self.total_wall_ms == 0 {
            return Err(anyhow::anyhow!(
                "required GPU benchmark expected positive total_wall_ms, got 0"
            ));
        }
        if self.frames_rendered != self.frames_expected {
            return Err(anyhow::anyhow!(
                "required GPU benchmark rendered {} frame(s), expected {}",
                self.frames_rendered,
                self.frames_expected
            ));
        }
        if self.frames_encoded != self.frames_expected {
            return Err(anyhow::anyhow!(
                "required GPU benchmark encoded {} frame(s), expected {}",
                self.frames_encoded,
                self.frames_expected
            ));
        }
        Ok(())
    }

    pub fn validate_required_acceleration_path(&self) -> anyhow::Result<()> {
        self.validate_required_gpu_benchmark()?;
        let capture = self.capture_backend.as_deref().unwrap_or("unknown");
        if !required_gpu_capture_backend_known(capture) {
            return Err(anyhow::anyhow!(
                "required GPU benchmark used non-GPU capture backend: {capture}"
            ));
        }

        let conversion = self.conversion_backend.as_deref().unwrap_or("unknown");
        if !required_gpu_conversion_backend_known(capture, conversion) {
            return Err(anyhow::anyhow!(
                "required GPU benchmark used non-GPU conversion backend: {conversion}"
            ));
        }

        let encoder = self.encoder_backend.as_deref().unwrap_or("unknown");
        if !required_gpu_encoder_backend_known(encoder) {
            return Err(anyhow::anyhow!(
                "required GPU benchmark used non-hardware encoder backend: {encoder}"
            ));
        }

        if let Some(requested) = self.requested_codec.as_deref() {
            if self.selected_codec.as_deref() != Some(requested)
                || velocast_renderer_policy::windows_codecs::selected_codec_label(encoder)
                    != Some(requested)
            {
                return Err(anyhow::anyhow!(
                    "required GPU benchmark substituted codec: requested={requested}, selected={:?}, encoder={encoder}",
                    self.selected_codec
                ));
            }
        }

        let _backend = required_gpu_backend_for_telemetry(capture, conversion, encoder).ok_or_else(|| {
            anyhow::anyhow!(
                "required GPU benchmark used incompatible backend path: capture_backend={capture}, conversion_backend={conversion}, encoder_backend={encoder}"
            )
        })?;
        Ok(())
    }

    pub fn validate_required_acceleration(&self) -> anyhow::Result<()> {
        self.validate_required_acceleration_path()?;
        if self.mode == RenderModeLabel::ParallelSegments
            && self.worker_backend_compatibility.as_deref() != Some("compatible")
        {
            return Err(anyhow::anyhow!(
                "required GPU benchmark segment workers were not compatible"
            ));
        }

        Ok(())
    }

    pub fn validate_required_capture_probe(&self) -> anyhow::Result<()> {
        if self.capture_probe.as_deref() != Some("accelerated_paint") {
            return Err(anyhow::anyhow!(
                "required accelerated capture probe did not mark capture_probe=accelerated_paint"
            ));
        }
        let capture_backend = self.capture_backend.as_deref().unwrap_or("unknown");
        let validation = required_gpu_capture_probe_validation(capture_backend).ok_or_else(|| {
            anyhow::anyhow!(
                "required accelerated capture probe did not receive a supported GPU capture backend: {capture_backend}"
            )
        })?;
        if self.surface_format_in.is_none() {
            return Err(anyhow::anyhow!(
                "required accelerated capture probe did not record input surface format"
            ));
        }
        match validation {
            CaptureProbeValidation::GenericGpuSurface => {
                self.validate_required_generic_capture_probe()?;
            }
        }
        if self.frames_expected != 1 {
            return Err(anyhow::anyhow!(
                "required accelerated capture probe expected {} frame(s), expected 1",
                self.frames_expected
            ));
        }
        if self.frames_rendered != 1 {
            return Err(anyhow::anyhow!(
                "required accelerated capture probe rendered {} frame(s), expected 1",
                self.frames_rendered
            ));
        }
        if self.frames_encoded != 0 {
            return Err(anyhow::anyhow!(
                "required accelerated capture probe encoded {} frame(s), expected 0",
                self.frames_encoded
            ));
        }
        if self.encoder_backend.is_some() {
            return Err(anyhow::anyhow!(
                "required accelerated capture probe unexpectedly initialized an encoder"
            ));
        }
        if self.conversion_backend.is_some() {
            return Err(anyhow::anyhow!(
                "required accelerated capture probe unexpectedly initialized conversion"
            ));
        }
        if self.cpu_readback_frames != 0 {
            return Err(anyhow::anyhow!(
                "required accelerated capture probe used {} CPU readback frame(s)",
                self.cpu_readback_frames
            ));
        }
        if self.fallback_used {
            return Err(anyhow::anyhow!(
                "required accelerated capture probe fell back from the GPU path: {}",
                self.fallback_reason.as_deref().unwrap_or("unknown reason")
            ));
        }
        Ok(())
    }

    fn validate_required_generic_capture_probe(&self) -> anyhow::Result<()> {
        Ok(())
    }

    #[allow(dead_code)]
    pub fn mark_finished(&mut self, total_wall_ms: u128) {
        self.total_wall_ms = total_wall_ms;
        if total_wall_ms > 0 {
            self.effective_fps_millis =
                (u128::from(self.frames_encoded) * 1_000_000 / total_wall_ms) as u64;
        }
    }
}

fn merge_segment_field(target: &mut Option<String>, worker: &Option<String>) {
    match (target.as_deref(), worker.as_deref()) {
        (None, Some(value)) => *target = Some(value.to_string()),
        (Some(current), Some(value)) if current == value || current == MIXED_SEGMENT_WORKERS => {}
        (Some(_), Some(_)) | (Some(_), None) => {
            *target = Some(MIXED_SEGMENT_WORKERS.to_string());
        }
        (None, None) => {}
    }
}

fn merge_segment_field_value(target: &mut Option<String>, value: &str) {
    merge_segment_field(target, &Some(value.to_string()));
}

fn aggregate_label<T>(value: &Option<String>) -> Aggregate<T>
where
    for<'value> T: From<&'value str>,
{
    match value.as_deref() {
        Some(MIXED_SEGMENT_WORKERS) => Aggregate::Mixed,
        Some(value) => Aggregate::Single(T::from(value)),
        None => Aggregate::Empty,
    }
}

fn aggregate_value<T>(value: Option<T>) -> Aggregate<T> {
    match value {
        Some(value) => Aggregate::Single(value),
        None => Aggregate::Empty,
    }
}

fn aggregate_label_to_legacy<T>(aggregate: &Aggregate<T>) -> Option<String>
where
    T: Clone + Into<String>,
{
    match aggregate {
        Aggregate::Empty => None,
        Aggregate::Single(value) => Some(value.clone().into()),
        Aggregate::Mixed => Some(MIXED_SEGMENT_WORKERS.to_string()),
    }
}

fn aggregate_value_to_option<T: Copy>(aggregate: &Aggregate<T>) -> Option<T> {
    match aggregate {
        Aggregate::Single(value) => Some(*value),
        Aggregate::Empty | Aggregate::Mixed => None,
    }
}

pub async fn write_report(path: &Path, telemetry: &RenderTelemetry) -> anyhow::Result<()> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        tokio::fs::create_dir_all(parent).await?;
    }

    let json = serde_json::to_vec_pretty(telemetry)?;
    let mut file = tokio::fs::File::create(path).await?;
    file.write_all(&json).await?;
    file.write_all(b"\n").await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_windows_telemetry(mode: RenderModeLabel) -> RenderTelemetry {
        let mut telemetry = RenderTelemetry::new(mode);
        telemetry.capture_backend = Some("electron_d3d11_shared_texture".into());
        telemetry.conversion_backend = Some("d3d11_video_processor".into());
        telemetry.encoder_backend = Some("h264_mf".into());
        telemetry.surface_format_in = Some("bgra".into());
        telemetry.surface_format_encoder = Some("nv12".into());
        telemetry.requested_codec = Some("h264".into());
        telemetry.selected_codec = Some("h264".into());
        telemetry.frames_expected = 1;
        telemetry.frames_rendered = 1;
        telemetry.frames_encoded = 1;
        telemetry.total_wall_ms = 1;
        telemetry
    }

    #[test]
    fn readiness_stage_metrics_merge_and_accept_older_reports() {
        let mut worker = RenderTelemetry::new(RenderModeLabel::ReferenceGpu);
        worker.browser_script_wait_ms = 7;
        worker.initial_post_render_paint_wait_ms = 3;
        worker.capture_generation_wait_ms = 11;
        worker.capture_generation_paints_observed = 4;
        worker.capture_generation_settle_paints_discarded = 2;
        let mut merged = RenderTelemetry::new(RenderModeLabel::ParallelSegments);
        merged.merge_segment_worker_report(&worker);
        merged.merge_segment_worker_report(&worker);
        assert_eq!(merged.browser_script_wait_ms, 14);
        assert_eq!(merged.initial_post_render_paint_wait_ms, 6);
        assert_eq!(merged.capture_generation_wait_ms, 22);
        assert_eq!(merged.capture_generation_paints_observed, 8);
        assert_eq!(merged.capture_generation_settle_paints_discarded, 4);
        let mut legacy = serde_json::to_value(&worker).unwrap();
        for field in [
            "browser_script_wait_ms",
            "initial_post_render_paint_wait_ms",
            "capture_generation_wait_ms",
            "capture_generation_paints_observed",
            "capture_generation_settle_paints_discarded",
        ] {
            legacy.as_object_mut().unwrap().remove(field);
        }
        let restored: RenderTelemetry = serde_json::from_value(legacy).unwrap();
        assert_eq!(restored.browser_script_wait_ms, 0);
        assert_eq!(restored.capture_generation_paints_observed, 0);
        assert_eq!(restored.capture_generation_settle_paints_discarded, 0);
    }

    #[test]
    fn serializes_backend_truth_report() {
        let mut telemetry = RenderTelemetry::new(RenderModeLabel::ReferenceGpu);
        telemetry.capture_backend = Some("electron_d3d11_shared_texture".to_string());
        telemetry.conversion_backend = Some("d3d11_video_processor".to_string());
        telemetry.encoder_backend = Some("h264_mf".to_string());
        telemetry.surface_format_in = Some("bgra".to_string());
        telemetry.surface_format_encoder = Some("nv12".to_string());
        telemetry.cpu_readback_frames = 0;
        telemetry.dropped_frames = 0;
        telemetry.fallback_used = false;
        telemetry.frames_expected = 240;
        telemetry.frames_encoded = 240;
        telemetry.gpu_import_ms = 2;
        telemetry.gpu_conversion_ms = 3;
        telemetry.gpu_sync_wait_ms = 4;

        let json = serde_json::to_value(&telemetry).unwrap();

        assert_eq!(json["mode"], "reference_gpu");
        assert_eq!(json["capture_backend"], "electron_d3d11_shared_texture");
        assert_eq!(json["conversion_backend"], "d3d11_video_processor");
        assert_eq!(json["encoder_backend"], "h264_mf");
        assert_eq!(json["surface_format_encoder"], "nv12");
        assert_eq!(json["cpu_readback_frames"], 0);
        assert_eq!(json["fallback_used"], false);
        assert_eq!(json["frames_expected"], 240);
        assert_eq!(json["frames_encoded"], 240);
        assert_eq!(json["gpu_import_ms"], 2);
        assert_eq!(json["gpu_conversion_ms"], 3);
        assert_eq!(json["gpu_sync_wait_ms"], 4);
    }

    #[test]
    fn serializes_requested_and_selected_codec_when_set() {
        let mut telemetry = RenderTelemetry::new(RenderModeLabel::ReferenceGpu);
        telemetry.requested_codec = Some("hevc".to_string());
        telemetry.selected_codec = Some("hevc".to_string());

        let json = serde_json::to_value(&telemetry).unwrap();

        assert_eq!(json["requested_codec"], "hevc");
        assert_eq!(json["selected_codec"], "hevc");
    }

    #[test]
    fn records_generic_capture_surface_metadata() {
        let mut telemetry = RenderTelemetry::new(RenderModeLabel::ReferenceGpu);
        let metadata = crate::surface::CapturedSurfaceMetadata::generic(
            "electron_d3d11_shared_texture",
            "bgra",
        );

        telemetry.record_capture_surface_metadata(&metadata);

        assert_eq!(
            telemetry.capture_backend.as_deref(),
            Some("electron_d3d11_shared_texture")
        );
        assert_eq!(telemetry.surface_format_in.as_deref(), Some("bgra"));
    }

    #[test]
    fn required_capture_probe_rejects_encoded_or_incomplete_probe() {
        let mut telemetry = RenderTelemetry::new(RenderModeLabel::ReferenceGpu);
        telemetry.capture_probe = Some("accelerated_paint".to_string());
        telemetry.capture_backend = Some("electron_d3d11_shared_texture".to_string());
        telemetry.surface_format_in = Some("bgra".to_string());
        telemetry.frames_expected = 1;
        telemetry.frames_rendered = 1;

        telemetry.validate_required_capture_probe().unwrap();

        let mut encoded = telemetry.clone();
        encoded.encoder_backend = Some("h264_mf".to_string());
        encoded.frames_encoded = 1;
        let error = encoded
            .validate_required_capture_probe()
            .unwrap_err()
            .to_string();
        assert_eq!(
            error,
            "required accelerated capture probe encoded 1 frame(s), expected 0"
        );

        let mut missing_probe = telemetry.clone();
        missing_probe.capture_probe = None;
        let error = missing_probe
            .validate_required_capture_probe()
            .unwrap_err()
            .to_string();
        assert_eq!(
            error,
            "required accelerated capture probe did not mark capture_probe=accelerated_paint"
        );

        let mut missing_input_format = telemetry;
        missing_input_format.surface_format_in = None;
        let error = missing_input_format
            .validate_required_capture_probe()
            .unwrap_err()
            .to_string();
        assert_eq!(
            error,
            "required accelerated capture probe did not record input surface format"
        );
    }

    #[test]
    fn required_capture_probe_accepts_descriptor_configured_gpu_capture() {
        let mut telemetry = RenderTelemetry::new(RenderModeLabel::ReferenceGpu);
        telemetry.capture_probe = Some("accelerated_paint".to_string());
        telemetry.capture_backend = Some("electron_d3d11_shared_texture".to_string());
        telemetry.surface_format_in = Some("bgra".to_string());
        telemetry.frames_expected = 1;
        telemetry.frames_rendered = 1;

        telemetry.validate_required_capture_probe().unwrap();
    }

    #[test]
    fn required_capture_probe_rejects_non_gpu_or_mismatched_surface_metadata() {
        let mut telemetry = RenderTelemetry::new(RenderModeLabel::ReferenceGpu);
        telemetry.capture_probe = Some("accelerated_paint".to_string());
        telemetry.capture_backend = Some("electron_software_bgra".to_string());
        telemetry.surface_format_in = Some("bgra".to_string());
        telemetry.frames_expected = 1;
        telemetry.frames_rendered = 1;

        let error = telemetry
            .validate_required_capture_probe()
            .unwrap_err()
            .to_string();
        assert_eq!(
            error,
            "required accelerated capture probe did not receive a supported GPU capture backend: electron_software_bgra"
        );
    }

    #[test]
    fn serializes_target_bitrate_for_quality_regression_checks() {
        let telemetry = RenderTelemetry::new(RenderModeLabel::ReferenceGpu);
        let json = serde_json::to_value(&telemetry).unwrap();

        assert!(json.get("target_bitrate_bps").is_some());
    }

    #[test]
    fn omits_empty_backend_diagnostics_from_reports() {
        let telemetry = RenderTelemetry::new(RenderModeLabel::ReferenceGpu);
        let json = serde_json::to_value(&telemetry).unwrap();

        assert!(json.get("backend_diagnostics").is_none());
    }

    #[test]
    fn serializes_structured_backend_diagnostics_when_present() {
        let mut telemetry = RenderTelemetry::new(RenderModeLabel::ReferenceGpu);
        telemetry.record_backend_diagnostics([BackendDiagnosticTelemetry {
            backend: "windows_d3d11_mf".to_string(),
            available: false,
            unavailable_code: Some("platform.device_unavailable".to_string()),
            unavailable_reason: Some("D3D11 device unavailable".to_string()),
        }]);

        let json = serde_json::to_value(&telemetry).unwrap();

        assert_eq!(
            json["backend_diagnostics"][0]["backend"],
            "windows_d3d11_mf"
        );
        assert_eq!(json["backend_diagnostics"][0]["available"], false);
        assert_eq!(
            json["backend_diagnostics"][0]["unavailable_code"],
            "platform.device_unavailable"
        );
        assert_eq!(
            json["backend_diagnostics"][0]["unavailable_reason"],
            "D3D11 device unavailable"
        );
    }

    #[test]
    fn required_gpu_benchmark_rejects_stale_backend_diagnostics() {
        let mut telemetry = RenderTelemetry::new(RenderModeLabel::ReferenceGpu);
        telemetry.record_backend_diagnostics([BackendDiagnosticTelemetry {
            backend: "windows_d3d11_mf".to_string(),
            available: false,
            unavailable_code: Some("platform.device_unavailable".to_string()),
            unavailable_reason: Some("D3D11 device unavailable".to_string()),
        }]);

        let error = telemetry
            .validate_required_gpu_benchmark()
            .unwrap_err()
            .to_string();

        assert!(error.contains("backend_diagnostics"), "{error}");
        assert!(error.contains("windows_d3d11_mf"), "{error}");
        assert!(error.contains("platform.device_unavailable"), "{error}");
    }

    #[test]
    fn required_gpu_benchmark_rejects_zero_frame_count() {
        let telemetry = RenderTelemetry::new(RenderModeLabel::ReferenceGpu);

        let error = telemetry
            .validate_required_gpu_benchmark()
            .unwrap_err()
            .to_string();

        assert_eq!(
            error,
            "required GPU benchmark expected positive frames_expected, got 0"
        );
    }

    #[test]
    fn required_gpu_benchmark_rejects_zero_wall_time() {
        let mut telemetry = RenderTelemetry::new(RenderModeLabel::ReferenceGpu);
        telemetry.frames_expected = 1;
        telemetry.frames_rendered = 1;
        telemetry.frames_encoded = 1;

        let error = telemetry
            .validate_required_gpu_benchmark()
            .unwrap_err()
            .to_string();

        assert_eq!(
            error,
            "required GPU benchmark expected positive total_wall_ms, got 0"
        );
    }

    #[test]
    fn records_fallback_reason_once() {
        let mut telemetry = RenderTelemetry::new(RenderModeLabel::ReferenceGpu);

        telemetry.record_fallback("D3D11 FFmpeg encoder unavailable");
        telemetry.record_fallback("second reason");

        assert!(telemetry.fallback_used);
        assert_eq!(
            telemetry.fallback_reason.as_deref(),
            Some("D3D11 FFmpeg encoder unavailable")
        );
    }

    #[test]
    fn required_gpu_benchmark_rejects_readback_or_fallback() {
        let mut telemetry = RenderTelemetry::new(RenderModeLabel::ReferenceGpu);
        telemetry.cpu_readback_frames = 1;

        let error = telemetry
            .validate_required_gpu_benchmark()
            .unwrap_err()
            .to_string();

        assert_eq!(error, "required GPU benchmark used 1 CPU readback frame(s)");

        let mut telemetry = RenderTelemetry::new(RenderModeLabel::ReferenceGpu);
        telemetry.record_fallback("raw encoder selected");

        let error = telemetry
            .validate_required_gpu_benchmark()
            .unwrap_err()
            .to_string();

        assert_eq!(
            error,
            "required GPU benchmark fell back from the GPU path: raw encoder selected"
        );
    }

    #[test]
    fn shader_report_does_not_bypass_the_zero_readback_gate() {
        let mut report = RenderTelemetry::new(RenderModeLabel::ReferenceGpu);
        report.capture_backend = Some("electron_d3d11_shared_texture".into());
        report.conversion_backend = Some("d3d11_shader_nv12".into());
        report.encoder_backend = Some("h264_mf".into());
        report.cpu_readback_frames = 1;
        assert_eq!(
            report
                .validate_required_gpu_benchmark()
                .unwrap_err()
                .to_string(),
            "required GPU benchmark used 1 CPU readback frame(s)"
        );
    }

    #[test]
    fn pipeline_facts_tracks_single_mixed_and_empty_states() {
        let mut first = RenderTelemetry::new(RenderModeLabel::ParallelSegments);
        first.capture_backend = Some("electron_d3d11_shared_texture".to_string());
        first.conversion_backend = Some("d3d11_video_processor".to_string());
        first.encoder_backend = Some("h264_mf".to_string());
        first.surface_format_in = Some("bgra".to_string());
        first.target_bitrate_bps = Some(60_000_000);

        let mut second = RenderTelemetry::new(RenderModeLabel::ParallelSegments);
        second.capture_backend = Some("electron_d3d11_shared_texture".to_string());
        second.conversion_backend = Some("cpu_bgra_readback".to_string());
        second.encoder_backend = Some("raw_bgra_ffmpeg_stdin".to_string());
        second.surface_format_in = Some("bgra".to_string());

        let mut facts =
            PipelineFacts::from_telemetry(&RenderTelemetry::new(RenderModeLabel::ParallelSegments));
        facts.merge_worker_report(&first);
        facts.merge_worker_report(&second);

        assert!(matches!(facts.capture_backend, Aggregate::Single(_)));
        assert!(matches!(facts.conversion_backend, Aggregate::Mixed));
        assert!(matches!(facts.encoder_backend, Aggregate::Mixed));
        assert!(matches!(facts.surface_format_in, Aggregate::Single(_)));
        assert!(matches!(facts.surface_format_encoder, Aggregate::Empty));
        assert!(matches!(facts.target_bitrate_bps, Aggregate::Mixed));

        let mut coordinator = RenderTelemetry::new(RenderModeLabel::ParallelSegments);
        facts.apply_to_telemetry(&mut coordinator);

        assert_eq!(
            coordinator.capture_backend.as_deref(),
            Some("electron_d3d11_shared_texture")
        );
        assert_eq!(
            coordinator.conversion_backend.as_deref(),
            Some(MIXED_SEGMENT_WORKERS)
        );
        assert_eq!(coordinator.target_bitrate_bps, None);
    }

    #[test]
    fn merge_segment_worker_report_preserves_numeric_mixed_state_across_workers() {
        let mut coordinator = RenderTelemetry::new(RenderModeLabel::ParallelSegments);
        let mut first = RenderTelemetry::new(RenderModeLabel::ParallelSegments);
        first.target_bitrate_bps = Some(60_000_000);

        let mut second = RenderTelemetry::new(RenderModeLabel::ParallelSegments);
        second.target_bitrate_bps = Some(80_000_000);

        let mut third = RenderTelemetry::new(RenderModeLabel::ParallelSegments);
        third.target_bitrate_bps = Some(60_000_000);

        coordinator.merge_segment_worker_report(&first);
        coordinator.merge_segment_worker_report(&second);
        coordinator.merge_segment_worker_report(&third);

        assert_eq!(coordinator.target_bitrate_bps, None);
        let facts = coordinator.pipeline_facts.as_ref().unwrap();
        assert!(matches!(facts.target_bitrate_bps, Aggregate::Mixed));
    }

    #[test]
    fn merge_segment_worker_report_treats_legacy_mixed_labels_as_mixed_facts() {
        let mut coordinator = RenderTelemetry::new(RenderModeLabel::ParallelSegments);
        let mut aggregated_worker = RenderTelemetry::new(RenderModeLabel::ParallelSegments);
        aggregated_worker.encoder_backend = Some(MIXED_SEGMENT_WORKERS.to_string());

        coordinator.merge_segment_worker_report(&aggregated_worker);

        let facts = coordinator.pipeline_facts.as_ref().unwrap();
        assert!(matches!(facts.encoder_backend, Aggregate::Mixed));
        assert_eq!(
            coordinator.encoder_backend.as_deref(),
            Some(MIXED_SEGMENT_WORKERS)
        );
    }

    #[test]
    fn aggregates_segment_worker_truth_into_coordinator_report() {
        let mut coordinator = RenderTelemetry::new(RenderModeLabel::ParallelSegments);
        coordinator.frames_expected = 4;

        let mut gpu_worker = RenderTelemetry::new(RenderModeLabel::ParallelSegments);
        gpu_worker.capture_backend = Some("electron_d3d11_shared_texture".to_string());
        gpu_worker.conversion_backend = Some("d3d11_video_processor".to_string());
        gpu_worker.encoder_backend = Some("h264_mf".to_string());
        gpu_worker.surface_format_in = Some("bgra".to_string());
        gpu_worker.surface_format_encoder = Some("nv12".to_string());
        gpu_worker.frames_expected = 2;
        gpu_worker.frames_rendered = 2;
        gpu_worker.frames_encoded = 2;
        gpu_worker.page_load_ms = 10;
        gpu_worker.frame_render_wait_ms = 20;
        gpu_worker.gpu_import_ms = 4;
        gpu_worker.gpu_conversion_ms = 5;
        gpu_worker.gpu_sync_wait_ms = 6;
        gpu_worker.encoder_submit_ms = 30;

        let mut raw_worker = RenderTelemetry::new(RenderModeLabel::ParallelSegments);
        raw_worker.capture_backend = Some("electron_d3d11_shared_texture".to_string());
        raw_worker.conversion_backend = Some("cpu_bgra_readback".to_string());
        raw_worker.encoder_backend = Some("raw_bgra_ffmpeg_stdin".to_string());
        raw_worker.surface_format_in = Some("bgra".to_string());
        raw_worker.surface_format_encoder = Some("yuv444p".to_string());
        raw_worker.cpu_readback_frames = 2;
        raw_worker.frames_expected = 2;
        raw_worker.frames_rendered = 2;
        raw_worker.frames_encoded = 2;
        raw_worker.page_load_ms = 1;
        raw_worker.frame_render_wait_ms = 2;
        raw_worker.gpu_import_ms = 1;
        raw_worker.gpu_conversion_ms = 2;
        raw_worker.gpu_sync_wait_ms = 3;
        raw_worker.encoder_submit_ms = 3;
        raw_worker.record_fallback("D3D11 unavailable");

        coordinator.merge_segment_worker_report(&gpu_worker);
        coordinator.merge_segment_worker_report(&raw_worker);

        assert_eq!(coordinator.frames_rendered, 4);
        assert_eq!(coordinator.frames_encoded, 4);
        assert_eq!(coordinator.cpu_readback_frames, 2);
        assert_eq!(coordinator.page_load_ms, 11);
        assert_eq!(coordinator.frame_render_wait_ms, 22);
        assert_eq!(coordinator.gpu_import_ms, 5);
        assert_eq!(coordinator.gpu_conversion_ms, 7);
        assert_eq!(coordinator.gpu_sync_wait_ms, 9);
        assert_eq!(coordinator.encoder_submit_ms, 33);
        assert!(coordinator.fallback_used);
        assert_eq!(
            coordinator.fallback_reason.as_deref(),
            Some("D3D11 unavailable")
        );
        assert_eq!(
            coordinator.capture_backend.as_deref(),
            Some("electron_d3d11_shared_texture")
        );
        assert_eq!(
            coordinator.conversion_backend.as_deref(),
            Some("mixed_segment_workers")
        );
        assert_eq!(
            coordinator.encoder_backend.as_deref(),
            Some("mixed_segment_workers")
        );
        assert_eq!(coordinator.surface_format_in.as_deref(), Some("bgra"));
        assert_eq!(
            coordinator.surface_format_encoder.as_deref(),
            Some("mixed_segment_workers")
        );
    }

    #[test]
    fn aggregates_backend_diagnostics_from_segment_workers() {
        let mut coordinator = RenderTelemetry::new(RenderModeLabel::ParallelSegments);
        let mut worker = RenderTelemetry::new(RenderModeLabel::ParallelSegments);
        worker.record_backend_diagnostics([BackendDiagnosticTelemetry {
            backend: "windows_d3d11_mf".to_string(),
            available: false,
            unavailable_code: Some("platform.device_unavailable".to_string()),
            unavailable_reason: Some("D3D11 device unavailable".to_string()),
        }]);

        coordinator.merge_segment_worker_report(&worker);
        coordinator.merge_segment_worker_report(&worker);

        assert_eq!(coordinator.backend_diagnostics.len(), 1);
        assert_eq!(
            coordinator.backend_diagnostics[0]
                .unavailable_code
                .as_deref(),
            Some("platform.device_unavailable")
        );
    }

    #[test]
    fn aggregates_mixed_codec_metadata_from_disagreeing_segment_workers() {
        let mut coordinator = RenderTelemetry::new(RenderModeLabel::ParallelSegments);
        let h264_worker = valid_windows_telemetry(RenderModeLabel::ParallelSegments);
        let mut hevc_worker = valid_windows_telemetry(RenderModeLabel::ParallelSegments);
        hevc_worker.encoder_backend = Some("hevc_mf".to_string());
        hevc_worker.requested_codec = Some("hevc".to_string());
        hevc_worker.selected_codec = Some("hevc".to_string());

        coordinator.merge_segment_worker_report(&h264_worker);
        coordinator.merge_segment_worker_report(&hevc_worker);

        assert_eq!(
            coordinator.requested_codec.as_deref(),
            Some(MIXED_SEGMENT_WORKERS)
        );
        assert_eq!(
            coordinator.selected_codec.as_deref(),
            Some(MIXED_SEGMENT_WORKERS)
        );
    }

    #[test]
    fn required_gpu_benchmark_rejects_incomplete_frame_counts() {
        let mut telemetry = RenderTelemetry::new(RenderModeLabel::ParallelSegments);
        telemetry.frames_expected = 4;
        telemetry.frames_rendered = 4;
        telemetry.frames_encoded = 3;
        telemetry.total_wall_ms = 1;

        let error = telemetry
            .validate_required_gpu_benchmark()
            .unwrap_err()
            .to_string();

        assert_eq!(
            error,
            "required GPU benchmark encoded 3 frame(s), expected 4"
        );
    }

    #[test]
    fn records_worker_backend_compatibility_status() {
        let mut telemetry = RenderTelemetry::new(RenderModeLabel::ParallelSegments);

        telemetry.record_worker_compatibility();

        assert_eq!(
            telemetry.worker_backend_compatibility.as_deref(),
            Some("compatible")
        );
        assert_eq!(telemetry.worker_backend_incompatibility_reason, None);

        telemetry.record_worker_incompatibility("mixed_encoder_backend");

        assert_eq!(
            telemetry.worker_backend_compatibility.as_deref(),
            Some("incompatible")
        );
        assert_eq!(
            telemetry.worker_backend_incompatibility_reason.as_deref(),
            Some("mixed_encoder_backend")
        );
    }

    #[test]
    fn required_acceleration_accepts_windows_d3d11_encoder_family() {
        for encoder_backend in windows_d3d11_encoder_labels_for_test() {
            let mut telemetry = RenderTelemetry::new(RenderModeLabel::ReferenceGpu);
            telemetry.capture_backend = Some("electron_d3d11_shared_texture".to_string());
            telemetry.conversion_backend = Some("d3d11_video_processor".to_string());
            telemetry.encoder_backend = Some(encoder_backend.to_string());
            telemetry.surface_format_encoder = Some("nv12".to_string());
            telemetry.requested_codec =
                crate::encode::windows::codecs::selected_codec_label(encoder_backend)
                    .map(str::to_string);
            telemetry.selected_codec = telemetry.requested_codec.clone();
            telemetry.frames_expected = 2;
            telemetry.frames_rendered = 2;
            telemetry.frames_encoded = 2;
            telemetry.total_wall_ms = 1;

            telemetry
                .validate_required_acceleration_path()
                .unwrap_or_else(|error| panic!("{encoder_backend}: {error}"));
        }
    }

    #[test]
    fn required_gpu_validation_rejects_codec_substitution() {
        let mut telemetry = valid_windows_telemetry(RenderModeLabel::ReferenceGpu);
        telemetry.encoder_backend = Some("h264_mf".to_string());
        telemetry.requested_codec = Some("av1".to_string());
        telemetry.selected_codec = Some("h264".to_string());

        let error = telemetry
            .validate_required_acceleration()
            .unwrap_err()
            .to_string();

        assert!(
            error.contains("required GPU benchmark substituted codec"),
            "{error}"
        );
    }

    #[test]
    fn required_gpu_validation_rejects_incompatible_conversion_codec() {
        let mut telemetry = valid_windows_telemetry(RenderModeLabel::ReferenceGpu);
        telemetry.encoder_backend = Some("hevc_mf".to_string());
        telemetry.conversion_backend = Some("d3d11_shader_nv12".to_string());
        telemetry.requested_codec = Some("hevc".into());
        telemetry.selected_codec = Some("hevc".into());

        let error = telemetry
            .validate_required_acceleration()
            .unwrap_err()
            .to_string();

        assert!(error.contains("used incompatible backend path"));
        assert!(error.contains("capture_backend=electron_d3d11_shared_texture"));
        assert!(error.contains("encoder_backend=hevc_mf"));
    }

    #[test]
    fn required_gpu_path_validation_allows_single_segment_worker_without_compatibility_summary() {
        let mut telemetry = RenderTelemetry::new(RenderModeLabel::ParallelSegments);
        telemetry.capture_backend = Some("electron_d3d11_shared_texture".to_string());
        telemetry.conversion_backend = Some("d3d11_video_processor".to_string());
        telemetry.encoder_backend = Some("h264_mf".to_string());
        telemetry.frames_expected = 120;
        telemetry.frames_rendered = 120;
        telemetry.frames_encoded = 120;
        telemetry.total_wall_ms = 1;

        telemetry.validate_required_acceleration_path().unwrap();

        assert!(telemetry.validate_required_acceleration().is_err());
    }

    #[test]
    fn required_gpu_validation_rejects_software_capture() {
        let mut telemetry = RenderTelemetry::new(RenderModeLabel::ReferenceGpu);
        telemetry.capture_backend = Some("electron_software_bgra".to_string());
        telemetry.conversion_backend = Some("software".to_string());
        telemetry.encoder_backend = Some("libx264".to_string());
        telemetry.frames_expected = 1;
        telemetry.frames_rendered = 1;
        telemetry.frames_encoded = 1;
        telemetry.total_wall_ms = 1;

        let error = telemetry
            .validate_required_acceleration()
            .unwrap_err()
            .to_string();

        assert!(error.contains("required GPU benchmark used non-GPU capture backend"));
    }

    fn windows_d3d11_encoder_labels_for_test() -> [&'static str; 12] {
        [
            "h264_amf",
            "h264_nvenc",
            "h264_qsv",
            "h264_mf",
            "hevc_amf",
            "hevc_nvenc",
            "hevc_qsv",
            "hevc_mf",
            "av1_amf",
            "av1_nvenc",
            "av1_qsv",
            "av1_mf",
        ]
    }
}
