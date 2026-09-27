//! Authored audio is frozen once, rendered in sample units and muxed inside the
//! existing job workspace. Video packets are copied, never decoded/re-encoded.
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, bail};
use sha2::{Digest, Sha256};
use tokio::process::Command;
use url::{Host, Url};
use velocast_protocol::{
    AudioPlan, AudioSampleRounding, CompositionManifest, RenderJob, audio_frames_to_samples,
};

const PER_SOURCE_LIMIT: u64 = 256 * 1024 * 1024;
const TOTAL_SOURCE_LIMIT: u64 = 256 * 1024 * 1024;
const SOURCE_COUNT_LIMIT: usize = 64;

pub(crate) struct PreparedAudio {
    plan: AudioPlan,
    sources: Vec<PathBuf>,
    source_channels: Vec<u8>,
    directory: PathBuf,
    frame_count: u32,
    fps: u32,
}

fn probe_source_channels(path: &Path) -> anyhow::Result<u8> {
    let output = std::process::Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=channels",
            "-of",
            "default=nokey=1:noprint_wrappers=1",
        ])
        .arg(path)
        .output()
        .context("audio.source_probe_failed")?;
    if !output.status.success() {
        bail!(
            "audio.source_probe_failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    match String::from_utf8_lossy(&output.stdout).trim() {
        "1" => Ok(1),
        "2" => Ok(2),
        value => bail!("audio.unsupported_channels: expected mono or stereo source, got {value}"),
    }
}

fn snapshot_origin(serve_url: &str) -> anyhow::Result<Url> {
    let base = Url::parse(serve_url).context("audio.invalid_source: invalid serve URL")?;
    let local = match base.host() {
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        Some(Host::Domain(name)) => name.eq_ignore_ascii_case("localhost"),
        None => false,
    };
    if base.scheme() != "http" || !local || !base.username().is_empty() || base.password().is_some()
    {
        bail!(
            "audio.unsupported_source: authored audio currently requires a versioned loopback HTTP snapshot"
        );
    }
    Ok(base)
}

fn resolve_source(base: &Url, source: &str) -> anyhow::Result<Url> {
    let url = base
        .join(source)
        .context("audio.invalid_source: invalid authored reference")?;
    if url.origin() != base.origin()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!(
            "audio.invalid_source: reference must remain in the frozen origin without credentials, query or fragment"
        );
    }
    Ok(url)
}

fn download_agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .proxy(None)
            .max_redirects(0)
            .http_status_as_error(false)
            .timeout_global(Some(timeout))
            .timeout_connect(Some(Duration::from_secs(2)))
            .timeout_recv_response(Some(Duration::from_secs(5)))
            .timeout_recv_body(Some(timeout))
            .build(),
    )
}

// Synchronous and bounded: no background downloader/writer can outlive the job.
fn download_source(
    agent: &ureq::Agent,
    url: &Url,
    source_version: &str,
    destination: &Path,
    limit: u64,
    cancellation: &crate::cancellation::RenderCancellation,
) -> anyhow::Result<u64> {
    cancellation.check()?;
    let mut response = agent
        .get(url.as_str())
        .call()
        .context("audio.download_failed")?;
    if response.status().as_u16() != 200 {
        bail!(
            "audio.download_failed: expected HTTP 200, got {}",
            response.status()
        );
    }
    let header = |name| {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
    };
    if header("x-velocast-source-version") != Some(source_version) {
        bail!("audio.snapshot_mismatch: source version header differs");
    }
    let expected_hash = header("x-velocast-content-sha256").unwrap_or("").to_owned();
    if expected_hash.len() != 64 || !expected_hash.bytes().all(|c| c.is_ascii_hexdigit()) {
        bail!("audio.snapshot_mismatch: missing content digest");
    }
    if header("content-encoding").is_some_and(|encoding| encoding != "identity") {
        bail!("audio.snapshot_mismatch: transformed response encoding");
    }
    let length = header("content-length")
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| anyhow::anyhow!("audio.download_failed: exact Content-Length required"))?;
    if length == 0 || length > limit {
        bail!("audio.source_limit: invalid or excessive source byte length");
    }
    tracing::info!(
        stage = "audio.download",
        bytes = length,
        "downloading frozen audio source"
    );
    let mut reader = response.body_mut().as_reader().take(limit + 1);
    let mut file = std::fs::File::create(destination)?;
    let mut hash = Sha256::new();
    let mut count = 0_u64;
    let mut bytes = [0_u8; 65536];
    loop {
        cancellation.check()?;
        let read = reader
            .read(&mut bytes)
            .context("audio.download_failed: source body read")?;
        cancellation.check()?;
        if read == 0 {
            break;
        }
        count += read as u64;
        if count > limit {
            bail!("audio.source_limit: source exceeded byte cap");
        }
        hash.update(&bytes[..read]);
        file.write_all(&bytes[..read])?;
    }
    file.sync_all()?;
    if count != length || !format!("{:x}", hash.finalize()).eq_ignore_ascii_case(&expected_hash) {
        bail!("audio.snapshot_mismatch: downloaded length or SHA-256 differs");
    }
    Ok(count)
}

pub(crate) fn prepare(
    job: &RenderJob,
    composition: &CompositionManifest,
    authored: Option<AudioPlan>,
    directory: &Path,
) -> anyhow::Result<Option<PreparedAudio>> {
    let Some(authored) = authored else {
        return Ok(None);
    };
    authored.validate().map_err(anyhow::Error::msg)?;
    let expected = audio_frames_to_samples(
        i64::from(composition.duration_frames),
        u64::from(composition.fps),
        authored.sample_rate,
        AudioSampleRounding::Round,
    )
    .map_err(anyhow::Error::msg)?;
    if authored.duration_samples != expected as u64 {
        bail!("audio.invalid_duration: plan must cover the full composition sample duration");
    }
    let range = job
        .output_range
        .clone()
        .unwrap_or(velocast_protocol::OutputFrameRange {
            start_frame: 0,
            end_frame: composition.duration_frames,
        });
    let plan = authored
        .slice_frames(
            i64::from(range.start_frame),
            i64::from(range.end_frame),
            u64::from(composition.fps),
            AudioSampleRounding::Round,
        )
        .map_err(anyhow::Error::msg)?;
    if plan.duration_samples == 0 {
        bail!("audio.invalid_duration: empty audio output");
    }
    let base = snapshot_origin(&job.serve_url)?;
    let version = job
        .render_session
        .as_ref()
        .and_then(|session| session.source_version.as_deref())
        .filter(|version| !version.is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "audio.frozen_source_required: authored audio requires a pinned sourceVersion"
            )
        })?;
    let agent = download_agent(Duration::from_secs(30));
    let cancellation =
        crate::cancellation::RenderCancellation::from_event_log_path(job.event_log_path.as_deref());
    let mut downloaded = BTreeMap::<String, PathBuf>::new();
    let mut sources = Vec::new();
    let mut total = 0;
    for clip in &plan.clips {
        let url = resolve_source(&base, &clip.source)?;
        if let Some(path) = downloaded.get(url.as_str()) {
            sources.push(path.clone());
            continue;
        }
        if downloaded.len() >= SOURCE_COUNT_LIMIT {
            bail!("audio.source_limit: too many audio sources");
        }
        let destination = directory.join(format!("audio-source-{}.input", downloaded.len()));
        let length = download_source(
            &agent,
            &url,
            version,
            &destination,
            PER_SOURCE_LIMIT.min(TOTAL_SOURCE_LIMIT - total),
            &cancellation,
        )?;
        total += length;
        downloaded.insert(url.to_string(), destination.clone());
        sources.push(destination);
    }
    let source_channels = sources
        .iter()
        .map(|source| probe_source_channels(source))
        .collect::<anyhow::Result<Vec<_>>>()?;
    Ok(Some(PreparedAudio {
        plan,
        sources,
        source_channels,
        directory: directory.to_owned(),
        frame_count: range.end_frame - range.start_frame,
        fps: composition.fps,
    }))
}

fn validate_pcm(path: &Path, expected: u64) -> anyhow::Result<String> {
    if std::fs::metadata(path)?.len() != expected {
        bail!("audio.invalid_pcm: unexpected PCM sample count");
    }
    let mut file = std::fs::File::open(path)?;
    let mut remaining = expected;
    let mut bytes = [0_u8; 65536];
    let mut hash = Sha256::new();
    while remaining > 0 {
        let count = remaining.min(bytes.len() as u64) as usize;
        file.read_exact(&mut bytes[..count])?;
        hash.update(&bytes[..count]);
        for sample in bytes[..count].chunks_exact(4) {
            if !f32::from_le_bytes(sample.try_into().unwrap()).is_finite() {
                bail!("audio.invalid_pcm: non-finite mixed sample");
            }
        }
        remaining -= count as u64;
    }
    Ok(format!("{:x}", hash.finalize()))
}

async fn validate_muxed(path: &Path, audio: &PreparedAudio) -> anyhow::Result<()> {
    let result = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,codec_name,sample_rate,channels,start_time,nb_frames,duration",
            "-of",
            "json",
        ])
        .arg(path)
        .kill_on_drop(true)
        .output()
        .await?;
    if !result.status.success() {
        bail!(
            "audio.mux_validation_failed: {}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
    let metadata: serde_json::Value = serde_json::from_slice(&result.stdout)?;
    let streams = metadata["streams"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("audio.mux_validation_failed: no streams"))?;
    let video = streams
        .iter()
        .find(|stream| stream["codec_type"] == "video")
        .ok_or_else(|| anyhow::anyhow!("audio.mux_validation_failed: video missing"))?;
    let sound = streams
        .iter()
        .find(|stream| stream["codec_type"] == "audio")
        .ok_or_else(|| anyhow::anyhow!("audio.mux_validation_failed: audio missing"))?;
    let number = |stream: &serde_json::Value, field: &str| {
        stream[field]
            .as_str()
            .and_then(|value| value.parse::<f64>().ok())
    };
    if number(video, "nb_frames") != Some(f64::from(audio.frame_count))
        || !number(video, "start_time").is_some_and(|value| value.abs() < 0.000001)
    {
        bail!("audio.mux_validation_failed: video count/PTS changed");
    }
    if sound["codec_name"] != "aac"
        || sound["channels"].as_u64() != Some(2)
        || number(sound, "sample_rate") != Some(audio.plan.sample_rate as f64)
    {
        bail!("audio.mux_validation_failed: unexpected audio format");
    }
    if !number(sound, "start_time")
        .is_some_and(|value| value.abs() <= 1.0 / audio.plan.sample_rate as f64)
    {
        bail!("audio.mux_validation_failed: audio PTS does not begin at zero");
    }
    let duration = audio.plan.duration_samples as f64 / audio.plan.sample_rate as f64;
    if !number(sound, "duration").is_some_and(|value| {
        value.is_finite() && (value - duration).abs() <= 1.0 / f64::from(audio.fps)
    }) {
        bail!("audio.mux_validation_failed: audio duration differs by more than one video frame");
    }
    Ok(())
}

fn pcm_arguments(audio: &PreparedAudio, output: &Path) -> Vec<String> {
    let plan = &audio.plan;
    let format = format!(
        "aformat=sample_fmts=flt:sample_rates={}:channel_layouts=stereo",
        plan.sample_rate
    );
    let mut args = vec![
        "-hide_banner",
        "-loglevel",
        "error",
        "-xerror",
        "-nostdin",
        "-y",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect::<Vec<_>>();
    let mut filters = vec![format!(
        "anullsrc=r={}:cl=stereo,atrim=end_sample={},asetpts=N/SR/TB,{format}[base]",
        plan.sample_rate, plan.duration_samples
    )];
    let mut labels = vec!["[base]".to_owned()];
    for (index, ((clip, source), channels)) in plan
        .clips
        .iter()
        .zip(&audio.sources)
        .zip(&audio.source_channels)
        .enumerate()
    {
        args.extend([
            "-protocol_whitelist".to_owned(),
            "file".to_owned(),
            "-format_whitelist".to_owned(),
            "wav,flac,mp3,mov,matroska,webm,ogg,aac".to_owned(),
            "-i".to_owned(),
            source.to_string_lossy().into_owned(),
        ]);
        let label = format!("[clip{index}]");
        labels.push(label.clone());
        let rematrix = match channels {
            // Web Audio duplicates a mono node to both stereo outputs at unity gain.
            // FFmpeg's implicit matrix instead applies -3 dB per output channel.
            1 => "pan=stereo|c0=c0|c1=c0,",
            2 => "",
            _ => unreachable!("probe_source_channels only admits mono or stereo"),
        };
        filters.push(format!("[{index}:a:0]asetpts=PTS-STARTPTS,aresample={}:async=0:first_pts=0,{rematrix}{format},atrim=start_sample={}:end_sample={},asetpts=N/SR/TB,{},adelay=delays={}S:all=1,apad=whole_len={},atrim=end_sample={},asetpts=N/SR/TB{label}", plan.sample_rate, clip.source_start_sample, clip.source_start_sample + clip.duration_samples, audio_gain_filter(clip), clip.start_sample, plan.duration_samples, plan.duration_samples));
    }
    if labels.len() == 1 {
        filters.push("[base]anull[pcm]".to_owned());
    } else {
        filters.push(format!("{}amix=inputs={}:duration=first:dropout_transition=0:normalize=0,atrim=end_sample={},asetpts=N/SR/TB,{format}[pcm]", labels.join(""), labels.len(), plan.duration_samples));
    }
    args.extend([
        "-filter_complex".to_owned(),
        filters.join(";"),
        "-map".to_owned(),
        "[pcm]".to_owned(),
        "-vn".to_owned(),
        "-sn".to_owned(),
        "-dn".to_owned(),
        "-ar".to_owned(),
        plan.sample_rate.to_string(),
        "-ac".to_owned(),
        "2".to_owned(),
        "-c:a".to_owned(),
        "pcm_f32le".to_owned(),
        "-f".to_owned(),
        "f32le".to_owned(),
        output.to_string_lossy().into_owned(),
    ]);
    args
}

async fn run_ffmpeg(
    args: Vec<String>,
    resources: &mut crate::render_job::RenderJobResources,
    stage: &str,
) -> anyhow::Result<()> {
    resources.check_cancellation()?;
    let mut command = Command::new("ffmpeg");
    command.args(args).stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.as_std_mut().creation_flags(0x08000000);
    }
    tracing::info!(%stage, "starting transactional audio process");
    resources.spawn_workers(vec![crate::render_job::WorkerCommand {
        start: 0,
        end: 0,
        capture_stdout: false,
        command,
    }])?;
    wait_for_audio_workers(resources, stage).await
}

async fn wait_for_audio_workers(
    resources: &mut crate::render_job::RenderJobResources,
    stage: &str,
) -> anyhow::Result<()> {
    let result = resources.wait_for_workers().await;
    // Worker waits also return cancellation. Keep the controller's marker as
    // the public error instead of hiding it beneath an audio stage failure.
    resources.check_cancellation()?;
    result.with_context(|| format!("audio.{stage}_failed"))
}

fn lacks_filter_graph_file_option(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        let Some(crate::errors::RendererError::WorkerFailed { message, .. }) =
            cause.downcast_ref::<crate::errors::RendererError>()
        else {
            return false;
        };
        let lines = message.lines().map(str::trim).collect::<Vec<_>>();
        lines.contains(&"Unrecognized option '/filter_complex'.")
            && lines.contains(&"Error splitting the argument list: Option not found")
    })
}

pub(crate) async fn mix_and_mux(
    audio: PreparedAudio,
    video: &Path,
    resources: &mut crate::render_job::RenderJobResources,
    telemetry: &mut crate::telemetry::RenderTelemetry,
) -> anyhow::Result<()> {
    if !video
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("mp4"))
    {
        bail!("audio.unsupported_output: authored audio currently requires MP4 output");
    }
    let pcm = audio.directory.join("audio-mix.f32");
    let mix_started = std::time::Instant::now();
    let mut args = pcm_arguments(&audio, &pcm);
    let graph_index = args
        .iter()
        .position(|arg| arg == "-filter_complex")
        .unwrap();
    let graph = audio.directory.join("audio-filter.txt");
    std::fs::write(&graph, &args[graph_index + 1]).context("audio.filter_write_failed")?;
    args[graph_index] = "-/filter_complex".to_owned();
    args[graph_index + 1] = graph.to_string_lossy().into_owned();
    if let Err(error) = run_ffmpeg(args.clone(), resources, "mix").await {
        // FFmpeg 6.1 uses the legacy file option, removed in FFmpeg 9. The exact
        // parser rejection occurs before any media is opened; mix errors and
        // cancellation must never enter this compatibility retry.
        if !lacks_filter_graph_file_option(&error) {
            return Err(error);
        }
        args[graph_index] = "-filter_complex_script".to_owned();
        run_ffmpeg(args, resources, "mix").await?;
    }
    let expected = audio
        .plan
        .duration_samples
        .checked_mul(8)
        .ok_or_else(|| anyhow::anyhow!("audio.invalid_duration: PCM size overflow"))?;
    let pcm_sha256 = validate_pcm(&pcm, expected)?;
    telemetry.audio = Some(crate::telemetry::AudioTelemetry {
        sample_rate: audio.plan.sample_rate,
        duration_samples: audio.plan.duration_samples,
        pcm_sha256,
        mix_ms: mix_started.elapsed().as_millis(),
        mux_ms: 0,
    });
    let muxed = audio.directory.join("audio-muxed.mp4");
    let args = vec![
        "-hide_banner".to_owned(),
        "-loglevel".to_owned(),
        "error".to_owned(),
        "-xerror".to_owned(),
        "-nostdin".to_owned(),
        "-y".to_owned(),
        "-i".to_owned(),
        video.to_string_lossy().into_owned(),
        "-f".to_owned(),
        "f32le".to_owned(),
        "-ar".to_owned(),
        audio.plan.sample_rate.to_string(),
        "-ac".to_owned(),
        "2".to_owned(),
        "-i".to_owned(),
        pcm.to_string_lossy().into_owned(),
        "-map".to_owned(),
        "0:v:0".to_owned(),
        "-map".to_owned(),
        "1:a:0".to_owned(),
        "-c:v".to_owned(),
        "copy".to_owned(),
        "-c:a".to_owned(),
        "aac".to_owned(),
        "-ar".to_owned(),
        audio.plan.sample_rate.to_string(),
        "-b:a".to_owned(),
        "256k".to_owned(),
        "-movflags".to_owned(),
        "+faststart".to_owned(),
        muxed.to_string_lossy().into_owned(),
    ];
    let mux_started = std::time::Instant::now();
    run_ffmpeg(args, resources, "mux").await?;
    validate_muxed(&muxed, &audio).await?;
    tokio::fs::remove_file(video).await?;
    tokio::fs::rename(&muxed, video).await?;
    if let Some(facts) = &mut telemetry.audio {
        facts.mux_ms = mux_started.elapsed().as_millis();
    }
    tracing::info!(
        samples = audio.plan.duration_samples,
        sample_rate = audio.plan.sample_rate,
        "audio mux finished before publication"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "velocast-audio-pipeline-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }
    fn cleanup(root: &Path) {
        let resolved = std::fs::canonicalize(root).unwrap();
        let parent = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        assert_eq!(resolved.parent(), Some(parent.as_path()));
        assert!(
            resolved
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("velocast-audio-pipeline-")
        );
        std::fs::remove_dir_all(resolved).unwrap();
    }

    #[tokio::test]
    async fn cancellation_before_or_during_audio_finalization_preserves_public_error_and_output() {
        for stage in ["mix", "mux"] {
            for before_spawn in [true, false] {
                let root = temporary_root();
                let directory = root.join("workspace");
                let output = root.join("movie.mp4");
                let temporary = directory.join("movie.final.mp4");
                let event = root.join("events.jsonl");
                let marker = root.join(format!("events.jsonl.{}.cancel", std::process::id()));
                std::fs::write(&output, b"previous completed output").unwrap();
                let error = crate::render_job::RenderJobResources::run(
                    Some(&output),
                    &temporary,
                    &directory,
                    async |resources| {
                        resources.set_cancellation(
                            crate::cancellation::RenderCancellation::from_event_log_path(
                                event.to_str(),
                            ),
                        );
                        std::fs::write(&temporary, b"unpublished video")?;
                        std::fs::write(&marker, b"")?;
                        if before_spawn {
                            // No FFmpeg executable is needed: cancellation must
                            // be observed before attempting to launch the command.
                            run_ffmpeg(vec![], resources, stage).await
                        } else {
                            // Reproduce the wait boundary that formerly wrapped
                            // renderer.cancelled as audio.mix_failed/mux_failed.
                            wait_for_audio_workers(resources, stage).await
                        }
                    },
                )
                .await
                .unwrap_err();
                assert!(error.to_string().starts_with("renderer.cancelled:"));
                assert_eq!(
                    std::fs::read(&output).unwrap(),
                    b"previous completed output"
                );
                assert!(!directory.exists());
                cleanup(&root);
            }
        }
    }

    #[tokio::test]
    async fn independent_audio_process_failures_keep_stage_context() {
        let root = temporary_root();
        let directory = root.join("workspace");
        let temporary = directory.join("movie.final.mp4");
        let error = crate::render_job::RenderJobResources::run(
            None,
            &temporary,
            &directory,
            async |resources| {
                // The native test harness rejects unknown arguments and exits with a
                // nonzero status; this exercises the real worker failure path without
                // depending on FFmpeg, media files, browser processes or GPU hardware.
                let mut command = Command::new(std::env::current_exe()?);
                command.arg("--invalid-audio-process-fixture-argument");
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    command.as_std_mut().creation_flags(0x08000000);
                }
                resources.spawn_workers(vec![crate::render_job::WorkerCommand {
                    start: 0,
                    end: 0,
                    capture_stdout: false,
                    command,
                }])?;
                wait_for_audio_workers(resources, "mix").await
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error.to_string(), "audio.mix_failed");
        assert!(
            error
                .chain()
                .any(|cause| cause.to_string().contains("exit status"))
        );
        assert!(!directory.exists());
        cleanup(&root);
    }
    fn server(
        status: &str,
        version: &str,
        digest: &str,
        body_delay: Duration,
    ) -> (Url, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = Url::parse(&format!(
            "http://{}/audio.wav",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let header = format!(
            "HTTP/1.1 {status}\r\nContent-Length: 3\r\nX-Velocast-Source-Version: {version}\r\nX-Velocast-Content-SHA256: {digest}\r\nLocation: http://127.0.0.1:9/never-follow\r\nConnection: close\r\n\r\n"
        );
        let handle = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut buffer = [0; 8192];
            let _ = socket.read(&mut buffer);
            let _ = socket.write_all(header.as_bytes());
            std::thread::sleep(body_delay);
            let _ = socket.write_all(b"abc");
        });
        (url, handle)
    }

    #[test]
    fn bounded_download_checks_version_hash_redirects_and_size() {
        let root = temporary_root();
        let digest = format!("{:x}", Sha256::digest(b"abc"));
        for (status, version, hash, limit, success) in [
            ("200 OK", "v1", digest.as_str(), 4, true),
            ("302 Found", "v1", digest.as_str(), 4, false),
            ("200 OK", "v2", digest.as_str(), 4, false),
            (
                "200 OK",
                "v1",
                "0000000000000000000000000000000000000000000000000000000000000000",
                4,
                false,
            ),
            ("200 OK", "v1", digest.as_str(), 2, false),
        ] {
            let (url, thread) = server(status, version, hash, Duration::ZERO);
            let result = download_source(
                &download_agent(Duration::from_secs(2)),
                &url,
                "v1",
                &root.join("source"),
                limit,
                &crate::cancellation::RenderCancellation::default(),
            );
            thread.join().unwrap();
            assert_eq!(result.is_ok(), success);
            if success {
                assert_eq!(std::fs::read(root.join("source")).unwrap(), b"abc");
            }
        }
        cleanup(&root);
    }

    #[test]
    fn large_media_headers_are_admitted_within_the_snapshot_budget() {
        // Header admission is tested without allocating/downloading a 200 MiB body.
        // Truncated admitted bodies must still fail later integrity/I/O validation.
        assert_eq!(PER_SOURCE_LIMIT, TOTAL_SOURCE_LIMIT);
        assert_eq!(TOTAL_SOURCE_LIMIT, 256 * 1024 * 1024);
        let root = temporary_root();
        for (length, limit, admitted) in [
            (69_120_044, PER_SOURCE_LIMIT, true),
            (200 * 1024 * 1024, PER_SOURCE_LIMIT, true),
            (PER_SOURCE_LIMIT + 1, PER_SOURCE_LIMIT, false),
            (69_120_044, 32 * 1024 * 1024, false),
        ] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let url = Url::parse(&format!(
                "http://{}/video.mp4",
                listener.local_addr().unwrap()
            ))
            .unwrap();
            let handle = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut buffer = [0; 8192];
                let _ = socket.read(&mut buffer);
                let digest = format!("{:x}", Sha256::digest(b""));
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {length}\r\nX-Velocast-Source-Version: v1\r\nX-Velocast-Content-SHA256: {digest}\r\nConnection: close\r\n\r\n"
                );
                let _ = socket.write_all(header.as_bytes());
            });
            let destination = root.join(format!("source-{length}-{limit}"));
            let error = download_source(
                &download_agent(Duration::from_secs(2)),
                &url,
                "v1",
                &destination,
                limit,
                &crate::cancellation::RenderCancellation::default(),
            )
            .unwrap_err();
            handle.join().unwrap();
            assert_eq!(destination.exists(), admitted);
            assert_eq!(error.to_string().contains("audio.source_limit"), !admitted);
        }
        cleanup(&root);
    }

    #[test]
    fn body_timeout_is_bounded_and_pcm_rejects_nonfinite_data() {
        let root = temporary_root();
        let digest = format!("{:x}", Sha256::digest(b"abc"));
        let (url, thread) = server("200 OK", "v1", &digest, Duration::from_millis(250));
        let error = download_source(
            &download_agent(Duration::from_millis(50)),
            &url,
            "v1",
            &root.join("source"),
            4,
            &crate::cancellation::RenderCancellation::default(),
        )
        .unwrap_err();
        thread.join().unwrap();
        assert!(
            error
                .chain()
                .any(|error| error.to_string().to_lowercase().contains("timeout"))
        );
        std::fs::write(root.join("pcm"), f32::NAN.to_le_bytes()).unwrap();
        assert!(validate_pcm(&root.join("pcm"), 4).is_err());
        std::fs::write(root.join("pcm"), 2.0_f32.to_le_bytes()).unwrap();
        assert!(validate_pcm(&root.join("pcm"), 4).is_ok());
        cleanup(&root);
    }
    #[test]
    fn authored_references_stay_in_versioned_loopback_origin() {
        let base = snapshot_origin("http://127.0.0.1:4000/project/index.html").unwrap();
        assert_eq!(
            resolve_source(&base, "../song.wav").unwrap().as_str(),
            "http://127.0.0.1:4000/song.wav"
        );
        for source in [
            "https://example.com/a.wav",
            "http://127.0.0.1:4001/a.wav",
            "file:///C:/a.wav",
            "http://user@127.0.0.1:4000/a.wav",
            "a.wav?key=value",
            "a.wav#fragment",
        ] {
            assert!(resolve_source(&base, source).is_err());
        }
        assert!(snapshot_origin("https://127.0.0.1:4000").is_err());
        assert!(snapshot_origin("http://example.com").is_err());
    }
    #[test]
    fn filter_file_compatibility_retry_accepts_only_the_exact_parser_rejection() {
        let stderr = "Unrecognized option '/filter_complex'.\nError splitting the argument list: Option not found";
        let failure = |message: &str| {
            anyhow::Error::new(crate::errors::RendererError::WorkerFailed {
                start: 0,
                end: 0,
                message: format!("exit status: 1\nstderr:\n{message}"),
            })
            .context("audio.mix_failed")
        };
        assert!(lacks_filter_graph_file_option(&failure(stderr)));
        for message in [
            "Unrecognized option 'other'.\nError splitting the argument list: Option not found",
            "Unrecognized option '/filter_complex'.\nError initializing complex filters",
            "Error splitting the argument list: Option not found",
            "Error opening input file: missing.wav",
        ] {
            assert!(!lacks_filter_graph_file_option(&failure(message)));
        }
        assert!(!lacks_filter_graph_file_option(&anyhow::anyhow!(stderr)));
        assert!(!lacks_filter_graph_file_option(&anyhow::anyhow!(
            "renderer.cancelled"
        )));
    }

    #[test]
    fn filter_plan_keeps_paths_outside_graph_and_uses_audio_stream_and_sample_indices() {
        let plan: AudioPlan = serde_json::from_value(serde_json::json!({"sampleRate":48000,"durationSamples":100,"clips":[{"source":"a","startSample":10,"sourceStartSample":20,"durationSamples":30,"gain":2}]})).unwrap();
        let path = PathBuf::from("source [unsafe];name.wav");
        let audio = PreparedAudio {
            plan,
            sources: vec![path.clone()],
            source_channels: vec![2],
            directory: PathBuf::from("work"),
            frame_count: 1,
            fps: 60,
        };
        let args = pcm_arguments(&audio, Path::new("out.f32"));
        let graph = &args[args
            .iter()
            .position(|arg| arg == "-filter_complex")
            .unwrap()
            + 1];
        assert!(!graph.contains("unsafe"));
        assert!(graph.contains("[0:a:0]"));
        assert!(graph.contains("start_sample=20:end_sample=50"));
        assert!(graph.contains("delays=10S"));
        assert!(graph.contains("normalize=0"));
        assert!(args.contains(&path.to_string_lossy().into_owned()));
    }
}

fn audio_gain_filter(clip: &velocast_protocol::AudioClip) -> String {
    let Some(points) = &clip.volume_envelope else {
        return format!("volume={}:precision=double", clip.gain);
    };
    fn segment(
        points: &[velocast_protocol::AudioEnvelopePoint],
        first: usize,
        last: usize,
    ) -> String {
        if first == last {
            let (left, right) = (&points[first], &points[first + 1]);
            return format!(
                "{}+({}-{})*((n-{})/{})",
                left.gain,
                right.gain,
                left.gain,
                left.sample,
                right.sample - left.sample
            );
        }
        let middle = (first + last) / 2;
        format!(
            "if(lt(n,{}),{},{})",
            points[middle + 1].sample,
            segment(points, first, middle),
            segment(points, middle + 1, last)
        )
    }
    let expression = if points.len() == 1 {
        points[0].gain.to_string()
    } else {
        format!(
            "if(lt(n,{}),{},if(gte(n,{}),{},{}))",
            points[0].sample,
            points[0].gain,
            points.last().unwrap().sample,
            points.last().unwrap().gain,
            segment(points, 0, points.len() - 2)
        )
    };
    format!(
        "aeval=exprs='val(0)*{}*({expression})|val(1)*{}*({expression})'",
        clip.gain, clip.gain
    )
}
