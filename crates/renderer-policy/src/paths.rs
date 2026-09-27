use crate::scheduler::FrameRange;
use std::path::{Path, PathBuf};
pub fn chunk_paths(ranges: &[FrameRange], chunk_dir: &Path) -> Vec<PathBuf> {
    ranges
        .iter()
        .enumerate()
        .map(|(index, _)| chunk_dir.join(format!("chunk-{index:04}.bgra")))
        .collect()
}

pub fn segment_paths(ranges: &[FrameRange], chunk_dir: &Path) -> Vec<PathBuf> {
    ranges
        .iter()
        .enumerate()
        .map(|(index, _)| chunk_dir.join(format!("segment-{index:04}.mp4")))
        .collect()
}

pub fn segment_report_path_for(segment_output: &Path) -> PathBuf {
    segment_output.with_extension("report.json")
}

pub fn segment_worker_report_path_for(segment_output: &Path) -> PathBuf {
    segment_output.with_extension("worker-report.json")
}

pub fn temp_chunk_dir_for_output(output: &Path, process_id: u32) -> PathBuf {
    let parent = output.parent().filter(|path| !path.as_os_str().is_empty());
    let stem = output
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("render");

    parent
        .unwrap_or_else(|| Path::new("."))
        .join(".velocast")
        .join("tmp")
        .join(format!("{stem}-{process_id}"))
}

pub fn temp_output_path_for(output: &Path, chunk_dir: &Path) -> PathBuf {
    let stem = output
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("render");
    let extension = output
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("mp4");

    chunk_dir.join(format!("{stem}.final.{extension}"))
}
