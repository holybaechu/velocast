pub mod backend_registry;
pub mod encoder_backends;
pub mod render_plan;

use crate::browser_surface::BrowserSurfaceMode;
use render_plan::{encoder_settings_for_job, RenderPipelinePlan};
use velocast_protocol::{CompositionManifest, RenderJob};
use velocast_renderer_policy::settings::EncoderExecutionContext;

pub(crate) fn plan_for_coordinator(
    job: &RenderJob,
    composition: &CompositionManifest,
    available_workers: u32,
    process_id: u32,
    surface_mode: BrowserSurfaceMode,
) -> anyhow::Result<RenderPipelinePlan> {
    let settings = encoder_settings_for_job(
        job,
        composition,
        std::path::Path::new(&job.output),
        EncoderExecutionContext::Reference,
    )?;
    let capabilities = encoder_backends::probe_encoder_capabilities(&settings);
    #[allow(unused_mut)]
    let mut plan = RenderPipelinePlan::for_coordinator(
        job,
        composition,
        available_workers,
        process_id,
        surface_mode,
        &capabilities,
    )?;
    #[cfg(windows)]
    if plan.backend.conversion_mode == render_plan::RenderPipelineConversionMode::D3D11VideoProcessor
        && crate::encode::windows::D3D11FfmpegHardwareEncoder::planned_shader_conversion(&settings.codec)?
    {
        plan.backend.conversion_mode = render_plan::RenderPipelineConversionMode::D3D11Shader;
    }
    Ok(plan)
}

/// Synthetic GPU availability for pure planning tests, independent of the test host.
/// These plans are inspected, never opened against an actual graphics device.
#[cfg(test)]
pub(crate) fn synthetic_gpu_capabilities(
) -> velocast_renderer_policy::encoder_plan::EncoderCapabilities {
    velocast_renderer_policy::encoder_plan::EncoderCapabilities::windows()
}
