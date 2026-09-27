//! Owns resources that must finish before a render job can return.

use std::path::Path;
use std::process::Stdio;
use tokio::io::AsyncReadExt;
use tokio::process::{Child, ChildStdout, Command};
use tokio::task::JoinHandle;

pub(crate) struct WorkerCommand {
    pub start: u32,
    pub end: u32,
    pub capture_stdout: bool,
    pub command: Command,
}

pub(crate) struct RenderJobResources {
    workspace: crate::output_workspace::OutputWorkspace,
    workers: WorkerGroup,
    cancellation: crate::cancellation::RenderCancellation,
}

impl RenderJobResources {
    pub async fn run<T>(
        output: Option<&Path>,
        temporary_output: &Path,
        directory: &Path,
        operation: impl AsyncFnOnce(&mut Self) -> anyhow::Result<T>,
    ) -> anyhow::Result<T> {
        let mut resources = Self::open(output, temporary_output, directory).await?;
        let result = operation(&mut resources).await;
        resources.finish(result).await
    }

    async fn open(
        output: Option<&Path>,
        temporary_output: &Path,
        directory: &Path,
    ) -> anyhow::Result<Self> {
        Ok(Self {
            workspace: crate::output_workspace::OutputWorkspace::open(
                output,
                temporary_output,
                directory,
            )
            .await?,
            workers: WorkerGroup::default(),
            cancellation: crate::cancellation::RenderCancellation::default(),
        })
    }

    pub fn spawn_workers(&mut self, commands: Vec<WorkerCommand>) -> anyhow::Result<()> {
        self.workers.spawn(commands)
    }

    pub fn worker_stdout(&mut self, index: usize) -> anyhow::Result<&mut ChildStdout> {
        self.workers
            .running
            .get_mut(index)
            .and_then(|worker| worker.stdout.as_mut())
            .ok_or_else(|| anyhow::anyhow!("streamed worker stdout is unavailable"))
    }

    pub async fn wait_for_workers(&mut self) -> anyhow::Result<()> {
        self.check_cancellation()?;
        self.workers.wait(&self.cancellation).await
    }

    pub fn set_cancellation(&mut self, cancellation: crate::cancellation::RenderCancellation) {
        self.cancellation = cancellation;
    }

    pub fn check_cancellation(&self) -> anyhow::Result<()> {
        self.cancellation.check()
    }

    pub async fn reset_attempt(&mut self) -> anyhow::Result<()> {
        self.workers.cancel().await?;
        self.workspace.reset().await
    }

    /// Every ordinary exit awaits process termination and output-reader joins
    /// before deleting the workspace or publishing the output.
    async fn finish<T>(mut self, result: anyhow::Result<T>) -> anyhow::Result<T> {
        let result = match result {
            Ok(value) => self.wait_for_workers().await.map(|()| value),
            Err(error) => Err(error),
        };
        let shutdown = self.workers.cancel().await;
        let result = match result {
            Err(error) => Err(error),
            Ok(value) => shutdown
                .and_then(|()| self.check_cancellation())
                .map(|()| value),
        };
        self.workspace.finish(result).await
    }
}

#[derive(Default)]
struct WorkerGroup {
    running: Vec<RunningWorker>,
}

struct RunningWorker {
    start: u32,
    end: u32,
    child: Child,
    stdout: Option<ChildStdout>,
    stderr: JoinHandle<Vec<u8>>,
}

impl WorkerGroup {
    pub fn spawn(&mut self, commands: Vec<WorkerCommand>) -> anyhow::Result<()> {
        for mut process in commands {
            process
                .command
                .stdout(if process.capture_stdout {
                    Stdio::piped()
                } else {
                    Stdio::null()
                })
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            let mut child = process.command.spawn()?;
            let stdout = child.stdout.take();
            let stderr = child.stderr.take();
            let stderr = tokio::spawn(async move {
                let mut output = Vec::new();
                if let Some(mut stderr) = stderr {
                    let _ = stderr.read_to_end(&mut output).await;
                }
                output
            });
            let stdout_missing = process.capture_stdout && stdout.is_none();
            self.running.push(RunningWorker {
                start: process.start,
                end: process.end,
                child,
                stdout,
                stderr,
            });
            if stdout_missing {
                return Err(anyhow::anyhow!("worker stdout is unavailable"));
            }
        }
        Ok(())
    }

    pub async fn wait(
        &mut self,
        cancellation: &crate::cancellation::RenderCancellation,
    ) -> anyhow::Result<()> {
        while !self.running.is_empty() {
            // Poll without dropping this future: a completed child's stderr
            // JoinHandle must still be collected before workspace cleanup.
            cancellation.check()?;
            let mut index = 0;
            while index < self.running.len() {
                let status = match self.running[index]
                    .child
                    .try_wait()
                    .map_err(worker_monitor_failed_error)?
                {
                    Some(status) => status,
                    None => {
                        index += 1;
                        continue;
                    }
                };
                let mut worker = self.running.swap_remove(index);
                let stderr = collect_worker_output(&mut worker).await;
                if !status.success() {
                    return Err(crate::errors::RendererError::WorkerFailed {
                        start: worker.start,
                        end: worker.end,
                        message: format!(
                            "exit status: {status}\nstderr:\n{}",
                            String::from_utf8_lossy(&stderr).trim()
                        ),
                    }
                    .into());
                }
            }
            if !self.running.is_empty() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }
        Ok(())
    }

    pub async fn cancel(&mut self) -> anyhow::Result<()> {
        let mut error = None;
        // Signal every child before awaiting any one child or its pipes.
        for worker in &mut self.running {
            if worker.child.try_wait().ok().flatten().is_none() {
                if let Err(failure) = worker.child.start_kill() {
                    error.get_or_insert_with(|| anyhow::Error::from(failure));
                }
            }
        }
        for mut worker in self.running.drain(..) {
            if let Err(failure) = worker.child.wait().await {
                error.get_or_insert_with(|| worker_monitor_failed_error(failure));
            }
            let _ = collect_worker_output(&mut worker).await;
        }
        error.map_or(Ok(()), Err)
    }
}

impl Drop for RunningWorker {
    fn drop(&mut self) {
        // Cancellation of the owning future cannot await. Keep this fallback
        // on each worker so it also covers cancellation during drain/join.
        let _ = self.child.start_kill();
        self.stderr.abort();
    }
}

fn worker_monitor_failed_error(error: std::io::Error) -> anyhow::Error {
    anyhow::anyhow!("failed to monitor worker process: {error}")
}

async fn collect_worker_output(worker: &mut RunningWorker) -> Vec<u8> {
    // A descendant can inherit stderr after its renderer parent exits. Do not
    // leave a detached drain task or wait forever for that unrelated handle.
    match tokio::time::timeout(std::time::Duration::from_secs(2), &mut worker.stderr).await {
        Ok(result) => result.unwrap_or_default(),
        Err(_) => {
            worker.stderr.abort();
            let _ = (&mut worker.stderr).await;
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn test_directory(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "velocast-job-{name}-{}-{nanos}",
            std::process::id()
        ))
    }

    #[tokio::test]
    async fn cancellation_after_successful_operation_prevents_publication() {
        let root = test_directory("publication-cancel");
        let directory = root.join("workspace");
        let output = root.join("movie.mp4");
        let temporary = directory.join("movie.final.mp4");
        let event = root.join("events.jsonl");
        let marker = root.join(format!("events.jsonl.{}.cancel", std::process::id()));
        tokio::fs::create_dir_all(&root).await.unwrap();
        tokio::fs::write(&output, b"distinct previous video")
            .await
            .unwrap();
        let error =
            RenderJobResources::run(Some(&output), &temporary, &directory, async |resources| {
                resources.set_cancellation(
                    crate::cancellation::RenderCancellation::from_event_log_path(event.to_str()),
                );
                tokio::fs::write(&temporary, b"complete new video").await?;
                tokio::fs::write(&marker, b"").await?;
                Ok(())
            })
            .await
            .unwrap_err();
        assert!(error.to_string().contains("renderer.cancelled"));
        assert_eq!(
            tokio::fs::read(&output).await.unwrap(),
            b"distinct previous video"
        );
        assert!(!directory.exists());
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn cancellation_during_worker_wait_reaps_worker_before_cleanup() {
        let root = test_directory("worker-cancel");
        let directory = root.join("workspace");
        let output = root.join("movie.mp4");
        let temporary = directory.join("movie.final.mp4");
        let event = root.join("events.jsonl");
        let marker = root.join(format!("events.jsonl.{}.cancel", std::process::id()));
        let ready = root.join("ready");
        let finished = root.join("finished");
        let error =
            RenderJobResources::run(Some(&output), &temporary, &directory, async |resources| {
                resources.set_cancellation(
                    crate::cancellation::RenderCancellation::from_event_log_path(event.to_str()),
                );
                resources.spawn_workers(vec![fixture_command(&ready, &finished, "slow")])?;
                wait_until_exists(&ready).await;
                tokio::fs::write(&marker, b"").await?;
                resources.wait_for_workers().await
            })
            .await
            .unwrap_err();
        assert!(error.to_string().contains("renderer.cancelled"));
        assert!(!directory.exists());
        tokio::time::sleep(std::time::Duration::from_millis(350)).await;
        assert!(!finished.exists(), "cancelled worker outlived workspace");
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn failed_validation_removes_workspace_and_preserves_existing_output() {
        let root = test_directory("validation");
        let directory = root.join("workspace");
        let output = root.join("movie.mp4");
        let temporary = directory.join("movie.final.mp4");
        tokio::fs::create_dir_all(&root).await.unwrap();
        tokio::fs::write(&output, b"existing video").await.unwrap();
        let error =
            RenderJobResources::run(Some(&output), &temporary, &directory, async |_resources| {
                tokio::fs::write(&temporary, b"invalid video").await?;
                Err::<(), _>(anyhow::anyhow!("output validation failed"))
            })
            .await
            .unwrap_err();

        assert_eq!(error.to_string(), "output validation failed");
        assert_eq!(tokio::fs::read(&output).await.unwrap(), b"existing video");
        assert!(!tokio::fs::try_exists(&directory).await.unwrap());
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn failure_after_spawn_reaps_workers_before_removing_their_workspace() {
        let root = test_directory("post-spawn");
        let directory = root.join("workspace");
        let ready = root.join("ready");
        let finished = root.join("finished");
        let output = root.join("movie.mp4");
        let temporary = directory.join("movie.final.mp4");
        let error =
            RenderJobResources::run(Some(&output), &temporary, &directory, async |resources| {
                resources.spawn_workers(vec![fixture_command(&ready, &finished, "slow")])?;
                wait_until_exists(&ready).await;
                tokio::fs::write(&temporary, b"partial video").await?;
                Err::<(), _>(anyhow::anyhow!("composition preparation failed"))
            })
            .await
            .unwrap_err();

        assert_eq!(error.to_string(), "composition preparation failed");
        assert!(!tokio::fs::try_exists(&directory).await.unwrap());
        tokio::time::sleep(std::time::Duration::from_millis(350)).await;
        assert!(
            !tokio::fs::try_exists(&finished).await.unwrap(),
            "worker outlived job failure"
        );
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn later_spawn_failure_terminates_already_started_workers() {
        let root = test_directory("spawn-failure");
        let directory = root.join("workspace");
        let ready = root.join("ready");
        let finished = root.join("finished");
        let output = root.join("movie.mp4");
        let temporary = directory.join("movie.final.mp4");
        let result =
            RenderJobResources::run(Some(&output), &temporary, &directory, async |resources| {
                resources.spawn_workers(vec![fixture_command(&ready, &finished, "slow")])?;
                wait_until_exists(&ready).await;
                resources.spawn_workers(vec![WorkerCommand {
                    start: 1,
                    end: 2,
                    capture_stdout: false,
                    command: Command::new(root.join("missing-worker-executable")),
                }])?;
                Ok(())
            })
            .await;
        assert!(result.is_err());
        assert!(!tokio::fs::try_exists(&directory).await.unwrap());
        tokio::time::sleep(std::time::Duration::from_millis(350)).await;
        assert!(!tokio::fs::try_exists(&finished).await.unwrap());
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn failed_sibling_cancels_workers_and_does_not_publish_output() {
        let root = test_directory("sibling");
        let directory = root.join("workspace");
        let ready = root.join("ready");
        let finished = root.join("finished");
        let output = root.join("movie.mp4");
        let temporary = directory.join("movie.final.mp4");
        let error =
            RenderJobResources::run(Some(&output), &temporary, &directory, async |resources| {
                resources.spawn_workers(vec![fixture_command(&ready, &finished, "slow")])?;
                wait_until_exists(&ready).await;
                resources.spawn_workers(vec![fixture_command(
                    &root.join("failed-ready"),
                    &finished,
                    "fail",
                )])?;
                tokio::fs::write(&temporary, b"unverified video").await?;
                Ok(())
            })
            .await
            .unwrap_err();
        assert!(error.to_string().contains("worker 0..1 failed"));
        assert!(!tokio::fs::try_exists(&output).await.unwrap());
        assert!(!tokio::fs::try_exists(&directory).await.unwrap());
        tokio::time::sleep(std::time::Duration::from_millis(350)).await;
        assert!(!tokio::fs::try_exists(&finished).await.unwrap());
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn success_waits_for_workers_before_publishing_and_removing_workspace() {
        let root = test_directory("success");
        let directory = root.join("workspace");
        let ready = root.join("ready");
        let finished = root.join("finished");
        let output = root.join("movie.mp4");
        let temporary = directory.join("movie.final.mp4");
        tokio::fs::create_dir_all(&root).await.unwrap();
        tokio::fs::write(&output, b"previous video").await.unwrap();
        RenderJobResources::run(Some(&output), &temporary, &directory, async |resources| {
            resources.spawn_workers(vec![fixture_command(&ready, &finished, "slow")])?;
            tokio::fs::write(&temporary, b"complete video").await?;
            assert_eq!(tokio::fs::read(&output).await?, b"previous video");
            Ok(())
        })
        .await
        .unwrap();
        assert!(tokio::fs::try_exists(&finished).await.unwrap());
        assert_eq!(tokio::fs::read(&output).await.unwrap(), b"complete video");
        assert!(!tokio::fs::try_exists(&directory).await.unwrap());
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn publication_stays_successful_when_a_locked_sidecar_prevents_cleanup() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = test_directory("committed-cleanup");
        let directory = root.join("workspace");
        let output = root.join("movie.mp4");
        let temporary = directory.join("movie.final.mp4");
        tokio::fs::create_dir_all(&root).await.unwrap();
        tokio::fs::write(&output, b"previous video").await.unwrap();
        let mut sidecar_lock = None;
        let result = RenderJobResources::run(Some(&output), &temporary, &directory, async |_| {
            let sidecar = directory.join("locked-sidecar");
            tokio::fs::write(&sidecar, b"pending cleanup").await?;
            sidecar_lock = Some(
                std::fs::OpenOptions::new()
                    .read(true)
                    .share_mode(0)
                    .open(sidecar)?,
            );
            tokio::fs::write(&temporary, b"published video").await?;
            Ok(())
        })
        .await;
        assert!(
            result.is_ok(),
            "published video must not be treated as a failed render: {result:?}"
        );
        assert_eq!(tokio::fs::read(&output).await.unwrap(), b"published video");
        assert!(tokio::fs::try_exists(&directory).await.unwrap());
        drop(sidecar_lock);
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn failed_promotion_restores_previous_output_and_removes_workspace() {
        let root = test_directory("promotion");
        let directory = root.join("workspace");
        let output = root.join("movie.mp4");
        let temporary = directory.join("missing-temporary.mp4");
        tokio::fs::create_dir_all(&root).await.unwrap();
        tokio::fs::write(&output, b"existing video").await.unwrap();
        let result =
            RenderJobResources::run(Some(&output), &temporary, &directory, async |_| Ok(())).await;
        assert!(result.is_err());
        assert_eq!(tokio::fs::read(&output).await.unwrap(), b"existing video");
        assert!(!tokio::fs::try_exists(&directory).await.unwrap());
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn capture_probe_finishes_without_requiring_or_replacing_a_video() {
        let root = test_directory("probe");
        let directory = root.join("workspace");
        let temporary = directory.join("unused.mp4");
        let value = RenderJobResources::run(None, &temporary, &directory, async |_| Ok(42))
            .await
            .unwrap();
        assert_eq!(value, 42);
        assert!(!tokio::fs::try_exists(&directory).await.unwrap());
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn retry_joins_previous_workers_and_discards_the_previous_attempt() {
        let root = test_directory("retry");
        let directory = root.join("workspace");
        let output = root.join("movie.mp4");
        let temporary = directory.join("movie.final.mp4");
        let ready = root.join("ready");
        let finished = root.join("finished");
        RenderJobResources::run(Some(&output), &temporary, &directory, async |resources| {
            resources.spawn_workers(vec![fixture_command(&ready, &finished, "slow")])?;
            wait_until_exists(&ready).await;
            tokio::fs::write(directory.join("old-segment.mp4"), b"first attempt").await?;
            resources.reset_attempt().await?;
            assert!(!tokio::fs::try_exists(directory.join("old-segment.mp4")).await?);
            tokio::fs::write(&temporary, b"successful retry").await?;
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(tokio::fs::read(&output).await.unwrap(), b"successful retry");
        tokio::time::sleep(std::time::Duration::from_millis(350)).await;
        assert!(!tokio::fs::try_exists(&finished).await.unwrap());
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn pending_recovery_copy_is_never_deleted_by_a_new_job() {
        let root = test_directory("recovery");
        let directory = root.join("workspace");
        let output = root.join("movie.mp4");
        let temporary = directory.join("movie.final.mp4");
        let recovery = temporary.with_extension("previous.tmp");
        tokio::fs::create_dir_all(&directory).await.unwrap();
        tokio::fs::write(&recovery, b"irreplaceable previous video")
            .await
            .unwrap();
        let result =
            RenderJobResources::run(Some(&output), &temporary, &directory, async |_| Ok(())).await;
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("recovery is pending")
        );
        assert_eq!(
            tokio::fs::read(&recovery).await.unwrap(),
            b"irreplaceable previous video"
        );
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    fn fixture_command(ready: &Path, finished: &Path, mode: &str) -> WorkerCommand {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "render_job::tests::worker_fixture",
                "--nocapture",
            ])
            .env("VELOCAST_JOB_TEST_READY", ready)
            .env("VELOCAST_JOB_TEST_FINISHED", finished)
            .env("VELOCAST_JOB_TEST_MODE", mode);
        WorkerCommand {
            start: 0,
            end: 1,
            capture_stdout: false,
            command,
        }
    }

    async fn wait_until_exists(path: &Path) {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !tokio::fs::try_exists(path).await.unwrap() {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("worker started");
    }

    #[test]
    fn worker_fixture() {
        let Some(ready) = std::env::var_os("VELOCAST_JOB_TEST_READY") else {
            return;
        };
        std::fs::write(ready, b"ready").unwrap();
        if std::env::var("VELOCAST_JOB_TEST_MODE").unwrap() == "fail" {
            std::process::exit(7);
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
        std::fs::write(
            std::env::var_os("VELOCAST_JOB_TEST_FINISHED").unwrap(),
            b"finished",
        )
        .unwrap();
    }
}
