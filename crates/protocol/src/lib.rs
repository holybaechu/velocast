mod audio;
mod generated;
pub use audio::{audio_frames_to_samples, AudioSampleRounding};
pub use generated::*;
use std::num::NonZeroU32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompositionJob {
    pub composition_id: Option<String>,
    pub composition: Option<CompositionManifest>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UrlJob {
    pub selector: String,
    pub composition: Option<CompositionManifest>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerJob {
    pub composition_id: Option<String>,
    pub composition: Option<CompositionManifest>,
    pub selector: Option<String>,
    pub frame_start: u32,
    pub frame_end: u32,
    pub frame_step: Option<NonZeroU32>,
    pub chunk_output: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RenderJobKind {
    Composition(CompositionJob),
    Url(UrlJob),
    CompositionWorker(WorkerJob),
}

impl RenderJob {
    pub fn kind(&self) -> Result<RenderJobKind, String> {
        generated::validate_render_job_mode(self)?;
        self.validate_output_request()?;
        match self.mode {
            RenderMode::Composition => Ok(RenderJobKind::Composition(CompositionJob {
                composition_id: self.composition_id.clone(),
                composition: self.composition.clone(),
            })),
            RenderMode::Url => Ok(RenderJobKind::Url(UrlJob {
                selector: self
                    .selector
                    .clone()
                    .ok_or_else(|| "url job requires selector".to_string())?,
                composition: self.composition.clone(),
            })),
            RenderMode::CompositionWorker => Ok(RenderJobKind::CompositionWorker(WorkerJob {
                composition_id: self.composition_id.clone(),
                composition: self.composition.clone(),
                selector: self.selector.clone(),
                frame_start: self
                    .frame_start
                    .ok_or_else(|| "composition_worker job requires frame_start".to_string())?,
                frame_end: self
                    .frame_end
                    .ok_or_else(|| "composition_worker job requires frame_end".to_string())?,
                frame_step: self.frame_step,
                chunk_output: self
                    .chunk_output
                    .clone()
                    .ok_or_else(|| "composition_worker job requires chunk_output".to_string())?,
            })),
        }
    }

    pub fn validate_output_request(&self) -> Result<(), String> {
        if self.mode != RenderMode::Composition
            && (self.operation != RenderOperation::Render
                || self.output_frame.is_some()
                || self.output_range.is_some())
        {
            return Err("output.invalid_request: frame, inspection and public ranges require composition mode".to_owned());
        }
        if self.mode == RenderMode::CompositionWorker && self.result_path.is_some() {
            return Err(
                "output.invalid_request: worker jobs cannot publish coordinator results".to_owned(),
            );
        }
        if self.capture_probe.is_some()
            && (self.operation != RenderOperation::Render || self.output_range.is_some())
        {
            return Err(
                "output.invalid_request: capture probes cannot include public output operations"
                    .to_owned(),
            );
        }
        match self.operation {
            RenderOperation::Render if self.output_frame.is_some() => {
                return Err(
                    "output.invalid_request: output_frame requires frame operation".to_owned(),
                )
            }
            RenderOperation::Inspect
                if self.output_frame.is_some()
                    || self.output_range.is_some()
                    || self.result_path.is_none() =>
            {
                return Err(
                    "output.invalid_request: inspect requires result_path and forbids frame/range"
                        .to_owned(),
                )
            }
            RenderOperation::Frame
                if self.output_frame.is_none() || self.output_range.is_some() =>
            {
                return Err(
                    "output.invalid_request: frame requires output_frame and forbids ranges"
                        .to_owned(),
                )
            }
            _ => {}
        }
        if let Some(range) = &self.output_range {
            if range.start_frame >= range.end_frame {
                return Err(
                    "output.invalid_range: startFrame must be less than exclusive endFrame"
                        .to_owned(),
                );
            }
        }
        if self
            .result_path
            .as_ref()
            .is_some_and(|path| path.trim().is_empty())
        {
            return Err("output.invalid_request: result_path must not be empty".to_owned());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::num::NonZeroU32;

    #[test]
    fn public_output_requests_default_to_legacy_render_and_reject_ambiguous_fields() {
        let base = json!({"mode":"composition","composition_id":"hero","serve_url":"http://localhost","output":"out.mp4","codec":"h264"});
        let job: RenderJob = serde_json::from_value(base.clone()).unwrap();
        assert_eq!(job.operation, RenderOperation::Render);
        assert!(job.kind().is_ok());
        for extra in [
            json!({"output_frame":2}),
            json!({"operation":"frame"}),
            json!({"operation":"inspect"}),
            json!({"output_range":{"startFrame":5,"endFrame":5}}),
            json!({"mode":"url","selector":"#root","output_range":{"startFrame":1,"endFrame":3}}),
        ] {
            let mut input = base.clone();
            input
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            let job: RenderJob = serde_json::from_value(input).unwrap();
            assert!(job.kind().is_err());
        }
        let mut input = base;
        input["output_range"] = json!({"startFrame":12,"endFrame":90});
        let job: RenderJob = serde_json::from_value(input).unwrap();
        assert!(job.kind().is_ok());
        assert_eq!(job.output_range.unwrap().end_frame, 90);
    }

    #[test]
    fn parses_render_job_from_cli_json() {
        let job: RenderJob = serde_json::from_str(
            r#"{
              "mode":"composition",
              "composition_id":"product-hero",
              "serve_url":"http://127.0.0.1:4545",
              "selector":null,
              "output":"out/hero.mp4",
              "codec":"h264",
              "pixel_format":"yuv444p"
            }"#,
        )
        .unwrap();

        assert_eq!(job.mode, RenderMode::Composition);
        assert_eq!(job.composition_id.as_deref(), Some("product-hero"));
        assert_eq!(job.pixel_format.as_deref(), Some("yuv444p"));
        assert!(matches!(
            job.kind().unwrap(),
            RenderJobKind::Composition(CompositionJob { .. })
        ));
    }

    #[test]
    fn parses_url_job_as_tagged_variant() {
        let job: RenderJob = serde_json::from_str(
            r##"{
          "mode":"url",
          "serve_url":"http://127.0.0.1:4545",
          "selector":"#hero",
          "output":"out/hero.mp4",
          "codec":"h264",
          "pixel_format":"yuv444p"
        }"##,
        )
        .unwrap();

        assert!(matches!(
            job.kind().unwrap(),
            RenderJobKind::Url(UrlJob { selector, .. }) if selector == "#hero"
        ));
    }

    #[test]
    fn rejects_url_job_without_selector() {
        let error = serde_json::from_str::<RenderJob>(
            r#"{
          "mode":"url",
          "serve_url":"http://127.0.0.1:4545",
          "output":"out/hero.mp4",
          "codec":"h264",
          "pixel_format":"yuv444p"
        }"#,
        )
        .unwrap_err();

        assert!(error.to_string().contains("url job requires selector"));
    }

    #[test]
    fn parses_accelerated_paint_capture_probe() {
        let job: RenderJob = serde_json::from_str(
            r#"{
          "mode":"composition",
          "composition_id":"product-hero",
          "serve_url":"http://127.0.0.1:4545",
          "selector":null,
          "output":"renders/probe-unused.mp4",
          "codec":"h264",
          "pixel_format":"nv12",
          "acceleration":"required",
          "capture_probe":"accelerated_paint"
        }"#,
        )
        .unwrap();

        assert_eq!(
            job.capture_probe,
            Some(RenderCaptureProbe::AcceleratedPaint)
        );
    }

    #[test]
    fn parses_segment_worker_report_path() {
        let job: RenderJob = serde_json::from_str(
            r#"{
          "mode":"composition",
          "composition_id":"product-hero",
          "serve_url":"http://127.0.0.1:4545",
          "selector":null,
          "output":"renders/segment-0.mp4",
          "codec":"h264",
          "pixel_format":"nv12",
          "acceleration":"required",
          "worker_report_path":"renders/segments/worker-0.report.json"
        }"#,
        )
        .unwrap();

        assert_eq!(
            job.worker_report_path.as_deref(),
            Some("renders/segments/worker-0.report.json")
        );
    }

    #[test]
    fn parses_renderer_event_log_path() {
        let job: RenderJob = serde_json::from_str(
            r#"{
          "mode":"composition",
          "composition_id":"product-hero",
          "serve_url":"http://127.0.0.1:4545",
          "selector":null,
          "output":"renders/product-hero.mp4",
          "codec":"h264",
          "pixel_format":"nv12",
          "event_log_path":"renders/product-hero.events.jsonl"
        }"#,
        )
        .unwrap();

        assert_eq!(
            job.event_log_path.as_deref(),
            Some("renders/product-hero.events.jsonl")
        );
    }

    #[test]
    fn serializes_render_context_with_js_camel_case_keys() {
        let context = RenderContext {
            composition_id: "product-hero".to_owned(),
            width: 1920,
            height: 1080,
            fps: 30,
            duration_frames: 120,
            target: Some("#root".to_owned()),
            input_props: None,
            render_session: None,
        };

        let value = serde_json::to_value(context).unwrap();

        assert_eq!(
            value,
            json!({
                "compositionId": "product-hero",
                "width": 1920,
                "height": 1080,
                "fps": 30,
                "durationFrames": 120,
                "target": "#root"
            })
        );
    }

    #[test]
    fn render_mode_url_round_trips_as_url() {
        let value = serde_json::to_string(&RenderMode::Url).unwrap();

        assert_eq!(value, r#""url""#);
        assert_eq!(
            serde_json::from_str::<RenderMode>(&value).unwrap(),
            RenderMode::Url
        );
    }

    #[test]
    fn parses_auto_renderer_concurrency() {
        let job: RenderJob = serde_json::from_str(
            r#"{
          "mode":"composition",
          "composition_id":"product-hero",
          "serve_url":"http://127.0.0.1:4545",
          "selector":null,
          "output":"out/hero.mp4",
          "codec":"h264",
          "pixel_format":"yuv444p",
          "concurrency":"auto"
        }"#,
        )
        .unwrap();

        assert_eq!(job.concurrency, Some(RendererConcurrency::Auto));
    }

    #[test]
    fn parses_numeric_renderer_concurrency() {
        let job: RenderJob = serde_json::from_str(
            r#"{
          "mode":"composition",
          "composition_id":"product-hero",
          "serve_url":"http://127.0.0.1:4545",
          "selector":null,
          "output":"out/hero.mp4",
          "codec":"h264",
          "pixel_format":"yuv444p",
          "concurrency":3
        }"#,
        )
        .unwrap();

        assert_eq!(
            job.concurrency,
            Some(RendererConcurrency::Workers(NonZeroU32::new(3).unwrap()))
        );
    }

    #[test]
    fn parses_renderer_acceleration_required() {
        let job: RenderJob = serde_json::from_str(
            r#"{
          "mode":"composition",
          "composition_id":"product-hero",
          "serve_url":"http://127.0.0.1:4545",
          "selector":null,
          "output":"out/hero.mp4",
          "codec":"h264",
          "pixel_format":"nv12",
          "bitrate_bps":60000000,
          "acceleration":"required"
        }"#,
        )
        .unwrap();

        assert_eq!(job.acceleration, RendererAcceleration::Required);
        assert_eq!(job.bitrate_bps, Some(60_000_000));
    }

    #[test]
    fn defaults_renderer_acceleration_to_auto() {
        let job: RenderJob = serde_json::from_str(
            r#"{
          "mode":"composition",
          "composition_id":"product-hero",
          "serve_url":"http://127.0.0.1:4545",
          "selector":null,
          "output":"out/hero.mp4",
          "codec":"h264",
          "pixel_format":"yuv444p"
        }"#,
        )
        .unwrap();

        assert_eq!(job.acceleration, RendererAcceleration::Auto);
    }

    #[test]
    fn parses_report_path_and_assembly_mode() {
        let job: RenderJob = serde_json::from_str(
            r#"{
          "mode":"composition",
          "composition_id":"product-hero",
          "serve_url":"http://127.0.0.1:4545",
          "selector":null,
          "output":"out/hero.mp4",
          "codec":"h264",
          "pixel_format":"nv12",
          "acceleration":"required",
          "assembly_mode":"segments",
          "report_path":"renders/report.json"
        }"#,
        )
        .unwrap();

        assert_eq!(job.assembly_mode, RendererAssemblyMode::Segments);
        assert_eq!(job.report_path.as_deref(), Some("renders/report.json"));
    }

    #[test]
    fn parses_input_props_path() {
        let job: RenderJob = serde_json::from_str(
            r#"{
          "mode":"composition",
          "composition_id":"product-hero",
          "serve_url":"http://127.0.0.1:4546",
          "selector":null,
          "output":"out/hero.mp4",
          "codec":"h264",
          "pixel_format":"nv12",
          "input_props_path":"inputs/product-hero.input-props.json"
        }"#,
        )
        .unwrap();

        assert_eq!(
            job.input_props_path.as_deref(),
            Some("inputs/product-hero.input-props.json")
        );
    }

    #[test]
    fn serializes_render_context_with_input_props() {
        let context = RenderContext {
            render_session: None,
            composition_id: "product-hero".to_owned(),
            width: 1920,
            height: 1080,
            fps: 60,
            duration_frames: 120,
            target: Some("#product-hero".to_owned()),
            input_props: Some(json!({
                "song": { "id": "1348147334" },
                "isScyllable": false
            })),
        };

        let value = serde_json::to_value(context).unwrap();

        assert_eq!(
            value.get("inputProps"),
            Some(&json!({
                "song": { "id": "1348147334" },
                "isScyllable": false
            }))
        );
    }

    #[test]
    fn defaults_assembly_mode_to_auto() {
        let job: RenderJob = serde_json::from_str(
            r#"{
          "mode":"composition",
          "composition_id":"product-hero",
          "serve_url":"http://127.0.0.1:4545",
          "selector":null,
          "output":"out/hero.mp4",
          "codec":"h264",
          "pixel_format":"yuv444p"
        }"#,
        )
        .unwrap();

        assert_eq!(job.assembly_mode, RendererAssemblyMode::Auto);
    }

    #[test]
    fn serializes_renderer_concurrency_as_auto_or_number() {
        assert_eq!(
            serde_json::to_value(RendererConcurrency::Auto).unwrap(),
            json!("auto")
        );
        assert_eq!(
            serde_json::to_value(RendererConcurrency::Workers(NonZeroU32::new(3).unwrap()))
                .unwrap(),
            json!(3)
        );
    }

    #[test]
    fn rejects_zero_renderer_concurrency() {
        let error = serde_json::from_str::<RenderJob>(
            r#"{
          "mode":"composition",
          "composition_id":"product-hero",
          "serve_url":"http://127.0.0.1:4545",
          "selector":null,
          "output":"out/hero.mp4",
          "codec":"h264",
          "pixel_format":"yuv444p",
          "concurrency":0
        }"#,
        )
        .unwrap_err();

        assert!(error.to_string().contains("positive integer or auto"));
    }

    #[test]
    fn parses_composition_worker_job_fields() {
        let job: RenderJob = serde_json::from_str(
            r#"{
          "mode":"composition_worker",
          "composition_id":"product-hero",
          "serve_url":"http://127.0.0.1:4545",
          "selector":null,
          "output":"out/hero.mp4",
          "codec":"h264",
          "frame_start":60,
          "frame_end":120,
          "frame_step":2,
          "chunk_output":".velocast/tmp/chunk-0001.bgra"
        }"#,
        )
        .unwrap();

        assert_eq!(job.mode, RenderMode::CompositionWorker);
        assert_eq!(job.frame_start, Some(60));
        assert_eq!(job.frame_end, Some(120));
        assert_eq!(job.frame_step, NonZeroU32::new(2));
        assert_eq!(
            job.chunk_output.as_deref(),
            Some(".velocast/tmp/chunk-0001.bgra")
        );
        assert!(matches!(
            job.kind().unwrap(),
            RenderJobKind::CompositionWorker(WorkerJob {
                frame_start: 60,
                frame_end: 120,
                ..
            })
        ));
    }

    #[test]
    fn rejects_composition_job_with_worker_only_fields() {
        let error = serde_json::from_str::<RenderJob>(
            r#"{
          "mode":"composition",
          "composition_id":"product-hero",
          "serve_url":"http://127.0.0.1:4545",
          "selector":null,
          "output":"out/hero.mp4",
          "codec":"h264",
          "frame_start":0
        }"#,
        )
        .unwrap_err();

        assert!(error
            .to_string()
            .contains("composition job cannot include composition_worker frame/chunk fields"));
    }

    #[test]
    fn rejects_worker_job_without_chunk_output() {
        let error = serde_json::from_str::<RenderJob>(
            r#"{
          "mode":"composition_worker",
          "composition_id":"product-hero",
          "serve_url":"http://127.0.0.1:4545",
          "selector":null,
          "output":"out/hero.mp4",
          "codec":"h264",
          "frame_start":60,
          "frame_end":120
        }"#,
        )
        .unwrap_err();

        assert!(error
            .to_string()
            .contains("composition_worker job requires chunk_output"));
    }

    #[test]
    fn parses_manifest_max_concurrency() {
        let manifest: CompositionManifest = serde_json::from_value(json!({
            "id": "product-hero",
            "width": 3840,
            "height": 2160,
            "fps": 60,
            "durationFrames": 240,
            "target": "#product-hero",
            "url": null,
            "maxConcurrency": 4
        }))
        .unwrap();

        assert_eq!(manifest.max_concurrency, Some(NonZeroU32::new(4).unwrap()));
    }

    #[test]
    fn rejects_zero_manifest_max_concurrency() {
        let error = serde_json::from_value::<CompositionManifest>(json!({
            "id": "product-hero",
            "width": 3840,
            "height": 2160,
            "fps": 60,
            "durationFrames": 240,
            "target": "#product-hero",
            "url": null,
            "maxConcurrency": 0
        }))
        .unwrap_err();

        assert!(error.to_string().contains("maxConcurrency"));
        assert!(error.to_string().contains("positive integer"));
    }
}
