use crate::scheduler::{chunk_frame_ranges, resolve_effective_concurrency, FrameRange};
use velocast_protocol::{
    CompositionManifest, RenderJob, RendererAssemblyMode, RendererConcurrency,
};
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenderPipelineRoute {
    SerialReference,
    ParallelSegments,
}
impl RenderPipelineRoute {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SerialReference => "serial_reference",
            Self::ParallelSegments => "parallel_segments",
        }
    }
}
#[derive(Debug, Clone)]
pub struct RenderPipelinePlan {
    pub route: RenderPipelineRoute,
    pub concurrency: u32,
    pub ranges: Vec<FrameRange>,
}
impl RenderPipelinePlan {
    pub fn for_job(
        job: &RenderJob,
        composition: &CompositionManifest,
        available: u32,
    ) -> anyhow::Result<Self> {
        if let Some(range) = &job.output_range {
            anyhow::ensure!(
                range.start_frame < range.end_frame
                    && range.end_frame <= composition.duration_frames,
                "output.invalid_range"
            );
            anyhow::ensure!(
                !matches!(job.concurrency,Some(RendererConcurrency::Workers(n)) if n.get()>1)
                    && job.assembly_mode != RendererAssemblyMode::Segments,
                "output.range_parallel_unsupported: ranges require one reference worker"
            );
            return Ok(Self {
                route: RenderPipelineRoute::SerialReference,
                concurrency: 1,
                ranges: vec![FrameRange::new(range.start_frame, range.end_frame)],
            });
        }
        let workers = resolve_effective_concurrency(
            job.concurrency.as_ref(),
            composition.max_concurrency,
            available,
            composition.duration_frames,
        );
        if job.assembly_mode == RendererAssemblyMode::Reference {
            anyhow::ensure!(
                !matches!(job.concurrency,Some(RendererConcurrency::Workers(n)) if n.get()>1),
                "renderer.invalid_concurrency: reference assembly requires one worker"
            );
            return Ok(Self {
                route: RenderPipelineRoute::SerialReference,
                concurrency: 1,
                ranges: vec![FrameRange::new(0, composition.duration_frames)],
            });
        }
        let count = if job.assembly_mode == RendererAssemblyMode::Auto
            && composition.duration_frames < 60
        {
            1
        } else {
            workers
        };
        Ok(Self {
            route: if count > 1 {
                RenderPipelineRoute::ParallelSegments
            } else {
                RenderPipelineRoute::SerialReference
            },
            concurrency: count,
            ranges: chunk_frame_ranges(composition.duration_frames, count),
        })
    }
}
