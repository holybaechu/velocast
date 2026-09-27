// GPU-only conversion. H264 defaults to rounded full-range BT.601.
// DXGI NV12 exposes R8_UNORM luma and R8G8_UNORM chroma RTVs; creation is
// deliberately fallible because support still depends on the actual device.
use super::frames::{validate_source_rect, OwnedFrame};
use crate::surface::TextureSourceRect;
use anyhow::{ensure, Context};
use windows::core::{s, Interface, PCSTR};
use windows::Win32::Graphics::Direct3D::{Fxc::*, ID3DBlob, D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;

const SHADER: &str = include_str!("shader_converter.hlsl");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ShaderMode {
    Bt709StudioCenter,
    Bt601FullCenter,
}
impl ShaderMode {
    pub(crate) fn from_selector(value: &str) -> Option<Self> {
        match value {
            "shader-bt709-studio-center" => Some(Self::Bt709StudioCenter),
            "shader-bt601-full-center" => Some(Self::Bt601FullCenter),
            _ => None,
        }
    }
    pub(crate) fn full_range(self) -> bool {
        self == Self::Bt601FullCenter
    }
}
pub(crate) struct ShaderConverter {
    mode: ShaderMode,
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    width: u32,
    height: u32,
    // One GPU-only crop/copy texture per encoder, independent of frame count.
    // Copying also removes assumptions about capture texture SRV bind flags.
    input: ID3D11Texture2D,
    input_view: ID3D11ShaderResourceView,
    vertex: ID3D11VertexShader,
    luma: ID3D11PixelShader,
    chroma: ID3D11PixelShader,
    rasterizer: ID3D11RasterizerState,
}

impl ShaderConverter {
    pub(crate) unsafe fn new(
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        width: u32,
        height: u32,
        mode: ShaderMode,
    ) -> anyhow::Result<Self> {
        let desc = input_description(width, height)?;
        let mut input = None;
        device
            .CreateTexture2D(&desc, None, Some(&mut input))
            .context("shader converter GPU copy allocation failed")?;
        let input = input.context("shader converter GPU copy was null")?;
        let mut input_view = None;
        device
            .CreateShaderResourceView(&input, None, Some(&mut input_view))
            .context("shader converter BGRA SRV creation failed")?;
        let input_view = input_view.context("shader converter SRV was null")?;
        let vertex_code = compile(s!("vs_main"), s!("vs_5_0"))?;
        let mut vertex = None;
        device
            .CreateVertexShader(blob_bytes(&vertex_code), None, Some(&mut vertex))
            .context("shader converter vertex shader creation failed")?;
        let luma = create_pixel_shader(
            device,
            if mode.full_range() {
                s!("ps_luma_601_full")
            } else {
                s!("ps_luma")
            },
        )?;
        let chroma = create_pixel_shader(
            device,
            if mode.full_range() {
                s!("ps_chroma_601_full")
            } else {
                s!("ps_chroma")
            },
        )?;
        let mut rasterizer = None;
        device
            .CreateRasterizerState(
                &D3D11_RASTERIZER_DESC {
                    FillMode: D3D11_FILL_SOLID,
                    CullMode: D3D11_CULL_NONE,
                    DepthClipEnable: true.into(),
                    ..Default::default()
                },
                Some(&mut rasterizer),
            )
            .context("shader converter rasterizer creation failed")?;
        tracing::info!(
            ?mode,
            "D3D11 shader conversion selected; rounded centered 2x2 chroma"
        );
        Ok(Self {
            mode,
            device: device.clone(),
            context: context.clone(),
            width,
            height,
            input,
            input_view,
            vertex: vertex.context("shader converter vertex shader was null")?,
            luma,
            chroma,
            rasterizer: rasterizer.context("shader converter rasterizer was null")?,
        })
    }

    pub(crate) fn mode(&self) -> ShaderMode {
        self.mode
    }

    pub(crate) unsafe fn convert(
        &self,
        source: &ID3D11Texture2D,
        rect: TextureSourceRect,
        frame: &OwnedFrame,
    ) -> anyhow::Result<()> {
        let mut source_desc = D3D11_TEXTURE2D_DESC::default();
        source.GetDesc(&mut source_desc);
        validate_source_rect(source_desc.Width, source_desc.Height, rect)?;
        validate_input(&source_desc, rect, self.width, self.height)?;
        ensure!(
            source.GetDevice()?.as_raw() == self.device.as_raw(),
            "shader converter source belongs to another D3D11 device"
        );
        let destination = frame.d3d11_texture()?;
        ensure!(
            destination.GetDevice()?.as_raw() == self.device.as_raw(),
            "shader converter destination belongs to another D3D11 device"
        );
        let slice = frame.d3d11_texture_index()?;
        let mut destination_desc = D3D11_TEXTURE2D_DESC::default();
        destination.GetDesc(&mut destination_desc);
        validate_destination(&destination_desc, slice, self.width, self.height)?;
        // Create both views before touching pipeline state. Views own resource
        // references until submission; no raw-pointer cache or unbounded pool.
        let y = self.plane_view(&destination, &destination_desc, slice, DXGI_FORMAT_R8_UNORM)?;
        let uv = self.plane_view(
            &destination,
            &destination_desc,
            slice,
            DXGI_FORMAT_R8G8_UNORM,
        )?;
        let source_box = D3D11_BOX {
            left: rect.left,
            top: rect.top,
            front: 0,
            right: rect.left + rect.width,
            bottom: rect.top + rect.height,
            back: 1,
        };
        self.context
            .CopySubresourceRegion(&self.input, 0, 0, 0, 0, source, 0, Some(&source_box));
        // This encoder owns its immediate context. Establish all state used by
        // the passes, then unbind resources before handing NV12 to the encoder.
        self.context.IASetInputLayout(None);
        self.context
            .IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        self.context.VSSetShader(&self.vertex, None);
        self.context.GSSetShader(None, None);
        self.context.HSSetShader(None, None);
        self.context.DSSetShader(None, None);
        self.context.RSSetState(&self.rasterizer);
        self.context.OMSetBlendState(None, None, u32::MAX);
        self.context.OMSetDepthStencilState(None, 0);
        self.context
            .PSSetShaderResources(0, Some(&[Some(self.input_view.clone())]));
        self.draw_plane(&y, &self.luma, self.width, self.height);
        self.draw_plane(&uv, &self.chroma, self.width / 2, self.height / 2);
        self.context.OMSetRenderTargets(None, None);
        self.context.PSSetShaderResources(0, Some(&[None]));
        self.context.PSSetShader(None, None);
        self.context.VSSetShader(None, None);
        self.context.RSSetState(None);
        self.device
            .GetDeviceRemovedReason()
            .context("shader converter device removed after GPU submission")
    }

    unsafe fn plane_view(
        &self,
        texture: &ID3D11Texture2D,
        desc: &D3D11_TEXTURE2D_DESC,
        slice: u32,
        format: DXGI_FORMAT,
    ) -> anyhow::Result<ID3D11RenderTargetView> {
        let view_desc = plane_description(desc.ArraySize, slice, format)?;
        let mut view = None;
        self.device.CreateRenderTargetView(texture, Some(&view_desc), Some(&mut view))
            .with_context(|| format!("NV12 shader plane RTV unsupported: format {format:?}, array slice {slice}"))?;
        view.context("shader converter NV12 plane RTV was null")
    }

    unsafe fn draw_plane(
        &self,
        view: &ID3D11RenderTargetView,
        shader: &ID3D11PixelShader,
        width: u32,
        height: u32,
    ) {
        self.context
            .OMSetRenderTargets(Some(&[Some(view.clone())]), None);
        self.context.RSSetViewports(Some(&[D3D11_VIEWPORT {
            Width: width as f32,
            Height: height as f32,
            MinDepth: 0.0,
            MaxDepth: 1.0,
            ..Default::default()
        }]));
        self.context.PSSetShader(shader, None);
        self.context.Draw(3, 0);
    }
}

fn input_description(width: u32, height: u32) -> anyhow::Result<D3D11_TEXTURE2D_DESC> {
    ensure!(
        width > 0
            && height > 0
            && width % 2 == 0
            && height % 2 == 0
            && width <= 16384
            && height <= 16384,
        "shader NV12 converter requires even nonzero dimensions <= 16384"
    );
    Ok(D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    })
}

fn validate_input(
    desc: &D3D11_TEXTURE2D_DESC,
    rect: TextureSourceRect,
    width: u32,
    height: u32,
) -> anyhow::Result<()> {
    ensure!(
        matches!(
            desc.Format,
            DXGI_FORMAT_B8G8R8A8_UNORM
                | DXGI_FORMAT_B8G8R8A8_TYPELESS
                | DXGI_FORMAT_B8G8R8A8_UNORM_SRGB
        ),
        "shader converter requires BGRA8 source"
    );
    ensure!(
        desc.ArraySize == 1
            && desc.MipLevels == 1
            && desc.SampleDesc.Count == 1
            && desc.SampleDesc.Quality == 0,
        "shader converter requires non-MSAA single-mip single-slice source"
    );
    ensure!(
        rect.width == width && rect.height == height,
        "shader converter does not scale source crops"
    );
    Ok(())
}

fn validate_destination(
    desc: &D3D11_TEXTURE2D_DESC,
    slice: u32,
    width: u32,
    height: u32,
) -> anyhow::Result<()> {
    ensure!(
        desc.Format == DXGI_FORMAT_NV12
            && desc.Width == width
            && desc.Height == height
            && width % 2 == 0
            && height % 2 == 0,
        "shader converter encoder frame format/geometry mismatch"
    );
    ensure!(
        slice < desc.ArraySize
            && desc.MipLevels == 1
            && desc.SampleDesc.Count == 1
            && desc.SampleDesc.Quality == 0,
        "shader converter encoder frame array/mip/sample mismatch"
    );
    ensure!(
        desc.BindFlags & D3D11_BIND_RENDER_TARGET.0 as u32 != 0,
        "shader converter NV12 encoder texture lacks RENDER_TARGET binding"
    );
    Ok(())
}

fn plane_description(
    array_size: u32,
    slice: u32,
    format: DXGI_FORMAT,
) -> anyhow::Result<D3D11_RENDER_TARGET_VIEW_DESC> {
    ensure!(slice < array_size, "shader plane array slice out of bounds");
    ensure!(
        matches!(format, DXGI_FORMAT_R8_UNORM | DXGI_FORMAT_R8G8_UNORM),
        "shader NV12 plane view format unsupported"
    );
    Ok(if array_size > 1 {
        D3D11_RENDER_TARGET_VIEW_DESC {
            Format: format,
            ViewDimension: D3D11_RTV_DIMENSION_TEXTURE2DARRAY,
            Anonymous: D3D11_RENDER_TARGET_VIEW_DESC_0 {
                Texture2DArray: D3D11_TEX2D_ARRAY_RTV {
                    MipSlice: 0,
                    FirstArraySlice: slice,
                    ArraySize: 1,
                },
            },
        }
    } else {
        D3D11_RENDER_TARGET_VIEW_DESC {
            Format: format,
            ViewDimension: D3D11_RTV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_RENDER_TARGET_VIEW_DESC_0 {
                Texture2D: D3D11_TEX2D_RTV { MipSlice: 0 },
            },
        }
    })
}

unsafe fn blob_bytes(blob: &ID3DBlob) -> &[u8] {
    std::slice::from_raw_parts(blob.GetBufferPointer().cast(), blob.GetBufferSize())
}

unsafe fn compile(entry: PCSTR, profile: PCSTR) -> anyhow::Result<ID3DBlob> {
    let mut code = None;
    let mut diagnostics = None;
    let result = D3DCompile(
        SHADER.as_ptr().cast(),
        SHADER.len(),
        s!("velocast-shader-converter"),
        None,
        None,
        entry,
        profile,
        D3DCOMPILE_ENABLE_STRICTNESS | D3DCOMPILE_IEEE_STRICTNESS | D3DCOMPILE_OPTIMIZATION_LEVEL3,
        0,
        &mut code,
        Some(&mut diagnostics),
    );
    if let Err(error) = result {
        let details = diagnostics
            .as_ref()
            .map(|blob| String::from_utf8_lossy(blob_bytes(blob)).into_owned())
            .unwrap_or_default();
        return Err(anyhow::anyhow!(
            "shader converter D3DCompile failed: {error}: {details}"
        ));
    }
    code.context("shader converter D3DCompile returned null")
}

unsafe fn create_pixel_shader(
    device: &ID3D11Device,
    entry: PCSTR,
) -> anyhow::Result<ID3D11PixelShader> {
    let code = compile(entry, s!("ps_5_0"))?;
    let mut shader = None;
    device
        .CreatePixelShader(blob_bytes(&code), None, Some(&mut shader))
        .context("shader converter pixel shader creation failed")?;
    shader.context("shader converter pixel shader was null")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shader_copy_is_gpu_only_and_bounded() {
        let desc = input_description(1920, 1080).unwrap();
        assert_eq!(desc.Usage, D3D11_USAGE_DEFAULT);
        assert_eq!(desc.CPUAccessFlags, 0);
        assert_eq!(desc.ArraySize, 1);
        assert_eq!(desc.BindFlags, D3D11_BIND_SHADER_RESOURCE.0 as u32);
        for (w, h) in [(0, 2), (2, 0), (3, 2), (2, 3), (16386, 2)] {
            assert!(input_description(w, h).is_err());
        }
    }
    #[test]
    fn shader_plane_views_select_exact_slice_and_format() {
        for format in [DXGI_FORMAT_R8_UNORM, DXGI_FORMAT_R8G8_UNORM] {
            let single = plane_description(1, 0, format).unwrap();
            assert_eq!(single.ViewDimension, D3D11_RTV_DIMENSION_TEXTURE2D);
            let array = plane_description(8, 5, format).unwrap();
            assert_eq!(array.Format, format);
            assert_eq!(array.ViewDimension, D3D11_RTV_DIMENSION_TEXTURE2DARRAY);
            unsafe {
                assert_eq!(array.Anonymous.Texture2DArray.FirstArraySlice, 5);
                assert_eq!(array.Anonymous.Texture2DArray.ArraySize, 1);
            }
        }
        assert!(plane_description(1, 1, DXGI_FORMAT_R8_UNORM).is_err());
        assert!(plane_description(0, 0, DXGI_FORMAT_R8_UNORM).is_err());
        assert!(plane_description(1, 0, DXGI_FORMAT_NV12).is_err());
    }
    #[test]
    fn shader_rejects_incompatible_encoder_frames() {
        let mut desc = input_description(1920, 1080).unwrap();
        desc.Format = DXGI_FORMAT_NV12;
        desc.BindFlags = D3D11_BIND_RENDER_TARGET.0 as u32;
        assert!(validate_destination(&desc, 0, 1920, 1080).is_ok());
        assert!(validate_destination(&desc, 1, 1920, 1080).is_err());
        assert!(validate_destination(&desc, 0, 1922, 1080).is_err());
        desc.BindFlags = 0;
        assert!(validate_destination(&desc, 0, 1920, 1080).is_err());
    }
    #[test]
    fn shader_rejects_scaling_msaa_array_and_wrong_source_format() {
        let mut desc = input_description(1920, 1080).unwrap();
        let rect = TextureSourceRect {
            left: 0,
            top: 0,
            width: 1920,
            height: 1080,
        };
        assert!(validate_input(&desc, rect, 1920, 1080).is_ok());
        assert!(validate_input(&desc, rect, 960, 540).is_err());
        desc.ArraySize = 2;
        assert!(validate_input(&desc, rect, 1920, 1080).is_err());
        desc.ArraySize = 1;
        desc.SampleDesc.Count = 4;
        assert!(validate_input(&desc, rect, 1920, 1080).is_err());
        desc.SampleDesc.Count = 1;
        desc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
        assert!(validate_input(&desc, rect, 1920, 1080).is_err());
    }
    #[test]
    fn shader_hlsl_compiles_without_a_gpu_device() {
        unsafe {
            for (entry, profile) in [
                (s!("vs_main"), s!("vs_5_0")),
                (s!("ps_luma"), s!("ps_5_0")),
                (s!("ps_chroma"), s!("ps_5_0")),
                (s!("ps_luma_601_full"), s!("ps_5_0")),
                (s!("ps_chroma_601_full"), s!("ps_5_0")),
            ] {
                assert!(compile(entry, profile).unwrap().GetBufferSize() > 0);
            }
        }
    }
    #[test]
    fn shader_bt601_full_reference_and_selector() {
        fn full(rgb: [f64; 3]) -> [u8; 3] {
            let y = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
            [
                (255.0 * y).round() as u8,
                (128.0 + 255.0 * (rgb[2] - y) / 1.772)
                    .clamp(0.0, 255.0)
                    .round() as u8,
                (128.0 + 255.0 * (rgb[0] - y) / 1.402)
                    .clamp(0.0, 255.0)
                    .round() as u8,
            ]
        }
        assert_eq!(full([0.0; 3]), [0, 128, 128]);
        assert_eq!(full([1.0; 3]), [255, 128, 128]);
        assert_eq!(full([1.0, 0.0, 0.0]), [76, 85, 255]);
        assert_eq!(full([0.0, 1.0, 0.0]), [150, 44, 21]);
        assert_eq!(full([0.0, 0.0, 1.0]), [29, 255, 107]);
        assert_eq!(full([0.5, 0.25, 0.5]), [90, 149, 155]);
        assert_eq!(
            ShaderMode::from_selector("shader-bt601-full-center"),
            Some(ShaderMode::Bt601FullCenter)
        );
        assert_eq!(
            ShaderMode::from_selector("video-processor-bt709-full"),
            None
        );
        assert_eq!(ShaderMode::from_selector(""), None);
    }
    fn studio(rgb: [f64; 3]) -> [u8; 3] {
        let y = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
        [
            (16.0 + 219.0 * y).round() as u8,
            (128.0 + 224.0 * (rgb[2] - y) / 1.8556).round() as u8,
            (128.0 + 224.0 * (rgb[0] - y) / 1.5748).round() as u8,
        ]
    }
    #[test]
    fn shader_bt709_studio_rounding_and_center_average_reference() {
        assert_eq!(studio([0.0; 3]), [16, 128, 128]);
        assert_eq!(studio([1.0; 3]), [235, 128, 128]);
        assert_eq!(studio([1.0, 0.0, 0.0]), [63, 102, 240]);
        assert_eq!(studio([0.0, 1.0, 0.0]), [173, 42, 26]);
        assert_eq!(studio([0.0, 0.0, 1.0]), [32, 240, 118]);
        // Black/white/red/blue block: average before one final quantization.
        assert_eq!(studio([0.5, 0.25, 0.5]), [86, 150, 153]);
        assert!(SHADER.contains("floor(value + 0.5) / 255.0"));
        assert!(SHADER.contains("* 0.25"));
    }
}
