use anyhow::{ensure, Context};
use serde_json::Value;
use std::io::Read;
use std::path::Path;
use velocast_protocol::CompositionManifest;

pub(crate) fn validate_video(
    metadata: &Value,
    composition: &CompositionManifest,
    frames: u32,
) -> anyhow::Result<()> {
    let video = &metadata["video"];
    ensure!(
        video["width"].as_u64() == Some(u64::from(composition.width))
            && video["height"].as_u64() == Some(u64::from(composition.height)),
        "output.invalid_video_dimensions"
    );
    ensure!(
        video["frameCount"].as_u64() == Some(u64::from(frames)),
        "output.frame_count_mismatch: actual encoded packets differ from schedule"
    );
    ensure!(
        video["firstTimestamp"]
            .as_f64()
            .is_some_and(|value| value.is_finite() && value.abs() < 0.000001),
        "output.timestamps_not_rebased"
    );
    let expected = f64::from(frames) / f64::from(composition.fps);
    ensure!(
        video["duration"]
            .as_f64()
            .is_some_and(|value| value.is_finite() && (value - expected).abs() < 0.01),
        "output.invalid_video_duration"
    );
    Ok(())
}
pub(crate) fn validate_codec(metadata: &Value, codec: &str) -> anyhow::Result<()> {
    let actual = metadata["video"]["codec"]
        .as_str()
        .context("output.missing_codec")?;
    ensure!(
        match codec {
            "h264" => matches!(actual, "avc" | "h264"),
            "hevc" => matches!(actual, "hevc" | "h265"),
            "av1" => actual == "av1",
            "vp8" => actual == "vp8",
            "vp9" => actual == "vp9",
            "prores" => matches!(actual, "prores" | "prores-422"),
            _ => false,
        },
        "output.codec_mismatch: requested {codec}, received {actual}"
    );
    Ok(())
}
pub(crate) fn validate_container(metadata: &Value, container: &str) -> anyhow::Result<()> {
    let actual = metadata["container"]
        .as_str()
        .context("output.missing_container")?;
    ensure!(
        actual == container,
        "output.container_mismatch: requested {container}, received {actual}"
    );
    Ok(())
}
pub(crate) fn validate_png(path: &Path, width: u32, height: u32) -> anyhow::Result<()> {
    let mut file = std::fs::File::open(path)?;
    let mut header = [0; 24];
    file.read_exact(&mut header)?;
    ensure!(
        &header[..8] == b"\x89PNG\r\n\x1a\n" && &header[12..16] == b"IHDR",
        "output.invalid_png"
    );
    ensure!(
        u32::from_be_bytes(header[16..20].try_into().unwrap()) == width
            && u32::from_be_bytes(header[20..24].try_into().unwrap()) == height,
        "output.invalid_png_dimensions"
    );
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> CompositionManifest {
        serde_json::from_value(
            serde_json::json!({"id":"scene","width":640,"height":360,"fps":30,"durationFrames":90}),
        )
        .unwrap()
    }
    #[test]
    fn validation_counts_real_packets_and_rebased_time() {
        let c = fixture();
        let mut m = serde_json::json!({"container":"mp4","video":{"width":640,"height":360,"frameCount":30,"firstTimestamp":0,"duration":1.0,"codec":"avc"}});
        validate_video(&m, &c, 30).unwrap();
        validate_codec(&m, "h264").unwrap();
        validate_container(&m, "mp4").unwrap();
        assert!(validate_container(&m, "mov").is_err());
        m["video"]["frameCount"] = serde_json::json!(29);
        assert!(validate_video(&m, &c, 30).is_err());
        m["video"]["frameCount"] = serde_json::json!(30);
        m["video"]["firstTimestamp"] = serde_json::json!(1);
        assert!(validate_video(&m, &c, 30).is_err());
    }
    #[test]
    fn output_codec_names_cover_the_supported_logical_formats() {
        let mut metadata = serde_json::json!({"video":{"codec":"avc"}});
        for (requested, actual) in [
            ("h264", "avc"),
            ("hevc", "hevc"),
            ("av1", "av1"),
            ("vp8", "vp8"),
            ("vp9", "vp9"),
            ("prores", "prores"),
        ] {
            metadata["video"]["codec"] = serde_json::json!(actual);
            validate_codec(&metadata, requested).unwrap();
            assert!(validate_codec(&metadata, "unknown").is_err());
        }
    }
}
