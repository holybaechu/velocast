//! One segment lifecycle for the coordinator's local worker and subprocess workers.

use std::path::{Path, PathBuf};
use std::time::Instant;
use velocast_protocol::{
    CompositionManifest, RenderJob, RenderJobKind, RenderMode, RendererAcceleration,
};

use crate::native_browser::NativeBrowser;
use crate::pipeline::render_plan::RenderPipelineSegmentPlan;
use crate::scheduler::FrameRange;
use crate::segment_muxer::SegmentProbeCache;
use crate::telemetry::{RenderModeLabel, RenderTelemetry};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SegmentWork {
    pub index: usize,
    pub range: FrameRange,
    pub output: PathBuf,
    pub telemetry_report: Option<PathBuf>,
    pub worker_report: Option<PathBuf>,
}

impl SegmentWork {
    pub fn from_plan(segment: &RenderPipelineSegmentPlan) -> Self {
        Self {
            index: segment.index,
            range: segment.range,
            output: segment.output.clone(),
            telemetry_report: Some(segment.telemetry_report.clone()),
            worker_report: segment.worker_report.clone(),
        }
    }

    /// Compatibility normalization happens once at the subprocess wire ingress.
    /// Locally planned work carries its index and range directly.
    pub fn from_worker_job(job: &RenderJob) -> anyhow::Result<Self> {
        let RenderJobKind::CompositionWorker(worker) = job.kind().map_err(anyhow::Error::msg)?
        else {
            return Err(crate::errors::RendererError::InvalidWorkerJob.into());
        };
        if worker.frame_start >= worker.frame_end {
            return Err(crate::errors::RendererError::InvalidWorkerRange {
                start: worker.frame_start,
                end: worker.frame_end,
            }
            .into());
        }
        if worker.frame_step.is_some_and(|step| step.get() != 1) {
            return Err(anyhow::anyhow!(
                "encoded segments require contiguous frames"
            ));
        }
        let output = PathBuf::from(worker.chunk_output);
        let index = output
            .file_stem()
            .and_then(|stem| stem.to_str())
            .and_then(|stem| {
                let start = stem
                    .trim_end_matches(|character: char| character.is_ascii_digit())
                    .len();
                stem[start..].parse().ok()
            })
            .unwrap_or(worker.frame_start as usize);
        Ok(Self {
            index,
            range: FrameRange::new(worker.frame_start, worker.frame_end),
            output,
            telemetry_report: job.report_path.as_ref().map(PathBuf::from),
            worker_report: job.worker_report_path.as_ref().map(PathBuf::from),
        })
    }

    pub fn worker_job(&self, base: &RenderJob, composition: &CompositionManifest) -> RenderJob {
        let mut job = base.clone();
        job.result_path = None;
        job.operation = velocast_protocol::RenderOperation::Render;
        job.output_frame = None;
        job.output_range = None;
        job.mode = RenderMode::CompositionWorker;
        job.composition_id = Some(composition.id.clone());
        job.composition = Some(composition.clone());
        job.concurrency = None;
        job.event_log_path = None;
        job.frame_start = Some(self.range.start);
        job.frame_end = Some(self.range.end);
        job.frame_step = std::num::NonZeroU32::new(1);
        job.chunk_output = Some(self.output.to_string_lossy().into_owned());
        job.report_path = self
            .telemetry_report
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned());
        job.worker_report_path = self
            .worker_report
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned());
        job
    }

    pub fn telemetry(&self) -> RenderTelemetry {
        let mut telemetry = RenderTelemetry::new(RenderModeLabel::ParallelSegments);
        telemetry.frames_expected = self.range.end - self.range.start;
        telemetry
    }
}

pub(crate) async fn execute_segment(
    work: &SegmentWork,
    job: &RenderJob,
    composition: &CompositionManifest,
    browser: &NativeBrowser,
    input_props: Option<&serde_json::Value>,
    telemetry: &mut RenderTelemetry,
    started_at: Instant,
    probe_cache: &mut SegmentProbeCache,
) -> anyhow::Result<()> {
    execute_with_renderer(
        work,
        job.acceleration,
        telemetry,
        started_at,
        &mut ElectronSegmentRenderer {
            job,
            composition,
            browser,
            input_props,
        },
        probe_cache,
    )
    .await
}

trait SegmentRenderer {
    async fn render(
        &mut self,
        work: &SegmentWork,
        telemetry: &mut RenderTelemetry,
    ) -> anyhow::Result<()>;
}

struct ElectronSegmentRenderer<'a> {
    job: &'a RenderJob,
    composition: &'a CompositionManifest,
    browser: &'a NativeBrowser,
    input_props: Option<&'a serde_json::Value>,
}

impl SegmentRenderer for ElectronSegmentRenderer<'_> {
    async fn render(
        &mut self,
        work: &SegmentWork,
        telemetry: &mut RenderTelemetry,
    ) -> anyhow::Result<()> {
        self.browser.prepare_composition_with_input_props(
            self.composition,
            None,
            self.input_props,
        )?;
        crate::frame_loop::render_frame_range_to_segment(
            self.job,
            self.composition,
            work.range,
            self.browser.paint_state(),
            self.browser,
            &work.output,
            telemetry,
        )
        .await
    }
}

async fn execute_with_renderer(
    work: &SegmentWork,
    acceleration: RendererAcceleration,
    telemetry: &mut RenderTelemetry,
    started_at: Instant,
    renderer: &mut impl SegmentRenderer,
    probe_cache: &mut SegmentProbeCache,
) -> anyhow::Result<()> {
    let render_result = renderer.render(work, telemetry).await;
    telemetry.mark_finished(started_at.elapsed().as_millis());
    let render_result = render_result.and_then(|()| {
        if acceleration == RendererAcceleration::Required {
            crate::platform::verify_render_completion(telemetry, false)
        } else {
            Ok(())
        }
    });
    let report_result = match &work.telemetry_report {
        Some(path) => crate::telemetry::write_report(path, telemetry).await,
        None => Ok(()),
    };
    let worker_report_result = write_worker_report(work, telemetry, probe_cache).await;
    // Attempt both reports on failure, while retaining the original render error.
    render_result.and(report_result).and(worker_report_result)
}

pub(crate) async fn write_worker_report(
    work: &SegmentWork,
    telemetry: &RenderTelemetry,
    probe_cache: &mut SegmentProbeCache,
) -> anyhow::Result<()> {
    let Some(path) = &work.worker_report else {
        return Ok(());
    };
    let stream = crate::parallel::worker_report::probe_segment_worker_stream_facts_with_cache(
        &work.output,
        probe_cache,
    )
    .await?;
    let report = crate::parallel::worker_report::SegmentWorkerReport::from_telemetry(
        work.index,
        work.range.start,
        work.range.end,
        telemetry,
        stream,
    )?;
    crate::parallel::worker_report::write_worker_report(path, &report).await
}

pub(crate) fn worker_output_is_segment(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("mp4"))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FailedRenderer;
    impl SegmentRenderer for FailedRenderer {
        async fn render(
            &mut self,
            _work: &SegmentWork,
            telemetry: &mut RenderTelemetry,
        ) -> anyhow::Result<()> {
            telemetry.frames_rendered = 2;
            Err(anyhow::anyhow!("frame capture failed"))
        }
    }

    #[tokio::test]
    async fn failed_segment_keeps_capture_error_and_writes_partial_telemetry() {
        let root = std::env::temp_dir().join(format!(
            "velocast-segment-report-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let report = root.join("report.json");
        let work = SegmentWork {
            index: 7,
            range: FrameRange::new(20, 30),
            output: root.join("segment.mp4"),
            telemetry_report: Some(report.clone()),
            worker_report: None,
        };
        let mut telemetry = work.telemetry();
        let result = execute_with_renderer(
            &work,
            RendererAcceleration::Off,
            &mut telemetry,
            Instant::now(),
            &mut FailedRenderer,
            &mut SegmentProbeCache::new(),
        )
        .await;
        assert_eq!(result.unwrap_err().to_string(), "frame capture failed");
        let recorded: RenderTelemetry =
            serde_json::from_slice(&tokio::fs::read(report).await.unwrap()).unwrap();
        assert_eq!(recorded.frames_expected, 10);
        assert_eq!(recorded.frames_rendered, 2);
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
}
