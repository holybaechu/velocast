//! Isolated Electron control transport. Native never imports GPU textures.
use crate::browser_protocol::{self, BrowserDriver};
use crate::browser_surface::BrowserSurfaceMode;
use crate::cancellation::RenderCancellation;
use crate::frame_loop::{seek_frame_script, SelectorMeasurement};
use anyhow::{ensure, Context};
#[cfg(test)]
use serde::Deserialize;
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::io::{BufRead, BufReader, Read, Write};
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::time::{Duration, Instant};
use velocast_protocol::{AudioPlan, CompositionManifest, RenderJob, RenderSession};
#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(all(windows, test))]
use windows_sys::Win32::Foundation::{DuplicateHandle, DUPLICATE_SAME_ACCESS};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::*;
#[cfg(all(windows, test))]
use windows_sys::Win32::System::Threading::GetCurrentProcess;
const SCRIPT_TIMEOUT: Duration = Duration::from_secs(6);
const MAX_MESSAGE_BYTES: u64 = 4 * 1024 * 1024;
#[cfg(test)]
const MAX_FRAME_BYTES: u64 = 256 * 1024 * 1024;

pub struct ElectronRenderer {
    surface_mode: BrowserSurfaceMode,
    host: RefCell<Option<HostProcess>>,
    session: RefCell<Option<RenderSession>>,
    sequence: Cell<u64>,
}
impl ElectronRenderer {
    pub(crate) fn surface_mode(&self) -> BrowserSurfaceMode {
        self.surface_mode
    }
    pub fn new(surface_mode: BrowserSurfaceMode) -> anyhow::Result<Self> {
        Ok(Self {
            surface_mode,
            host: RefCell::new(None),
            session: RefCell::new(None),
            sequence: Cell::new(0),
        })
    }
    pub(crate) fn host_request(&self, request: Value) -> anyhow::Result<Value> {
        let timeout = match request["method"].as_str() {
            Some("media-operation" | "webcodecs-finish" | "webcodecs-open") => {
                Duration::from_secs(600)
            }
            _ => Duration::from_secs(45),
        };
        self.request(request, timeout)
    }
    pub async fn load(&self, job: &RenderJob) -> anyhow::Result<()> {
        let cancellation = RenderCancellation::from_event_log_path(job.event_log_path.as_deref());
        *self.host.borrow_mut() = Some(HostProcess::spawn(cancellation, self.surface_mode)?);
        self.request(
            json!({"method":"load","url":job.serve_url,"width":1200,"height":630}),
            Duration::from_secs(16),
        )?;
        self.execute(&format!(
            "window.__velocastRenderer = {};",
            include_str!("../browser/runtime.js")
        ))?;
        self.execute(&browser_protocol::render_environment_script(1200, 630))?;
        self.report(|token| Ok(browser_protocol::protocol_compatibility_script(token)))?;
        let session = browser_protocol::render_session_for_job(job);
        self.report(|token| browser_protocol::session_binding_script(&session, token))?;
        *self.session.borrow_mut() = Some(session);
        self.execute(&browser_protocol::protocol_missing_sentinel_script())?;
        if let Some(props) = crate::input_props::read_input_props(job.input_props_path.as_deref())?
        {
            self.report(|token| browser_protocol::input_props_script(&props, token))?;
        }
        self.report(|token| Ok(browser_protocol::readiness_script(token)))?;
        tracing::info!(surface_mode = ?self.surface_mode, "Electron browser ready");
        Ok(())
    }

    fn request(&self, request: Value, timeout: Duration) -> anyhow::Result<Value> {
        self.host
            .borrow_mut()
            .as_mut()
            .context("electron.host_unavailable")?
            .request(request, timeout)
    }
    fn execute(&self, script: &str) -> anyhow::Result<()> {
        self.request(json!({"method":"execute","script":script}), SCRIPT_TIMEOUT)
            .map(|_| ())
    }

    fn report(
        &self,
        script: impl FnOnce(&str) -> anyhow::Result<String>,
    ) -> anyhow::Result<String> {
        let sequence = self
            .sequence
            .get()
            .checked_add(1)
            .context("electron.request_overflow")?;
        self.sequence.set(sequence);
        let token = format!("electron-{sequence}");
        let response = self.request(
            json!({"method":"execute","script":script(&token)?,"token":token}),
            SCRIPT_TIMEOUT,
        )?;
        response["result"]
            .as_str()
            .map(str::to_owned)
            .context("electron.protocol_error: script result must be a string")
    }

    pub fn discover_compositions(&self) -> anyhow::Result<Vec<CompositionManifest>> {
        serde_json::from_str(
            &self.report(|token| Ok(browser_protocol::composition_discovery_script(token)))?,
        )
        .map_err(Into::into)
    }

    pub fn resolve_audio_plan(
        &self,
        composition: &CompositionManifest,
        props: Option<&Value>,
    ) -> anyhow::Result<Option<AudioPlan>> {
        browser_protocol::parse_audio_plan_result(&self.report(|token| {
            browser_protocol::audio_plan_script(
                composition,
                props,
                self.session.borrow().as_ref(),
                token,
            )
        })?)
    }

    pub fn measure_selector(&self, selector: &str) -> anyhow::Result<SelectorMeasurement> {
        browser_protocol::selector_measurement_from_json(&self.report(|token| {
            Ok(browser_protocol::selector_measurement_script(
                selector, token,
            ))
        })?)
    }

    pub fn prepare_composition_with_input_props(
        &self,
        composition: &CompositionManifest,
        frame: Option<u32>,
        props: Option<&Value>,
    ) -> anyhow::Result<()> {
        self.request(
            json!({"method":"resize","width":composition.width,"height":composition.height}),
            SCRIPT_TIMEOUT,
        )?;
        self.execute(&browser_protocol::render_environment_script(
            composition.width,
            composition.height,
        ))?;
        self.execute(&browser_protocol::target_capture_environment_script(
            composition.target.as_deref().unwrap_or(""),
        ))?;
        if let Some(frame) = frame {
            let mut context =
                crate::frame_loop::render_context_with_input_props(composition, props);
            context.render_session = self.session.borrow().clone();
            self.render_frame(&seek_frame_script(frame, &context)?, frame)?;
        }
        Ok(())
    }
}
impl BrowserDriver for ElectronRenderer {
    fn render_session(&self) -> Option<RenderSession> {
        self.session.borrow().clone()
    }
    fn render_frame(&self, script: &str, frame: u32) -> anyhow::Result<()> {
        self.report(|token| {
            Ok(browser_protocol::render_frame_completion_script(
                script, frame, token,
            ))
        })
        .map(|_| ())
    }
}
impl Drop for ElectronRenderer {
    fn drop(&mut self) {
        self.host.get_mut().take();
    }
}
#[cfg(test)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SoftwarePaintResponse {
    generation: u64,
    width: u32,
    height: u32,
    pixel_format: String,
    byte_length: u64,
    software_frame_id: String,
}

#[cfg(test)]
impl SoftwarePaintResponse {
    fn validate(&self, generation: u64) -> anyhow::Result<()> {
        ensure!(
            self.generation == generation,
            "electron.stale_paint: software generation mismatch"
        );
        let expected = u64::from(self.width)
            .checked_mul(u64::from(self.height))
            .and_then(|pixels| pixels.checked_mul(4))
            .context("electron.invalid_geometry: software BGRA length overflow")?;
        ensure!(
            self.width > 0
                && self.height > 0
                && self.width <= 16384
                && self.height <= 16384
                && expected <= MAX_FRAME_BYTES
                && self.byte_length == expected,
            "electron.invalid_geometry: software BGRA size is invalid or exceeds 256 MiB"
        );
        ensure!(
            self.pixel_format == "bgra",
            "electron.unsupported_format: expected software BGRA"
        );
        ensure!(
            !self.software_frame_id.is_empty() && self.software_frame_id.len() <= 64,
            "electron.invalid_lease: software frame lease is missing or oversized"
        );
        Ok(())
    }
}

struct HostDirectory {
    root: PathBuf,
    canonical_root: PathBuf,
}

impl HostDirectory {
    fn create() -> anyhow::Result<Self> {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos();
        for _ in 0..8 {
            let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = std::path::absolute(std::env::temp_dir())?.join(format!(
                "velocast-electron-{}-{timestamp}-{sequence}",
                std::process::id()
            ));
            match create_private_directory(&path) {
                Ok(()) => {
                    let canonical_root = match std::fs::canonicalize(&path) {
                        Ok(path) => path,
                        Err(error) => {
                            let _ = std::fs::remove_dir(&path);
                            return Err(error).context("electron.host_directory_identity_failed");
                        }
                    };
                    let directory = Self {
                        canonical_root,
                        root: path,
                    };
                    create_private_directory(&directory.profile_path())
                        .context("electron.profile_directory_creation_failed")?;
                    return Ok(directory);
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(error).context("electron.host_directory_creation_failed");
                }
            }
        }
        anyhow::bail!("electron.host_directory_creation_failed: repeated name collision")
    }

    fn profile_path(&self) -> PathBuf {
        self.root.join("profile")
    }

    #[cfg(test)]
    fn read_frame(&self, expected: u64) -> anyhow::Result<Vec<u8>> {
        ensure!(
            expected > 0 && expected <= MAX_FRAME_BYTES,
            "electron.invalid_frame_size"
        );
        let path = self.root.join("frame.bgra");
        let metadata =
            std::fs::symlink_metadata(&path).context("electron.software_frame_missing")?;
        ensure!(
            metadata.is_file() && metadata.len() == expected,
            "electron.invalid_frame_size: expected regular file of exact BGRA length"
        );
        let file = std::fs::File::open(&path)?;
        let mut pixels = Vec::with_capacity(expected as usize);
        file.take(expected + 1).read_to_end(&mut pixels)?;
        ensure!(
            pixels.len() as u64 == expected,
            "electron.invalid_frame_size: software frame changed while reading"
        );
        Ok(pixels)
    }
}

fn create_private_directory(path: &std::path::Path) -> std::io::Result<()> {
    let builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    let builder = {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = builder;
        builder.mode(0o700);
        builder
    };
    builder.create(path)
}

impl Drop for HostDirectory {
    fn drop(&mut self) {
        // Only this constructor's exclusively created root can be removed. Do
        // not follow a root replaced with a symlink/junction or a different path.
        let owned = std::fs::symlink_metadata(&self.root)
            .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
            && std::fs::canonicalize(&self.root).is_ok_and(|path| path == self.canonical_root);
        if !owned {
            tracing::warn!(path = %self.root.display(), "Electron host directory identity changed; skipping cleanup");
            return;
        }
        // Chromium descendants can release profile handles shortly after the
        // containing job is terminated. Bounded Windows backoff totals 310ms.
        for attempt in 0..6 {
            match std::fs::remove_dir_all(&self.root) {
                Ok(()) => return,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
                Err(error) => {
                    if cfg!(windows)
                        && attempt < 5
                        && matches!(error.raw_os_error(), Some(5 | 32 | 33 | 145))
                    {
                        std::thread::sleep(Duration::from_millis(10 << attempt));
                        continue;
                    }
                    tracing::warn!(path = %self.root.display(), %error, "Could not remove Electron host directory");
                    return;
                }
            }
        }
    }
}

#[cfg(windows)]
struct NativeHandle(HANDLE);
#[cfg(windows)]
impl Drop for NativeHandle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

#[cfg(windows)]
struct ProcessContainment(NativeHandle);
#[cfg(windows)]
impl ProcessContainment {
    fn terminate(&self) {
        unsafe {
            TerminateJobObject(self.0 .0, 1);
        }
    }
}

#[cfg(unix)]
struct ProcessContainment {
    pid: libc::pid_t,
    own_group: bool,
    armed: Cell<bool>,
}
#[cfg(unix)]
impl ProcessContainment {
    fn terminate(&self) {
        // Child was placed in its own process group before exec, so Chromium's
        // renderer/GPU subprocesses receive the same termination on cancellation.
        if !self.armed.replace(false) {
            return;
        }
        unsafe {
            libc::kill(
                if self.own_group { -self.pid } else { self.pid },
                libc::SIGKILL,
            );
        }
    }
}

#[cfg(unix)]
fn contain_process(child: &Child) -> anyhow::Result<ProcessContainment> {
    let pid = libc::pid_t::try_from(child.id()).context("electron.invalid_process_id")?;
    let inherited = std::env::var("VELOCAST_ELECTRON_WORKER_GROUP").as_deref() == Ok("1");
    let group = unsafe { libc::getpgid(pid) };
    ensure!(
        pid > 0
            && if inherited {
                group == unsafe { libc::getpid() } && group == unsafe { libc::getpgrp() }
            } else {
                group == pid
            },
        "electron.process_group_missing: host must own an isolated process group"
    );
    Ok(ProcessContainment {
        pid,
        own_group: !inherited,
        armed: Cell::new(true),
    })
}

/// Observe completion without releasing the PID. Callers terminate owned
/// process groups before wait()/try_wait() can allow the leader PID to be reused.
#[cfg(unix)]
pub(crate) fn unix_child_has_exited(pid: u32) -> std::io::Result<bool> {
    let mut information: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            pid as libc::id_t,
            &mut information,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    if result == 0 {
        Ok(unsafe { information.si_pid() } != 0)
    } else {
        Err(std::io::Error::last_os_error())
    }
}

struct HostProcess {
    child: Child,
    job: ProcessContainment,
    host_directory: Option<HostDirectory>,
    writes: Option<SyncSender<Vec<u8>>>,
    responses: Receiver<anyhow::Result<Value>>,
    sequence: u64,
    failed: bool,
    cancellation: RenderCancellation,
}

impl HostProcess {
    fn spawn(cancellation: RenderCancellation, mode: BrowserSurfaceMode) -> anyhow::Result<Self> {
        let binary = absolute_file_env("VELOCAST_ELECTRON_BINARY")?;
        let script = absolute_file_env("VELOCAST_ELECTRON_HOST_SCRIPT")?;
        let host_directory = HostDirectory::create()?;
        let mut command = Command::new(binary);
        command
            .arg(script)
            .env_remove("ELECTRON_RUN_AS_NODE")
            .env(
                "VELOCAST_ELECTRON_SURFACE_MODE",
                match mode {
                    BrowserSurfaceMode::Software => "software",
                    BrowserSurfaceMode::Bitmap => "bitmap",
                    BrowserSurfaceMode::WebCodecs => "webcodecs",
                },
            )
            .env(
                "VELOCAST_ELECTRON_PROFILE_DIRECTORY",
                host_directory.profile_path(),
            )
            .env_remove("VELOCAST_ELECTRON_FRAME_DIRECTORY")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        command.env("VELOCAST_ELECTRON_FRAME_DIRECTORY", &host_directory.root);
        #[cfg(windows)]
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            if std::env::var("VELOCAST_ELECTRON_WORKER_GROUP").as_deref() != Ok("1") {
                command.process_group(0);
            }
        }
        let child = command.spawn().context("electron.spawn_failed")?;
        Self::from_child(child, cancellation, Some(host_directory))
    }

    fn from_child(
        mut child: Child,
        cancellation: RenderCancellation,
        host_directory: Option<HostDirectory>,
    ) -> anyhow::Result<Self> {
        let job = match contain_process(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let (mut stdin, stdout) = match (child.stdin.take(), child.stdout.take()) {
            (Some(stdin), Some(stdout)) => (stdin, stdout),
            _ => {
                job.terminate();
                let _ = child.kill();
                let _ = child.wait();
                anyhow::bail!("electron.pipe_unavailable: host requires stdin and stdout pipes");
            }
        };
        let (writes, pending) = mpsc::sync_channel::<Vec<u8>>(1);
        let (messages, responses) = mpsc::sync_channel(2);
        let errors = messages.clone();
        std::thread::spawn(move || {
            while let Ok(bytes) = pending.recv() {
                if let Err(error) = stdin.write_all(&bytes).and_then(|_| stdin.flush()) {
                    let _ = errors.try_send(Err(error.into()));
                    return;
                }
            }
        });
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let message = read_message(&mut reader);
                let failed = message.is_err();
                if messages.try_send(message).is_err() || failed {
                    return;
                }
            }
        });
        let mut host = Self {
            child,
            job,
            host_directory,
            writes: Some(writes),
            responses,
            sequence: 0,
            failed: false,
            cancellation,
        };
        let ready = host.receive(Duration::from_secs(16))?;
        ensure!(
            ready["event"] == "ready"
                && ready["version"] == 3
                && ready["pid"].as_u64() == Some(u64::from(host.child.id())),
            "electron.protocol_error: invalid host handshake"
        );
        Ok(host)
    }

    fn request(&mut self, mut request: Value, timeout: Duration) -> anyhow::Result<Value> {
        ensure!(
            !self.failed,
            "electron.host_failed: previous request invalidated this process"
        );
        let result = (|| {
            self.cancellation.check()?;
            self.sequence = self
                .sequence
                .checked_add(1)
                .context("electron.request_overflow")?;
            request["id"] = json!(self.sequence);
            let mut bytes = serde_json::to_vec(&request)?;
            ensure!(
                bytes.len() < MAX_MESSAGE_BYTES as usize,
                "electron.request_too_large"
            );
            bytes.push(b'\n');
            self.writes
                .as_ref()
                .context("electron.stdin_closed")?
                .try_send(bytes)
                .context("electron.write_queue_unavailable")?;
            let response = self.receive(timeout)?;
            validate_response(&response, self.sequence)?;
            Ok(response)
        })();
        if result.is_err() {
            self.abort();
        }
        result
    }

    fn abort(&mut self) {
        self.failed = true;
        self.job.terminate();
        let _ = self.child.kill();
        self.writes.take();
        let _ = self.child.wait();
        self.host_directory.take();
    }

    fn receive(&mut self, timeout: Duration) -> anyhow::Result<Value> {
        let deadline = Instant::now() + timeout;
        loop {
            self.cancellation.check()?;
            let remaining = deadline.saturating_duration_since(Instant::now());
            ensure!(
                !remaining.is_zero(),
                "electron.request_timeout: host response deadline elapsed"
            );
            match self
                .responses
                .recv_timeout(remaining.min(Duration::from_millis(25)))
            {
                Ok(message) => return message,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    anyhow::bail!("electron.pipe_closed: host disconnected")
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    #[cfg(unix)]
                    if unix_child_has_exited(self.child.id())? {
                        self.job.terminate();
                        let status = self.child.wait()?;
                        anyhow::bail!("electron.host_exited: {status}");
                    }
                    #[cfg(windows)]
                    if let Some(status) = self.child.try_wait()? {
                        anyhow::bail!("electron.host_exited: {status}");
                    }
                }
            }
        }
    }
}

impl Drop for HostProcess {
    fn drop(&mut self) {
        if !self.failed {
            // Cancellation stops work, but must not block an idle host's close
            // handshake and orderly renderer/profile teardown.
            self.cancellation = RenderCancellation::default();
            let _ = self.request(json!({"method":"close"}), Duration::from_millis(250));
        }
        // Electron's fd0 reader can keep app.exit alive after its close ACK.
        // Disconnect the writer so its thread drops stdin and delivers EOF.
        self.writes.take();
        if !self.failed {
            let deadline = Instant::now() + Duration::from_millis(500);
            while Instant::now() < deadline {
                #[cfg(unix)]
                match unix_child_has_exited(self.child.id()) {
                    Ok(true) | Err(_) => break,
                    Ok(false) => std::thread::sleep(Duration::from_millis(5)),
                }
                #[cfg(windows)]
                match self.child.try_wait() {
                    Ok(Some(_)) | Err(_) => break,
                    Ok(None) => std::thread::sleep(Duration::from_millis(5)),
                }
            }
        }
        // The job owns Chromium descendants as well as Electron main. This also
        // handles cancellation, malformed messages and EOF during a texture lease.
        self.job.terminate();
        let _ = self.child.kill();
        let _ = self.child.wait();
        // Cleanup must happen after process termination/reaping, including on
        // failed startup, capture errors, EOF and cancellation.
        self.host_directory.take();
    }
}

#[cfg(windows)]
fn contain_process(child: &Child) -> anyhow::Result<ProcessContainment> {
    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    ensure!(
        !job.is_null(),
        "electron.job_creation_failed: {}",
        std::io::Error::last_os_error()
    );
    let job = NativeHandle(job);
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let configured = unsafe {
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of_val(&limits) as u32,
        )
    };
    ensure!(
        configured != 0,
        "electron.job_configuration_failed: {}",
        std::io::Error::last_os_error()
    );
    ensure!(
        unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle()) } != 0,
        "electron.job_assignment_failed: {}",
        std::io::Error::last_os_error()
    );
    Ok(ProcessContainment(job))
}

fn absolute_file_env(name: &str) -> anyhow::Result<PathBuf> {
    let path = PathBuf::from(
        std::env::var_os(name)
            .with_context(|| format!("electron.configuration: {name} is required"))?,
    );
    ensure!(
        path.is_absolute() && path.is_file(),
        "electron.configuration: {name} must name an existing absolute file"
    );
    Ok(path)
}

fn read_message(reader: &mut impl BufRead) -> anyhow::Result<Value> {
    // Windows Electron can emit an empty line before its main script starts.
    // Bound skipped lines too, so a noisy child cannot keep a reader busy forever.
    for _ in 0..=8 {
        let mut bytes = Vec::new();
        reader
            .take(MAX_MESSAGE_BYTES + 1)
            .read_until(b'\n', &mut bytes)?;
        ensure!(!bytes.is_empty(), "electron.pipe_closed: host stdout ended");
        ensure!(
            bytes.len() <= MAX_MESSAGE_BYTES as usize && bytes.last() == Some(&b'\n'),
            "electron.protocol_error: oversized or truncated JSONL response"
        );
        if bytes == b"\n" || bytes == b"\r\n" {
            continue;
        }
        return serde_json::from_slice(&bytes)
            .context("electron.protocol_error: invalid JSONL response");
    }
    anyhow::bail!("electron.protocol_error: too many empty stdout lines")
}

fn validate_response(response: &Value, id: u64) -> anyhow::Result<()> {
    ensure!(
        response["id"].as_u64() == Some(id),
        "electron.stale_response: response id did not match active request"
    );
    match response["ok"].as_bool() {
        Some(true) => Ok(()),
        Some(false) => anyhow::bail!(
            "electron.host_error: {}",
            response["error"]
                .as_str()
                .unwrap_or("unspecified host error")
        ),
        None => anyhow::bail!("electron.protocol_error: missing response status"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn software_metadata_rejects_stale_oversized_and_inconsistent_frames() {
        let mut paint = SoftwarePaintResponse {
            generation: 5,
            width: 2,
            height: 1,
            pixel_format: "bgra".into(),
            byte_length: 8,
            software_frame_id: "5:1".into(),
        };
        assert!(paint.validate(5).is_ok());
        assert!(paint.validate(4).is_err());
        paint.byte_length = 9;
        assert!(paint.validate(5).is_err());
        paint.width = 16384;
        paint.height = 16384;
        paint.byte_length = 16384 * 16384 * 4;
        assert!(paint.validate(5).is_err());
        paint.width = u32::MAX;
        paint.height = u32::MAX;
        assert!(paint.validate(5).is_err());
        paint.width = 0;
        paint.byte_length = 0;
        assert!(paint.validate(5).is_err());
    }

    #[test]
    fn software_transfer_reads_exact_bytes_and_cleans_abandoned_frame() {
        let directory = HostDirectory::create().unwrap();
        let path = directory.root.clone();
        let pixels = [0, 0, 0, 0, 9, 8, 7, 255];
        std::fs::write(path.join("frame.bgra"), pixels).unwrap();
        assert_eq!(directory.read_frame(8).unwrap(), pixels);
        assert!(directory.read_frame(4).is_err());
        assert!(directory.read_frame(12).is_err());
        assert!(directory.read_frame(MAX_FRAME_BYTES + 1).is_err());
        drop(directory);
        assert!(!path.exists());
    }

    #[test]
    fn host_directories_isolate_profiles_and_remove_nested_cache_files() {
        let first = HostDirectory::create().unwrap();
        let second = HostDirectory::create().unwrap();
        assert_ne!(first.root, second.root);
        assert!(first.profile_path().is_dir());
        assert!(second.profile_path().is_dir());
        assert!(!first.root.join("frame.bgra").exists());
        let cache = first.profile_path().join("GPUCache");
        std::fs::create_dir(&cache).unwrap();
        std::fs::write(cache.join("data_0"), b"first cache").unwrap();
        std::fs::write(second.profile_path().join("keep"), b"second cache").unwrap();
        let path = first.root.clone();
        drop(first);
        assert!(!path.exists());
        assert_eq!(
            std::fs::read(second.profile_path().join("keep")).unwrap(),
            b"second cache"
        );
    }

    #[cfg(unix)]
    #[test]
    fn host_directory_is_private_and_cleanup_does_not_follow_cache_symlinks() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let directory = HostDirectory::create().unwrap();
        let outside = HostDirectory::create().unwrap();
        std::fs::write(outside.root.join("keep"), b"outside").unwrap();
        for path in [directory.root.clone(), directory.profile_path()] {
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        symlink(&outside.root, directory.profile_path().join("cache-link")).unwrap();
        drop(directory);
        assert_eq!(
            std::fs::read(outside.root.join("keep")).unwrap(),
            b"outside"
        );
    }

    #[cfg(unix)]
    #[test]
    fn host_directory_cleanup_refuses_a_replaced_root_symlink() {
        use std::os::unix::fs::symlink;
        let directory = HostDirectory::create().unwrap();
        let outside = HostDirectory::create().unwrap();
        let original = directory.root.clone();
        std::fs::write(outside.root.join("keep"), b"outside").unwrap();
        std::fs::remove_dir(directory.profile_path()).unwrap();
        std::fs::remove_dir(&original).unwrap();
        symlink(&outside.root, &original).unwrap();
        drop(directory);
        assert_eq!(
            std::fs::read(outside.root.join("keep")).unwrap(),
            b"outside"
        );
        std::fs::remove_file(original).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn host_directory_cleanup_retries_transient_windows_profile_locks() {
        use std::os::windows::fs::OpenOptionsExt;
        let directory = HostDirectory::create().unwrap();
        let path = directory.root.clone();
        let lock = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .share_mode(0)
            .open(directory.profile_path().join("cache-lock"))
            .unwrap();
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(35));
            drop(lock);
        });
        drop(directory);
        release.join().unwrap();
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn unix_timeout_terminates_isolated_process_group() {
        use std::os::unix::process::CommandExt;
        let child = Command::new("sh")
            .arg("-c")
            .arg(
                r#"printf '{"event":"ready","version":3,"pid":%s}\n' "$$"; read request; sleep 30"#,
            )
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut host = HostProcess::from_child(child, RenderCancellation::default(), None).unwrap();
        let result = host.request(json!({"method":"paint"}), Duration::from_millis(40));
        assert!(result.unwrap_err().to_string().contains("request_timeout"));
        assert!(!host.child.wait().unwrap().success());
    }

    /// Exercise real pipe and Windows job ownership without Electron or fake GPU
    /// resources. The child only prints its handshake and runs the supplied test.
    #[cfg(windows)]
    fn test_host(script: &str, cancellation: RenderCancellation) -> HostProcess {
        let shell = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let script = format!(
            r#"[Console]::WriteLine('{{"event":"ready","version":3,"pid":' + $PID + '}}'); {script}"#
        );
        let child = Command::new(shell)
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(0x08000000)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        HostProcess::from_child(child, cancellation, None).unwrap()
    }

    #[cfg(windows)]
    fn assert_terminated(host: &mut HostProcess) {
        #[cfg(windows)]
        use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
        #[cfg(windows)]
        use windows_sys::Win32::System::Threading::WaitForSingleObject;
        assert_eq!(
            unsafe { WaitForSingleObject(host.child.as_raw_handle(), 2000) },
            WAIT_OBJECT_0
        );
        assert!(host.child.wait().is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn timeout_terminates_host_and_rejects_future_requests() {
        let mut host = test_host(
            "$null = [Console]::ReadLine(); Start-Sleep -Seconds 30",
            RenderCancellation::default(),
        );
        let error = host
            .request(json!({"method":"paint"}), Duration::from_millis(40))
            .unwrap_err();
        assert!(error.to_string().contains("request_timeout"));
        assert_terminated(&mut host);
        assert!(host
            .request(json!({"method":"paint"}), SCRIPT_TIMEOUT)
            .unwrap_err()
            .to_string()
            .contains("host_failed"));
    }

    #[cfg(windows)]
    #[test]
    fn graceful_close_delivers_stdin_eof_and_preserves_successful_exit() {
        #[cfg(windows)]
        use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
        #[cfg(windows)]
        use windows_sys::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
        let host = test_host(
            r#"$request = [Console]::ReadLine() | ConvertFrom-Json; [Console]::WriteLine('{"id":' + $request.id + ',"ok":true}'); while ($null -ne [Console]::ReadLine()) {}; exit 0"#,
            RenderCancellation::default(),
        );
        // Keep a real process handle so we can distinguish graceful exit0 from
        // the Job Object's forced exit1 after HostProcess closes its own handle.
        let mut process = std::ptr::null_mut();
        assert_ne!(
            unsafe {
                DuplicateHandle(
                    GetCurrentProcess(),
                    host.child.as_raw_handle(),
                    GetCurrentProcess(),
                    &mut process,
                    0,
                    0,
                    DUPLICATE_SAME_ACCESS,
                )
            },
            0
        );
        let process = NativeHandle(process);
        drop(host);
        assert_eq!(
            unsafe { WaitForSingleObject(process.0, 2000) },
            WAIT_OBJECT_0
        );
        let mut exit_code = u32::MAX;
        assert_ne!(unsafe { GetExitCodeProcess(process.0, &mut exit_code) }, 0);
        assert_eq!(exit_code, 0);
    }

    #[cfg(windows)]
    #[test]
    fn pipe_closure_invalidates_host_without_waiting_for_request_timeout() {
        let mut host = test_host(
            "$null = [Console]::ReadLine(); exit 9",
            RenderCancellation::default(),
        );
        let started = Instant::now();
        assert!(host
            .request(json!({"method":"paint"}), Duration::from_secs(10))
            .is_err());
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_terminated(&mut host);
    }

    #[cfg(windows)]
    #[test]
    fn cancellation_interrupts_pending_response_and_terminates_host() {
        let event = std::env::temp_dir().join(format!(
            "electron-cancel-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let cancellation = RenderCancellation::from_event_log_path(event.to_str());
        let marker = PathBuf::from(format!("{}.{}.cancel", event.display(), std::process::id()));
        let mut host = test_host(
            "$null = [Console]::ReadLine(); Start-Sleep -Seconds 30",
            cancellation,
        );
        let marker_writer = marker.clone();
        let cancel = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            std::fs::write(marker_writer, b"").unwrap();
        });
        let error = host
            .request(json!({"method":"paint"}), Duration::from_secs(5))
            .unwrap_err();
        cancel.join().unwrap();
        std::fs::remove_file(marker).unwrap();
        assert!(error.to_string().contains("renderer.cancelled"));
        assert_terminated(&mut host);
    }

    #[test]
    fn rejects_stale_responses_and_host_errors() {
        assert!(validate_response(&json!({"id":4,"ok":true}), 5).is_err());
        assert!(
            validate_response(&json!({"id":5,"ok":false,"error":"crashed"}), 5)
                .unwrap_err()
                .to_string()
                .contains("crashed")
        );
        assert!(validate_response(&json!({"id":5}), 5).is_err());
    }
    #[test]
    fn jsonl_is_bounded_and_requires_complete_message() {
        assert!(read_message(&mut &b"{\"id\":1}\n"[..]).is_ok());
        assert!(read_message(&mut &b"\n\r\n{\"id\":1}\n"[..]).is_ok());
        assert!(read_message(&mut &b"\n\n\n\n\n\n\n\n\n{}\n"[..]).is_err());
        assert!(read_message(&mut &b"{}"[..]).is_err());
        assert!(read_message(&mut &b""[..]).is_err());
        assert!(read_message(&mut &vec![b' '; MAX_MESSAGE_BYTES as usize + 1][..]).is_err());
    }
}
