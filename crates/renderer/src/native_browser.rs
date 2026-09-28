use crate::browser_protocol::BrowserDriver;
use crate::browser_surface::BrowserSurfaceMode;
use crate::frame_loop::SelectorMeasurement;
use serde_json::{json, Value};
use velocast_protocol::{AudioPlan, CompositionManifest, RenderJob, RenderSession};
pub struct NativeBrowser(crate::electron_app::ElectronRenderer);
impl NativeBrowser {
    pub(crate) fn surface_mode(&self) -> BrowserSurfaceMode {
        self.0.surface_mode()
    }
    pub fn new(mode: BrowserSurfaceMode) -> anyhow::Result<Self> {
        Ok(Self(crate::electron_app::ElectronRenderer::new(mode)?))
    }
    pub(crate) fn host_request(&self, request: Value) -> anyhow::Result<Value> {
        self.0.host_request(request)
    }
    pub(crate) fn media_operation(&self, operation: Value) -> anyhow::Result<Value> {
        self.host_request(json!({"method":"media-operation","operation":operation}))
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
}
