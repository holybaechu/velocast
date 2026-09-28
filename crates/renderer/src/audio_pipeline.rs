//! Freeze authored audio source bytes and slice the sample plan before browser media processing.
use anyhow::{bail, Context};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use url::{Host, Url};
use velocast_protocol::{
    audio_frames_to_samples, AudioPlan, AudioSampleRounding, CompositionManifest, RenderJob,
};
const PER_SOURCE_LIMIT: u64 = 256 * 1024 * 1024;
const TOTAL_SOURCE_LIMIT: u64 = 256 * 1024 * 1024;
const SOURCE_COUNT_LIMIT: usize = 64;
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
) -> anyhow::Result<Option<serde_json::Value>> {
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
    let sources = plan
        .clips
        .iter()
        .zip(sources)
        .map(|(clip, path)| (clip.source.clone(), path))
        .collect::<BTreeMap<_, _>>();
    Ok(Some(serde_json::json!({"plan":plan,"sources":sources})))
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
        assert!(resolved
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("velocast-audio-pipeline-"));
        std::fs::remove_dir_all(resolved).unwrap();
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
}
