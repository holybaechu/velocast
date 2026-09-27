#[cfg(windows)]
mod backend;
#[cfg(windows)]
mod converter;
#[cfg(windows)]
mod conversion_mode;
#[cfg(windows)]
mod device;
#[cfg(windows)]
mod frames;
#[cfg(windows)]
mod metadata_bsf;
#[cfg(windows)]
mod shader_converter;

#[cfg(windows)]
pub(crate) use backend::D3D11FfmpegHardwareEncoder;
#[cfg(windows)]
pub(crate) use device::initialize_com_for_d3d11_encoding;

#[cfg(not(windows))]
pub(crate) fn initialize_com_for_d3d11_encoding() -> anyhow::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn d3d11_spawn_for_backend_filters_candidate_list() {
        let source = include_str!("d3d11/backend.rs");

        assert!(source
            .contains("selected_backend: Option<crate::pipeline::backend_registry::BackendKind>"));
        assert!(source.contains("d3d11_encoder_candidates_for_backend"));
        assert!(source.contains("BackendKind::WindowsD3D11Nvenc"));
        assert!(source.contains("codecs::forced_candidate(parsed.codec, backend)"));
    }
}
