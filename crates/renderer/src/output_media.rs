use std::path::Path;
use std::process::Stdio;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

pub(crate) async fn validate_rebased_video(output: &Path) -> anyhow::Result<()> {
    let result = tokio::process::Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=start_time",
            "-of",
            "json",
        ])
        .arg(output)
        .kill_on_drop(true)
        .output()
        .await?;
    if !result.status.success() {
        return Err(anyhow::anyhow!(
            "output.validation_failed: {}",
            String::from_utf8_lossy(&result.stderr)
        ));
    }
    let metadata: serde_json::Value = serde_json::from_slice(&result.stdout)?;
    let start = metadata["streams"][0]["start_time"]
        .as_str()
        .and_then(|value| value.parse::<f64>().ok());
    if !start.is_some_and(|start| start.is_finite() && start.abs() < 0.000_001) {
        return Err(anyhow::anyhow!(
            "output.timestamps_not_rebased: range video must begin at PTS zero"
        ));
    }
    Ok(())
}

pub(crate) async fn write_bgra_png(
    width: u32,
    height: u32,
    pixels: &[u8],
    output: &Path,
) -> anyhow::Result<()> {
    let expected = usize::try_from(width)?
        .checked_mul(usize::try_from(height)?)
        .and_then(|size| size.checked_mul(4));
    if expected != Some(pixels.len()) || width == 0 || height == 0 {
        return Err(anyhow::anyhow!(
            "output.invalid_pixels: BGRA dimensions do not match the captured buffer"
        ));
    }
    let mut child = tokio::process::Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "rawvideo",
            "-pixel_format",
            "bgra",
            "-video_size",
            &format!("{width}x{height}"),
            "-i",
            "pipe:0",
            "-frames:v",
            "1",
            "-c:v",
            "png",
            "-pix_fmt",
            "rgba",
            "-f",
            "image2",
        ])
        .arg(output)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow::anyhow!("output.png_encoder_failed: stdin unavailable"))?;
    let written = stdin.write_all(pixels).await;
    drop(stdin);
    if let Err(error) = written {
        let _ = child.kill().await;
        return Err(error.into());
    }
    let result = child.wait_with_output().await?;
    if !result.status.success() {
        return Err(anyhow::anyhow!(
            "output.png_encoder_failed: {}",
            String::from_utf8_lossy(&result.stderr)
        ));
    }
    validate_png(output, width, height).await
}

async fn validate_png(path: &Path, width: u32, height: u32) -> anyhow::Result<()> {
    let mut file = tokio::fs::File::open(path).await?;
    let length = file.metadata().await?.len();
    if length < 45 {
        return Err(anyhow::anyhow!("output.invalid_png: output is truncated"));
    }
    let mut header = [0u8; 24];
    file.read_exact(&mut header).await?;
    if &header[..8] != b"\x89PNG\r\n\x1a\n"
        || &header[12..16] != b"IHDR"
        || u32::from_be_bytes(header[16..20].try_into()?) != width
        || u32::from_be_bytes(header[20..24].try_into()?) != height
    {
        return Err(anyhow::anyhow!(
            "output.invalid_png: signature or dimensions do not match"
        ));
    }
    file.seek(std::io::SeekFrom::End(-12)).await?;
    let mut tail = [0u8; 12];
    file.read_exact(&mut tail).await?;
    if &tail != b"\0\0\0\0IEND\xaeB`\x82" {
        return Err(anyhow::anyhow!(
            "output.invalid_png: missing final PNG chunk"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn malformed_capture_is_rejected_before_any_encoder_process() {
        let error = write_bgra_png(2, 2, &[0; 4], Path::new("unused.png"))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("output.invalid_pixels"));
    }
}
