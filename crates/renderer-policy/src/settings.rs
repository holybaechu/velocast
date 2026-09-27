#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EncoderBackendPreference {
    Auto,
    Software,
    HardwareRequired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EncoderExecutionContext {
    Reference,
    SegmentWorker,
    StreamedBgraWorker,
}

/// Requested encoding configuration. Host discovery belongs to the native runtime.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncoderSettings {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub codec: String,
    pub pixel_format: String,
    pub bitrate_bps: Option<u64>,
    pub output: String,
    pub backend: EncoderBackendPreference,
    pub execution_context: EncoderExecutionContext,
}

impl EncoderSettings {
    pub fn new(
        width: u32,
        height: u32,
        fps: u32,
        codec: &str,
        pixel_format: &str,
        output: &str,
    ) -> Self {
        Self {
            width,
            height,
            fps,
            codec: codec.to_string(),
            pixel_format: pixel_format.to_string(),
            bitrate_bps: None,
            output: output.to_string(),
            backend: EncoderBackendPreference::Auto,
            execution_context: EncoderExecutionContext::Reference,
        }
    }

    pub fn with_bitrate_bps(mut self, bitrate_bps: u64) -> Self {
        self.bitrate_bps = Some(bitrate_bps);
        self
    }

    pub fn with_execution_context(mut self, context: EncoderExecutionContext) -> Self {
        self.execution_context = context;
        self
    }

    pub fn d3d11_target_bitrate_bps(&self) -> u64 {
        self.bitrate_bps
            .unwrap_or_else(|| default_d3d11_target_bitrate_bps(self.width, self.height, self.fps))
    }
}

pub fn default_d3d11_target_bitrate_bps(width: u32, height: u32, fps: u32) -> u64 {
    const BITS_PER_PIXEL_FRAME_NUMERATOR: u64 = 3;
    const BITS_PER_PIXEL_FRAME_DENOMINATOR: u64 = 25;
    const MIN_BITRATE_BPS: u64 = 8_000_000;
    const MAX_BITRATE_BPS: u64 = 240_000_000;
    const BITRATE_INCREMENT_BPS: u64 = 500_000;
    let pixels_per_second = u64::from(width)
        .saturating_mul(u64::from(height))
        .saturating_mul(u64::from(fps.max(1)));
    let raw_bitrate = pixels_per_second.saturating_mul(BITS_PER_PIXEL_FRAME_NUMERATOR)
        / BITS_PER_PIXEL_FRAME_DENOMINATOR;
    let clamped = raw_bitrate.clamp(MIN_BITRATE_BPS, MAX_BITRATE_BPS);
    clamped
        .div_ceil(BITRATE_INCREMENT_BPS)
        .saturating_mul(BITRATE_INCREMENT_BPS)
}

pub fn hardware_preserves_requested_pixel_format(pixel_format: &str) -> bool {
    matches!(
        pixel_format.to_ascii_lowercase().as_str(),
        "nv12" | "yuv420p"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encoder_plan::{EncoderCapabilities, EncoderPlan};
    fn allows_hardware(settings: &EncoderSettings) -> bool {
        EncoderPlan::resolve(settings.clone(), &EncoderCapabilities::windows()).is_ok_and(|plan| {
            plan.candidates().iter().any(|candidate| {
                candidate.kind() != crate::backend_registry::BackendKind::SoftwareBgraFfmpeg
            })
        })
    }
    #[test]
    fn hardware_pixel_format_policy_accepts_nv12_and_yuv420p() {
        assert!(hardware_preserves_requested_pixel_format("nv12"));
        assert!(hardware_preserves_requested_pixel_format("yuv420p"));
        assert!(!hardware_preserves_requested_pixel_format("yuv444p"));
    }

    #[test]
    fn auto_encoder_settings_prefers_hardware_on_windows_serial_renders() {
        let settings = EncoderSettings::new(1920, 1080, 30, "h264", "nv12", "out.mp4")
            .with_execution_context(EncoderExecutionContext::Reference);

        assert_eq!(settings.backend, EncoderBackendPreference::Auto);
        assert_eq!(allows_hardware(&settings), true);
    }

    #[test]
    fn d3d11_default_target_bitrate_scales_for_4k60_quality() {
        assert_eq!(default_d3d11_target_bitrate_bps(3840, 2160, 60), 60_000_000);
    }

    #[test]
    fn explicit_encoder_bitrate_overrides_d3d11_default() {
        let settings = EncoderSettings::new(3840, 2160, 60, "h264", "nv12", "out.mp4")
            .with_bitrate_bps(80_000_000);

        assert_eq!(settings.d3d11_target_bitrate_bps(), 80_000_000);
    }

    #[test]
    fn auto_encoder_settings_disables_hardware_for_streamed_bgra_worker() {
        let settings = EncoderSettings::new(1920, 1080, 30, "h264", "nv12", "out.mp4")
            .with_execution_context(EncoderExecutionContext::StreamedBgraWorker);

        assert!(!allows_hardware(&settings));
    }

    #[test]
    fn segment_worker_context_allows_hardware_serial_encode() {
        let mut settings = EncoderSettings::new(3840, 2160, 60, "h264", "nv12", "segment.mp4");
        settings.backend = EncoderBackendPreference::HardwareRequired;
        settings.execution_context = EncoderExecutionContext::SegmentWorker;

        assert_eq!(allows_hardware(&settings), true);
    }

    #[test]
    fn streamed_bgra_worker_context_disables_hardware() {
        let mut settings = EncoderSettings::new(3840, 2160, 60, "h264", "nv12", "chunk.bgra");
        settings.backend = EncoderBackendPreference::HardwareRequired;
        settings.execution_context = EncoderExecutionContext::StreamedBgraWorker;

        assert!(!allows_hardware(&settings));
    }

    #[test]
    fn auto_encoder_preserves_quality_default_on_raw_path() {
        let settings = EncoderSettings::new(1920, 1080, 30, "h264", "yuv444p", "out.mp4");

        assert_eq!(allows_hardware(&settings), true);
    }

    #[test]
    fn auto_encoder_allows_hardware_for_explicit_nv12() {
        let settings = EncoderSettings::new(1920, 1080, 30, "h264", "nv12", "out.mp4");

        assert_eq!(allows_hardware(&settings), true);
    }

    #[test]
    fn required_acceleration_uses_hard_hardware_preference() {
        let mut settings = EncoderSettings::new(1920, 1080, 30, "h264", "nv12", "out.mp4");
        settings.backend = EncoderBackendPreference::HardwareRequired;

        assert_eq!(allows_hardware(&settings), true);
    }

    #[test]
    fn off_acceleration_forces_software_preference() {
        let mut settings = EncoderSettings::new(1920, 1080, 30, "h264", "nv12", "out.mp4");
        settings.backend = EncoderBackendPreference::Software;

        assert!(!allows_hardware(&settings));
    }
}
