#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestedVideoCodec {
    H264,
    Hevc,
    Av1,
    Vp8,
    Vp9,
    ProRes,
}
impl RequestedVideoCodec {
    pub fn parse(value: &str) -> anyhow::Result<Self> {
        match value.to_ascii_lowercase().as_str() {
            "h264" => Ok(Self::H264),
            "hevc" | "h265" => Ok(Self::Hevc),
            "av1" => Ok(Self::Av1),
            "vp8" => Ok(Self::Vp8),
            "vp9" => Ok(Self::Vp9),
            "prores" => Ok(Self::ProRes),
            _ => {
                anyhow::bail!("encoder.codec_unsupported: use h264, hevc, av1, vp8, vp9, or prores")
            }
        }
    }
    pub fn canonical_label(self) -> &'static str {
        match self {
            Self::H264 => "h264",
            Self::Hevc => "hevc",
            Self::Av1 => "av1",
            Self::Vp8 => "vp8",
            Self::Vp9 => "vp9",
            Self::ProRes => "prores",
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn logical_codec_selection() {
        assert_eq!(
            RequestedVideoCodec::parse("h265").unwrap(),
            RequestedVideoCodec::Hevc
        );
        assert!(RequestedVideoCodec::parse("vendor_encoder").is_err());
    }
}
