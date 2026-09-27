//! Transactional output publication. Failed renders retain the previous video.

use std::path::{Path, PathBuf};

pub(crate) struct OutputWorkspace {
    output: Option<PathBuf>,
    temporary_output: PathBuf,
    directory: PathBuf,
}

impl OutputWorkspace {
    pub async fn open(
        output: Option<&Path>,
        temporary_output: &Path,
        directory: &Path,
    ) -> anyhow::Result<Self> {
        let workspace = Self {
            output: output.map(Path::to_owned),
            temporary_output: temporary_output.to_owned(),
            directory: directory.to_owned(),
        };
        let recovery = temporary_output.with_extension("previous.tmp");
        if tokio::fs::try_exists(&recovery).await? {
            return Err(anyhow::anyhow!(
                "previous output recovery is pending at {}",
                recovery.display()
            ));
        }
        tokio::fs::create_dir_all(directory).await?;
        if let Err(error) = remove_file_if_present(temporary_output).await {
            let _ = workspace.discard().await;
            return Err(error.into());
        }
        Ok(workspace)
    }

    pub async fn reset(&self) -> anyhow::Result<()> {
        let recovery = self.temporary_output.with_extension("previous.tmp");
        if tokio::fs::try_exists(&recovery).await? {
            return Err(anyhow::anyhow!(
                "previous output recovery is pending at {}",
                recovery.display()
            ));
        }
        self.discard().await?;
        tokio::fs::create_dir_all(&self.directory).await?;
        Ok(())
    }

    pub async fn finish<T>(self, result: anyhow::Result<T>) -> anyhow::Result<T> {
        let result = match result {
            Ok(value) => match &self.output {
                Some(output) => match promote_temp_output(&self.temporary_output, output).await {
                    Ok(published) => {
                        published.finish_housekeeping(&self.directory).await;
                        return Ok(value);
                    }
                    Err(error) => Err(error),
                },
                None => return self.discard().await.map(|()| value),
            },
            Err(error) => Err(error),
        };
        // If restoring an old video failed, retain the recovery copy. A later
        // cleanup must never turn a failed publication into data loss.
        let recovery = self.temporary_output.with_extension("previous.tmp");
        let cleanup = match tokio::fs::try_exists(&recovery).await {
            Ok(false) => self.discard().await,
            Ok(true) => Err(anyhow::anyhow!(
                "previous output retained at {}",
                recovery.display()
            )),
            Err(error) => Err(error.into()),
        };
        match result {
            Err(error) => Err(error),
            Ok(value) => cleanup.map(|()| value),
        }
    }

    async fn discard(&self) -> anyhow::Result<()> {
        match tokio::fs::remove_dir_all(&self.directory).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }
}

pub(crate) async fn promote_temp_output(
    temporary_output: &Path,
    output: &Path,
) -> anyhow::Result<PublishedOutput> {
    if let Some(parent) = output
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        tokio::fs::create_dir_all(parent).await?;
    }
    let previous_output = temporary_output.with_extension("previous.tmp");
    // Never overwrite a recovery copy left by an unsuccessful earlier restore.
    if tokio::fs::try_exists(&previous_output).await? {
        return Err(anyhow::anyhow!(
            "previous output recovery is pending at {}",
            previous_output.display()
        ));
    }
    let had_previous = tokio::fs::try_exists(output).await?;
    if had_previous {
        tokio::fs::rename(output, &previous_output).await?;
    }
    if let Err(error) = tokio::fs::rename(temporary_output, output).await {
        if had_previous {
            if let Err(restore_error) = tokio::fs::rename(&previous_output, output).await {
                return Err(anyhow::anyhow!(
                    "{error}; restoring previous output failed: {restore_error}; recovery copy: {}",
                    previous_output.display()
                ));
            }
        }
        return Err(error.into());
    }
    Ok(PublishedOutput {
        output: output.to_owned(),
        previous_output,
    })
}

/// Publication has committed. Housekeeping can retain recovery files and warn,
/// but it cannot turn the published video into a failed render.
pub(crate) struct PublishedOutput {
    output: PathBuf,
    previous_output: PathBuf,
}

impl PublishedOutput {
    pub async fn finish_housekeeping(self, directory: &Path) {
        if let Err(error) = remove_file_if_present(&self.previous_output).await {
            tracing::warn!(
                output = %self.output.display(),
                recovery = %self.previous_output.display(),
                %error,
                "video was published successfully; previous output could not be removed; the recovery copy and workspace were retained for manual cleanup"
            );
            return;
        }
        if let Err(error) = tokio::fs::remove_dir_all(directory).await {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(
                    output = %self.output.display(),
                    workspace = %directory.display(),
                    %error,
                    "video was published successfully; workspace cleanup failed; remove the retained workspace after releasing any file locks"
                );
            }
        }
    }
}

async fn remove_file_if_present(path: &Path) -> std::io::Result<()> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::os::windows::fs::OpenOptionsExt;

    #[tokio::test]
    async fn committed_publication_retains_locked_backup_without_failing_the_video() {
        let root = std::env::temp_dir().join(format!(
            "velocast-publication-backup-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        let directory = root.join("workspace");
        let output = root.join("movie.mp4");
        let temporary = directory.join("movie.final.mp4");
        let recovery = temporary.with_extension("previous.tmp");
        tokio::fs::create_dir_all(&directory).await.unwrap();
        tokio::fs::write(&output, b"previous video").await.unwrap();
        tokio::fs::write(&temporary, b"published video")
            .await
            .unwrap();

        let published = promote_temp_output(&temporary, &output).await.unwrap();
        let backup_lock = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&recovery)
            .unwrap();
        published.finish_housekeeping(&directory).await;

        assert_eq!(tokio::fs::read(&output).await.unwrap(), b"published video");
        assert!(tokio::fs::try_exists(&directory).await.unwrap());
        drop(backup_lock);
        assert_eq!(tokio::fs::read(&recovery).await.unwrap(), b"previous video");
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
}
