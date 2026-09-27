//! One immutable conversion choice per encoder. Planning may resolve the same
//! choice without constructing a device; metadata never re-reads environment.
use super::shader_converter::ShaderMode;
use crate::encode::codec::RequestedVideoCodec;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ConversionMode {
    VideoProcessorStudio,
    VideoProcessorFull,
    Shader(ShaderMode),
}
impl ConversionMode {
    pub(crate) fn resolve(codec: &str, selector: Option<&str>) -> anyhow::Result<Self> {
        let codec = RequestedVideoCodec::parse(codec)?;
        let mode = match selector {
            None if codec == RequestedVideoCodec::H264 => Self::Shader(ShaderMode::Bt601FullCenter),
            None => Self::VideoProcessorStudio,
            Some("video-processor-bt709-studio") => Self::VideoProcessorStudio,
            Some("video-processor-bt709-full") => Self::VideoProcessorFull,
            Some(value) => Self::Shader(ShaderMode::from_selector(value).ok_or_else(|| {
                anyhow::anyhow!("unknown VELOCAST_EXPERIMENTAL_D3D11_CONVERTER selector: {value:?}")
            })?),
        };
        anyhow::ensure!(
            mode.shader_mode().is_none() || codec == RequestedVideoCodec::H264,
            "centered D3D11 shader conversion supports H264 only; requested {}",
            codec.canonical_label()
        );
        Ok(mode)
    }
    pub(crate) fn from_environment(codec: &str) -> anyhow::Result<Self> {
        let selector = match std::env::var("VELOCAST_EXPERIMENTAL_D3D11_CONVERTER") {
            Ok(value) => Some(value),
            Err(std::env::VarError::NotPresent) => None,
            Err(std::env::VarError::NotUnicode(_)) => {
                anyhow::bail!("VELOCAST_EXPERIMENTAL_D3D11_CONVERTER must be Unicode")
            }
        };
        Self::resolve(codec, selector.as_deref())
    }
    pub(crate) fn shader_mode(self) -> Option<ShaderMode> {
        match self {
            Self::Shader(mode) => Some(mode),
            _ => None,
        }
    }
    pub(crate) fn full_range(self) -> bool {
        self == Self::VideoProcessorFull || self.shader_mode().is_some_and(ShaderMode::full_range)
    }
    pub(crate) fn bt601(self) -> bool {
        self == Self::Shader(ShaderMode::Bt601FullCenter)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_h264_aliases_select_accepted_shader() {
        for codec in [
            "h264",
            "libx264",
            "H264",
            "h264_mf",
            "h264_nvenc",
            "h264_qsv",
            "h264_amf",
        ] {
            let mode = ConversionMode::resolve(codec, None).unwrap();
            assert_eq!(mode, ConversionMode::Shader(ShaderMode::Bt601FullCenter));
            assert!(mode.full_range() && mode.bt601());
        }
    }
    #[test]
    fn default_other_codecs_preserve_studio_video_processor() {
        for codec in [
            "hevc",
            "h265",
            "libx265",
            "hevc_mf",
            "av1",
            "av1_nvenc",
            "libsvtav1",
        ] {
            let mode = ConversionMode::resolve(codec, None).unwrap();
            assert_eq!(mode, ConversionMode::VideoProcessorStudio);
            assert!(!mode.full_range() && !mode.bt601());
        }
    }
    #[test]
    fn explicit_replay_modes_override_default() {
        for (selector, expected) in [
            (
                "video-processor-bt709-studio",
                ConversionMode::VideoProcessorStudio,
            ),
            (
                "video-processor-bt709-full",
                ConversionMode::VideoProcessorFull,
            ),
            (
                "shader-bt709-studio-center",
                ConversionMode::Shader(ShaderMode::Bt709StudioCenter),
            ),
            (
                "shader-bt601-full-center",
                ConversionMode::Shader(ShaderMode::Bt601FullCenter),
            ),
        ] {
            assert_eq!(
                ConversionMode::resolve("h264", Some(selector)).unwrap(),
                expected
            );
        }
        let full = ConversionMode::resolve("hevc", Some("video-processor-bt709-full")).unwrap();
        assert!(full.full_range() && !full.bt601() && full.shader_mode().is_none());
    }
    #[test]
    fn invalid_selector_and_non_h264_shader_fail_before_device_creation() {
        for selector in ["", "unknown", "shader-bt601-full-centre"] {
            assert!(ConversionMode::resolve("h264", Some(selector))
                .unwrap_err()
                .to_string()
                .contains("unknown VELOCAST"));
        }
        for codec in ["hevc", "av1"] {
            for selector in ["shader-bt601-full-center", "shader-bt709-studio-center"] {
                assert!(ConversionMode::resolve(codec, Some(selector))
                    .unwrap_err()
                    .to_string()
                    .contains("H264 only"));
            }
        }
        assert!(ConversionMode::resolve("unsupported", None).is_err());
    }
}
