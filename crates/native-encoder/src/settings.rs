use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub output: String,
    pub codec: String,
    pub bitrate_bps: Option<u64>,
    pub expected_frames: Option<u64>,
}

impl Config {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            (2..=16384).contains(&self.width) && self.width % 2 == 0,
            "NV12 width must be even and between 2 and 16384"
        );
        ensure!(
            (2..=16384).contains(&self.height) && self.height % 2 == 0,
            "NV12 height must be even and between 2 and 16384"
        );
        ensure!(
            (1..=240).contains(&self.fps),
            "fps must be between 1 and 240"
        );
        ensure!(
            self.codec == "h264",
            "native NV12 encoder supports only h264"
        );
        ensure!(
            std::path::Path::new(&self.output).is_absolute() && !self.output.contains('\0'),
            "output must be an absolute local path"
        );
        ensure!(
            self.bitrate_bps
                .is_none_or(|v| (1..=i32::MAX as u64).contains(&v)),
            "invalid bitrateBps"
        );
        ensure!(
            self.expected_frames != Some(0),
            "expectedFrames must be positive"
        );
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ColorSpace {
    pub primaries: String,
    pub transfer: String,
    pub matrix: String,
    pub range: String,
}

impl ColorSpace {
    pub fn rec709() -> Self {
        Self {
            primaries: "bt709".into(),
            transfer: "bt709".into(),
            matrix: "bt709".into(),
            range: "limited".into(),
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rect {
    pub left: u32,
    pub top: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Frame {
    pub handle: String,
    pub texture_width: u32,
    pub texture_height: u32,
    pub source_rect: Rect,
    pub width: u32,
    pub height: u32,
    pub pixel_format: String,
    pub frame: u64,
    pub pts: i64,
    pub color_space: ColorSpace,
}

impl Frame {
    pub fn handle_value(&self) -> Result<usize> {
        let text = self
            .handle
            .strip_prefix("0x")
            .ok_or_else(|| anyhow::anyhow!("handle must be hexadecimal with 0x prefix"))?;
        let value = usize::from_str_radix(text, 16)?;
        ensure!(
            value != 0 && value != usize::MAX,
            "invalid NT texture handle"
        );
        Ok(value)
    }
    pub fn validate(&self, config: &Config, next_pts: u64, last_frame: Option<u64>) -> Result<()> {
        self.handle_value()?;
        ensure!(
            self.pixel_format == "nv12",
            "only native NV12 textures are accepted"
        );
        ensure!(
            self.color_space == ColorSpace::rec709(),
            "NV12 colorSpace must be BT709 primaries/transfer/matrix and limited range"
        );
        ensure!(
            self.width == config.width && self.height == config.height,
            "frame dimensions changed"
        );
        ensure!(
            self.texture_width > 0
                && self.texture_height > 0
                && self.texture_width <= 16384
                && self.texture_height <= 16384
                && self.texture_width % 2 == 0
                && self.texture_height % 2 == 0,
            "invalid NV12 texture dimensions"
        );
        let r = &self.source_rect;
        ensure!(
            r.width == self.width && r.height == self.height && r.left % 2 == 0 && r.top % 2 == 0,
            "NV12 source rectangle must be chroma aligned without scaling"
        );
        ensure!(
            r.left
                .checked_add(r.width)
                .is_some_and(|v| v <= self.texture_width)
                && r.top
                    .checked_add(r.height)
                    .is_some_and(|v| v <= self.texture_height),
            "source rectangle outside texture"
        );
        ensure!(
            self.pts >= 0 && self.pts as u64 == next_pts,
            "pts must start at zero and be consecutive"
        );
        ensure!(
            last_frame.is_none_or(|v| self.frame > v),
            "source frame numbers must increase"
        );
        ensure!(
            config.expected_frames.is_none_or(|v| next_pts < v),
            "too many frames"
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Config {
        Config {
            width: 1920,
            height: 1080,
            fps: 60,
            output: std::env::temp_dir()
                .join("validation.mp4")
                .to_string_lossy()
                .into_owned(),
            codec: "h264".into(),
            bitrate_bps: None,
            expected_frames: Some(2),
        }
    }
    fn frame() -> Frame {
        Frame {
            handle: "0x1234".into(),
            texture_width: 1920,
            texture_height: 1080,
            source_rect: Rect {
                left: 0,
                top: 0,
                width: 1920,
                height: 1080,
            },
            width: 1920,
            height: 1080,
            pixel_format: "nv12".into(),
            frame: 10,
            pts: 0,
            color_space: ColorSpace::rec709(),
        }
    }
    #[test]
    fn validates_color_geometry_and_timeline() {
        let c = config();
        c.validate().unwrap();
        frame().validate(&c, 0, None).unwrap();
        let mut f = frame();
        f.color_space.range = "full".into();
        assert!(f.validate(&c, 0, None).is_err());
        let mut f = frame();
        f.source_rect.left = 1;
        assert!(f.validate(&c, 0, None).is_err());
        let mut f = frame();
        f.source_rect.left = u32::MAX - 1;
        assert!(f.validate(&c, 0, None).is_err());
        assert!(frame().validate(&c, 1, None).is_err());
        assert!(frame().validate(&c, 0, Some(10)).is_err());
    }
    #[test]
    fn rejects_invalid_config_and_handles() {
        let mut c = config();
        c.width = 1919;
        assert!(c.validate().is_err());
        for handle in ["0x0", "1234", "0xffffffffffffffff", "0xgarbage"] {
            let mut f = frame();
            f.handle = handle.into();
            assert!(f.handle_value().is_err());
        }
    }
}
