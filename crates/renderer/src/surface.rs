pub use crate::capture::windows_d3d11::WindowsD3D11Surface;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TextureSourceRect {
    pub left: u32,
    pub top: u32,
    pub width: u32,
    pub height: u32,
}

impl TextureSourceRect {
    pub fn full(width: u32, height: u32) -> Self {
        Self {
            left: 0,
            top: 0,
            width,
            height,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SurfaceFormat {
    Bgra,
    #[cfg(test)]
    Rgba,
    #[cfg(test)]
    Unknown,
}

impl SurfaceFormat {
    pub fn telemetry_label(self) -> &'static str {
        match self {
            SurfaceFormat::Bgra => "bgra",
            #[cfg(test)]
            SurfaceFormat::Rgba => "rgba",
            #[cfg(test)]
            SurfaceFormat::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapturedSurfaceMetadata {
    pub capture_backend: &'static str,
    pub surface_format_in: &'static str,
}

impl CapturedSurfaceMetadata {
    pub fn generic(capture_backend: &'static str, surface_format_in: &'static str) -> Self {
        Self {
            capture_backend,
            surface_format_in,
        }
    }

    #[cfg(test)]
    pub fn software_bgra() -> Self {
        Self::generic("electron_software_bgra", "bgra")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SoftwarePixelFormat {
    Bgra,
}

#[derive(Debug)]
pub enum PlatformSurface {
    WindowsD3D11(WindowsD3D11Surface),
}

impl PlatformSurface {
    #[cfg(test)]
    pub fn capture_backend_label(&self) -> &'static str {
        match self {
            PlatformSurface::WindowsD3D11(surface) => surface.owned_texture.capture_backend_label(),
        }
    }

    pub fn capture_metadata(&self, source_format: SurfaceFormat) -> CapturedSurfaceMetadata {
        match self {
            PlatformSurface::WindowsD3D11(surface) => CapturedSurfaceMetadata::generic(
                surface.owned_texture.capture_backend_label(),
                source_format.telemetry_label(),
            ),
        }
    }

    pub fn validate_for_capture_probe(&self) -> anyhow::Result<()> {
        match self {
            PlatformSurface::WindowsD3D11(_) => Ok(()),
        }
    }
}

#[derive(Debug)]
pub struct GpuSurfaceFrame {
    pub width: u32,
    pub height: u32,
    pub texture_width: u32,
    pub texture_height: u32,
    pub source_rect: TextureSourceRect,
    pub source_format: SurfaceFormat,
    pub platform_surface: PlatformSurface,
}

#[derive(Debug)]
pub struct SoftwareFrame {
    pub capture_backend: &'static str,
    pub width: u32,
    pub height: u32,
    pub pixel_format: SoftwarePixelFormat,
    pub pixels: Vec<u8>,
}

impl SoftwareFrame {
    pub fn capture_metadata(&self) -> CapturedSurfaceMetadata {
        CapturedSurfaceMetadata::generic(self.capture_backend, "bgra")
    }

    pub fn validate(&self) -> anyhow::Result<()> {
        match self.pixel_format {
            SoftwarePixelFormat::Bgra => {}
        }
        let expected = self
            .width
            .checked_mul(self.height)
            .and_then(|pixels| pixels.checked_mul(4))
            .map(|bytes| bytes as usize)
            .ok_or_else(|| anyhow::anyhow!("software frame dimensions overflow"))?;
        if self.pixels.len() != expected {
            return Err(anyhow::anyhow!(
                "BGRA frame length {} did not match expected {}",
                self.pixels.len(),
                expected
            ));
        }
        Ok(())
    }
}

#[derive(Debug)]
pub enum CapturedFrame {
    GpuSurface(GpuSurfaceFrame),
    BgraSoftware(SoftwareFrame),
}

impl CapturedFrame {
    pub fn capture_metadata(&self) -> CapturedSurfaceMetadata {
        match self {
            CapturedFrame::GpuSurface(frame) => {
                frame.platform_surface.capture_metadata(frame.source_format)
            }
            CapturedFrame::BgraSoftware(frame) => frame.capture_metadata(),
        }
    }

    #[cfg(test)]
    pub fn capture_backend_label(&self) -> &'static str {
        match self {
            CapturedFrame::GpuSurface(frame) => frame.platform_surface.capture_backend_label(),
            CapturedFrame::BgraSoftware(frame) => frame.capture_backend,
        }
    }

    #[cfg(test)]
    pub fn surface_format_label(&self) -> &'static str {
        match self {
            CapturedFrame::GpuSurface(frame) => frame.source_format.telemetry_label(),
            CapturedFrame::BgraSoftware(_) => "bgra",
        }
    }

    pub fn into_bgra(self) -> anyhow::Result<Vec<u8>> {
        match self {
            CapturedFrame::BgraSoftware(frame) => {
                frame.validate()?;
                Ok(frame.pixels)
            }
            CapturedFrame::GpuSurface(frame) => match frame.platform_surface {
                PlatformSurface::WindowsD3D11(_) => {
                    Err(anyhow::anyhow!("capture.accelerated_readback_unavailable"))
                }
            },
        }
    }

    pub fn into_bgra_with_telemetry(
        self,
        telemetry: &mut crate::telemetry::RenderTelemetry,
    ) -> anyhow::Result<Vec<u8>> {
        if matches!(self, CapturedFrame::GpuSurface(_)) {
            telemetry.cpu_readback_frames += 1;
        }
        self.into_bgra()
    }
}

#[cfg(test)]
mod portability_structure_tests {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn surface_format_reports_telemetry_labels() {
        assert_eq!(SurfaceFormat::Bgra.telemetry_label(), "bgra");
        assert_eq!(SurfaceFormat::Rgba.telemetry_label(), "rgba");
        assert_eq!(SurfaceFormat::Unknown.telemetry_label(), "unknown");
    }

    #[test]
    fn gpu_surface_reports_windows_d3d11_labels() {
        let surface = PlatformSurface::WindowsD3D11(WindowsD3D11Surface {
            owned_texture: crate::capture::windows_d3d11::OwnedTextureLease::borrowed_for_test(42),
        });
        let frame = CapturedFrame::GpuSurface(GpuSurfaceFrame {
            width: 1920,
            height: 1080,
            texture_width: 1920,
            texture_height: 1080,
            source_rect: TextureSourceRect::full(1920, 1080),
            source_format: SurfaceFormat::Bgra,
            platform_surface: surface,
        });

        assert_eq!(
            frame.capture_backend_label(),
            "electron_d3d11_shared_texture"
        );
        assert_eq!(frame.surface_format_label(), "bgra");
        assert_eq!(
            frame.capture_metadata(),
            CapturedSurfaceMetadata::generic("electron_d3d11_shared_texture", "bgra")
        );
    }

    #[test]
    fn software_frame_reports_electron_software_bgra() {
        let frame = CapturedFrame::BgraSoftware(SoftwareFrame {
            capture_backend: "electron_software_bgra",
            width: 2,
            height: 1,
            pixel_format: SoftwarePixelFormat::Bgra,
            pixels: vec![0, 1, 2, 3, 4, 5, 6, 7],
        });

        assert_eq!(frame.capture_backend_label(), "electron_software_bgra");
        assert_eq!(frame.surface_format_label(), "bgra");
        assert_eq!(
            frame.capture_metadata(),
            CapturedSurfaceMetadata::software_bgra()
        );
    }

    #[test]
    fn software_frame_validates_bgra_length() {
        let frame = SoftwareFrame {
            capture_backend: "electron_software_bgra",
            width: 2,
            height: 2,
            pixel_format: SoftwarePixelFormat::Bgra,
            pixels: vec![0; 15],
        };

        let error = frame.validate().unwrap_err();

        assert!(error
            .to_string()
            .contains("BGRA frame length 15 did not match expected 16"));
    }

    #[test]
    fn software_frame_validate_reports_dimension_overflow() {
        let frame = SoftwareFrame {
            capture_backend: "electron_software_bgra",
            width: u32::MAX,
            height: 2,
            pixel_format: SoftwarePixelFormat::Bgra,
            pixels: Vec::new(),
        };

        let error = frame.validate().unwrap_err();

        assert!(error
            .to_string()
            .contains("software frame dimensions overflow"));
    }

    #[test]
    fn gpu_surface_readback_attempt_increments_cpu_readback_telemetry() {
        let frame = CapturedFrame::GpuSurface(GpuSurfaceFrame {
            width: 2,
            height: 2,
            texture_width: 2,
            texture_height: 2,
            source_rect: TextureSourceRect::full(2, 2),
            source_format: SurfaceFormat::Bgra,
            platform_surface: PlatformSurface::WindowsD3D11(WindowsD3D11Surface {
                owned_texture: crate::capture::windows_d3d11::OwnedTextureLease::borrowed_for_test(
                    0,
                ),
            }),
        });
        let mut telemetry =
            crate::telemetry::RenderTelemetry::new(crate::telemetry::RenderModeLabel::ReferenceGpu);
        telemetry.cpu_readback_frames = 7;

        let error = frame.into_bgra_with_telemetry(&mut telemetry).unwrap_err();

        assert!(error
            .to_string()
            .contains("capture.accelerated_readback_unavailable"));
        assert_eq!(telemetry.cpu_readback_frames, 8);
    }
}
