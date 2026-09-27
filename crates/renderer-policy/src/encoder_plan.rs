use velocast_protocol::RendererAcceleration;

use crate::backend_registry::{
    BackendCandidate, BackendDiagnosticCode, BackendKind, BackendRegistry,
    BackendSelectionDiagnostic, SelectedBackend,
};
use crate::codec::{ParsedVideoCodec, RequestedEncoderBackend, WindowsD3D11EncoderBackend};
use crate::settings::{EncoderBackendPreference, EncoderExecutionContext, EncoderSettings};

/// Facts collected for the requested codec and dimensions. Opening the planned
/// encoder remains fallible: discovery does not reserve a device or session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncoderCapabilities {
    pub windows_d3d11: bool,
}

impl EncoderCapabilities {
    pub fn software_only() -> Self {
        Self {
            windows_d3d11: false,
        }
    }

    pub fn windows() -> Self {
        Self {
            windows_d3d11: true,
            ..Self::software_only()
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EncoderCandidatePlan {
    WindowsD3D11 { kind: BackendKind },
    Software,
}

impl EncoderCandidatePlan {
    pub fn kind(&self) -> BackendKind {
        match self {
            Self::WindowsD3D11 { kind } => *kind,
            Self::Software => BackendKind::SoftwareBgraFfmpeg,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncoderPlan {
    pub settings: EncoderSettings,
    pub selected: SelectedBackend,
    pub diagnostics: Vec<BackendSelectionDiagnostic>,
    candidates: Vec<EncoderCandidatePlan>,
}

#[derive(Debug)]
pub struct EncoderOpenFailure<E> {
    pub kind: BackendKind,
    pub error: E,
}

#[derive(Debug)]
pub struct ActivatedEncoder<T, E> {
    pub kind: BackendKind,
    pub value: T,
    pub failures: Vec<EncoderOpenFailure<E>>,
}

impl EncoderPlan {
    pub fn resolve(
        settings: EncoderSettings,
        capabilities: &EncoderCapabilities,
    ) -> anyhow::Result<Self> {
        if settings.codec.to_ascii_lowercase().ends_with("_vaapi") {
            anyhow::bail!(
                "encoder.codec_unavailable: VAAPI codecs have been retired: {}",
                settings.codec
            );
        }
        let registry = BackendRegistry::new(encoder_backend_candidates(&settings, capabilities));
        let acceleration = match settings.backend {
            EncoderBackendPreference::Auto => RendererAcceleration::Auto,
            EncoderBackendPreference::Software => RendererAcceleration::Off,
            EncoderBackendPreference::HardwareRequired => RendererAcceleration::Required,
        };
        let selected = registry.select(acceleration)?;
        let mut candidates = Vec::new();
        if settings.backend != EncoderBackendPreference::Software {
            for backend in registry.ordered_gpu_candidates() {
                candidates.push(EncoderCandidatePlan::WindowsD3D11 { kind: backend.kind });
            }
        }
        if settings.backend != EncoderBackendPreference::HardwareRequired {
            candidates.push(EncoderCandidatePlan::Software);
        }
        Ok(Self {
            settings,
            selected,
            diagnostics: registry.gpu_diagnostics(),
            candidates,
        })
    }

    pub fn candidates(&self) -> &[EncoderCandidatePlan] {
        &self.candidates
    }

    /// Attempt exactly the planned order. The runtime supplies native opening;
    /// policy owns retry order and whether software fallback is permitted.
    pub fn activate<T, E>(
        &self,
        mut open: impl FnMut(&EncoderCandidatePlan) -> Result<T, E>,
    ) -> Result<ActivatedEncoder<T, E>, Vec<EncoderOpenFailure<E>>> {
        let mut failures = Vec::new();
        for candidate in &self.candidates {
            match open(candidate) {
                Ok(value) => {
                    return Ok(ActivatedEncoder {
                        kind: candidate.kind(),
                        value,
                        failures,
                    })
                }
                Err(error) => failures.push(EncoderOpenFailure {
                    kind: candidate.kind(),
                    error,
                }),
            }
        }
        Err(failures)
    }
}

pub fn encoder_backend_candidates(
    settings: &EncoderSettings,
    capabilities: &EncoderCapabilities,
) -> Vec<BackendCandidate> {
    let mut candidates = Vec::new();
    let windows = match ParsedVideoCodec::parse(&settings.codec) {
        Ok(parsed) => windows_kinds(parsed.backend)
            .into_iter()
            .map(|kind| {
                if settings.execution_context == EncoderExecutionContext::StreamedBgraWorker {
                    unsupported_pipeline(kind)
                } else if capabilities.windows_d3d11 {
                    BackendCandidate::available(kind)
                } else {
                    BackendCandidate::unavailable_with_code(
                        kind,
                        BackendDiagnosticCode::PlatformTargetUnavailable,
                        "Windows D3D11 backend is unavailable for this target",
                    )
                }
            })
            .collect::<Vec<_>>(),
        Err(error) => windows_kinds(RequestedEncoderBackend::Auto)
            .into_iter()
            .map(|kind| {
                BackendCandidate::unavailable_with_code(
                    kind,
                    BackendDiagnosticCode::EncoderCodecUnavailable,
                    error.to_string(),
                )
            })
            .collect(),
    };
    candidates.extend(windows);
    candidates.push(BackendCandidate::available(BackendKind::SoftwareBgraFfmpeg));
    candidates
}

fn unsupported_pipeline(kind: BackendKind) -> BackendCandidate {
    BackendCandidate::unavailable_with_code(
        kind,
        BackendDiagnosticCode::PipelineModeUnsupported,
        "streamed BGRA worker assembly is enabled",
    )
}

fn windows_kinds(backend: RequestedEncoderBackend) -> Vec<BackendKind> {
    match backend {
        RequestedEncoderBackend::Auto => vec![
            BackendKind::WindowsD3D11Amf,
            BackendKind::WindowsD3D11Nvenc,
            BackendKind::WindowsD3D11Qsv,
            BackendKind::WindowsD3D11Mf,
        ],
        RequestedEncoderBackend::WindowsD3D11(WindowsD3D11EncoderBackend::Amf) => {
            vec![BackendKind::WindowsD3D11Amf]
        }
        RequestedEncoderBackend::WindowsD3D11(WindowsD3D11EncoderBackend::Nvenc) => {
            vec![BackendKind::WindowsD3D11Nvenc]
        }
        RequestedEncoderBackend::WindowsD3D11(WindowsD3D11EncoderBackend::Qsv) => {
            vec![BackendKind::WindowsD3D11Qsv]
        }
        RequestedEncoderBackend::WindowsD3D11(WindowsD3D11EncoderBackend::Mf) => {
            vec![BackendKind::WindowsD3D11Mf]
        }
    }
}
