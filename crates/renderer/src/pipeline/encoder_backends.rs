use crate::errors::RendererError;
use velocast_renderer_policy::encoder_plan::{EncoderCapabilities, EncoderPlan};
use velocast_renderer_policy::settings::{
    EncoderBackendPreference, EncoderExecutionContext, EncoderSettings,
};

/// Observe the native host once. Tests pass explicit capability facts to policy;
/// this path has identical behavior in test and production builds.
pub(crate) fn probe_encoder_capabilities(settings: &EncoderSettings) -> EncoderCapabilities {
    let _ = settings;
    EncoderCapabilities {
        windows_d3d11: cfg!(windows),
    }
}

pub(crate) fn plan_encoder(settings: EncoderSettings) -> Result<EncoderPlan, RendererError> {
    if settings.backend == EncoderBackendPreference::HardwareRequired
        && settings.execution_context == EncoderExecutionContext::StreamedBgraWorker
    {
        return Err(RendererError::RequiredAccelerationPathUnsupported(
            "streamed BGRA worker assembly is enabled",
        ));
    }
    let capabilities = probe_encoder_capabilities(&settings);
    EncoderPlan::resolve(settings, &capabilities)
        .map_err(|error| RendererError::RequiredAccelerationUnavailable(error.to_string()))
}
