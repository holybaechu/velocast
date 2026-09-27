//! Browser-host selection only; capture, conversion, encoding and publication stay shared.
use serde_json::Value;
use velocast_protocol::{
    AudioPlan, CompositionManifest, RenderJob, RenderSession, RendererAcceleration,
};

use crate::browser_protocol::BrowserDriver;
use crate::browser_surface::BrowserSurfaceMode;

use crate::frame_loop::SelectorMeasurement;
use crate::paint_state::PaintState;

pub struct NativeBrowser(crate::electron_app::ElectronRenderer);

impl NativeBrowser {
    pub(crate) fn new_webcodecs() -> anyhow::Result<Self> {
        selected_browser_host()?;
        Ok(Self(crate::electron_app::ElectronRenderer::new_webcodecs()?))
    }

    pub(crate) fn webcodecs_request(&self, request: Value) -> anyhow::Result<Value> {
        self.0.webcodecs_request(request)
    }

    pub(crate) fn webcodecs_stream(&self) -> anyhow::Result<std::path::PathBuf> {
        self.0.webcodecs_stream()
    }

    pub fn new(mode: BrowserSurfaceMode) -> anyhow::Result<Self> {
        selected_browser_host()?;
        Ok(Self(crate::electron_app::ElectronRenderer::new(mode)?))
    }

    pub fn paint_state(&self) -> PaintState {
        self.0.paint_state()
    }
    pub async fn load(&self, job: &RenderJob) -> anyhow::Result<()> {
        self.0.load(job).await
    }

    pub fn discover_compositions(&self) -> anyhow::Result<Vec<CompositionManifest>> {
        self.0.discover_compositions()
    }
    pub fn resolve_audio_plan(
        &self,
        composition: &CompositionManifest,
        props: Option<&Value>,
    ) -> anyhow::Result<Option<AudioPlan>> {
        self.0.resolve_audio_plan(composition, props)
    }
    pub fn prepare_composition_with_input_props(
        &self,
        composition: &CompositionManifest,
        frame: Option<u32>,
        props: Option<&Value>,
    ) -> anyhow::Result<()> {
        self.0
            .prepare_composition_with_input_props(composition, frame, props)
    }
    pub fn measure_selector(&self, selector: &str) -> anyhow::Result<SelectorMeasurement> {
        self.0.measure_selector(selector)
    }
}

impl BrowserDriver for NativeBrowser {
    fn render_session(&self) -> Option<RenderSession> {
        self.0.render_session()
    }
    fn render_frame(&self, script: &str, frame: u32) -> anyhow::Result<()> {
        self.0.render_frame(script, frame)
    }
    fn request_paint(&self) -> anyhow::Result<()> {
        self.0.request_paint()
    }
    fn invalidate_for_next_capture(&self) -> anyhow::Result<()> {
        self.0.invalidate_for_next_capture()
    }
    fn requires_initial_post_render_paint_settle(&self) -> bool {
        self.0.requires_initial_post_render_paint_settle()
    }
    fn pump(&self) {
        self.0.pump()
    }
}

pub(crate) const ELECTRON_SOFTWARE_FALLBACK: &str =
    "electron.gpu_capture_unsupported: this platform supports Electron software capture only";

fn selected_browser_host() -> anyhow::Result<&'static str> {
    for name in ["VELOCAST_BROWSER", "VELOCAST_EXPERIMENTAL_BROWSER"] {
        match std::env::var(name) {
            Ok(value) if !value.is_empty() => {
                resolve_browser_host(&value)?;
            }
            Ok(_) | Err(std::env::VarError::NotPresent) => {}
            Err(error) => anyhow::bail!("browser.invalid_host: {name}: {error}"),
        }
    }
    Ok("electron")
}

pub(crate) fn resolve_surface_mode(
    mode: BrowserSurfaceMode,
    acceleration: RendererAcceleration,
) -> anyhow::Result<BrowserSurfaceMode> {
    surface_mode_for_host(mode, acceleration, selected_browser_host()?, cfg!(windows))
}

fn surface_mode_for_host(
    mode: BrowserSurfaceMode,
    acceleration: RendererAcceleration,
    host: &str,
    is_windows: bool,
) -> anyhow::Result<BrowserSurfaceMode> {
    if host == "electron" && !is_windows && mode == BrowserSurfaceMode::Accelerated {
        if acceleration == RendererAcceleration::Required {
            anyhow::bail!("{ELECTRON_SOFTWARE_FALLBACK}; use --acceleration off");
        }
        return Ok(BrowserSurfaceMode::Software);
    }
    Ok(mode)
}

pub(crate) fn default_browser_host() -> &'static str {
    "electron"
}
pub(crate) fn browser_hosts() -> Vec<&'static str> {
    vec!["electron"]
}

fn resolve_browser_host(requested: &str) -> anyhow::Result<&'static str> {
    match requested {
        "" | "electron" => Ok("electron"),
        "cef" => anyhow::bail!("browser.host_not_supported: CEF has been retired; use Electron"),
        _ => anyhow::bail!("browser.invalid_host: VELOCAST_BROWSER must be electron"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn electron_is_the_only_host_and_retired_host_is_explicitly_rejected() {
        assert_eq!(default_browser_host(), "electron");
        assert_eq!(browser_hosts(), vec!["electron"]);
        assert_eq!(resolve_browser_host("").unwrap(), "electron");
        assert_eq!(resolve_browser_host("electron").unwrap(), "electron");
        assert!(resolve_browser_host("cef")
            .unwrap_err()
            .to_string()
            .contains("browser.host_not_supported"));
        assert!(resolve_browser_host("other").is_err());
    }
    #[test]
    fn software_only_platform_falls_back_for_auto_and_rejects_required_gpu() {
        use BrowserSurfaceMode::{Accelerated, Software};
        use RendererAcceleration::{Auto, Off, Required};
        assert_eq!(
            surface_mode_for_host(Accelerated, Auto, "electron", false).unwrap(),
            Software
        );
        assert_eq!(
            surface_mode_for_host(Software, Off, "electron", false).unwrap(),
            Software
        );
        assert!(surface_mode_for_host(Accelerated, Required, "electron", false).is_err());
        assert_eq!(
            surface_mode_for_host(Accelerated, Required, "electron", true).unwrap(),
            Accelerated
        );
    }
}
