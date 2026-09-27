//! Browser-independent driver contract and injected protocol operations.
use crate::frame_loop::{get_compositions_script, SelectorMeasurement};
use serde_json::Value;
use velocast_protocol::{AudioPlan, CompositionManifest, RenderJob, RenderSession};

pub(crate) const SCRIPT_RESULT_TITLE_PREFIX: &str = "velocast-script-result:";

pub trait BrowserDriver {
    fn render_session(&self) -> Option<RenderSession> {
        None
    }
    fn render_frame(&self, script: &str, frame: u32) -> anyhow::Result<()>;
    fn request_paint(&self) -> anyhow::Result<()> {
        Ok(())
    }
    /// Prepare the next capture without requiring a completed paint. Any paint
    /// produced here is discarded; capture-generation requests provide freshness.
    fn invalidate_for_next_capture(&self) -> anyhow::Result<()> {
        self.request_paint()?;
        self.pump();
        Ok(())
    }
    fn requires_initial_post_render_paint_settle(&self) -> bool {
        false
    }
    fn pump(&self);
}

pub(crate) fn composition_discovery_script(token: &str) -> String {
    script_result_wrapper(get_compositions_script(), token)
}

pub(crate) fn audio_plan_script(
    composition: &CompositionManifest,
    input_props: Option<&Value>,
    session: Option<&RenderSession>,
    token: &str,
) -> anyhow::Result<String> {
    let mut context = crate::frame_loop::render_context_with_input_props(composition, input_props);
    context.render_session = session.cloned();
    Ok(script_result_wrapper(
        &format!(
            "window.__velocast?.getAudioPlan?.({}, {}) ?? null",
            serde_json::to_string(&composition.id)?,
            serde_json::to_string(&context)?
        ),
        token,
    ))
}

pub(crate) fn parse_audio_plan_result(json: &str) -> anyhow::Result<Option<AudioPlan>> {
    let plan: Option<AudioPlan> = serde_json::from_str(json)
        .map_err(|error| anyhow::anyhow!("audio.invalid_plan: {error}"))?;
    if let Some(plan) = &plan {
        plan.validate().map_err(anyhow::Error::msg)?;
    }
    Ok(plan)
}

pub(crate) fn input_props_script(input_props: &Value, token: &str) -> anyhow::Result<String> {
    let json = serde_json::to_string(input_props)?;
    Ok(script_result_wrapper(
        &format!("window.__velocastRenderer.setInputProps({json})"),
        token,
    ))
}

pub(crate) fn readiness_script(token: &str) -> String {
    script_result_wrapper("window.__velocastRenderer.waitForReady()", token)
}

pub(crate) fn protocol_compatibility_script(token: &str) -> String {
    script_result_wrapper(
        &format!(
            "window.__velocastRenderer.assertProtocol({})",
            velocast_protocol::BROWSER_PROTOCOL_VERSION
        ),
        token,
    )
}

pub(crate) fn render_session_for_job(job: &RenderJob) -> RenderSession {
    job.render_session.clone().unwrap_or_else(|| RenderSession {
        session_id: format!(
            "native-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ),
        source_version: None,
    })
}

pub(crate) fn session_binding_script(
    session: &RenderSession,
    token: &str,
) -> anyhow::Result<String> {
    Ok(script_result_wrapper(
        &format!(
            "window.__velocastRenderer.bindSession({})",
            serde_json::to_string(session)?
        ),
        token,
    ))
}

#[cfg(test)]
pub(crate) fn cancel_request_script(token: &str) -> String {
    let token = serde_json::to_string(token).expect("request token should serialize");
    format!("window.__velocastRenderer.cancel({token});")
}

pub(crate) fn protocol_missing_sentinel_script() -> String {
    "window.__velocastRenderer.installMissingProtocol();".to_string()
}

pub fn render_environment_script(width: u32, height: u32) -> String {
    format!("window.__velocastRenderer.renderEnvironment({width}, {height});")
}

pub(crate) fn target_capture_environment_script(selector: &str) -> String {
    let selector = serde_json::to_string(selector).expect("selector should serialize");
    format!("window.__velocastRenderer.selectTarget({selector});")
}

pub(crate) fn render_frame_completion_script(script: &str, _frame: u32, token: &str) -> String {
    script_result_wrapper(
        &format!("window.__velocastRenderer.completeFrame(() => {script})"),
        token,
    )
}

pub(crate) fn selector_measurement_script(selector: &str, token: &str) -> String {
    let selector = serde_json::to_string(selector).expect("selector should serialize");
    script_result_wrapper(
        &format!("window.__velocastRenderer.measureSelector({selector})"),
        token,
    )
}

pub(crate) fn script_result_wrapper(script: &str, token: &str) -> String {
    let prefix =
        serde_json::to_string(SCRIPT_RESULT_TITLE_PREFIX).expect("prefix should serialize");
    let token = serde_json::to_string(token).expect("token should serialize");
    format!("window.__velocastRenderer.report({token}, {prefix}, () => {script});")
}

pub(crate) fn selector_measurement_from_json(json: &str) -> anyhow::Result<SelectorMeasurement> {
    let value: serde_json::Value = serde_json::from_str(json)?;
    let width = value
        .get("width")
        .and_then(serde_json::Value::as_f64)
        .ok_or_else(|| anyhow::anyhow!("selector measurement width is unavailable"))?;
    let height = value
        .get("height")
        .and_then(serde_json::Value::as_f64)
        .ok_or_else(|| anyhow::anyhow!("selector measurement height is unavailable"))?;

    Ok(SelectorMeasurement { width, height })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn browser_dispatch_serializes_arguments_without_changing_script_tokens() {
        assert_eq!(
            protocol_compatibility_script("protocol-check"),
            r#"window.__velocastRenderer.report("protocol-check", "velocast-script-result:", () => window.__velocastRenderer.assertProtocol(4));"#,
        );
        assert_eq!(
            cancel_request_script("cancel-\"token"),
            r#"window.__velocastRenderer.cancel("cancel-\"token");"#,
        );
        assert_eq!(
            readiness_script("ready-token"),
            r#"window.__velocastRenderer.report("ready-token", "velocast-script-result:", () => window.__velocastRenderer.waitForReady());"#,
        );
        assert_eq!(
            target_capture_environment_script("[data-title=\"hero\"]"),
            r#"window.__velocastRenderer.selectTarget("[data-title=\"hero\"]");"#,
        );
    }

    #[test]
    fn audio_plan_dispatch_retains_props_session_and_escaped_composition_id() {
        let composition: CompositionManifest = serde_json::from_value(serde_json::json!({"id":"song\"id","width":1920,"height":1080,"fps":60,"durationFrames":120})).unwrap();
        let props = serde_json::json!({"gain":0.5,"label":"한글"});
        let session = RenderSession {
            session_id: "session-audio".to_owned(),
            source_version: Some("fixed-source".to_owned()),
        };
        let script =
            audio_plan_script(&composition, Some(&props), Some(&session), "audio-token").unwrap();
        assert!(script.starts_with("window.__velocastRenderer.report(\"audio-token\""));
        assert!(script.contains("getAudioPlan?.(\"song\\\"id\""));
        assert!(script.contains("\"inputProps\":{\"gain\":0.5,\"label\":\"한글\"}"));
        assert!(script.contains("\"renderSession\":{\"sessionId\":\"session-audio\",\"sourceVersion\":\"fixed-source\"}"));
        assert!(script.ends_with(" ?? null);"));
    }

    #[test]
    fn audio_plan_result_distinguishes_no_audio_and_rejects_invalid_data() {
        assert!(parse_audio_plan_result("null").unwrap().is_none());
        let plan = parse_audio_plan_result(r#"{"sampleRate":48000,"durationSamples":10,"clips":[{"source":"song.wav","startSample":-2,"sourceStartSample":4,"durationSamples":10,"gain":0.5}]}"#).unwrap().unwrap();
        assert_eq!(plan.clips[0].start_sample, -2);
        assert_eq!(plan.normalized().unwrap().clips[0].source_start_sample, 6);
        assert!(
            parse_audio_plan_result(r#"{"sampleRate":0,"durationSamples":10,"clips":[]}"#).is_err()
        );
        assert!(parse_audio_plan_result(r#"{"sampleRate":48000,"durationSamples":10,"clips":[{"source":"a","startSample":0,"sourceStartSample":0,"durationSamples":10,"gain":-1}]}"#).is_err());
        assert!(parse_audio_plan_result("undefined").is_err());
    }
}
