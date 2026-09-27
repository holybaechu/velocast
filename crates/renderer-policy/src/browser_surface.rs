use std::os::raw::c_int;

use velocast_protocol::RendererAcceleration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserSurfaceMode {
    Accelerated,
    Software,
}

impl BrowserSurfaceMode {
    pub fn initial_for_acceleration(acceleration: RendererAcceleration) -> Self {
        match acceleration {
            RendererAcceleration::Required | RendererAcceleration::Auto => {
                BrowserSurfaceMode::Accelerated
            }
            RendererAcceleration::Off => BrowserSurfaceMode::Software,
        }
    }

    pub fn can_retry_software(acceleration: RendererAcceleration) -> bool {
        acceleration == RendererAcceleration::Auto
    }

    pub fn shared_texture_enabled(self) -> c_int {
        match self {
            BrowserSurfaceMode::Accelerated => 1,
            BrowserSurfaceMode::Software => 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use velocast_protocol::RendererAcceleration;

    #[test]
    fn required_and_auto_start_with_accelerated_surface_mode() {
        assert_eq!(
            BrowserSurfaceMode::initial_for_acceleration(RendererAcceleration::Required),
            BrowserSurfaceMode::Accelerated
        );
        assert_eq!(
            BrowserSurfaceMode::initial_for_acceleration(RendererAcceleration::Auto),
            BrowserSurfaceMode::Accelerated
        );
    }

    #[test]
    fn off_uses_software_surface_mode() {
        assert_eq!(
            BrowserSurfaceMode::initial_for_acceleration(RendererAcceleration::Off),
            BrowserSurfaceMode::Software
        );
    }

    #[test]
    fn only_auto_can_retry_software_after_accelerated_start_failure() {
        assert!(BrowserSurfaceMode::can_retry_software(
            RendererAcceleration::Auto
        ));
        assert!(!BrowserSurfaceMode::can_retry_software(
            RendererAcceleration::Required
        ));
        assert!(!BrowserSurfaceMode::can_retry_software(
            RendererAcceleration::Off
        ));
    }

    #[test]
    fn shared_texture_flag_matches_surface_mode() {
        assert_eq!(BrowserSurfaceMode::Accelerated.shared_texture_enabled(), 1);
        assert_eq!(BrowserSurfaceMode::Software.shared_texture_enabled(), 0);
    }
}
