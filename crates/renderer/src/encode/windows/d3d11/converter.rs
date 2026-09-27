use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::mem::ManuallyDrop;

use anyhow::Context;
use windows::core::Interface;
use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11DeviceContext, ID3D11Resource, ID3D11Texture2D, ID3D11VideoContext,
    ID3D11VideoContext1, ID3D11VideoDevice, ID3D11VideoProcessor, ID3D11VideoProcessorEnumerator,
    ID3D11VideoProcessorInputView, ID3D11VideoProcessorOutputView, D3D11_TEX2D_ARRAY_VPOV,
    D3D11_TEX2D_VPIV, D3D11_TEX2D_VPOV, D3D11_TEXTURE2D_DESC, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
    D3D11_VIDEO_PROCESSOR_CONTENT_DESC, D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT,
    D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT, D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT,
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0,
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0,
    D3D11_VIDEO_PROCESSOR_STREAM, D3D11_VIDEO_USAGE_OPTIMAL_SPEED, D3D11_VPIV_DIMENSION_TEXTURE2D,
    D3D11_VPOV_DIMENSION_TEXTURE2D, D3D11_VPOV_DIMENSION_TEXTURE2DARRAY,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709, DXGI_COLOR_SPACE_YCBCR_FULL_G22_LEFT_P709,
    DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709, DXGI_FORMAT, DXGI_FORMAT_NV12, DXGI_RATIONAL,
};

use crate::encoder::EncoderSettings;
use crate::surface::TextureSourceRect;

use super::conversion_mode::ConversionMode;
use super::frames::{validate_source_rect, OwnedFrame};

const MAX_CACHED_INPUT_VIEWS: usize = 8;
const MAX_CACHED_OUTPUT_VIEWS: usize = 8;

pub(crate) struct D3D11VideoProcessorConverter {
    mode: ConversionMode,
    shader: Option<super::shader_converter::ShaderConverter>,
    video_device: ID3D11VideoDevice,
    video_context: ID3D11VideoContext,
    enumerator: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
    width: u32,
    height: u32,
    input_format_support: RefCell<HashSet<i32>>,
    input_views: RefCell<HashMap<usize, ID3D11VideoProcessorInputView>>,
    output_views: RefCell<HashMap<(usize, u32), ID3D11VideoProcessorOutputView>>,
}

impl D3D11VideoProcessorConverter {
    pub(crate) fn new(
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        settings: &EncoderSettings,
        mode: ConversionMode,
    ) -> anyhow::Result<Self> {
        unsafe {
            let video_device: ID3D11VideoDevice = device
                .cast()
                .context("failed to cast D3D11 device to ID3D11VideoDevice")?;
            let video_context: ID3D11VideoContext = context
                .cast()
                .context("failed to cast D3D11 context to ID3D11VideoContext")?;
            let video_context1 = video_context
                .cast::<ID3D11VideoContext1>()
                .context("D3D11 video context cannot configure explicit BT.709 conversion")?;
            let frame_rate = DXGI_RATIONAL {
                Numerator: settings.fps.max(1),
                Denominator: 1,
            };
            let content_desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
                InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                InputFrameRate: frame_rate,
                InputWidth: settings.width,
                InputHeight: settings.height,
                OutputFrameRate: frame_rate,
                OutputWidth: settings.width,
                OutputHeight: settings.height,
                Usage: D3D11_VIDEO_USAGE_OPTIMAL_SPEED,
            };
            let enumerator = video_device
                .CreateVideoProcessorEnumerator(&content_desc)
                .context("ID3D11VideoDevice::CreateVideoProcessorEnumerator failed")?;
            ensure_video_processor_format_support(
                &enumerator,
                DXGI_FORMAT_NV12,
                D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT,
                "output",
            )?;
            let processor = video_device
                .CreateVideoProcessor(&enumerator, 0)
                .context("ID3D11VideoDevice::CreateVideoProcessor failed")?;

            let rect = RECT {
                left: 0,
                top: 0,
                right: settings.width as i32,
                bottom: settings.height as i32,
            };
            video_context.VideoProcessorSetStreamFrameFormat(
                &processor,
                0,
                D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            );
            video_context.VideoProcessorSetStreamSourceRect(&processor, 0, true, Some(&rect));
            video_context.VideoProcessorSetStreamDestRect(&processor, 0, true, Some(&rect));
            video_context.VideoProcessorSetOutputTargetRect(&processor, true, Some(&rect));
            video_context.VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false);
            {
                video_context1.VideoProcessorSetStreamColorSpace1(
                    &processor,
                    0,
                    DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709,
                );
                video_context1.VideoProcessorSetOutputColorSpace1(
                    &processor,
                    if mode.full_range() {
                        DXGI_COLOR_SPACE_YCBCR_FULL_G22_LEFT_P709
                    } else {
                        DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709
                    },
                );
            }

            let shader = if let Some(shader_mode) = mode.shader_mode() {
                Some(super::shader_converter::ShaderConverter::new(
                    device,
                    context,
                    settings.width,
                    settings.height,
                    shader_mode,
                )?)
            } else {
                None
            };
            Ok(Self {
                mode,
                shader,
                video_device,
                video_context,
                enumerator,
                processor,
                width: settings.width,
                height: settings.height,
                input_format_support: RefCell::new(HashSet::new()),
                input_views: RefCell::new(HashMap::new()),
                output_views: RefCell::new(HashMap::new()),
            })
        }
    }

    pub(crate) fn mode(&self) -> ConversionMode {
        self.mode
    }

    pub(crate) fn shader_mode(&self) -> Option<super::shader_converter::ShaderMode> {
        self.shader.as_ref().map(|shader| shader.mode())
    }
    pub(crate) fn conversion_backend_name(&self) -> &'static str {
        if self.shader.is_some() {
            "d3d11_shader_nv12"
        } else {
            "d3d11_video_processor"
        }
    }
    pub(crate) unsafe fn convert_bgra_texture_to_encoder_frame(
        &self,
        source: &ID3D11Texture2D,
        source_rect: TextureSourceRect,
        destination: &OwnedFrame,
    ) -> anyhow::Result<()> {
        if let Some(shader) = &self.shader {
            return shader.convert(source, source_rect, destination);
        }
        let mut source_desc = D3D11_TEXTURE2D_DESC::default();
        source.GetDesc(&mut source_desc);
        validate_source_rect(source_desc.Width, source_desc.Height, source_rect)?;
        self.ensure_cached_input_format_support(source_desc.Format)?;

        let destination_texture = destination.d3d11_texture()?;
        let destination_index = destination.d3d11_texture_index()?;
        let mut destination_desc = D3D11_TEXTURE2D_DESC::default();
        destination_texture.GetDesc(&mut destination_desc);
        if destination_desc.Format != DXGI_FORMAT_NV12
            || destination_desc.Width != self.width
            || destination_desc.Height != self.height
        {
            return Err(anyhow::anyhow!(
                "encoder frame pool produced incompatible D3D11 texture {:?} {}x{}",
                destination_desc.Format,
                destination_desc.Width,
                destination_desc.Height
            ));
        }
        if destination_index >= destination_desc.ArraySize {
            return Err(anyhow::anyhow!(
                "encoder frame texture index {} exceeded array size {}",
                destination_index,
                destination_desc.ArraySize
            ));
        }

        let source_resource: ID3D11Resource = source
            .cast()
            .context("failed to cast source texture to D3D11 resource")?;
        let destination_resource: ID3D11Resource = destination_texture
            .cast()
            .context("failed to cast encoder frame texture to D3D11 resource")?;
        let input_view = self.cached_input_view(&source_resource)?;
        let output_view =
            self.cached_output_view(&destination_resource, &destination_desc, destination_index)?;
        let source_rect = RECT {
            left: source_rect.left as i32,
            top: source_rect.top as i32,
            right: source_rect
                .left
                .checked_add(source_rect.width)
                .ok_or_else(|| anyhow::anyhow!("D3D11 source rect overflow"))?
                as i32,
            bottom: source_rect
                .top
                .checked_add(source_rect.height)
                .ok_or_else(|| anyhow::anyhow!("D3D11 source rect overflow"))?
                as i32,
        };
        let destination_rect = RECT {
            left: 0,
            top: 0,
            right: self.width as i32,
            bottom: self.height as i32,
        };
        self.video_context.VideoProcessorSetStreamSourceRect(
            &self.processor,
            0,
            true,
            Some(&source_rect),
        );
        self.video_context.VideoProcessorSetStreamDestRect(
            &self.processor,
            0,
            true,
            Some(&destination_rect),
        );
        let mut stream = D3D11_VIDEO_PROCESSOR_STREAM {
            Enable: true.into(),
            OutputIndex: 0,
            InputFrameOrField: 0,
            pInputSurface: ManuallyDrop::new(Some(input_view)),
            ..Default::default()
        };

        let blit_result = self.video_context.VideoProcessorBlt(
            &self.processor,
            &output_view,
            0,
            std::slice::from_ref(&stream),
        );
        ManuallyDrop::drop(&mut stream.pInputSurface);
        blit_result.context("ID3D11VideoContext::VideoProcessorBlt failed")
    }

    unsafe fn create_input_view(
        &self,
        source_resource: &ID3D11Resource,
    ) -> anyhow::Result<ID3D11VideoProcessorInputView> {
        let input_desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
            FourCC: 0,
            ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
                Texture2D: D3D11_TEX2D_VPIV {
                    MipSlice: 0,
                    ArraySlice: 0,
                },
            },
        };
        let mut input_view = None;
        self.video_device
            .CreateVideoProcessorInputView(
                source_resource,
                &self.enumerator,
                &input_desc,
                Some(&mut input_view),
            )
            .context("ID3D11VideoDevice::CreateVideoProcessorInputView failed")?;
        input_view.ok_or_else(|| {
            anyhow::anyhow!("ID3D11VideoDevice::CreateVideoProcessorInputView returned null")
        })
    }

    unsafe fn cached_input_view(
        &self,
        source_resource: &ID3D11Resource,
    ) -> anyhow::Result<ID3D11VideoProcessorInputView> {
        let key = source_resource.as_raw() as usize;
        if let Some(input_view) = self.input_views.borrow().get(&key) {
            return Ok(input_view.clone());
        }

        let input_view = self.create_input_view(source_resource)?;
        let mut input_views = self.input_views.borrow_mut();
        if input_views.len() >= MAX_CACHED_INPUT_VIEWS {
            input_views.clear();
        }
        input_views.insert(key, input_view.clone());
        Ok(input_view)
    }

    fn ensure_cached_input_format_support(&self, format: DXGI_FORMAT) -> anyhow::Result<()> {
        let key = format.0;
        if self.input_format_support.borrow().contains(&key) {
            return Ok(());
        }

        unsafe {
            ensure_video_processor_format_support(
                &self.enumerator,
                format,
                D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT,
                "input",
            )?;
        }
        self.input_format_support.borrow_mut().insert(key);
        Ok(())
    }

    unsafe fn cached_output_view(
        &self,
        destination_resource: &ID3D11Resource,
        destination_desc: &D3D11_TEXTURE2D_DESC,
        array_slice: u32,
    ) -> anyhow::Result<ID3D11VideoProcessorOutputView> {
        let key = (destination_resource.as_raw() as usize, array_slice);
        if let Some(output_view) = self.output_views.borrow().get(&key) {
            return Ok(output_view.clone());
        }

        let output_view =
            self.create_output_view(destination_resource, destination_desc, array_slice)?;
        let mut output_views = self.output_views.borrow_mut();
        if output_views.len() >= MAX_CACHED_OUTPUT_VIEWS {
            output_views.clear();
        }
        output_views.insert(key, output_view.clone());
        Ok(output_view)
    }

    unsafe fn create_output_view(
        &self,
        destination_resource: &ID3D11Resource,
        destination_desc: &D3D11_TEXTURE2D_DESC,
        array_slice: u32,
    ) -> anyhow::Result<ID3D11VideoProcessorOutputView> {
        let output_desc = if destination_desc.ArraySize > 1 {
            D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2DARRAY,
                Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                    Texture2DArray: D3D11_TEX2D_ARRAY_VPOV {
                        MipSlice: 0,
                        FirstArraySlice: array_slice,
                        ArraySize: 1,
                    },
                },
            }
        } else {
            D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                    Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 },
                },
            }
        };
        let mut output_view = None;
        self.video_device
            .CreateVideoProcessorOutputView(
                destination_resource,
                &self.enumerator,
                &output_desc,
                Some(&mut output_view),
            )
            .context("ID3D11VideoDevice::CreateVideoProcessorOutputView failed")?;
        output_view.ok_or_else(|| {
            anyhow::anyhow!("ID3D11VideoDevice::CreateVideoProcessorOutputView returned null")
        })
    }
}
unsafe fn ensure_video_processor_format_support(
    enumerator: &ID3D11VideoProcessorEnumerator,
    format: DXGI_FORMAT,
    required_support: D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT,
    direction: &str,
) -> anyhow::Result<()> {
    let flags = enumerator
        .CheckVideoProcessorFormat(format)
        .with_context(|| {
            format!(
                "ID3D11VideoProcessorEnumerator::CheckVideoProcessorFormat failed for {format:?}"
            )
        })?;
    if flags & required_support.0 as u32 == 0 {
        return Err(anyhow::anyhow!(
            "D3D11 video processor does not support {:?} as {} format",
            format,
            direction
        ));
    }
    Ok(())
}
