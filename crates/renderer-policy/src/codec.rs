#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestedVideoCodec {
    H264,
    Hevc,
    Av1,
}

impl RequestedVideoCodec {
    pub fn parse(value: &str) -> anyhow::Result<Self> {
        ParsedVideoCodec::parse(value).map(|parsed| parsed.codec)
    }

    #[allow(dead_code)]
    pub fn canonical_label(self) -> &'static str {
        match self {
            Self::H264 => "h264",
            Self::Hevc => "hevc",
            Self::Av1 => "av1",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowsD3D11EncoderBackend {
    Amf,
    Nvenc,
    Qsv,
    Mf,
}

#[allow(dead_code)]
impl WindowsD3D11EncoderBackend {
    pub fn telemetry_label(self) -> &'static str {
        match self {
            Self::Amf => "windows_d3d11_amf",
            Self::Nvenc => "windows_d3d11_nvenc",
            Self::Qsv => "windows_d3d11_qsv",
            Self::Mf => "windows_d3d11_mf",
        }
    }

    pub fn suffix(self) -> &'static str {
        match self {
            Self::Amf => "amf",
            Self::Nvenc => "nvenc",
            Self::Qsv => "qsv",
            Self::Mf => "mf",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestedEncoderBackend {
    Auto,
    WindowsD3D11(WindowsD3D11EncoderBackend),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParsedVideoCodec {
    pub codec: RequestedVideoCodec,
    pub backend: RequestedEncoderBackend,
}

impl ParsedVideoCodec {
    pub fn parse(value: &str) -> anyhow::Result<Self> {
        let value = value.to_ascii_lowercase();
        let parsed = match value.as_str() {
            "h264" | "libx264" => Self {
                codec: RequestedVideoCodec::H264,
                backend: RequestedEncoderBackend::Auto,
            },
            "hevc" | "h265" | "libx265" => Self {
                codec: RequestedVideoCodec::Hevc,
                backend: RequestedEncoderBackend::Auto,
            },
            "av1" | "libaom-av1" | "libsvtav1" => Self {
                codec: RequestedVideoCodec::Av1,
                backend: RequestedEncoderBackend::Auto,
            },
            "h264_amf" => Self {
                codec: RequestedVideoCodec::H264,
                backend: RequestedEncoderBackend::WindowsD3D11(WindowsD3D11EncoderBackend::Amf),
            },
            "h264_nvenc" => Self {
                codec: RequestedVideoCodec::H264,
                backend: RequestedEncoderBackend::WindowsD3D11(WindowsD3D11EncoderBackend::Nvenc),
            },
            "h264_qsv" => Self {
                codec: RequestedVideoCodec::H264,
                backend: RequestedEncoderBackend::WindowsD3D11(WindowsD3D11EncoderBackend::Qsv),
            },
            "h264_mf" => Self {
                codec: RequestedVideoCodec::H264,
                backend: RequestedEncoderBackend::WindowsD3D11(WindowsD3D11EncoderBackend::Mf),
            },
            "hevc_amf" => Self {
                codec: RequestedVideoCodec::Hevc,
                backend: RequestedEncoderBackend::WindowsD3D11(WindowsD3D11EncoderBackend::Amf),
            },
            "hevc_nvenc" => Self {
                codec: RequestedVideoCodec::Hevc,
                backend: RequestedEncoderBackend::WindowsD3D11(WindowsD3D11EncoderBackend::Nvenc),
            },
            "hevc_qsv" => Self {
                codec: RequestedVideoCodec::Hevc,
                backend: RequestedEncoderBackend::WindowsD3D11(WindowsD3D11EncoderBackend::Qsv),
            },
            "hevc_mf" => Self {
                codec: RequestedVideoCodec::Hevc,
                backend: RequestedEncoderBackend::WindowsD3D11(WindowsD3D11EncoderBackend::Mf),
            },
            "av1_amf" => Self {
                codec: RequestedVideoCodec::Av1,
                backend: RequestedEncoderBackend::WindowsD3D11(WindowsD3D11EncoderBackend::Amf),
            },
            "av1_nvenc" => Self {
                codec: RequestedVideoCodec::Av1,
                backend: RequestedEncoderBackend::WindowsD3D11(WindowsD3D11EncoderBackend::Nvenc),
            },
            "av1_qsv" => Self {
                codec: RequestedVideoCodec::Av1,
                backend: RequestedEncoderBackend::WindowsD3D11(WindowsD3D11EncoderBackend::Qsv),
            },
            "av1_mf" => Self {
                codec: RequestedVideoCodec::Av1,
                backend: RequestedEncoderBackend::WindowsD3D11(WindowsD3D11EncoderBackend::Mf),
            },
            other => {
                return Err(anyhow::anyhow!(
                    "encoder.codec_unavailable: unsupported video codec {other}"
                ))
            }
        };
        Ok(parsed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_generic_codecs_as_auto_backend() {
        let parsed = ParsedVideoCodec::parse("h264").unwrap();
        assert_eq!(parsed.codec, RequestedVideoCodec::H264);
        assert_eq!(parsed.backend, RequestedEncoderBackend::Auto);

        let parsed = ParsedVideoCodec::parse("hevc").unwrap();
        assert_eq!(parsed.codec, RequestedVideoCodec::Hevc);
        assert_eq!(parsed.backend, RequestedEncoderBackend::Auto);

        let parsed = ParsedVideoCodec::parse("av1").unwrap();
        assert_eq!(parsed.codec, RequestedVideoCodec::Av1);
        assert_eq!(parsed.backend, RequestedEncoderBackend::Auto);
    }

    #[test]
    fn parses_windows_forced_encoder_names_as_backend_hints() {
        let parsed = ParsedVideoCodec::parse("h264_nvenc").unwrap();
        assert_eq!(parsed.codec, RequestedVideoCodec::H264);
        assert_eq!(
            parsed.backend,
            RequestedEncoderBackend::WindowsD3D11(WindowsD3D11EncoderBackend::Nvenc)
        );

        let parsed = ParsedVideoCodec::parse("hevc_amf").unwrap();
        assert_eq!(parsed.codec, RequestedVideoCodec::Hevc);
        assert_eq!(
            parsed.backend,
            RequestedEncoderBackend::WindowsD3D11(WindowsD3D11EncoderBackend::Amf)
        );

        let parsed = ParsedVideoCodec::parse("av1_qsv").unwrap();
        assert_eq!(parsed.codec, RequestedVideoCodec::Av1);
        assert_eq!(
            parsed.backend,
            RequestedEncoderBackend::WindowsD3D11(WindowsD3D11EncoderBackend::Qsv)
        );

        let parsed = ParsedVideoCodec::parse("h264_mf").unwrap();
        assert_eq!(parsed.codec, RequestedVideoCodec::H264);
        assert_eq!(
            parsed.backend,
            RequestedEncoderBackend::WindowsD3D11(WindowsD3D11EncoderBackend::Mf)
        );
    }

    #[test]
    fn existing_codec_parse_preserves_family_only_behavior() {
        assert_eq!(
            RequestedVideoCodec::parse("h264_nvenc").unwrap(),
            RequestedVideoCodec::H264
        );
        assert_eq!(
            RequestedVideoCodec::parse("hevc_qsv").unwrap(),
            RequestedVideoCodec::Hevc
        );
        assert_eq!(
            RequestedVideoCodec::parse("av1_mf").unwrap(),
            RequestedVideoCodec::Av1
        );
    }

    #[test]
    fn maps_user_codec_names_to_hardware_codecs() {
        assert_eq!(
            RequestedVideoCodec::parse("h264").unwrap(),
            RequestedVideoCodec::H264
        );
        assert_eq!(
            RequestedVideoCodec::parse("libx264").unwrap(),
            RequestedVideoCodec::H264
        );
        assert_eq!(
            RequestedVideoCodec::parse("hevc").unwrap(),
            RequestedVideoCodec::Hevc
        );
        assert_eq!(
            RequestedVideoCodec::parse("h265").unwrap(),
            RequestedVideoCodec::Hevc
        );
        assert_eq!(
            RequestedVideoCodec::parse("av1").unwrap(),
            RequestedVideoCodec::Av1
        );
    }

    #[test]
    fn retired_vaapi_aliases_are_rejected() {
        for codec in ["h264_vaapi", "hevc_vaapi", "av1_vaapi"] {
            assert!(ParsedVideoCodec::parse(codec)
                .unwrap_err()
                .to_string()
                .contains("encoder.codec_unavailable"));
        }
    }
}
