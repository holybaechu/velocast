use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;

const PREVIEW_FRAME_INDEX: usize = 72;
const WATCHED_FRAME_START_INDEX: usize = 168;
const WATCHED_FRAME_END_INDEX: usize = 176;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StreamSignature {
    pub codec_name: String,
    pub width: u32,
    pub height: u32,
    pub avg_frame_rate: String,
    pub pix_fmt: String,
    pub color_range: Option<String>,
    pub color_space: Option<String>,
    pub color_transfer: Option<String>,
    pub color_primaries: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SegmentProbe {
    pub signature: StreamSignature,
    pub frame_count: u32,
    pub duration_seconds: Option<OrderedSeconds>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct OrderedSeconds {
    millis: u64,
}

impl OrderedSeconds {
    fn from_ffprobe(value: Option<String>) -> anyhow::Result<Option<Self>> {
        let Some(value) = value else {
            return Ok(None);
        };
        if value == "N/A" {
            return Ok(None);
        }
        let seconds = value
            .parse::<f64>()
            .map_err(|error| anyhow::anyhow!("invalid ffprobe stream duration {value}: {error}"))?;
        if !seconds.is_finite() || seconds < 0.0 {
            return Err(anyhow::anyhow!("invalid ffprobe stream duration {value}"));
        }
        Ok(Some(Self {
            millis: (seconds * 1000.0).round() as u64,
        }))
    }

    fn from_frames(frame_count: u32, fps: u32) -> Self {
        let millis = (u128::from(frame_count) * 1000 + u128::from(fps) / 2) / u128::from(fps);
        Self {
            millis: millis.min(u128::from(u64::MAX)) as u64,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpectedVideoOutput {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub frame_count: u32,
    pub codec_name: String,
    pub pix_fmts: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SegmentVerification {
    None,
    FinalOutput(ExpectedVideoOutput),
    SegmentsAndFinal(ExpectedVideoOutput),
}

impl SegmentVerification {
    fn probe_segments(&self) -> bool {
        matches!(self, Self::SegmentsAndFinal(_))
    }

    fn expected_output(&self) -> Option<&ExpectedVideoOutput> {
        match self {
            Self::None => None,
            Self::FinalOutput(expected) | Self::SegmentsAndFinal(expected) => Some(expected),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct SelectedHashProbeKey {
    video: PathBuf,
    indices: Vec<u32>,
}

#[derive(Debug, Default)]
pub struct SegmentProbeCache {
    segment_probes: HashMap<PathBuf, SegmentProbe>,
    selected_frame_hashes: HashMap<SelectedHashProbeKey, Vec<String>>,
}

impl SegmentProbeCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn seed_segment_probe(&mut self, segment: impl Into<PathBuf>, probe: SegmentProbe) {
        self.segment_probes.insert(segment.into(), probe);
    }

    pub async fn probe_segment(&mut self, segment: &Path) -> anyhow::Result<SegmentProbe> {
        if let Some(probe) = self.segment_probes.get(segment) {
            return Ok(probe.clone());
        }
        let probe = probe_segment(segment).await?;
        self.segment_probes
            .insert(segment.to_path_buf(), probe.clone());
        Ok(probe)
    }

    async fn probe_segments_concurrently(
        &mut self,
        segments: &[PathBuf],
    ) -> anyhow::Result<Vec<SegmentProbe>> {
        let mut handles = Vec::new();
        for (index, segment) in segments.iter().cloned().enumerate() {
            if !self.segment_probes.contains_key(&segment) {
                handles.push(tokio::spawn(async move {
                    let probe = probe_segment(&segment).await?;
                    Ok::<_, anyhow::Error>((index, segment, probe))
                }));
            }
        }

        for handle in handles {
            let (_index, segment, probe) = handle
                .await
                .map_err(|error| anyhow::anyhow!("segment probe task failed: {error}"))??;
            self.segment_probes.insert(segment, probe);
        }

        segments
            .iter()
            .enumerate()
            .map(|(index, segment)| {
                self.segment_probes.get(segment).cloned().ok_or_else(|| {
                    anyhow::anyhow!("segment probe cache did not return probe for segment {index}")
                })
            })
            .collect()
    }

    async fn probe_decoded_frame_hashes_at_indices(
        &mut self,
        video: &Path,
        indices: &[u32],
    ) -> anyhow::Result<Vec<String>> {
        let key = SelectedHashProbeKey {
            video: video.to_path_buf(),
            indices: indices.to_vec(),
        };
        if let Some(hashes) = self.selected_frame_hashes.get(&key) {
            return Ok(hashes.clone());
        }
        let hashes = probe_decoded_frame_hashes_at_indices(video, indices).await?;
        self.selected_frame_hashes.insert(key, hashes.clone());
        Ok(hashes)
    }
}

#[allow(dead_code)]
pub fn concat_file_text(segments: &[PathBuf]) -> String {
    segments
        .iter()
        .map(|segment| concat_file_line(segment))
        .collect()
}

pub fn concat_file_text_for(segments: &[PathBuf], concat_file: &Path) -> anyhow::Result<String> {
    let parent = concat_file.parent().unwrap_or_else(|| Path::new(""));
    let mut text = String::new();
    for segment in segments {
        text.push_str(&concat_file_line(&concat_entry_path(segment, parent)?));
    }
    Ok(text)
}

fn concat_entry_path(segment: &Path, concat_parent: &Path) -> anyhow::Result<PathBuf> {
    let entry = if !concat_parent.as_os_str().is_empty() {
        if let Ok(relative) = segment.strip_prefix(concat_parent) {
            relative.to_path_buf()
        } else if let Ok(relative) =
            absolute_path(segment).strip_prefix(absolute_path(concat_parent))
        {
            relative.to_path_buf()
        } else {
            return Err(anyhow::anyhow!(
                "segment path {} is outside concat file directory {}",
                segment.display(),
                concat_parent.display()
            ));
        }
    } else {
        segment.to_path_buf()
    };

    safe_relative_concat_entry(segment, entry)
}

fn safe_relative_concat_entry(segment: &Path, entry: PathBuf) -> anyhow::Result<PathBuf> {
    if entry.as_os_str().is_empty()
        || entry.is_absolute()
        || entry.components().any(|component| {
            matches!(
                component,
                Component::Prefix(_) | Component::RootDir | Component::ParentDir
            )
        })
    {
        return Err(anyhow::anyhow!(
            "segment path {} produced unsafe concat entry {}",
            segment.display(),
            entry.display()
        ));
    }

    Ok(entry)
}

fn absolute_path(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

fn concat_file_line(path: &Path) -> String {
    let escaped = path
        .to_string_lossy()
        .replace('\\', "/")
        .replace('\'', "'\\''");
    format!("file '{escaped}'\n")
}

pub fn validate_stream_signatures(signatures: &[StreamSignature]) -> anyhow::Result<()> {
    let Some(first) = signatures.first() else {
        return Err(anyhow::anyhow!(
            "no segment stream signatures were provided"
        ));
    };

    for (index, signature) in signatures.iter().enumerate().skip(1) {
        if signature != first {
            return Err(anyhow::anyhow!(
                "segment stream parameters differ at segment {index}"
            ));
        }
    }

    Ok(())
}

pub async fn probe_segment(segment: &Path) -> anyhow::Result<SegmentProbe> {
    let segment_arg = segment.to_string_lossy().to_string();
    let output = run_ffprobe_segment_probe(&segment_arg, false).await?;
    match segment_probe_from_ffprobe_json(&output) {
        Ok(probe) => return Ok(probe),
        Err(error) if segment_probe_needs_counted_frames(&error) => {}
        Err(error) => {
            return Err(anyhow::anyhow!(
                "failed to parse ffprobe output for {}: {error}",
                segment.display()
            ));
        }
    }

    let output = run_ffprobe_segment_probe(&segment_arg, true).await?;
    segment_probe_from_ffprobe_json(&output).map_err(|error| {
        anyhow::anyhow!(
            "failed to parse ffprobe output for {}: {error}",
            segment.display()
        )
    })
}

async fn run_ffprobe_segment_probe(
    segment_arg: &str,
    count_frames: bool,
) -> anyhow::Result<Vec<u8>> {
    let output = Command::new("ffprobe")
        .args(ffprobe_segment_args(segment_arg, count_frames))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await?;

    if !output.status.success() {
        return Err(anyhow::anyhow!(
            "ffprobe segment stream probe failed for {} with code {}{}",
            segment_arg,
            output.status.code().unwrap_or(-1),
            stderr_suffix(&output.stderr)
        ));
    }

    Ok(output.stdout)
}

fn ffprobe_segment_args(segment_arg: &str, count_frames: bool) -> Vec<String> {
    let mut args = vec!["-v".to_string(), "error".to_string()];
    if count_frames {
        args.push("-count_frames".to_string());
    }
    args.extend([
        "-select_streams".to_string(),
        "v:0".to_string(),
        "-show_entries".to_string(),
        ffprobe_stream_entries(count_frames).to_string(),
        "-of".to_string(),
        "json".to_string(),
        segment_arg.to_string(),
    ]);
    args
}

fn ffprobe_stream_entries(count_frames: bool) -> &'static str {
    if count_frames {
        "stream=codec_name,width,height,avg_frame_rate,duration,pix_fmt,color_range,color_space,color_transfer,color_primaries,nb_read_frames,nb_frames"
    } else {
        "stream=codec_name,width,height,avg_frame_rate,duration,pix_fmt,color_range,color_space,color_transfer,color_primaries,nb_frames"
    }
}

fn segment_probe_needs_counted_frames(error: &anyhow::Error) -> bool {
    error.to_string().contains("stream frame count")
}

async fn probe_and_validate_decoded_frame_hashes(
    video: &Path,
    expected_frame_count: Option<u32>,
) -> anyhow::Result<()> {
    let video_arg = video.to_string_lossy().to_string();
    let mut child = Command::new("ffmpeg")
        .args(decoded_frame_hashes_args(&video_arg))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let Some(stdout) = child.stdout.take() else {
        let _ = child.start_kill();
        let _ = child.wait().await;
        return Err(anyhow::anyhow!(
            "ffmpeg decoded frame hash probe did not pipe stdout"
        ));
    };
    let Some(stderr) = child.stderr.take() else {
        let _ = child.start_kill();
        let _ = child.wait().await;
        return Err(anyhow::anyhow!(
            "ffmpeg decoded frame hash probe did not pipe stderr"
        ));
    };

    let stderr_task = tokio::spawn(async move {
        let mut stderr = stderr;
        let mut output = Vec::new();
        stderr.read_to_end(&mut output).await?;
        Ok::<_, std::io::Error>(output)
    });
    let mut lines = BufReader::new(stdout).lines();
    let mut validator = DecodedFrameHashValidator::new(video, expected_frame_count);
    let validation_result = async {
        while let Some(line) = lines.next_line().await? {
            validator.accept_framemd5_line(&line)?;
        }
        Ok::<_, anyhow::Error>(())
    }
    .await;

    if validation_result.is_err() {
        let _ = child.start_kill();
    }
    let status = child.wait().await?;
    let stderr = stderr_task.await.map_err(|error| {
        anyhow::anyhow!("ffmpeg decoded frame hash stderr task failed: {error}")
    })??;
    validation_result?;
    if !status.success() {
        return Err(anyhow::anyhow!(
            "ffmpeg decoded frame hash probe failed for {} with code {}{}",
            video.display(),
            status.code().unwrap_or(-1),
            stderr_suffix(&stderr)
        ));
    }

    validator.finish()
}

fn decoded_frame_hashes_args(video_arg: &str) -> Vec<String> {
    vec![
        "-v".to_string(),
        "error".to_string(),
        "-i".to_string(),
        video_arg.to_string(),
        "-map".to_string(),
        "0:v:0".to_string(),
        "-f".to_string(),
        "framemd5".to_string(),
        "-".to_string(),
    ]
}

async fn probe_decoded_frame_hashes_at_indices(
    video: &Path,
    indices: &[u32],
) -> anyhow::Result<Vec<String>> {
    if indices.is_empty() {
        return Ok(Vec::new());
    }

    let video_arg = video.to_string_lossy().to_string();
    let output = Command::new("ffmpeg")
        .args(decoded_frame_hashes_at_indices_args(&video_arg, indices))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await?;

    if !output.status.success() {
        return Err(anyhow::anyhow!(
            "ffmpeg decoded selected frame hash probe failed for {} with code {}{}",
            video.display(),
            output.status.code().unwrap_or(-1),
            stderr_suffix(&output.stderr)
        ));
    }

    let hashes = decoded_frame_hashes_from_framemd5(&output.stdout)?;
    if hashes.len() != indices.len() {
        return Err(anyhow::anyhow!(
            "decoded selected frame hash probe returned {} frame(s), expected {} in {}",
            hashes.len(),
            indices.len(),
            video.display()
        ));
    }
    Ok(hashes)
}

fn decoded_frame_hashes_at_indices_args(video_arg: &str, indices: &[u32]) -> Vec<String> {
    vec![
        "-v".to_string(),
        "error".to_string(),
        "-i".to_string(),
        video_arg.to_string(),
        "-map".to_string(),
        "0:v:0".to_string(),
        "-vf".to_string(),
        decoded_frame_select_filter(indices),
        "-fps_mode".to_string(),
        "passthrough".to_string(),
        "-f".to_string(),
        "framemd5".to_string(),
        "-".to_string(),
    ]
}

fn decoded_frame_select_filter(indices: &[u32]) -> String {
    let clauses = indices
        .iter()
        .map(|index| format!("eq(n\\,{index})"))
        .collect::<Vec<_>>()
        .join("+");
    format!("select={clauses}")
}

#[cfg(test)]
fn stream_signature_from_ffprobe_json(output: &[u8]) -> anyhow::Result<StreamSignature> {
    Ok(segment_probe_from_ffprobe_json(output)?.signature)
}

fn segment_probe_from_ffprobe_json(output: &[u8]) -> anyhow::Result<SegmentProbe> {
    let ffprobe: FfprobeOutput = serde_json::from_slice(output)?;
    let stream = ffprobe
        .streams
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("ffprobe output did not include a video stream"))?;

    let frame_count = parse_frame_count(stream.nb_read_frames, stream.nb_frames)?;

    Ok(SegmentProbe {
        signature: StreamSignature {
            codec_name: required_stream_field(stream.codec_name, "codec_name")?,
            width: required_stream_field(stream.width, "width")?,
            height: required_stream_field(stream.height, "height")?,
            avg_frame_rate: required_stream_field(stream.avg_frame_rate, "avg_frame_rate")?,
            pix_fmt: required_stream_field(stream.pix_fmt, "pix_fmt")?,
            color_range: stream.color_range,
            color_space: stream.color_space,
            color_transfer: stream.color_transfer,
            color_primaries: stream.color_primaries,
        },
        frame_count,
        duration_seconds: OrderedSeconds::from_ffprobe(stream.duration)?,
    })
}

fn required_stream_field<T>(value: Option<T>, field: &str) -> anyhow::Result<T> {
    value.ok_or_else(|| anyhow::anyhow!("ffprobe output missing stream field {field}"))
}

fn parse_frame_count(
    nb_read_frames: Option<String>,
    nb_frames: Option<String>,
) -> anyhow::Result<u32> {
    for value in [nb_read_frames, nb_frames].into_iter().flatten() {
        if value == "N/A" {
            continue;
        }
        return value.parse::<u32>().map_err(|error| {
            anyhow::anyhow!("invalid ffprobe stream frame count {value}: {error}")
        });
    }
    Err(anyhow::anyhow!("ffprobe output missing stream frame count"))
}

fn decoded_frame_hashes_from_framemd5(output: &[u8]) -> anyhow::Result<Vec<String>> {
    let text = std::str::from_utf8(output)?;
    let mut hashes = Vec::new();
    for line in text.lines() {
        if let Some(hash) = framemd5_hash_from_line(line)? {
            hashes.push(hash.to_string());
        }
    }
    Ok(hashes)
}

fn framemd5_hash_from_line(line: &str) -> anyhow::Result<Option<&str>> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return Ok(None);
    }
    line.rsplit_once(',')
        .map(|(_, hash)| hash.trim())
        .filter(|hash| !hash.is_empty())
        .map(Some)
        .ok_or_else(|| anyhow::anyhow!("invalid framemd5 frame line: {line}"))
}

// Generic output validation checks decodability and frame count. Pixel equality
// is valid for still compositions, holds and low-FPS sources; only an external
// content oracle or capture request identity can establish stale capture.
struct DecodedFrameHashValidator<'a> {
    path: &'a Path,
    expected_frame_count: Option<u32>,
    frame_count: usize,
}

impl<'a> DecodedFrameHashValidator<'a> {
    fn new(path: &'a Path, expected_frame_count: Option<u32>) -> Self {
        Self {
            path,
            expected_frame_count,
            frame_count: 0,
        }
    }

    fn accept_framemd5_line(&mut self, line: &str) -> anyhow::Result<()> {
        if let Some(hash) = framemd5_hash_from_line(line)? {
            self.accept_hash(hash)?;
        }
        Ok(())
    }

    fn accept_hash(&mut self, hash: impl AsRef<str>) -> anyhow::Result<()> {
        if hash.as_ref().is_empty() {
            return Err(anyhow::anyhow!(
                "empty decoded frame hash in {}",
                self.path.display()
            ));
        }
        self.frame_count += 1;
        Ok(())
    }

    fn finish(self) -> anyhow::Result<()> {
        if let Some(expected_frame_count) = self.expected_frame_count {
            if self.frame_count != expected_frame_count as usize {
                return Err(anyhow::anyhow!(
                    "decoded frame hash count {} did not match expected frame count {} in {}",
                    self.frame_count,
                    expected_frame_count,
                    self.path.display()
                ));
            }
        }
        if self.frame_count == 0 {
            return Err(anyhow::anyhow!(
                "no decoded frames in {}",
                self.path.display()
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
fn validate_decoded_frame_hashes(
    hashes: &[String],
    expected_frame_count: u32,
    path: &Path,
) -> anyhow::Result<()> {
    let mut validator = DecodedFrameHashValidator::new(path, Some(expected_frame_count));
    for hash in hashes {
        validator.accept_hash(hash.as_str())?;
    }
    validator.finish()
}

fn segment_boundary_frame_indices(expected_frame_counts: &[u32]) -> Vec<u32> {
    let mut indices = Vec::new();
    let mut next_start = 0_u32;
    for frame_count in expected_frame_counts
        .iter()
        .take(expected_frame_counts.len().saturating_sub(1))
    {
        next_start = next_start.saturating_add(*frame_count);
        if next_start > 0 {
            indices.push(next_start - 1);
            indices.push(next_start);
        }
    }
    indices
}

fn selected_frame_hash_indices(expected_frame_counts: &[u32]) -> Vec<u32> {
    let mut indices = segment_boundary_frame_indices(expected_frame_counts);
    let expected_frame_count = expected_frame_counts
        .iter()
        .fold(0_u32, |total, count| total.saturating_add(*count));

    push_watched_frame_hash_indices(&mut indices, expected_frame_count);
    indices.sort_unstable();
    indices.dedup();
    indices
}

fn push_watched_frame_hash_indices(indices: &mut Vec<u32>, expected_frame_count: u32) {
    if expected_frame_count == 0 {
        return;
    }

    indices.push(0);
    push_frame_hash_index_if_available(indices, PREVIEW_FRAME_INDEX, expected_frame_count);
    for frame_index in WATCHED_FRAME_START_INDEX..=WATCHED_FRAME_END_INDEX {
        push_frame_hash_index_if_available(indices, frame_index, expected_frame_count);
    }
}

fn push_frame_hash_index_if_available(
    indices: &mut Vec<u32>,
    frame_index: usize,
    expected_frame_count: u32,
) {
    if frame_index < expected_frame_count as usize {
        indices.push(frame_index as u32);
    }
}

fn validate_selected_frame_hashes(
    hashes: &[String],
    indices: &[u32],
    expected_frame_counts: &[u32],
    path: &Path,
) -> anyhow::Result<()> {
    if hashes.len() != indices.len() {
        return Err(anyhow::anyhow!(
            "decoded selected frame hash count {} did not match selected frame count {} in {}",
            hashes.len(),
            indices.len(),
            path.display()
        ));
    }

    // Boundary samples must decode, but are allowed to have identical pixels.
    for index in segment_boundary_frame_indices(expected_frame_counts) {
        require_selected_frame_hash(hashes, indices, index, path)?;
    }
    if hashes.iter().any(String::is_empty) {
        return Err(anyhow::anyhow!(
            "empty decoded selected frame hash in {}",
            path.display()
        ));
    }
    Ok(())
}

fn selected_frame_hash<'a>(
    hashes: &'a [String],
    indices: &[u32],
    frame_index: u32,
) -> Option<&'a str> {
    indices
        .iter()
        .position(|selected_index| *selected_index == frame_index)
        .and_then(|position| hashes.get(position).map(String::as_str))
}

fn require_selected_frame_hash<'a>(
    hashes: &'a [String],
    indices: &[u32],
    frame_index: u32,
    path: &Path,
) -> anyhow::Result<&'a str> {
    selected_frame_hash(hashes, indices, frame_index).ok_or_else(|| {
        anyhow::anyhow!(
            "decoded selected frame hash probe missing frame {} in {}",
            frame_index,
            path.display()
        )
    })
}

pub fn validate_segment_frame_counts(
    probes: &[SegmentProbe],
    expected_frame_counts: &[u32],
) -> anyhow::Result<()> {
    if probes.len() != expected_frame_counts.len() {
        return Err(anyhow::anyhow!(
            "segment probe count {} does not match expected segment count {}",
            probes.len(),
            expected_frame_counts.len()
        ));
    }

    for (index, (probe, expected)) in probes.iter().zip(expected_frame_counts).enumerate() {
        if probe.frame_count != *expected {
            return Err(anyhow::anyhow!(
                "segment {index} contains {} frame(s), expected {}",
                probe.frame_count,
                expected
            ));
        }
    }

    Ok(())
}

pub fn validate_final_output(
    probe: &SegmentProbe,
    expected: &ExpectedVideoOutput,
) -> anyhow::Result<()> {
    if probe.signature.codec_name != expected.codec_name {
        return Err(anyhow::anyhow!(
            "remuxed output codec {} did not match expected {}",
            probe.signature.codec_name,
            expected.codec_name
        ));
    }
    if !expected
        .pix_fmts
        .iter()
        .any(|pix_fmt| pix_fmt == &probe.signature.pix_fmt)
    {
        return Err(anyhow::anyhow!(
            "remuxed output pixel format {} did not match expected {}",
            probe.signature.pix_fmt,
            expected.pix_fmts.join(" or ")
        ));
    }
    if probe.signature.width != expected.width || probe.signature.height != expected.height {
        return Err(anyhow::anyhow!(
            "remuxed output dimensions {}x{} did not match expected {}x{}",
            probe.signature.width,
            probe.signature.height,
            expected.width,
            expected.height
        ));
    }
    validate_avg_frame_rate(&probe.signature.avg_frame_rate, expected.fps)?;
    if probe.frame_count != expected.frame_count {
        return Err(anyhow::anyhow!(
            "remuxed output contains {} frame(s), expected {}",
            probe.frame_count,
            expected.frame_count
        ));
    }
    let Some(duration) = probe.duration_seconds else {
        return Err(anyhow::anyhow!("ffprobe output missing stream duration"));
    };
    let expected_duration = OrderedSeconds::from_frames(expected.frame_count, expected.fps);
    if duration != expected_duration {
        return Err(anyhow::anyhow!(
            "remuxed output duration {}ms did not match expected {}ms",
            duration.millis,
            expected_duration.millis
        ));
    }
    Ok(())
}

pub fn expected_codec_name(codec: &str) -> String {
    match codec.to_ascii_lowercase().as_str() {
        "h264" | "libx264" | "h264_amf" | "h264_nvenc" | "h264_qsv" | "h264_mf" => {
            "h264".to_string()
        }
        "h265" | "hevc" | "libx265" | "hevc_amf" | "hevc_nvenc" | "hevc_qsv" | "hevc_mf" => {
            "hevc".to_string()
        }
        "av1" | "libaom-av1" | "libsvtav1" | "av1_amf" | "av1_nvenc" | "av1_qsv" | "av1_mf" => {
            "av1".to_string()
        }
        other => other.to_string(),
    }
}

pub fn expected_stream_pix_fmts(pixel_format: &str) -> Vec<String> {
    match pixel_format.to_ascii_lowercase().as_str() {
        // NV12 is the GPU transport layout. The decoded planar stream may carry
        // either nominal range; FFmpeg names full-range 8-bit 4:2:0 yuvj420p.
        "nv12" => vec![
            "yuv420p".to_string(),
            "nv12".to_string(),
            "yuvj420p".to_string(),
        ],
        "yuv420p" => vec!["yuv420p".to_string(), "nv12".to_string()],
        other => vec![other.to_string()],
    }
}

fn validate_avg_frame_rate(avg_frame_rate: &str, expected_fps: u32) -> anyhow::Result<()> {
    let (num, den) = avg_frame_rate
        .split_once('/')
        .ok_or_else(|| anyhow::anyhow!("invalid ffprobe avg_frame_rate {avg_frame_rate}"))?;
    let num = num.parse::<u64>().map_err(|error| {
        anyhow::anyhow!("invalid ffprobe avg_frame_rate {avg_frame_rate}: {error}")
    })?;
    let den = den.parse::<u64>().map_err(|error| {
        anyhow::anyhow!("invalid ffprobe avg_frame_rate {avg_frame_rate}: {error}")
    })?;
    if den == 0 || num != u64::from(expected_fps) * den {
        return Err(anyhow::anyhow!(
            "remuxed output avg_frame_rate {avg_frame_rate} did not match expected {expected_fps}/1"
        ));
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct FfprobeOutput {
    #[serde(default)]
    streams: Vec<FfprobeStream>,
}

#[derive(Debug, Deserialize)]
struct FfprobeStream {
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    avg_frame_rate: Option<String>,
    pix_fmt: Option<String>,
    color_range: Option<String>,
    color_space: Option<String>,
    color_transfer: Option<String>,
    color_primaries: Option<String>,
    duration: Option<String>,
    nb_read_frames: Option<String>,
    nb_frames: Option<String>,
}

pub async fn remux_segments_with_cache(
    segments: &[PathBuf],
    expected_frame_counts: &[u32],
    concat_file: &Path,
    output: &Path,
    verification: SegmentVerification,
    probe_cache: &mut SegmentProbeCache,
) -> anyhow::Result<()> {
    let concat_text = concat_file_text_for(segments, concat_file)?;

    if verification.probe_segments() {
        let probes = probe_cache.probe_segments_concurrently(segments).await?;
        let signatures = probes
            .iter()
            .map(|probe| probe.signature.clone())
            .collect::<Vec<_>>();
        validate_stream_signatures(&signatures)?;
        validate_segment_frame_counts(&probes, expected_frame_counts)?;
    }

    if let Some(parent) = concat_file
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(concat_file, concat_text).await?;

    let concat_file_arg = concat_file.to_string_lossy().to_string();
    let output_result = Command::new("ffmpeg")
        .args(ffmpeg_segment_remux_args(&concat_file_arg, output))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .await?;

    if output_result.status.success() {
        if let Some(expected) = verification.expected_output() {
            let final_probe = probe_cache.probe_segment(output).await?;
            validate_final_output(&final_probe, expected)?;
        }
        if verification.probe_segments() {
            probe_and_validate_decoded_frame_hashes(
                output,
                verification
                    .expected_output()
                    .map(|expected| expected.frame_count),
            )
            .await?;
        } else if verification.expected_output().is_some() {
            let indices = selected_frame_hash_indices(expected_frame_counts);
            let hashes = probe_cache
                .probe_decoded_frame_hashes_at_indices(output, &indices)
                .await?;
            validate_selected_frame_hashes(&hashes, &indices, expected_frame_counts, output)?;
        }
        return Ok(());
    }

    Err(anyhow::anyhow!(
        "ffmpeg segment remux failed with code {}{}",
        output_result.status.code().unwrap_or(-1),
        stderr_suffix(&output_result.stderr)
    ))
}

fn ffmpeg_segment_remux_args(concat_file_arg: &str, output: &Path) -> Vec<String> {
    let mut args = vec![
        "-y".to_string(),
        "-fflags".to_string(),
        "+genpts".to_string(),
        "-f".to_string(),
        "concat".to_string(),
        "-safe".to_string(),
        "0".to_string(),
        "-auto_convert".to_string(),
        "0".to_string(),
        "-i".to_string(),
        concat_file_arg.to_string(),
        "-avoid_negative_ts".to_string(),
        "make_zero".to_string(),
        "-c".to_string(),
        "copy".to_string(),
    ];

    if output_supports_faststart(output) {
        args.push("-movflags".to_string());
        args.push("+faststart".to_string());
    }

    args.push(output.to_string_lossy().to_string());
    args
}

fn output_supports_faststart(output: &Path) -> bool {
    output
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "mp4" | "m4v" | "mov" | "ismv"
            )
        })
        .unwrap_or(false)
}

fn stderr_suffix(stderr: &[u8]) -> String {
    let stderr = String::from_utf8_lossy(stderr).trim().to_string();
    if stderr.is_empty() {
        return String::new();
    }

    let tail = stderr
        .lines()
        .rev()
        .take(12)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    format!(": {tail}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn concat_file_escapes_windows_paths_for_ffmpeg() {
        let segments = vec![
            PathBuf::from(r"C:\tmp\segment 1.mp4"),
            PathBuf::from(r"C:\tmp\segment'2.mp4"),
        ];

        let text = concat_file_text(&segments);

        assert!(text.contains("file 'C:/tmp/segment 1.mp4'"));
        assert!(text.contains("file 'C:/tmp/segment'\\''2.mp4'"));
    }

    #[test]
    fn concat_file_entries_are_relative_to_concat_file_parent() {
        let concat_file = PathBuf::from("renders/.velocast/tmp/product-hero-42/segments.txt");
        let segments = vec![PathBuf::from(
            "renders/.velocast/tmp/product-hero-42/segment-0000.mp4",
        )];

        let text = concat_file_text_for(&segments, &concat_file).unwrap();

        assert_eq!(text, "file 'segment-0000.mp4'\n");
    }

    #[test]
    fn concat_file_entries_outside_parent_are_rejected() {
        let concat_file = PathBuf::from("renders/.velocast/tmp/product-hero-42/segments.txt");
        let segment = PathBuf::from("renders/other/segment'0000.mp4");
        let error = concat_file_text_for(&[segment.clone()], &concat_file)
            .unwrap_err()
            .to_string();

        assert_eq!(
            error,
            "segment path renders/other/segment'0000.mp4 is outside concat file directory renders/.velocast/tmp/product-hero-42"
        );
    }

    #[test]
    fn concat_file_entries_with_parent_dir_components_are_rejected() {
        let concat_file = PathBuf::from("renders/.velocast/tmp/product-hero-42/segments.txt");
        let segment = PathBuf::from("renders/.velocast/tmp/product-hero-42/../outside.mp4");
        let error = concat_file_text_for(&[segment.clone()], &concat_file)
            .unwrap_err()
            .to_string();

        assert_eq!(
            error,
            "segment path renders/.velocast/tmp/product-hero-42/../outside.mp4 produced unsafe concat entry ../outside.mp4"
        );
    }

    #[test]
    fn remux_args_normalize_segment_timestamps_and_faststart_mp4() {
        let args = ffmpeg_segment_remux_args("segments.txt", Path::new("movie.final.mp4"));

        assert!(args.windows(2).any(|pair| pair == ["-fflags", "+genpts"]));
        assert!(args.windows(2).any(|pair| pair == ["-auto_convert", "0"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-avoid_negative_ts", "make_zero"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-movflags", "+faststart"]));
        assert_eq!(args.last().map(String::as_str), Some("movie.final.mp4"));
    }

    #[test]
    fn remux_args_skip_mp4_movflags_for_non_mp4_outputs() {
        let args = ffmpeg_segment_remux_args("segments.txt", Path::new("movie.final.mkv"));

        assert!(!args.iter().any(|arg| arg == "-movflags"));
        assert_eq!(args.last().map(String::as_str), Some("movie.final.mkv"));
    }

    #[test]
    fn parses_ffprobe_segment_probe_json() {
        let json = br#"{
            "streams": [
                {
                    "codec_name": "h264",
                    "width": 3840,
                    "height": 2160,
                    "avg_frame_rate": "60/1",
                    "pix_fmt": "yuv420p",
                    "color_range": "tv",
                    "color_space": "bt709",
                    "color_transfer": "bt709",
                    "color_primaries": "bt709",
                    "nb_read_frames": "120"
                }
            ]
        }"#;

        let probe = segment_probe_from_ffprobe_json(json).unwrap();

        assert_eq!(
            probe.signature,
            StreamSignature {
                codec_name: "h264".to_string(),
                width: 3840,
                height: 2160,
                avg_frame_rate: "60/1".to_string(),
                pix_fmt: "yuv420p".to_string(),
                color_range: Some("tv".to_string()),
                color_space: Some("bt709".to_string()),
                color_transfer: Some("bt709".to_string()),
                color_primaries: Some("bt709".to_string()),
            }
        );
        assert_eq!(probe.frame_count, 120);
        assert_eq!(probe.duration_seconds, None);
    }

    #[test]
    fn parses_ffprobe_frame_count_from_nb_frames_when_counted_frames_are_unavailable() {
        let json = br#"{
            "streams": [
                {
                    "codec_name": "h264",
                    "width": 3840,
                    "height": 2160,
                    "avg_frame_rate": "60/1",
                    "pix_fmt": "yuv420p",
                    "nb_read_frames": "N/A",
                    "nb_frames": "240"
                }
            ]
        }"#;

        let probe = segment_probe_from_ffprobe_json(json).unwrap();

        assert_eq!(probe.frame_count, 240);
    }

    #[tokio::test]
    async fn seeded_segment_probe_cache_reuses_worker_probe_without_ffprobe() {
        let mut cache = SegmentProbeCache::new();
        let missing_segment = PathBuf::from("/definitely/missing/segment.mp4");
        let probe = SegmentProbe {
            signature: StreamSignature {
                codec_name: "h264".to_string(),
                width: 3840,
                height: 2160,
                avg_frame_rate: "60/1".to_string(),
                pix_fmt: "yuv420p".to_string(),
                color_range: Some("tv".to_string()),
                color_space: Some("bt709".to_string()),
                color_transfer: Some("bt709".to_string()),
                color_primaries: Some("bt709".to_string()),
            },
            frame_count: 120,
            duration_seconds: None,
        };

        cache.seed_segment_probe(missing_segment.clone(), probe.clone());

        assert_eq!(cache.probe_segment(&missing_segment).await.unwrap(), probe);
    }

    #[test]
    fn fast_ffprobe_probe_does_not_count_frames_by_default() {
        let args = ffprobe_segment_args("segment.mp4", false);

        assert!(!args.iter().any(|arg| arg == "-count_frames"));
        assert!(args.iter().any(|arg| arg == "stream=codec_name,width,height,avg_frame_rate,duration,pix_fmt,color_range,color_space,color_transfer,color_primaries,nb_frames"));
    }

    #[test]
    fn fallback_ffprobe_probe_counts_frames_when_metadata_is_missing() {
        let args = ffprobe_segment_args("segment.mp4", true);

        assert!(args.iter().any(|arg| arg == "-count_frames"));
        assert!(args.iter().any(|arg| arg == "stream=codec_name,width,height,avg_frame_rate,duration,pix_fmt,color_range,color_space,color_transfer,color_primaries,nb_read_frames,nb_frames"));
    }

    #[test]
    fn segment_verification_probes_segments_concurrently() {
        let source = include_str!("segment_muxer.rs");

        assert!(source.contains("probe_segments_concurrently"));
        assert!(source.contains("tokio::spawn"));
        assert!(!source.contains("for segment in segments {\n            probes.push(probe_segment(segment).await?);\n        }"));
    }

    #[test]
    fn rejects_ffprobe_json_without_video_stream() {
        let error = stream_signature_from_ffprobe_json(br#"{"streams":[]}"#)
            .unwrap_err()
            .to_string();

        assert_eq!(error, "ffprobe output did not include a video stream");
    }

    #[test]
    fn stream_signature_detects_incompatible_segments() {
        let first = StreamSignature {
            codec_name: "h264".to_string(),
            width: 3840,
            height: 2160,
            avg_frame_rate: "60/1".to_string(),
            pix_fmt: "yuv420p".to_string(),
            color_range: Some("tv".to_string()),
            color_space: Some("bt709".to_string()),
            color_transfer: Some("bt709".to_string()),
            color_primaries: Some("bt709".to_string()),
        };
        let mut second = first.clone();
        second.avg_frame_rate = "30/1".to_string();

        let error = validate_stream_signatures(&[first, second])
            .unwrap_err()
            .to_string();

        assert_eq!(error, "segment stream parameters differ at segment 1");
    }

    #[test]
    fn parses_decoded_frame_hashes_from_framemd5() {
        let hashes = decoded_frame_hashes_from_framemd5(
            br#"#format: frame checksums
#stream#, dts, pts, duration, size, hash
0, 0, 0, 1, 1024, aaaabbbb
0, 1, 1, 1, 1024, ccccdddd
"#,
        )
        .unwrap();

        assert_eq!(hashes, vec!["aaaabbbb", "ccccdddd"]);
    }

    #[test]
    fn decoded_hash_validation_accepts_static_frames_and_low_fps_repeats() {
        let static_hashes = vec!["same".to_string(); 180];
        validate_decoded_frame_hashes(&static_hashes, 180, Path::new("out.mp4")).unwrap();
        let mut hashes = unique_frame_hashes(180);
        hashes[1] = hashes[0].clone();
        hashes[72] = hashes[0].clone();
        hashes[176] = hashes[168].clone();
        validate_decoded_frame_hashes(&hashes, 180, Path::new("out.mp4")).unwrap();
    }

    #[test]
    fn selected_hash_validation_accepts_static_segment_boundaries() {
        let counts = [60, 60, 60];
        let indices = selected_frame_hash_indices(&counts);
        let hashes = vec!["same".to_string(); indices.len()];
        validate_selected_frame_hashes(&hashes, &indices, &counts, Path::new("out.mp4")).unwrap();
    }

    #[test]
    fn selected_hash_validation_rejects_missing_boundary_frames() {
        let error = validate_selected_frame_hashes(
            &["same".to_string()],
            &[59],
            &[60, 60],
            Path::new("out.mp4"),
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("decoded selected frame hash probe missing frame 60"));
    }

    #[test]
    fn streaming_hash_validation_keeps_decode_errors_and_counts() {
        let mut validator = DecodedFrameHashValidator::new(Path::new("out.mp4"), Some(2));
        validator
            .accept_framemd5_line("#format: frame checksums")
            .unwrap();
        validator
            .accept_framemd5_line("0, 0, 0, 1, 24, same")
            .unwrap();
        validator
            .accept_framemd5_line("0, 1, 1, 1, 24, same")
            .unwrap();
        validator.finish().unwrap();
        let mut invalid = DecodedFrameHashValidator::new(Path::new("out.mp4"), None);
        assert!(invalid.accept_framemd5_line("malformed").is_err());
        assert!(invalid.accept_hash("").is_err());
        assert!(invalid
            .finish()
            .unwrap_err()
            .to_string()
            .contains("no decoded frames"));
    }

    #[test]
    fn decoded_hash_validation_rejects_frame_count_mismatch() {
        let error = validate_decoded_frame_hashes(
            &["aaaabbbb".to_string(), "ccccdddd".to_string()],
            3,
            Path::new("out.mp4"),
        )
        .unwrap_err()
        .to_string();

        assert_eq!(
            error,
            "decoded frame hash count 2 did not match expected frame count 3 in out.mp4"
        );
    }

    #[test]
    fn segment_boundary_indices_select_frames_around_each_join() {
        assert_eq!(
            segment_boundary_frame_indices(&[60, 60, 60, 60]),
            vec![59, 60, 119, 120, 179, 180]
        );
    }

    #[test]
    fn selected_hash_indices_include_watched_frames_and_segment_boundaries() {
        assert_eq!(
            selected_frame_hash_indices(&[60, 60, 60, 60]),
            vec![0, 59, 60, 72, 119, 120, 168, 169, 170, 171, 172, 173, 174, 175, 176, 179, 180]
        );
    }

    #[test]
    fn full_hash_probe_maps_only_first_video_stream() {
        let args = decoded_frame_hashes_args("out.mp4");

        assert!(args.windows(2).any(|pair| pair == ["-map", "0:v:0"]));
        assert!(args.windows(2).any(|pair| pair == ["-f", "framemd5"]));
    }

    #[test]
    fn boundary_hash_probe_selects_only_join_frames() {
        let args = decoded_frame_hashes_at_indices_args("out.mp4", &[59, 60, 119, 120]);

        assert!(args.windows(2).any(|pair| pair == ["-map", "0:v:0"]));
        assert!(args.windows(2).any(|pair| pair
            == [
                "-vf",
                "select=eq(n\\,59)+eq(n\\,60)+eq(n\\,119)+eq(n\\,120)"
            ]));
        assert!(args.windows(2).any(|pair| pair == ["-f", "framemd5"]));
    }

    #[test]
    fn full_hash_probe_streams_framemd5_stdout() {
        let source = include_str!("segment_muxer.rs");

        assert!(source.contains("probe_and_validate_decoded_frame_hashes"));
        assert!(source.contains("BufReader::new(stdout).lines()"));
        assert!(source.contains("child.stdout.take()"));
        let buffered_full_probe = [
            "let hashes = probe_decoded_frame_hashes",
            "(output).await?;",
        ]
        .concat();
        assert!(!source.contains(&buffered_full_probe));
    }

    #[test]
    fn segment_frame_count_validation_rejects_truncated_segment() {
        let signature = StreamSignature {
            codec_name: "h264".to_string(),
            width: 3840,
            height: 2160,
            avg_frame_rate: "60/1".to_string(),
            pix_fmt: "yuv420p".to_string(),
            color_range: Some("tv".to_string()),
            color_space: Some("bt709".to_string()),
            color_transfer: Some("bt709".to_string()),
            color_primaries: Some("bt709".to_string()),
        };
        let probes = vec![
            SegmentProbe {
                signature: signature.clone(),
                frame_count: 120,
                duration_seconds: Some(OrderedSeconds::from_frames(120, 60)),
            },
            SegmentProbe {
                signature,
                frame_count: 119,
                duration_seconds: Some(OrderedSeconds::from_frames(119, 60)),
            },
        ];

        let error = validate_segment_frame_counts(&probes, &[120, 120])
            .unwrap_err()
            .to_string();

        assert_eq!(error, "segment 1 contains 119 frame(s), expected 120");
    }

    #[test]
    fn final_output_validation_rejects_mismatched_duration() {
        let probe = SegmentProbe {
            signature: StreamSignature {
                codec_name: "h264".to_string(),
                width: 3840,
                height: 2160,
                avg_frame_rate: "60/1".to_string(),
                pix_fmt: "yuv420p".to_string(),
                color_range: Some("tv".to_string()),
                color_space: Some("bt709".to_string()),
                color_transfer: Some("bt709".to_string()),
                color_primaries: Some("bt709".to_string()),
            },
            frame_count: 240,
            duration_seconds: Some(OrderedSeconds { millis: 3000 }),
        };

        let error = validate_final_output(
            &probe,
            &ExpectedVideoOutput {
                width: 3840,
                height: 2160,
                fps: 60,
                frame_count: 240,
                codec_name: "h264".to_string(),
                pix_fmts: vec!["yuv420p".to_string()],
            },
        )
        .unwrap_err()
        .to_string();

        assert_eq!(
            error,
            "remuxed output duration 3000ms did not match expected 4000ms"
        );
    }

    #[test]
    fn final_output_validation_rejects_mismatched_codec() {
        let probe = SegmentProbe {
            signature: StreamSignature {
                codec_name: "hevc".to_string(),
                width: 3840,
                height: 2160,
                avg_frame_rate: "60/1".to_string(),
                pix_fmt: "yuv420p".to_string(),
                color_range: Some("tv".to_string()),
                color_space: Some("bt709".to_string()),
                color_transfer: Some("bt709".to_string()),
                color_primaries: Some("bt709".to_string()),
            },
            frame_count: 240,
            duration_seconds: Some(OrderedSeconds::from_frames(240, 60)),
        };

        let error = validate_final_output(
            &probe,
            &ExpectedVideoOutput {
                width: 3840,
                height: 2160,
                fps: 60,
                frame_count: 240,
                codec_name: "h264".to_string(),
                pix_fmts: vec!["yuv420p".to_string()],
            },
        )
        .unwrap_err()
        .to_string();

        assert_eq!(
            error,
            "remuxed output codec hevc did not match expected h264"
        );
    }

    #[test]
    fn final_output_validation_rejects_mismatched_pixel_format() {
        let probe = SegmentProbe {
            signature: StreamSignature {
                codec_name: "h264".to_string(),
                width: 3840,
                height: 2160,
                avg_frame_rate: "60/1".to_string(),
                pix_fmt: "yuv444p".to_string(),
                color_range: Some("tv".to_string()),
                color_space: Some("bt709".to_string()),
                color_transfer: Some("bt709".to_string()),
                color_primaries: Some("bt709".to_string()),
            },
            frame_count: 240,
            duration_seconds: Some(OrderedSeconds::from_frames(240, 60)),
        };

        let error = validate_final_output(
            &probe,
            &ExpectedVideoOutput {
                width: 3840,
                height: 2160,
                fps: 60,
                frame_count: 240,
                codec_name: "h264".to_string(),
                pix_fmts: vec!["yuv420p".to_string(), "nv12".to_string()],
            },
        )
        .unwrap_err()
        .to_string();

        assert_eq!(
            error,
            "remuxed output pixel format yuv444p did not match expected yuv420p or nv12"
        );
    }

    #[test]
    fn expected_output_maps_hardware_h264_nv12_to_stream_facts() {
        assert_eq!(expected_codec_name("h264_mf"), "h264");
        assert_eq!(
            expected_stream_pix_fmts("nv12"),
            vec![
                "yuv420p".to_string(),
                "nv12".to_string(),
                "yuvj420p".to_string()
            ]
        );
        assert!(!expected_stream_pix_fmts("yuv420p").contains(&"yuvj420p".to_string()));
        assert_eq!(
            expected_stream_pix_fmts("yuv444p"),
            vec!["yuv444p".to_string()]
        );
    }

    #[test]
    fn expected_codec_name_normalizes_windows_hardware_encoder_labels() {
        for codec in ["h264_amf", "h264_nvenc", "h264_qsv", "h264_mf"] {
            assert_eq!(expected_codec_name(codec), "h264");
        }
        for codec in ["hevc_amf", "hevc_nvenc", "hevc_qsv", "hevc_mf"] {
            assert_eq!(expected_codec_name(codec), "hevc");
        }
        for codec in ["av1_amf", "av1_nvenc", "av1_qsv", "av1_mf"] {
            assert_eq!(expected_codec_name(codec), "av1");
        }
    }

    fn unique_frame_hashes(count: usize) -> Vec<String> {
        (0..count).map(|index| format!("hash-{index}")).collect()
    }
}
