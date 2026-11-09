//! Executes the real protocol serializers for cross-language conformance tests.
//! This target deliberately depends on no renderer or browser/GPU runtime.
use std::io;
use velocast_protocol::{AudioPlan, CompositionManifest, RenderContext, RenderJob, RendererEvent};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    match std::env::args().nth(1).as_deref() {
        Some("audio-plans") => {
            let plans: Vec<AudioPlan> = serde_json::from_reader(io::stdin().lock())?;
            for plan in &plans {
                plan.validate()?;
            }
            serde_json::to_writer(io::stdout().lock(), &plans)?;
        }
        Some("jobs") => {
            let jobs: Vec<RenderJob> = serde_json::from_reader(io::stdin().lock())?;
            serde_json::to_writer(io::stdout().lock(), &jobs)?;
        }
        Some("events") => {
            for event in sample_events() {
                println!("{}", serde_json::to_string(&event)?);
            }
        }
        Some("metadata") => {
            let manifests: Vec<CompositionManifest> = serde_json::from_reader(io::stdin().lock())?;
            serde_json::to_writer(io::stdout().lock(), &manifests)?;
        }
        Some("contexts") => {
            let contexts: Vec<RenderContext> = serde_json::from_reader(io::stdin().lock())?;
            serde_json::to_writer(io::stdout().lock(), &contexts)?;
        }
        _ => return Err("unknown conformance command".into()),
    }
    Ok(())
}

fn sample_events() -> [RendererEvent; 6] {
    [
        RendererEvent::RendererStarted {
            mode: "composition".into(),
            output: "out.mp4".into(),
        },
        RendererEvent::PipelinePlanResolved {
            route: "parallel_segments".into(),
            effective_concurrency: 3,
            probe_tier: "segments_and_final_deep".into(),
            segment_count: 3,
            capture_mode: "electron_shared_texture".into(),
            conversion_mode: "chromium_webcodecs".into(),
            encoder_mode: "webcodecs".into(),
            planned_encoder_backend: "electron_webcodecs_h264".into(),
            encoder_backend: "electron_webcodecs_h264".into(),
        },
        RendererEvent::FrameRendered {
            frame: 0,
            capture_backend: Some("electron_shared_texture".into()),
            surface_format_in: None,
        },
        RendererEvent::FrameEncoded {
            frame: 0,
            frames_encoded: 1,
        },
        RendererEvent::RendererFinished {
            frames_rendered: 1,
            frames_encoded: 1,
            fallback_used: false,
            fallback_reason: None,
            cpu_readback_frames: 4_294_967_296,
            capture_backend: Some("electron_shared_texture".into()),
            conversion_backend: Some("chromium_webcodecs".into()),
            encoder_backend: Some("electron_webcodecs_h264".into()),
        },
        RendererEvent::RendererFailed {
            error: "renderer stopped".into(),
        },
    ]
}
