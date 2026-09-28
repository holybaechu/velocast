#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestedVideoCodec {
    H264,
    Hevc,
    Av1,
}
impl RequestedVideoCodec {
    pub fn parse(value: &str) -> anyhow::Result<Self> {
        match value.to_ascii_lowercase().as_str(){
        "h264"=>Ok(Self::H264),"hevc"|"h265"=>Ok(Self::Hevc),"av1"=>Ok(Self::Av1),
        _=>anyhow::bail!("encoder.codec_unsupported: use a logical h264, hevc, or av1 codec; native encoder names are no longer supported"),
    }
    }
    pub fn canonical_label(self) -> &'static str {
        match self {
            Self::H264 => "h264",
            Self::Hevc => "hevc",
            Self::Av1 => "av1",
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
