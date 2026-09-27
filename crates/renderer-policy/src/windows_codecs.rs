use crate::codec::{
    ParsedVideoCodec, RequestedEncoderBackend, RequestedVideoCodec, WindowsD3D11EncoderBackend,
};

pub fn ffmpeg_encoder_candidates(parsed: ParsedVideoCodec) -> Vec<&'static str> {
    match parsed.backend {
        RequestedEncoderBackend::Auto => generic_candidates(parsed.codec),
        RequestedEncoderBackend::WindowsD3D11(backend) => forced_candidate(parsed.codec, backend)
            .into_iter()
            .collect(),
    }
}

pub fn generic_candidates(codec: RequestedVideoCodec) -> Vec<&'static str> {
    match codec {
        RequestedVideoCodec::H264 => vec!["h264_amf", "h264_nvenc", "h264_qsv", "h264_mf"],
        RequestedVideoCodec::Hevc => vec!["hevc_amf", "hevc_nvenc", "hevc_qsv", "hevc_mf"],
        RequestedVideoCodec::Av1 => vec!["av1_amf", "av1_nvenc", "av1_qsv", "av1_mf"],
    }
}

pub fn forced_candidate(
    codec: RequestedVideoCodec,
    backend: WindowsD3D11EncoderBackend,
) -> Option<&'static str> {
    match (codec, backend) {
        (RequestedVideoCodec::H264, WindowsD3D11EncoderBackend::Amf) => Some("h264_amf"),
        (RequestedVideoCodec::H264, WindowsD3D11EncoderBackend::Nvenc) => Some("h264_nvenc"),
        (RequestedVideoCodec::H264, WindowsD3D11EncoderBackend::Qsv) => Some("h264_qsv"),
        (RequestedVideoCodec::H264, WindowsD3D11EncoderBackend::Mf) => Some("h264_mf"),
        (RequestedVideoCodec::Hevc, WindowsD3D11EncoderBackend::Amf) => Some("hevc_amf"),
        (RequestedVideoCodec::Hevc, WindowsD3D11EncoderBackend::Nvenc) => Some("hevc_nvenc"),
        (RequestedVideoCodec::Hevc, WindowsD3D11EncoderBackend::Qsv) => Some("hevc_qsv"),
        (RequestedVideoCodec::Hevc, WindowsD3D11EncoderBackend::Mf) => Some("hevc_mf"),
        (RequestedVideoCodec::Av1, WindowsD3D11EncoderBackend::Amf) => Some("av1_amf"),
        (RequestedVideoCodec::Av1, WindowsD3D11EncoderBackend::Nvenc) => Some("av1_nvenc"),
        (RequestedVideoCodec::Av1, WindowsD3D11EncoderBackend::Qsv) => Some("av1_qsv"),
        (RequestedVideoCodec::Av1, WindowsD3D11EncoderBackend::Mf) => Some("av1_mf"),
    }
}

pub fn is_windows_d3d11_ffmpeg_encoder(encoder: &str) -> bool {
    backend_for_ffmpeg_encoder(encoder).is_some()
}

pub fn backend_for_ffmpeg_encoder(encoder: &str) -> Option<WindowsD3D11EncoderBackend> {
    let encoder = encoder.to_ascii_lowercase();
    match encoder.as_str() {
        "h264_amf" | "hevc_amf" | "av1_amf" => Some(WindowsD3D11EncoderBackend::Amf),
        "h264_nvenc" | "hevc_nvenc" | "av1_nvenc" => Some(WindowsD3D11EncoderBackend::Nvenc),
        "h264_qsv" | "hevc_qsv" | "av1_qsv" => Some(WindowsD3D11EncoderBackend::Qsv),
        "h264_mf" | "hevc_mf" | "av1_mf" => Some(WindowsD3D11EncoderBackend::Mf),
        _ => None,
    }
}

pub fn selected_codec_label(encoder: &str) -> Option<&'static str> {
    match encoder.to_ascii_lowercase().as_str() {
        "h264_amf" | "h264_nvenc" | "h264_qsv" | "h264_mf" => Some("h264"),
        "hevc_amf" | "hevc_nvenc" | "hevc_qsv" | "hevc_mf" => Some("hevc"),
        "av1_amf" | "av1_nvenc" | "av1_qsv" | "av1_mf" => Some("av1"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generic_h264_uses_windows_priority_order() {
        let parsed = ParsedVideoCodec::parse("h264").unwrap();
        assert_eq!(
            ffmpeg_encoder_candidates(parsed),
            vec!["h264_amf", "h264_nvenc", "h264_qsv", "h264_mf"]
        );
    }

    #[test]
    fn forced_nvenc_uses_only_nvenc() {
        let parsed = ParsedVideoCodec::parse("h264_nvenc").unwrap();
        assert_eq!(ffmpeg_encoder_candidates(parsed), vec!["h264_nvenc"]);
    }

    #[test]
    fn forced_mf_uses_only_mf() {
        let parsed = ParsedVideoCodec::parse("hevc_mf").unwrap();
        assert_eq!(ffmpeg_encoder_candidates(parsed), vec!["hevc_mf"]);
    }

    #[test]
    fn recognizes_supported_windows_encoder_names() {
        for encoder in [
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
        ] {
            assert!(is_windows_d3d11_ffmpeg_encoder(encoder), "{encoder}");
        }
    }

    #[test]
    fn maps_ffmpeg_encoder_names_to_backend_hints() {
        assert_eq!(
            backend_for_ffmpeg_encoder("h264_nvenc"),
            Some(WindowsD3D11EncoderBackend::Nvenc)
        );
        assert_eq!(
            backend_for_ffmpeg_encoder("hevc_amf"),
            Some(WindowsD3D11EncoderBackend::Amf)
        );
        assert_eq!(
            backend_for_ffmpeg_encoder("av1_qsv"),
            Some(WindowsD3D11EncoderBackend::Qsv)
        );
        assert_eq!(
            backend_for_ffmpeg_encoder("h264_mf"),
            Some(WindowsD3D11EncoderBackend::Mf)
        );
        assert_eq!(backend_for_ffmpeg_encoder("h264_vaapi"), None);
        assert_eq!(backend_for_ffmpeg_encoder("not_a_real_mf"), None);
        assert_eq!(backend_for_ffmpeg_encoder("h264_not_a_real_mf"), None);
    }

    #[test]
    fn selected_codec_label_only_accepts_supported_windows_encoder_names() {
        assert_eq!(selected_codec_label("h264_nvenc"), Some("h264"));
        assert_eq!(selected_codec_label("HEVC_MF"), Some("hevc"));
        assert_eq!(selected_codec_label("av1_qsv"), Some("av1"));
        assert_eq!(selected_codec_label("h264_vaapi"), None);
        assert_eq!(selected_codec_label("h264_not_a_real_mf"), None);
        assert_eq!(selected_codec_label("<unknown>"), None);
    }
}
