use std::path::Path;
use std::process::Stdio;

use crate::segment_muxer::{SegmentProbe, SegmentProbeCache};
use serde::{Deserialize, Serialize};
use tokio::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SegmentWorkerReport {
    pub segment_index: usize,
    pub start_frame: u32,
    pub end_frame_exclusive: u32,
    pub frames_expected: u32,
    pub frames_rendered: u32,
    pub frames_encoded: u32,
    pub capture_backend: String,
    pub conversion_backend: String,
    pub encoder_backend: String,
    pub surface_format_in: String,
    pub surface_format_encoder: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_codec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_codec: Option<String>,
    pub codec: String,
    pub pixel_format: String,
    pub avg_frame_rate: String,
    pub timebase: String,
    pub cpu_readback_frames: u64,
    pub fallback_used: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub segment_probe: Option<SegmentProbe>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SegmentWorkerStreamFacts {
    pub codec: String,
    pub pixel_format: String,
    pub avg_frame_rate: String,
    pub timebase: String,
    pub segment_probe: SegmentProbe,
}

impl SegmentWorkerStreamFacts {
    fn from_probe(probe: SegmentProbe, timebase: String) -> Self {
        Self {
            codec: probe.signature.codec_name.clone(),
            pixel_format: probe.signature.pix_fmt.clone(),
            avg_frame_rate: probe.signature.avg_frame_rate.clone(),
            timebase,
            segment_probe: probe,
        }
    }
}

impl SegmentWorkerReport {
    pub fn from_telemetry(
        segment_index: usize,
        start_frame: u32,
        end_frame_exclusive: u32,
        telemetry: &crate::telemetry::RenderTelemetry,
        stream: SegmentWorkerStreamFacts,
    ) -> anyhow::Result<Self> {
        Ok(Self {
            segment_index,
            start_frame,
            end_frame_exclusive,
            frames_expected: telemetry.frames_expected,
            frames_rendered: telemetry.frames_rendered,
            frames_encoded: telemetry.frames_encoded,
            capture_backend: required_field("capture_backend", &telemetry.capture_backend)?,
            conversion_backend: required_field(
                "conversion_backend",
                &telemetry.conversion_backend,
            )?,
            encoder_backend: required_field("encoder_backend", &telemetry.encoder_backend)?,
            surface_format_in: required_field("surface_format_in", &telemetry.surface_format_in)?,
            surface_format_encoder: required_field(
                "surface_format_encoder",
                &telemetry.surface_format_encoder,
            )?,
            requested_codec: telemetry.requested_codec.clone(),
            selected_codec: telemetry.selected_codec.clone(),
            codec: stream.codec,
            pixel_format: stream.pixel_format,
            avg_frame_rate: stream.avg_frame_rate,
            timebase: stream.timebase,
            cpu_readback_frames: telemetry.cpu_readback_frames,
            fallback_used: telemetry.fallback_used,
            segment_probe: Some(stream.segment_probe),
        })
    }
}

fn required_field(name: &str, value: &Option<String>) -> anyhow::Result<String> {
    value
        .clone()
        .ok_or_else(|| anyhow::anyhow!("worker_report.missing_field: {name}"))
}

pub async fn write_worker_report(path: &Path, report: &SegmentWorkerReport) -> anyhow::Result<()> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        tokio::fs::create_dir_all(parent).await?;
    }
    let json = serde_json::to_vec_pretty(report)?;
    tokio::fs::write(path, [json.as_slice(), b"\n"].concat()).await?;
    Ok(())
}

pub async fn read_worker_report(path: &Path) -> anyhow::Result<SegmentWorkerReport> {
    let bytes = tokio::fs::read(path).await?;
    Ok(serde_json::from_slice(&bytes)?)
}

pub async fn probe_segment_worker_stream_facts(
    segment: &Path,
) -> anyhow::Result<SegmentWorkerStreamFacts> {
    let mut cache = SegmentProbeCache::new();
    probe_segment_worker_stream_facts_with_cache(segment, &mut cache).await
}

pub async fn probe_segment_worker_stream_facts_with_cache(
    segment: &Path,
    cache: &mut SegmentProbeCache,
) -> anyhow::Result<SegmentWorkerStreamFacts> {
    let probe = cache.probe_segment(segment).await?;
    let timebase = probe_segment_timebase(segment).await?;
    Ok(SegmentWorkerStreamFacts::from_probe(probe, timebase))
}

async fn probe_segment_timebase(segment: &Path) -> anyhow::Result<String> {
    let segment_arg = segment.to_string_lossy().to_string();
    let output = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=time_base",
            "-of",
            "json",
            &segment_arg,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await?;

    if !output.status.success() {
        return Err(anyhow::anyhow!(
            "ffprobe segment timebase probe failed for {} with code {}{}",
            segment.display(),
            output.status.code().unwrap_or(-1),
            stderr_suffix(&output.stderr)
        ));
    }

    let parsed: FfprobeTimebaseOutput =
        serde_json::from_slice(&output.stdout).map_err(|error| {
            anyhow::anyhow!(
                "failed to parse ffprobe timebase output for {}: {error}",
                segment.display()
            )
        })?;
    Ok(parsed
        .streams
        .into_iter()
        .next()
        .and_then(|stream| stream.time_base)
        .filter(|timebase| !timebase.trim().is_empty() && timebase != "N/A")
        .unwrap_or_else(|| "unavailable".to_string()))
}

#[derive(Debug, Deserialize)]
struct FfprobeTimebaseOutput {
    #[serde(default)]
    streams: Vec<FfprobeTimebaseStream>,
}

#[derive(Debug, Deserialize)]
struct FfprobeTimebaseStream {
    time_base: Option<String>,
}

fn stderr_suffix(stderr: &[u8]) -> String {
    let stderr = String::from_utf8_lossy(stderr);
    let stderr = stderr.trim();
    if stderr.is_empty() {
        String::new()
    } else {
        format!(": {stderr}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn telemetry() -> crate::telemetry::RenderTelemetry {
        let mut telemetry = crate::telemetry::RenderTelemetry::new(
            crate::telemetry::RenderModeLabel::ParallelSegments,
        );
        telemetry.frames_expected = 120;
        telemetry.frames_rendered = 120;
        telemetry.frames_encoded = 120;
        telemetry.capture_backend = Some("electron_d3d11_shared_texture".to_string());
        telemetry.conversion_backend = Some("d3d11_video_processor".to_string());
        telemetry.encoder_backend = Some("h264_mf".to_string());
        telemetry.surface_format_in = Some("bgra".to_string());
        telemetry.surface_format_encoder = Some("nv12".to_string());
        telemetry.requested_codec = Some("h264".to_string());
        telemetry.selected_codec = Some("h264".to_string());
        telemetry
    }

    fn segment_probe(codec: &str, pixel_format: &str, avg_frame_rate: &str) -> SegmentProbe {
        SegmentProbe {
            signature: crate::segment_muxer::StreamSignature {
                codec_name: codec.to_string(),
                width: 3840,
                height: 2160,
                avg_frame_rate: avg_frame_rate.to_string(),
                pix_fmt: pixel_format.to_string(),
                color_range: Some("tv".to_string()),
                color_space: Some("bt709".to_string()),
                color_transfer: Some("bt709".to_string()),
                color_primaries: Some("bt709".to_string()),
            },
            frame_count: 120,
            duration_seconds: None,
        }
    }

    #[test]
    fn report_uses_produced_segment_stream_facts() {
        let report = SegmentWorkerReport::from_telemetry(
            0,
            0,
            120,
            &telemetry(),
            SegmentWorkerStreamFacts {
                codec: "hevc".to_string(),
                pixel_format: "yuv420p".to_string(),
                avg_frame_rate: "30000/1001".to_string(),
                timebase: "1/30000".to_string(),
                segment_probe: segment_probe("hevc", "yuv420p", "30000/1001"),
            },
        )
        .unwrap();

        assert_eq!(report.codec, "hevc");
        assert_eq!(report.requested_codec.as_deref(), Some("h264"));
        assert_eq!(report.selected_codec.as_deref(), Some("h264"));
        assert_eq!(report.pixel_format, "yuv420p");
        assert_eq!(report.avg_frame_rate, "30000/1001");
        assert_eq!(report.timebase, "1/30000");
    }

    #[test]
    fn compatibility_rejects_mismatched_produced_stream_facts() {
        let mut first = SegmentWorkerReport::from_telemetry(
            0,
            0,
            120,
            &telemetry(),
            SegmentWorkerStreamFacts {
                codec: "h264".to_string(),
                pixel_format: "nv12".to_string(),
                avg_frame_rate: "60/1".to_string(),
                timebase: "1/15360".to_string(),
                segment_probe: segment_probe("h264", "nv12", "60/1"),
            },
        )
        .unwrap();
        let second = SegmentWorkerReport::from_telemetry(
            1,
            120,
            240,
            &telemetry(),
            SegmentWorkerStreamFacts {
                codec: "h264".to_string(),
                pixel_format: "yuv420p".to_string(),
                avg_frame_rate: "60/1".to_string(),
                timebase: "1/15360".to_string(),
                segment_probe: segment_probe("h264", "yuv420p", "60/1"),
            },
        )
        .unwrap();
        first.segment_index = 0;

        let error =
            crate::parallel::compatibility::validate_required_segment_workers(&[first, second])
                .unwrap_err()
                .to_string();

        assert!(error.contains("worker_backend.incompatible"));
        assert!(error.contains("mixed_pixel_format"));
    }

    #[test]
    fn deserializes_legacy_worker_report_without_segment_probe() {
        let report: SegmentWorkerReport = serde_json::from_value(serde_json::json!({
            "segment_index": 1,
            "start_frame": 120,
            "end_frame_exclusive": 240,
            "frames_expected": 120,
            "frames_rendered": 120,
            "frames_encoded": 120,
            "capture_backend": "electron_d3d11_shared_texture",
            "conversion_backend": "d3d11_video_processor",
            "encoder_backend": "h264_mf",
            "surface_format_in": "bgra",
            "surface_format_encoder": "nv12",
            "requested_codec": "h264",
            "selected_codec": "h264",
            "codec": "h264",
            "pixel_format": "nv12",
            "avg_frame_rate": "60/1",
            "timebase": "1/15360",
            "cpu_readback_frames": 0,
            "fallback_used": false
        }))
        .unwrap();

        assert_eq!(report.segment_probe, None);
    }
}
