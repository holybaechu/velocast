use std::path::{Path, PathBuf};
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
