use crate::browser_protocol::BrowserDriver;
use serde_json::Value;
use std::path::Path;
use velocast_protocol::{CompositionManifest, RenderContext};
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SelectorMeasurement {
    pub width: f64,
    pub height: f64,
}

pub fn get_compositions_script() -> &'static str {
    "window.__velocast.getCompositions()"
}

pub fn seek_frame_script(frame: u32, context: &RenderContext) -> anyhow::Result<String> {
    let composition_id = serde_json::to_string(&context.composition_id)?;
    let json = serde_json::to_string(context)?;
    Ok(format!(
        "window.__velocast.seekFrame({composition_id}, {frame}, {json})"
    ))
}

pub fn select_composition(
    compositions: &[CompositionManifest],
    id: &str,
) -> anyhow::Result<CompositionManifest> {
    compositions
        .iter()
        .find(|composition| composition.id == id)
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("composition {id} was not found"))
}

pub fn select_url_composition(
    compositions: &[CompositionManifest],
    selector: &str,
) -> anyhow::Result<CompositionManifest> {
    compositions
        .iter()
        .find(|composition| composition.target.as_deref() == Some(selector))
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("selector {selector} was not found in composition metadata"))
}

pub fn composition_from_selector_measurement(
    selector: &str,
    measurement: SelectorMeasurement,
) -> anyhow::Result<CompositionManifest> {
    if !measurement.width.is_finite()
        || !measurement.height.is_finite()
        || measurement.width <= 0.0
        || measurement.height <= 0.0
        || measurement.width > u32::MAX as f64
        || measurement.height > u32::MAX as f64
    {
        return Err(anyhow::anyhow!(
            "selector {selector} must have positive finite bounds"
        ));
    }

    Ok(CompositionManifest {
        id: format!("selector:{selector}"),
        width: measurement.width.ceil() as u32,
        height: measurement.height.ceil() as u32,
        fps: 30,
        duration_frames: 1,
        target: Some(selector.to_string()),
        url: None,
        max_concurrency: None,
    })
}

pub(crate) fn render_context(composition: &CompositionManifest) -> RenderContext {
    render_context_with_input_props(composition, None)
}

pub(crate) fn render_context_with_input_props(
    composition: &CompositionManifest,
    input_props: Option<&Value>,
) -> RenderContext {
    RenderContext {
        composition_id: composition.id.clone(),
        width: composition.width,
        height: composition.height,
        fps: composition.fps,
        duration_frames: composition.duration_frames,
        target: composition.target.clone(),
        input_props: input_props.cloned(),
        render_session: None,
    }
}

pub async fn render_frame_png(
    composition: &CompositionManifest,
    frame: u32,
    browser: &crate::native_browser::NativeBrowser,
    output: &Path,
    telemetry: &mut crate::telemetry::RenderTelemetry,
    events: &mut crate::events::RendererEventSink,
) -> anyhow::Result<()> {
    let mut context = render_context(composition);
    context.render_session = browser.render_session();
    browser.render_frame(&seek_frame_script(frame, &context)?, frame)?;
    let metadata=browser.host_request(serde_json::json!({"method":"png","outputPath":std::path::absolute(output)?,"expectedWidth":composition.width,"expectedHeight":composition.height}))?;
    anyhow::ensure!(
        metadata["width"].as_u64() == Some(composition.width as u64)
            && metadata["height"].as_u64() == Some(composition.height as u64),
        "output.invalid_png_dimensions"
    );
    crate::output_media::validate_png(output, composition.width, composition.height)?;
    telemetry.capture_backend = Some("electron_software_png".into());
    telemetry.encoder_backend = Some("electron_png".into());
    telemetry.surface_format_in = Some("bgra".into());
    telemetry.surface_format_encoder = Some("rgba".into());
    telemetry.frames_rendered = 1;
    telemetry.frames_encoded = 1;
    events
        .emit(crate::events::RendererEvent::FrameRendered {
            frame,
            capture_backend: telemetry.capture_backend.clone(),
            surface_format_in: telemetry.surface_format_in.clone(),
        })
        .await?;
    events
        .emit(crate::events::RendererEvent::FrameEncoded {
            frame,
            frames_encoded: 1,
        })
        .await?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selector_bounds_must_be_positive_finite() {
        for width in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(composition_from_selector_measurement(
                "#scene",
                SelectorMeasurement {
                    width,
                    height: 20.0
                }
            )
            .is_err());
        }
    }
}
