use velocast_protocol::RendererAcceleration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub enum BackendKind {
    WindowsD3D11Amf,
    WindowsD3D11Nvenc,
    WindowsD3D11Qsv,
    WindowsD3D11Mf,
    SoftwareBgraFfmpeg,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendSurfaceValidation {
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureProbeValidation {
    GenericGpuSurface,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BackendDescriptor {
    pub kind: BackendKind,
    pub telemetry_label: &'static str,
    pub capture_backend: Option<&'static str>,
    pub conversion_backend: Option<&'static str>,
    pub encoder_backend: Option<&'static str>,
    pub surface_validation: BackendSurfaceValidation,
}

const BACKEND_DESCRIPTORS: [BackendDescriptor; 5] = [
    BackendDescriptor {
        kind: BackendKind::WindowsD3D11Amf,
        telemetry_label: "windows_d3d11_amf",
        capture_backend: Some("electron_d3d11_shared_texture"),
        conversion_backend: Some("d3d11_video_processor"),
        encoder_backend: Some("h264_amf"),
        surface_validation: BackendSurfaceValidation::None,
    },
    BackendDescriptor {
        kind: BackendKind::WindowsD3D11Nvenc,
        telemetry_label: "windows_d3d11_nvenc",
        capture_backend: Some("electron_d3d11_shared_texture"),
        conversion_backend: Some("d3d11_video_processor"),
        encoder_backend: Some("h264_nvenc"),
        surface_validation: BackendSurfaceValidation::None,
    },
    BackendDescriptor {
        kind: BackendKind::WindowsD3D11Qsv,
        telemetry_label: "windows_d3d11_qsv",
        capture_backend: Some("electron_d3d11_shared_texture"),
        conversion_backend: Some("d3d11_video_processor"),
        encoder_backend: Some("h264_qsv"),
        surface_validation: BackendSurfaceValidation::None,
    },
    BackendDescriptor {
        kind: BackendKind::WindowsD3D11Mf,
        telemetry_label: "windows_d3d11_mf",
        capture_backend: Some("electron_d3d11_shared_texture"),
        conversion_backend: Some("d3d11_video_processor"),
        encoder_backend: Some("h264_mf"),
        surface_validation: BackendSurfaceValidation::None,
    },
    BackendDescriptor {
        kind: BackendKind::SoftwareBgraFfmpeg,
        telemetry_label: "software_bgra_ffmpeg",
        capture_backend: Some("electron_software_bgra"),
        conversion_backend: Some("software"),
        encoder_backend: Some("libx264"),
        surface_validation: BackendSurfaceValidation::None,
    },
];

impl BackendKind {
    #[allow(dead_code)]
    pub fn telemetry_label(self) -> &'static str {
        backend_descriptor(self).telemetry_label
    }
}

const GPU_BACKEND_PRIORITY: [BackendKind; 4] = [
    BackendKind::WindowsD3D11Amf,
    BackendKind::WindowsD3D11Nvenc,
    BackendKind::WindowsD3D11Qsv,
    BackendKind::WindowsD3D11Mf,
];

pub fn backend_descriptor(kind: BackendKind) -> &'static BackendDescriptor {
    BACKEND_DESCRIPTORS
        .iter()
        .find(|descriptor| descriptor.kind == kind)
        .expect("backend kind is missing a descriptor")
}

pub fn required_gpu_backend_for_telemetry(
    capture_backend: &str,
    conversion_backend: &str,
    encoder_backend: &str,
) -> Option<&'static BackendDescriptor> {
    required_gpu_backend_descriptors().find(|descriptor| {
        capture_matches(descriptor, capture_backend)
            && conversion_matches(descriptor, conversion_backend)
            && descriptor.supports_encoder_backend(encoder_backend)
            && (conversion_backend != "d3d11_shader_nv12" || encoder_backend.starts_with("h264_"))
    })
}

pub fn required_gpu_capture_backend_known(capture_backend: &str) -> bool {
    required_gpu_backend_descriptors()
        .any(|descriptor| capture_matches(descriptor, capture_backend))
}

fn capture_matches(descriptor: &BackendDescriptor, capture_backend: &str) -> bool {
    descriptor.capture_backend == Some(capture_backend)
}

fn conversion_matches(descriptor: &BackendDescriptor, conversion_backend: &str) -> bool {
    descriptor.conversion_backend == Some(conversion_backend)
        || (descriptor.capture_backend == Some("electron_d3d11_shared_texture")
            && descriptor.conversion_backend == Some("d3d11_video_processor")
            && conversion_backend == "d3d11_shader_nv12")
}

pub fn required_gpu_capture_probe_validation(
    capture_backend: &str,
) -> Option<CaptureProbeValidation> {
    required_gpu_backend_descriptors()
        .find(|descriptor| capture_matches(descriptor, capture_backend))
        .map(|descriptor| match descriptor.surface_validation {
            BackendSurfaceValidation::None => CaptureProbeValidation::GenericGpuSurface,
        })
}

pub fn required_gpu_conversion_backend_known(
    capture_backend: &str,
    conversion_backend: &str,
) -> bool {
    required_gpu_backend_descriptors().any(|descriptor| {
        capture_matches(descriptor, capture_backend)
            && conversion_matches(descriptor, conversion_backend)
    })
}

pub fn required_gpu_encoder_backend_known(encoder_backend: &str) -> bool {
    required_gpu_backend_descriptors()
        .any(|descriptor| descriptor.supports_encoder_backend(encoder_backend))
}

fn required_gpu_backend_descriptors() -> impl Iterator<Item = &'static BackendDescriptor> {
    GPU_BACKEND_PRIORITY
        .iter()
        .map(|kind| backend_descriptor(*kind))
}

impl BackendDescriptor {
    pub fn supports_encoder_backend(&self, encoder_backend: &str) -> bool {
        match self.kind {
            BackendKind::WindowsD3D11Amf => {
                matches!(encoder_backend, "h264_amf" | "hevc_amf" | "av1_amf")
            }
            BackendKind::WindowsD3D11Nvenc => {
                matches!(encoder_backend, "h264_nvenc" | "hevc_nvenc" | "av1_nvenc")
            }
            BackendKind::WindowsD3D11Qsv => {
                matches!(encoder_backend, "h264_qsv" | "hevc_qsv" | "av1_qsv")
            }
            BackendKind::WindowsD3D11Mf => {
                matches!(encoder_backend, "h264_mf" | "hevc_mf" | "av1_mf")
            }
            BackendKind::SoftwareBgraFfmpeg => self.encoder_backend == Some(encoder_backend),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendDiagnosticCode {
    BackendUnavailable,
    EncoderCodecUnavailable,
    EncoderFfmpegFinishFailed,
    EncoderFfmpegOpenFailed,
    EncoderFfmpegPacketWriteFailed,
    EncoderHardwareUnavailable,
    GpuConvertFailed,
    GpuImportUnavailable,
    PipelineModeUnsupported,
    PlatformDeviceMismatch,
    PlatformDeviceUnavailable,
    PlatformTargetUnavailable,
}

impl BackendDiagnosticCode {
    pub const ALL: [Self; 12] = [
        Self::BackendUnavailable,
        Self::EncoderCodecUnavailable,
        Self::EncoderFfmpegFinishFailed,
        Self::EncoderFfmpegOpenFailed,
        Self::EncoderFfmpegPacketWriteFailed,
        Self::EncoderHardwareUnavailable,
        Self::GpuConvertFailed,
        Self::GpuImportUnavailable,
        Self::PipelineModeUnsupported,
        Self::PlatformDeviceMismatch,
        Self::PlatformDeviceUnavailable,
        Self::PlatformTargetUnavailable,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::BackendUnavailable => "backend.unavailable",
            Self::EncoderCodecUnavailable => "encoder.codec_unavailable",
            Self::EncoderFfmpegFinishFailed => "encoder.ffmpeg_finish_failed",
            Self::EncoderFfmpegOpenFailed => "encoder.ffmpeg_open_failed",
            Self::EncoderFfmpegPacketWriteFailed => "encoder.ffmpeg_packet_write_failed",
            Self::EncoderHardwareUnavailable => "encoder.hardware_unavailable",
            Self::GpuConvertFailed => "gpu.convert_failed",
            Self::GpuImportUnavailable => "gpu.import_unavailable",
            Self::PipelineModeUnsupported => "pipeline.mode_unsupported",
            Self::PlatformDeviceMismatch => "platform.device_mismatch",
            Self::PlatformDeviceUnavailable => "platform.device_unavailable",
            Self::PlatformTargetUnavailable => "platform.target_unavailable",
        }
    }

    pub fn from_str(code: &str) -> Option<Self> {
        Self::ALL
            .iter()
            .copied()
            .find(|candidate| candidate.as_str() == code)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackendUnavailableDiagnostic {
    pub code: BackendDiagnosticCode,
    pub reason: String,
}

impl BackendUnavailableDiagnostic {
    pub fn new(code: BackendDiagnosticCode, reason: impl Into<String>) -> Self {
        Self {
            code,
            reason: reason.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackendSelectionDiagnostic {
    pub backend: &'static str,
    pub available: bool,
    pub unavailable: Option<BackendUnavailableDiagnostic>,
}

impl BackendSelectionDiagnostic {
    pub fn unavailable_code(&self) -> Option<&'static str> {
        self.unavailable
            .as_ref()
            .map(|diagnostic| diagnostic.code.as_str())
    }

    pub fn unavailable_reason(&self) -> Option<&str> {
        self.unavailable
            .as_ref()
            .map(|diagnostic| diagnostic.reason.as_str())
    }

    pub fn unavailable_summary(&self) -> Option<String> {
        let code = self.unavailable_code()?;
        let reason = self.unavailable_reason()?;
        let reason = if reason.starts_with(code) {
            reason.to_string()
        } else {
            format!("{code}: {reason}")
        };
        Some(format!("{} unavailable: {reason}", self.backend))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackendCandidate {
    pub kind: BackendKind,
    pub available: bool,
    pub reason: Option<String>,
    pub diagnostic: Option<BackendUnavailableDiagnostic>,
}

impl BackendCandidate {
    pub fn available(kind: BackendKind) -> Self {
        Self {
            kind,
            available: true,
            reason: None,
            diagnostic: None,
        }
    }

    #[cfg(test)]
    pub fn unavailable(kind: BackendKind, reason: impl Into<String>) -> Self {
        Self::unavailable_with_code(kind, BackendDiagnosticCode::BackendUnavailable, reason)
    }

    pub fn unavailable_with_code(
        kind: BackendKind,
        code: BackendDiagnosticCode,
        reason: impl Into<String>,
    ) -> Self {
        let reason = reason.into();
        Self {
            kind,
            available: false,
            reason: Some(reason.clone()),
            diagnostic: Some(BackendUnavailableDiagnostic::new(code, reason)),
        }
    }

    pub fn selection_diagnostic(&self) -> BackendSelectionDiagnostic {
        BackendSelectionDiagnostic {
            backend: self.kind.telemetry_label(),
            available: self.available,
            unavailable: self.diagnostic.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectedBackend {
    pub kind: BackendKind,
    pub software_fallback: bool,
}

#[derive(Debug, Clone)]
pub struct BackendRegistry {
    candidates: Vec<BackendCandidate>,
}

impl BackendRegistry {
    pub fn new(candidates: Vec<BackendCandidate>) -> Self {
        Self { candidates }
    }

    pub fn select(&self, acceleration: RendererAcceleration) -> anyhow::Result<SelectedBackend> {
        let gpu = self.select_gpu();

        match acceleration {
            RendererAcceleration::Required => gpu
                .map(|candidate| SelectedBackend {
                    kind: candidate.kind,
                    software_fallback: false,
                })
                .ok_or_else(|| {
                    let mut message = String::from(
                        "acceleration.required_unavailable: no required GPU backend is available",
                    );
                    let reasons = self.unavailable_gpu_reasons();
                    if !reasons.is_empty() {
                        message.push_str(" (");
                        message.push_str(&reasons.join("; "));
                        message.push(')');
                    }
                    anyhow::anyhow!(message)
                }),
            RendererAcceleration::Auto => {
                if let Some(candidate) = gpu {
                    Ok(SelectedBackend {
                        kind: candidate.kind,
                        software_fallback: false,
                    })
                } else {
                    self.select_software(true)
                }
            }
            RendererAcceleration::Off => self.select_software(false),
        }
    }

    pub fn gpu_diagnostics(&self) -> Vec<BackendSelectionDiagnostic> {
        GPU_BACKEND_PRIORITY
            .iter()
            .filter_map(|kind| {
                self.candidates
                    .iter()
                    .find(|candidate| candidate.kind == *kind)
                    .map(BackendCandidate::selection_diagnostic)
            })
            .collect()
    }

    pub fn ordered_gpu_candidates(&self) -> Vec<SelectedBackend> {
        GPU_BACKEND_PRIORITY
            .iter()
            .filter_map(|kind| {
                self.candidates
                    .iter()
                    .find(|candidate| candidate.available && candidate.kind == *kind)
                    .map(|candidate| SelectedBackend {
                        kind: candidate.kind,
                        software_fallback: false,
                    })
            })
            .collect()
    }

    fn select_gpu(&self) -> Option<&BackendCandidate> {
        GPU_BACKEND_PRIORITY.iter().find_map(|kind| {
            self.candidates
                .iter()
                .find(|candidate| candidate.available && candidate.kind == *kind)
        })
    }

    fn unavailable_gpu_reasons(&self) -> Vec<String> {
        self.gpu_diagnostics()
            .into_iter()
            .filter(|diagnostic| !diagnostic.available)
            .filter_map(|diagnostic| diagnostic.unavailable_summary())
            .collect()
    }

    fn select_software(&self, software_fallback: bool) -> anyhow::Result<SelectedBackend> {
        self.candidates
            .iter()
            .find(|candidate| {
                candidate.available && candidate.kind == BackendKind::SoftwareBgraFfmpeg
            })
            .map(|candidate| SelectedBackend {
                kind: candidate.kind,
                software_fallback,
            })
            .ok_or_else(|| anyhow::anyhow!("software renderer backend is unavailable"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hardware_priority_and_required_selection_are_independent_of_input_order() {
        let registry = BackendRegistry::new(vec![
            BackendCandidate::available(BackendKind::WindowsD3D11Mf),
            BackendCandidate::available(BackendKind::SoftwareBgraFfmpeg),
            BackendCandidate::available(BackendKind::WindowsD3D11Nvenc),
            BackendCandidate::available(BackendKind::WindowsD3D11Amf),
        ]);
        assert_eq!(
            registry
                .ordered_gpu_candidates()
                .iter()
                .map(|v| v.kind)
                .collect::<Vec<_>>(),
            vec![
                BackendKind::WindowsD3D11Amf,
                BackendKind::WindowsD3D11Nvenc,
                BackendKind::WindowsD3D11Mf
            ]
        );
        assert_eq!(
            registry
                .select(RendererAcceleration::Required)
                .unwrap()
                .kind,
            BackendKind::WindowsD3D11Amf
        );
        assert_eq!(
            registry.select(RendererAcceleration::Off).unwrap().kind,
            BackendKind::SoftwareBgraFfmpeg
        );
    }
    #[test]
    fn software_only_hosts_fall_back_for_auto_and_reject_required() {
        let registry = BackendRegistry::new(vec![
            BackendCandidate::unavailable_with_code(
                BackendKind::WindowsD3D11Mf,
                BackendDiagnosticCode::PlatformTargetUnavailable,
                "Windows D3D11 unavailable",
            ),
            BackendCandidate::available(BackendKind::SoftwareBgraFfmpeg),
        ]);
        let selected = registry.select(RendererAcceleration::Auto).unwrap();
        assert_eq!(selected.kind, BackendKind::SoftwareBgraFfmpeg);
        assert!(selected.software_fallback);
        assert!(
            !registry
                .select(RendererAcceleration::Off)
                .unwrap()
                .software_fallback
        );
        let error = registry
            .select(RendererAcceleration::Required)
            .unwrap_err()
            .to_string();
        assert!(error.contains("acceleration.required_unavailable"));
        assert!(error.contains("platform.target_unavailable"));
        assert!(error.contains("Windows D3D11 unavailable"));
    }
    #[test]
    fn electron_gpu_validation_preserves_encoder_and_conversion_compatibility() {
        for encoder in [
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
        ] {
            assert!(required_gpu_backend_for_telemetry(
                "electron_d3d11_shared_texture",
                "d3d11_video_processor",
                encoder
            )
            .is_some());
            assert_eq!(
                required_gpu_backend_for_telemetry(
                    "electron_d3d11_shared_texture",
                    "d3d11_shader_nv12",
                    encoder
                )
                .is_some(),
                encoder.starts_with("h264_")
            );
        }
        for capture in [
            "electron_software_bgra",
            "cef_d3d11_shared_texture",
            "cef_dmabuf",
            "cef_iosurface",
        ] {
            assert!(!required_gpu_capture_backend_known(capture));
        }
        assert!(!required_gpu_encoder_backend_known("h264_vaapi"));
        assert!(required_gpu_backend_for_telemetry(
            "electron_d3d11_shared_texture",
            "software",
            "h264_mf"
        )
        .is_none());
    }
    #[test]
    fn diagnostic_codes_round_trip_and_retired_codes_are_rejected() {
        for code in BackendDiagnosticCode::ALL {
            assert_eq!(BackendDiagnosticCode::from_str(code.as_str()), Some(code));
        }
        for code in [
            "capture.dmabuf_unavailable",
            "encoder.vaapi_device_probe_failed",
            "gpu.modifier_unsupported",
        ] {
            assert_eq!(BackendDiagnosticCode::from_str(code), None);
        }
    }
}
