mod owned_texture;

pub(crate) use owned_texture::OwnedTextureLease;
#[cfg(windows)]
pub(crate) use owned_texture::{create_d3d11_device, OwnedTexturePool};

#[derive(Debug)]
pub struct WindowsD3D11Surface {
    pub owned_texture: OwnedTextureLease,
}
