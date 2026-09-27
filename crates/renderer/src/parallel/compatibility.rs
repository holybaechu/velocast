use crate::parallel::worker_report::SegmentWorkerReport;
use crate::pipeline::backend_registry::required_gpu_backend_for_telemetry;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerBackendCompatibility {
    Compatible,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerCompatibilityReport {
    pub status: WorkerBackendCompatibility,
}

pub fn validate_required_segment_workers(
    reports: &[SegmentWorkerReport],
) -> anyhow::Result<WorkerCompatibilityReport> {
    if reports.is_empty() {
        return Err(anyhow::anyhow!(
            "worker_backend.incompatible: no worker reports were produced"
        ));
    }

    let first = &reports[0];
    for report in reports {
        validate_worker_backend_report(report)?;
        if report.fallback_used {
            return Err(anyhow::anyhow!(
                "worker_backend.incompatible: worker {} used fallback",
                report.segment_index
            ));
        }
        if report.cpu_readback_frames > 0 {
            return Err(anyhow::anyhow!(
                "worker_backend.incompatible: worker {} used cpu_readback",
                report.segment_index
            ));
        }
        if report.frames_rendered != report.frames_expected
            || report.frames_encoded != report.frames_expected
        {
            return Err(anyhow::anyhow!(
                "worker_backend.incompatible: worker {} frame count mismatch",
                report.segment_index
            ));
        }
        compare_field(
            "capture_backend",
            &first.capture_backend,
            &report.capture_backend,
        )?;
        compare_field(
            "conversion_backend",
            &first.conversion_backend,
            &report.conversion_backend,
        )?;
        compare_field(
            "encoder_backend",
            &first.encoder_backend,
            &report.encoder_backend,
        )
        .map_err(|_| anyhow::anyhow!("worker_backend.incompatible: mixed_encoder_backend"))?;
        compare_optional_field(
            "requested_codec",
            first.requested_codec.as_deref(),
            report.requested_codec.as_deref(),
        )?;
        compare_optional_field(
            "selected_codec",
            first.selected_codec.as_deref(),
            report.selected_codec.as_deref(),
        )?;
        compare_field(
            "surface_format_in",
            &first.surface_format_in,
            &report.surface_format_in,
        )?;
        compare_field(
            "surface_format_encoder",
            &first.surface_format_encoder,
            &report.surface_format_encoder,
        )?;
        compare_field("codec", &first.codec, &report.codec)?;
        compare_field("pixel_format", &first.pixel_format, &report.pixel_format)?;
        compare_field(
            "avg_frame_rate",
            &first.avg_frame_rate,
            &report.avg_frame_rate,
        )?;
        compare_field("timebase", &first.timebase, &report.timebase)?;
    }

    Ok(WorkerCompatibilityReport {
        status: WorkerBackendCompatibility::Compatible,
    })
}

fn validate_worker_backend_report(report: &SegmentWorkerReport) -> anyhow::Result<()> {
    required_gpu_backend_for_telemetry(
        &report.capture_backend,
        &report.conversion_backend,
        &report.encoder_backend,
    )
    .ok_or_else(|| {
        anyhow::anyhow!(
            "worker_backend.incompatible: worker {} used unsupported backend path: capture_backend={}, conversion_backend={}, encoder_backend={}",
            report.segment_index,
            report.capture_backend,
            report.conversion_backend,
            report.encoder_backend
        )
    })?;

    Ok(())
}

fn compare_field(name: &str, expected: &str, actual: &str) -> anyhow::Result<()> {
    if expected != actual {
        return Err(anyhow::anyhow!(
            "worker_backend.incompatible: mixed_{name}: expected {expected}, got {actual}"
        ));
    }
    Ok(())
}

fn compare_optional_field(
    name: &str,
    expected: Option<&str>,
    actual: Option<&str>,
) -> anyhow::Result<()> {
    match (expected, actual) {
        (None, None) => Ok(()),
        (Some(expected), Some(actual)) => compare_field(name, expected, actual),
        (expected, actual) => Err(anyhow::anyhow!(
            "worker_backend.incompatible: mixed_{name}: expected {expected:?}, got {actual:?}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parallel::worker_report::SegmentWorkerReport;

    fn report(index: usize, encoder_backend: &str) -> SegmentWorkerReport {
        let codec = if encoder_backend.starts_with("hevc") {
            "hevc"
        } else if encoder_backend.starts_with("av1") {
            "av1"
        } else {
            "h264"
        };
        let telemetry_codec = Some(codec.to_string());
        SegmentWorkerReport {
            segment_index: index,
            start_frame: (index as u32) * 120,
            end_frame_exclusive: ((index as u32) + 1) * 120,
            frames_expected: 120,
            frames_rendered: 120,
            frames_encoded: 120,
            capture_backend: "electron_d3d11_shared_texture".to_string(),
            conversion_backend: "d3d11_video_processor".to_string(),
            encoder_backend: encoder_backend.to_string(),
            surface_format_in: "bgra".to_string(),
            surface_format_encoder: "nv12".to_string(),
            requested_codec: telemetry_codec.clone(),
            selected_codec: telemetry_codec,
            codec: codec.to_string(),
            pixel_format: "nv12".to_string(),
            avg_frame_rate: "60/1".to_string(),
            timebase: "1/15360".to_string(),
            cpu_readback_frames: 0,
            fallback_used: false,
            segment_probe: None,
        }
    }

    fn windows_report(index: usize) -> SegmentWorkerReport {
        SegmentWorkerReport {
            segment_index: index,
            start_frame: (index as u32) * 120,
            end_frame_exclusive: ((index as u32) + 1) * 120,
            frames_expected: 120,
            frames_rendered: 120,
            frames_encoded: 120,
            capture_backend: "electron_d3d11_shared_texture".to_string(),
            conversion_backend: "d3d11_video_processor".to_string(),
            encoder_backend: "h264_mf".to_string(),
            surface_format_in: "bgra".to_string(),
            surface_format_encoder: "nv12".to_string(),
            requested_codec: None,
            selected_codec: None,
            codec: "h264".to_string(),
            pixel_format: "nv12".to_string(),
            avg_frame_rate: "60/1".to_string(),
            timebase: "1/15360".to_string(),
            cpu_readback_frames: 0,
            fallback_used: false,
            segment_probe: None,
        }
    }

    #[test]
    fn accepts_matching_windows_gpu_workers_for_encoder_family() {
        for encoder_backend in ["h264_amf", "h264_nvenc", "h264_qsv", "h264_mf"] {
            let mut first = windows_report(0);
            first.encoder_backend = encoder_backend.to_string();
            let mut second = windows_report(1);
            second.encoder_backend = encoder_backend.to_string();

            let result = validate_required_segment_workers(&[first, second])
                .unwrap_or_else(|error| panic!("{encoder_backend}: {error}"));

            assert_eq!(result.status, WorkerBackendCompatibility::Compatible);
        }
    }

    #[test]
    fn rejects_mixed_platform_backend_path() {
        let mut bad = report(0, "h264_mf");
        bad.capture_backend = "retired_capture_backend".to_string();

        let error = validate_required_segment_workers(&[bad])
            .unwrap_err()
            .to_string();

        assert!(error.contains("worker_backend.incompatible"));
        assert!(error.contains("unsupported backend path"));
        assert!(error.contains("encoder_backend=h264_mf"));
    }

    #[test]
    fn rejects_mixed_encoder_backends() {
        let error =
            validate_required_segment_workers(&[report(0, "h264_mf"), report(1, "hevc_mf")])
                .unwrap_err()
                .to_string();

        assert!(error.contains("worker_backend.incompatible"));
        assert!(error.contains("mixed_encoder_backend"));
    }

    #[test]
    fn rejects_worker_cpu_readback() {
        let mut bad = report(0, "h264_mf");
        bad.cpu_readback_frames = 1;

        let error = validate_required_segment_workers(&[bad])
            .unwrap_err()
            .to_string();

        assert!(error.contains("worker_backend.incompatible"));
        assert!(error.contains("cpu_readback"));
    }

    #[test]
    fn rejects_mixed_requested_codecs() {
        let first = report(0, "h264_mf");
        let mut second = report(1, "h264_mf");
        second.requested_codec = Some("av1".to_string());

        let error = validate_required_segment_workers(&[first, second])
            .unwrap_err()
            .to_string();

        assert!(error.contains("worker_backend.incompatible"));
        assert!(error.contains("mixed_requested_codec"));
    }

    #[test]
    fn rejects_mixed_selected_codecs() {
        let first = report(0, "h264_mf");
        let mut second = report(1, "h264_mf");
        second.selected_codec = Some("hevc".to_string());

        let error = validate_required_segment_workers(&[first, second])
            .unwrap_err()
            .to_string();

        assert!(error.contains("worker_backend.incompatible"));
        assert!(error.contains("mixed_selected_codec"));
    }
}
