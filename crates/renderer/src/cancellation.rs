//! A synchronous publication fence written by the CLI before slower OS process
//! tree termination. A per-process sibling of the existing event protocol path
//! avoids reusing a cancellation from an earlier invocation.
use std::path::{Path, PathBuf};

#[derive(Clone, Default)]
pub(crate) struct RenderCancellation {
    path: Option<PathBuf>,
}

impl RenderCancellation {
    pub fn from_event_log_path(path: Option<&str>) -> Self {
        Self::for_process(path.map(Path::new), std::process::id())
    }

    pub(crate) fn for_process(path: Option<&Path>, pid: u32) -> Self {
        Self {
            path: path.map(|path| {
                let mut name = path.as_os_str().to_os_string();
                name.push(format!(".{pid}.cancel"));
                PathBuf::from(name)
            }),
        }
    }

    pub(crate) fn request(&self) -> anyhow::Result<bool> {
        let Some(path) = &self.path else {
            return Ok(false);
        };
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
        {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
            Err(error) => Err(error.into()),
        }
    }

    pub(crate) fn remove_requested(&self) {
        if let Some(path) = &self.path {
            let _ = std::fs::remove_file(path);
        }
    }

    pub fn check(&self) -> anyhow::Result<()> {
        if let Some(path) = &self.path {
            match std::fs::symlink_metadata(path) {
                Ok(_) => anyhow::bail!("renderer.cancelled: publication cancelled by controller"),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_is_specific_to_event_path_and_process_and_disabled_for_direct_jobs() {
        let event = std::env::temp_dir().join(format!(
            "velocast-cancel-{}-{}.jsonl",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let current = RenderCancellation::for_process(Some(&event), 42);
        let other = RenderCancellation::for_process(Some(&event), 43);
        assert!(current
            .path
            .as_ref()
            .unwrap()
            .to_string_lossy()
            .ends_with(".jsonl.42.cancel"));
        current.check().unwrap();
        std::fs::write(current.path.as_ref().unwrap(), b"").unwrap();
        assert!(current
            .check()
            .unwrap_err()
            .to_string()
            .contains("renderer.cancelled"));
        other.check().unwrap();
        RenderCancellation::default().check().unwrap();
        std::fs::remove_file(current.path.unwrap()).unwrap();
    }
}
