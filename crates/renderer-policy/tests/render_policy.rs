use velocast_renderer_policy::backend_registry::BackendKind;
use velocast_renderer_policy::encoder_plan::EncoderCandidatePlan;
use velocast_renderer_policy::encoder_plan::{EncoderCapabilities, EncoderPlan};
use velocast_renderer_policy::scheduler::{chunk_frame_ranges, FrameRange};
use velocast_renderer_policy::settings::EncoderSettings;
use velocast_renderer_policy::settings::{EncoderBackendPreference, EncoderExecutionContext};

#[test]
fn segment_schedule_covers_every_frame_once_when_work_does_not_divide_evenly() {
    assert_eq!(
        chunk_frame_ranges(10, 3),
        vec![
            FrameRange { start: 0, end: 4 },
            FrameRange { start: 4, end: 7 },
            FrameRange { start: 7, end: 10 },
        ],
    );
}

#[test]
fn activation_tries_the_planned_backends_in_order_before_software_fallback() {
    let plan = EncoderPlan::resolve(
        EncoderSettings::new(1920, 1080, 30, "h264", "nv12", "out.mp4"),
        &EncoderCapabilities::windows(),
    )
    .unwrap();
    let mut attempted = Vec::new();
    let opened = plan
        .activate(|candidate| {
            attempted.push(candidate.kind());
            if candidate.kind() == BackendKind::WindowsD3D11Nvenc {
                Ok("nvenc encoder")
            } else {
                Err("backend could not open")
            }
        })
        .unwrap();
    assert_eq!(
        attempted,
        vec![BackendKind::WindowsD3D11Amf, BackendKind::WindowsD3D11Nvenc]
    );
    assert_eq!(opened.value, "nvenc encoder");
    assert_eq!(opened.failures.len(), 1);
    assert_eq!(opened.failures[0].kind, BackendKind::WindowsD3D11Amf);
}

#[test]
fn required_acceleration_returns_all_open_failures_without_attempting_software() {
    let mut settings = EncoderSettings::new(1920, 1080, 30, "h264", "nv12", "out.mp4");
    settings.backend = EncoderBackendPreference::HardwareRequired;
    let plan = EncoderPlan::resolve(settings, &EncoderCapabilities::windows()).unwrap();
    let mut attempts = Vec::new();
    let failures = plan
        .activate::<(), _>(|candidate| {
            attempts.push(candidate.kind());
            Err("device busy")
        })
        .unwrap_err();
    assert_eq!(
        attempts,
        vec![
            BackendKind::WindowsD3D11Amf,
            BackendKind::WindowsD3D11Nvenc,
            BackendKind::WindowsD3D11Qsv,
            BackendKind::WindowsD3D11Mf
        ]
    );
    assert_eq!(failures.len(), 4);
    assert!(failures
        .iter()
        .all(|failure| failure.error == "device busy"));
}

#[test]
fn auto_fallback_preserves_failed_attempts_when_software_opens() {
    let settings = EncoderSettings::new(1920, 1080, 30, "hevc_mf", "nv12", "out.mp4");
    let plan = EncoderPlan::resolve(settings, &EncoderCapabilities::windows()).unwrap();
    let opened = plan
        .activate(|candidate| match candidate {
            EncoderCandidatePlan::Software => Ok("software encoder"),
            _ => Err("encoder.ffmpeg_open_failed: device busy"),
        })
        .unwrap();
    assert_eq!(opened.kind, BackendKind::SoftwareBgraFfmpeg);
    assert_eq!(opened.failures.len(), 1);
    assert_eq!(opened.failures[0].kind, BackendKind::WindowsD3D11Mf);
    assert_eq!(
        opened.failures[0].error,
        "encoder.ffmpeg_open_failed: device busy"
    );
}

#[test]
fn software_and_streamed_workers_do_not_attempt_hardware_even_when_host_supports_it() {
    let mut software = EncoderSettings::new(1920, 1080, 30, "h264", "nv12", "out.mp4");
    software.backend = EncoderBackendPreference::Software;
    let streamed = EncoderSettings::new(1920, 1080, 30, "h264", "nv12", "out.mp4")
        .with_execution_context(EncoderExecutionContext::StreamedBgraWorker);
    for settings in [software, streamed] {
        let plan = EncoderPlan::resolve(settings, &EncoderCapabilities::windows()).unwrap();
        assert_eq!(plan.candidates(), &[EncoderCandidatePlan::Software]);
    }
}

#[test]
fn retired_vaapi_codecs_are_rejected_even_when_software_fallback_is_allowed() {
    for capabilities in [
        EncoderCapabilities::software_only(),
        EncoderCapabilities::windows(),
    ] {
        for codec in ["h264_vaapi", "hevc_vaapi", "av1_vaapi"] {
            let settings = EncoderSettings::new(1920, 1080, 30, codec, "nv12", "out.mp4");
            assert!(EncoderPlan::resolve(settings, &capabilities)
                .unwrap_err()
                .to_string()
                .contains("encoder.codec_unavailable"));
        }
    }
}
