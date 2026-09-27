use serde::Serialize;
use std::collections::BTreeMap;

#[cfg(windows)]
use std::ffi::CString;

#[cfg(windows)]
use ffmpeg_sys_next as ffmpeg;

const WINDOWS_D3D11_FFMPEG_ENCODERS: [&str; 12] = [
    "h264_amf",
    "h264_nvenc",
    "h264_qsv",
    "h264_mf",
    "hevc_amf",
    "hevc_nvenc",
    "hevc_qsv",
    "hevc_mf",
    "av1_amf",
    "av1_nvenc",
    "av1_qsv",
    "av1_mf",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RendererCapabilities {
    output_api_version: u32,
    platform: &'static str,
    browser_hosts: Vec<&'static str>,
    default_browser_host: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    electron_host_protocol_version: Option<u32>,
    d3d11_ffmpeg_encoder: D3D11FfmpegEncoderCapabilities,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct D3D11FfmpegEncoderCapabilities {
    compiled: bool,
    encoders: BTreeMap<&'static str, bool>,
}

pub(crate) fn capabilities_json() -> anyhow::Result<String> {
    Ok(serde_json::to_string(&renderer_capabilities())?)
}

fn renderer_capabilities() -> RendererCapabilities {
    RendererCapabilities {
        output_api_version: velocast_protocol::OUTPUT_API_VERSION,
        platform: std::env::consts::OS,
        browser_hosts: crate::native_browser::browser_hosts(),
        default_browser_host: crate::native_browser::default_browser_host(),
        electron_host_protocol_version: Some(1),
        d3d11_ffmpeg_encoder: D3D11FfmpegEncoderCapabilities {
            compiled: d3d11_ffmpeg_encoder_compiled(),
            encoders: WINDOWS_D3D11_FFMPEG_ENCODERS
                .into_iter()
                .map(|encoder| (encoder, d3d11_ffmpeg_encoder_available(encoder)))
                .collect(),
        },
    }
}

fn d3d11_ffmpeg_encoder_compiled() -> bool {
    cfg!(windows)
}

#[cfg(windows)]
fn d3d11_ffmpeg_encoder_available(encoder: &str) -> bool {
    let Ok(name) = CString::new(encoder) else {
        return false;
    };
    unsafe { !ffmpeg::avcodec_find_encoder_by_name(name.as_ptr()).is_null() }
}

#[cfg(not(windows))]
fn d3d11_ffmpeg_encoder_available(_encoder: &str) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renderer_capabilities_reports_d3d11_encoder_support_and_known_encoder_names() {
        let capabilities = renderer_capabilities();

        assert_eq!(capabilities.platform, std::env::consts::OS);
        assert_eq!(capabilities.electron_host_protocol_version, Some(1));
        assert_eq!(capabilities.d3d11_ffmpeg_encoder.compiled, cfg!(windows));
        let mut expected = WINDOWS_D3D11_FFMPEG_ENCODERS
            .into_iter()
            .collect::<Vec<_>>();
        expected.sort_unstable();
        assert_eq!(
            capabilities
                .d3d11_ffmpeg_encoder
                .encoders
                .keys()
                .copied()
                .collect::<Vec<_>>(),
            expected
        );
    }
}
