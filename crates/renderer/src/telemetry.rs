use serde::{Deserialize, Serialize};
use std::path::Path;
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RenderModeLabel {
    CompositionInspection,
    FramePng,
    ReferenceWebCodecs,
    ParallelSegments,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WebCodecsTelemetry {
    pub codec: String,
    pub hardware_acceleration: String,
    pub hardware_encoder_verified: bool,
    pub uncompressed_readback_verified: bool,
    pub color_space: Option<serde_json::Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BackendDiagnosticTelemetry {
    pub backend: String,
    pub available: bool,
    pub unavailable_code: Option<String>,
    pub unavailable_reason: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AudioTelemetry {
    pub sample_rate: u64,
    pub duration_samples: u64,
    pub pcm_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codec: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoded_sample_rate: Option<u64>,
    #[serde(default)]
    pub codec_fallback_used: bool,
    pub mix_ms: u128,
    pub mux_ms: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RenderTelemetry {
    pub mode: RenderModeLabel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webcodecs: Option<WebCodecsTelemetry>,
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
}

impl RenderTelemetry {
    pub fn new(mode: RenderModeLabel) -> Self {
        Self {
            mode,
            webcodecs: None,
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
        }
    }

    pub fn mark_finished(&mut self, total_wall_ms: u128) {
        self.total_wall_ms = total_wall_ms;
        self.effective_fps_millis = if total_wall_ms == 0 {
            0
        } else {
            ((u128::from(self.frames_encoded) * 1_000_000) / total_wall_ms).min(u64::MAX as u128)
                as u64
        };
    }
    pub fn merge_worker(&mut self, worker: &Self) {
        self.frames_rendered += worker.frames_rendered;
        self.frames_encoded += worker.frames_encoded;
        self.frame_render_wait_ms += worker.frame_render_wait_ms;
        self.encoder_submit_ms += worker.encoder_submit_ms;
        self.page_load_ms += worker.page_load_ms;
        self.cpu_readback_frames += worker.cpu_readback_frames;
        self.dropped_frames += worker.dropped_frames;
        self.stale_frames += worker.stale_frames;
    }
}
pub async fn write_report(path: &Path, report: &RenderTelemetry) -> anyhow::Result<()> {
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(path, serde_json::to_vec_pretty(report)?).await?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn report_does_not_claim_hardware_selection() {
        let mut t = RenderTelemetry::new(RenderModeLabel::ReferenceWebCodecs);
        t.frames_encoded = 60;
        t.mark_finished(2000);
        assert_eq!(t.effective_fps_millis, 30000);
        assert!(t.webcodecs.is_none());
    }
}
