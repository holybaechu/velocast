use std::num::NonZeroU32;
use velocast_protocol::{
    CompositionManifest, OutputFrameRange, RenderJob, RendererAssemblyMode, RendererConcurrency,
};
use velocast_renderer_policy::render_plan::{RenderPipelinePlan, RenderPipelineRoute};
fn fixture() -> (RenderJob, CompositionManifest) {
    (
 serde_json::from_value(serde_json::json!({"mode":"composition","serve_url":"http://localhost","output":"movie.mp4","codec":"h264"})).unwrap(),
 serde_json::from_value(serde_json::json!({"id":"scene","width":640,"height":360,"fps":30,"durationFrames":90})).unwrap())
}
#[test]
fn segment_ranges_cover_every_frame_once() {
    let (job, c) = fixture();
    let p = RenderPipelinePlan::for_job(&job, &c, 4).unwrap();
    assert_eq!(p.route, RenderPipelineRoute::ParallelSegments);
    assert_eq!(
        p.ranges.iter().flat_map(|r| r.frames()).collect::<Vec<_>>(),
        (0..90).collect::<Vec<_>>()
    );
}
#[test]
fn reference_selection_is_serial() {
    let (mut job, c) = fixture();
    job.assembly_mode = RendererAssemblyMode::Reference;
    assert_eq!(
        RenderPipelinePlan::for_job(&job, &c, 8)
            .unwrap()
            .concurrency,
        1
    );
    job.concurrency = Some(RendererConcurrency::Workers(NonZeroU32::new(2).unwrap()));
    assert!(RenderPipelinePlan::for_job(&job, &c, 8).is_err());
}
#[test]
fn ranges_preserve_source_frames_and_reject_parallel() {
    let (mut job, c) = fixture();
    job.output_range = Some(OutputFrameRange {
        start_frame: 20,
        end_frame: 25,
    });
    let p = RenderPipelinePlan::for_job(&job, &c, 8).unwrap();
    assert_eq!(
        p.ranges[0].frames().collect::<Vec<_>>(),
        vec![20, 21, 22, 23, 24]
    );
    job.assembly_mode = RendererAssemblyMode::Segments;
    assert!(RenderPipelinePlan::for_job(&job, &c, 8).is_err());
}
