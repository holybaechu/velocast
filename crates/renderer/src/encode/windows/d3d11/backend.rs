use std::collections::VecDeque;
use std::ffi::CString;
use std::path::Path;
use std::ptr;
use std::time::Instant;

use anyhow::Context;
use ffmpeg_sys_next as ffmpeg;
use windows::core::Interface;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11DeviceContext, D3D11_TEXTURE2D_DESC,
};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;

use crate::capture::windows_d3d11::{create_d3d11_device, OwnedTextureLease, OwnedTexturePool};
use crate::encoder::{EncoderSettings, FrameEncodeStats};
use crate::errors::RendererError;
use crate::surface::{CapturedFrame, PlatformSurface, TextureSourceRect};

use super::converter::D3D11VideoProcessorConverter;
use super::frames::{
    allocate_packet, check_ffmpeg, create_codec_context, create_encoder_frame,
    create_hw_frames_context, create_output_context, first_stream, selected_codec_name,
    validate_source_rect, AVD3D11VADeviceContext, OwnedFrame,
};

const AVERROR_EAGAIN: i32 = -11;
const MAX_PENDING_ENCODER_FRAMES: usize = 4;

pub(crate) struct D3D11FfmpegHardwareEncoder {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    owned_texture_pool: OwnedTexturePool,
    video_processor: D3D11VideoProcessorConverter,
    format_context: *mut ffmpeg::AVFormatContext,
    codec_context: *mut ffmpeg::AVCodecContext,
    stream: *mut ffmpeg::AVStream,
    packet: *mut ffmpeg::AVPacket,
    metadata_bsf: Option<super::metadata_bsf::MetadataBsf>,
    hw_device_ref: *mut ffmpeg::AVBufferRef,
    hw_frames_ref: *mut ffmpeg::AVBufferRef,
    next_pts: i64,
    selected_codec_name: String,
    pending_frames: VecDeque<OwnedFrame>,
}

impl D3D11FfmpegHardwareEncoder {
    /// Resolve the planned conversion without creating a device or encoder.
    pub(crate) fn planned_shader_conversion(codec: &str) -> anyhow::Result<bool> {
        Ok(
            super::conversion_mode::ConversionMode::from_environment(codec)?
                .shader_mode()
                .is_some(),
        )
    }

    pub(crate) fn spawn_for_backend(
        settings: &EncoderSettings,
        selected_backend: crate::pipeline::backend_registry::BackendKind,
    ) -> Result<Self, RendererError> {
        unsafe { Self::try_spawn(settings, Some(selected_backend)) }
            .map_err(|error| RendererError::FfmpegInit(error.to_string()))
    }

    unsafe fn try_spawn(
        settings: &EncoderSettings,
        selected_backend: Option<crate::pipeline::backend_registry::BackendKind>,
    ) -> anyhow::Result<Self> {
        let conversion_mode =
            super::conversion_mode::ConversionMode::from_environment(&settings.codec)?;
        if let Some(parent) = Path::new(&settings.output)
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            std::fs::create_dir_all(parent).with_context(|| {
                format!("failed to create output directory {}", parent.display())
            })?;
        }

        let (device, context) = create_d3d11_device()?;
        let dxgi_device: IDXGIDevice = device.cast().context("query D3D11 encoder DXGI device")?;
        let adapter = dxgi_device
            .GetAdapter()
            .context("query D3D11 encoder adapter")?;
        let description = adapter
            .GetDesc()
            .context("query D3D11 encoder adapter description")?;
        let name_end = description
            .Description
            .iter()
            .position(|value| *value == 0)
            .unwrap_or(description.Description.len());
        let adapter_name = String::from_utf16_lossy(&description.Description[..name_end]);
        tracing::info!(
            adapter = %adapter_name,
            vendor_id = description.VendorId,
            device_id = description.DeviceId,
            adapter_luid_low = description.AdapterLuid.LowPart,
            adapter_luid_high = description.AdapterLuid.HighPart,
            "selected D3D11 encoder adapter"
        );
        let owned_texture_pool = OwnedTexturePool::from_device(device.clone(), context.clone());
        let video_processor =
            D3D11VideoProcessorConverter::new(&device, &context, settings, conversion_mode)?;
        let time_base = ffmpeg::AVRational {
            num: 1,
            den: settings.fps as i32,
        };
        let frame_rate = ffmpeg::AVRational {
            num: settings.fps as i32,
            den: 1,
        };

        let mut encoder = Self {
            device,
            context,
            owned_texture_pool,
            video_processor,
            format_context: ptr::null_mut(),
            codec_context: ptr::null_mut(),
            stream: ptr::null_mut(),
            packet: ptr::null_mut(),
            metadata_bsf: None,
            hw_device_ref: ptr::null_mut(),
            hw_frames_ref: ptr::null_mut(),
            next_pts: 0,
            selected_codec_name: String::new(),
            pending_frames: VecDeque::new(),
        };

        encoder.hw_device_ref = encoder.create_hw_device_context()?;
        encoder.hw_frames_ref =
            create_hw_frames_context(encoder.hw_device_ref, settings.width, settings.height)?;
        let mut last_error = None;
        for candidate in d3d11_encoder_candidates_for_backend(&settings.codec, selected_backend) {
            let Some(codec) = find_encoder_by_name(candidate)? else {
                tracing::info!(
                    candidate,
                    "D3D11 encoder candidate is not available in this FFmpeg build"
                );
                continue;
            };
            match encoder.try_spawn_with_codec(codec, settings, time_base, frame_rate) {
                Ok(()) => {
                    encoder.selected_codec_name = selected_codec_name(codec);
                    tracing::info!(
                        codec = %encoder.selected_codec_name,
                        output = %settings.output,
                        "using D3D11 FFmpeg hardware encoder"
                    );
                    if !settings.pixel_format.eq_ignore_ascii_case("nv12") {
                        tracing::info!(
                            requested_pixel_format = %settings.pixel_format,
                            encoder_input_format = "d3d11/nv12",
                            "D3D11 hardware encoder ignores raw-output pixel_format and uses encoder-required NV12 hardware surfaces"
                        );
                    }

                    return Ok(encoder);
                }
                Err(error) => {
                    tracing::info!(
                        candidate,
                        ?error,
                        "failed to initialize D3D11 FFmpeg hardware encoder candidate"
                    );
                    encoder.cleanup_codec_attempt();
                    last_error = Some(error);
                }
            }
        }

        Err(last_error.unwrap_or_else(|| {
            anyhow::anyhow!(
                "no D3D11-capable FFmpeg encoder found for codec {}",
                settings.codec
            )
        }))
    }

    unsafe fn try_spawn_with_codec(
        &mut self,
        codec: *const ffmpeg::AVCodec,
        settings: &EncoderSettings,
        time_base: ffmpeg::AVRational,
        frame_rate: ffmpeg::AVRational,
    ) -> anyhow::Result<()> {
        self.codec_context = create_codec_context(
            codec,
            self.hw_frames_ref,
            settings,
            time_base,
            frame_rate,
            self.video_processor.mode(),
        )?;
        self.metadata_bsf = self
            .video_processor
            .shader_mode()
            .map(|mode| super::metadata_bsf::MetadataBsf::new(self.codec_context, mode))
            .transpose()?;
        self.format_context = create_output_context(
            &settings.output,
            self.codec_context,
            codec,
            time_base,
            self.metadata_bsf.as_ref().map(|bsf| bsf.parameters()),
        )?;
        self.stream = first_stream(self.format_context)?;
        self.packet = allocate_packet()?;
        Ok(())
    }

    pub(crate) fn conversion_backend_name(&self) -> &'static str {
        self.video_processor.conversion_backend_name()
    }
    pub(crate) fn codec_name(&self) -> &str {
        &self.selected_codec_name
    }

    pub(crate) fn owned_texture_pool(&self) -> OwnedTexturePool {
        self.owned_texture_pool.clone()
    }

    pub(crate) async fn write_frame(
        &mut self,
        frame: CapturedFrame,
    ) -> anyhow::Result<FrameEncodeStats> {
        match frame {
            CapturedFrame::GpuSurface(crate::surface::GpuSurfaceFrame {
                width,
                height,
                texture_width,
                texture_height,
                source_rect,
                platform_surface:
                    PlatformSurface::WindowsD3D11(crate::surface::WindowsD3D11Surface { owned_texture }),
                ..
            }) => unsafe {
                self.write_owned_texture_frame(
                    width,
                    height,
                    texture_width,
                    texture_height,
                    source_rect,
                    owned_texture,
                )
            },
            CapturedFrame::BgraSoftware(_) => Err(anyhow::anyhow!(
                "D3D11 hardware encoder received a CPU BGRA frame"
            )),
        }
    }

    unsafe fn write_owned_texture_frame(
        &mut self,
        width: u32,
        height: u32,
        texture_width: u32,
        texture_height: u32,
        source_rect: TextureSourceRect,
        mut owned_texture: OwnedTextureLease,
    ) -> anyhow::Result<FrameEncodeStats> {
        let texture = owned_texture.texture()?;
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        texture.GetDesc(&mut desc);

        if desc.Width != texture_width || desc.Height != texture_height {
            return Err(anyhow::anyhow!(
                "D3D11 owned texture dimensions {}x{} did not match accelerated texture {}x{}",
                desc.Width,
                desc.Height,
                texture_width,
                texture_height
            ));
        }
        validate_source_rect(texture_width, texture_height, source_rect)?;

        let converted = create_encoder_frame(
            &mut self.video_processor,
            texture,
            source_rect,
            self.hw_frames_ref,
            width,
            height,
            self.next_pts,
        );
        let consumer_finished = owned_texture.finish_gpu_use();
        let (frame, gpu_conversion_ms) = match (converted, consumer_finished) {
            (Ok(converted), Ok(())) => converted,
            (Err(error), Ok(())) => return Err(error),
            (Ok(_), Err(error)) => return Err(error),
            (Err(conversion_error), Err(fence_error)) => {
                return Err(anyhow::anyhow!(
                    "D3D11 conversion failed ({conversion_error}); owned texture consumer fence failed ({fence_error})"
                ));
            }
        };
        self.next_pts += 1;

        let mut packet_write_ms = self.send_frame_with_backpressure(&frame)?;
        self.pending_frames.push_back(frame);
        packet_write_ms +=
            self.drain_packets_until_pending_at_most(MAX_PENDING_ENCODER_FRAMES.saturating_sub(1))?;
        Ok(FrameEncodeStats {
            gpu_conversion_ms,
            packet_write_ms,
            ..FrameEncodeStats::default()
        })
    }

    pub(crate) async fn finish(mut self) -> Result<(), RendererError> {
        unsafe { self.finish_inner() }.map_err(|error| RendererError::FfmpegInit(error.to_string()))
    }

    unsafe fn finish_inner(&mut self) -> anyhow::Result<()> {
        let _ = self.drain_packets()?;
        check_ffmpeg(
            ffmpeg::avcodec_send_frame(self.codec_context, ptr::null()),
            "avcodec_send_frame flush",
        )?;
        let _ = self.drain_packets()?;
        if let Some(bsf) = &self.metadata_bsf {
            bsf.send(ptr::null_mut())?;
            let _ = self.drain_filtered_packets(true)?;
        }
        check_ffmpeg(
            ffmpeg::av_write_trailer(self.format_context),
            "av_write_trailer",
        )?;
        self.cleanup();
        Ok(())
    }

    unsafe fn send_frame_with_backpressure(&mut self, frame: &OwnedFrame) -> anyhow::Result<u128> {
        let send_result = ffmpeg::avcodec_send_frame(self.codec_context, frame.as_ptr());
        if send_result != AVERROR_EAGAIN {
            check_ffmpeg(send_result, "avcodec_send_frame")?;
            return Ok(0);
        }

        let packet_write_ms = self.drain_packets()?;
        check_ffmpeg(
            ffmpeg::avcodec_send_frame(self.codec_context, frame.as_ptr()),
            "avcodec_send_frame",
        )?;
        Ok(packet_write_ms)
    }

    pub(crate) async fn abort(mut self) -> Result<(), RendererError> {
        unsafe {
            self.cleanup();
        }
        Ok(())
    }

    unsafe fn drain_packets(&mut self) -> anyhow::Result<u128> {
        let mut packet_write_ms = 0;
        loop {
            let ret = ffmpeg::avcodec_receive_packet(self.codec_context, self.packet);
            if ret == AVERROR_EAGAIN || ret == ffmpeg::AVERROR_EOF {
                return Ok(packet_write_ms);
            }
            check_ffmpeg(ret, "avcodec_receive_packet")?;

            // Release one hardware input per encoder output, not per BSF output.
            let _ = self.pending_frames.pop_front();
            if let Some(bsf) = &self.metadata_bsf {
                bsf.send(self.packet)?;
                packet_write_ms += self.drain_filtered_packets(false)?;
            } else {
                packet_write_ms += self.mux_packet((*self.codec_context).time_base)?;
            }
        }
    }

    unsafe fn drain_filtered_packets(&mut self, flushing: bool) -> anyhow::Result<u128> {
        let mut elapsed = 0;
        loop {
            let bsf = self
                .metadata_bsf
                .as_ref()
                .context("missing metadata filter")?;
            let ret = bsf.receive(self.packet);
            if ret == ffmpeg::AVERROR_EOF {
                return Ok(elapsed);
            }
            if ret == AVERROR_EAGAIN {
                anyhow::ensure!(!flushing, "metadata filter requested input after EOF");
                return Ok(elapsed);
            }
            check_ffmpeg(ret, "av_bsf_receive_packet(h264_metadata)")?;
            let time_base = bsf.time_base();
            elapsed += self.mux_packet(time_base)?;
        }
    }
    unsafe fn mux_packet(&mut self, time_base: ffmpeg::AVRational) -> anyhow::Result<u128> {
        ffmpeg::av_packet_rescale_ts(self.packet, time_base, (*self.stream).time_base);
        (*self.packet).stream_index = (*self.stream).index;
        let started = Instant::now();
        let result = check_ffmpeg(
            ffmpeg::av_interleaved_write_frame(self.format_context, self.packet),
            "av_interleaved_write_frame",
        );
        ffmpeg::av_packet_unref(self.packet);
        result?;
        Ok(started.elapsed().as_millis())
    }

    unsafe fn drain_packets_until_pending_at_most(
        &mut self,
        max_pending_frames: usize,
    ) -> anyhow::Result<u128> {
        let mut packet_write_ms = 0;
        while self.pending_frames.len() > max_pending_frames {
            let pending_before = self.pending_frames.len();
            packet_write_ms += self.drain_packets()?;
            if self.pending_frames.len() >= pending_before {
                break;
            }
        }
        Ok(packet_write_ms)
    }

    unsafe fn create_hw_device_context(&self) -> anyhow::Result<*mut ffmpeg::AVBufferRef> {
        let hw_device_ref =
            ffmpeg::av_hwdevice_ctx_alloc(ffmpeg::AVHWDeviceType::AV_HWDEVICE_TYPE_D3D11VA);
        if hw_device_ref.is_null() {
            return Err(anyhow::anyhow!("av_hwdevice_ctx_alloc returned null"));
        }

        let device_context = (*hw_device_ref).data as *mut ffmpeg::AVHWDeviceContext;
        if device_context.is_null() || (*device_context).hwctx.is_null() {
            let mut owned = hw_device_ref;
            ffmpeg::av_buffer_unref(&mut owned);
            return Err(anyhow::anyhow!("D3D11 AVHWDeviceContext is unavailable"));
        }

        let d3d11_context = (*device_context).hwctx as *mut AVD3D11VADeviceContext;
        (*d3d11_context).device = self.device.clone().into_raw();
        (*d3d11_context).device_context = self.context.clone().into_raw();

        if let Err(error) = check_ffmpeg(
            ffmpeg::av_hwdevice_ctx_init(hw_device_ref),
            "av_hwdevice_ctx_init",
        ) {
            let mut owned = hw_device_ref;
            ffmpeg::av_buffer_unref(&mut owned);
            return Err(error);
        }

        Ok(hw_device_ref)
    }

    unsafe fn cleanup(&mut self) {
        self.pending_frames.clear();
        self.cleanup_codec_attempt();
        if !self.hw_frames_ref.is_null() {
            ffmpeg::av_buffer_unref(&mut self.hw_frames_ref);
        }
        if !self.hw_device_ref.is_null() {
            ffmpeg::av_buffer_unref(&mut self.hw_device_ref);
        }
    }

    unsafe fn cleanup_codec_attempt(&mut self) {
        self.metadata_bsf = None;
        if !self.packet.is_null() {
            ffmpeg::av_packet_free(&mut self.packet);
        }
        if !self.codec_context.is_null() {
            ffmpeg::avcodec_free_context(&mut self.codec_context);
        }
        if !self.format_context.is_null() {
            if !(*self.format_context).pb.is_null()
                && ((*(*self.format_context).oformat).flags & ffmpeg::AVFMT_NOFILE) == 0
            {
                ffmpeg::avio_closep(&mut (*self.format_context).pb);
            }
            ffmpeg::avformat_free_context(self.format_context);
            self.format_context = ptr::null_mut();
        }
        self.stream = ptr::null_mut();
    }
}

impl Drop for D3D11FfmpegHardwareEncoder {
    fn drop(&mut self) {
        unsafe {
            self.cleanup();
        }
    }
}
unsafe fn find_encoder_by_name(candidate: &str) -> anyhow::Result<Option<*const ffmpeg::AVCodec>> {
    let name = CString::new(candidate)?;
    let encoder = ffmpeg::avcodec_find_encoder_by_name(name.as_ptr());
    Ok((!encoder.is_null()).then_some(encoder))
}

fn d3d11_encoder_candidates_for_backend(
    codec: &str,
    selected_backend: Option<crate::pipeline::backend_registry::BackendKind>,
) -> Vec<&'static str> {
    let Ok(parsed) = crate::encode::codec::ParsedVideoCodec::parse(codec) else {
        return Vec::new();
    };
    let Some(selected_backend) = selected_backend else {
        return crate::encode::windows::codecs::ffmpeg_encoder_candidates(parsed);
    };
    let backend = match selected_backend {
        crate::pipeline::backend_registry::BackendKind::WindowsD3D11Amf => {
            crate::encode::codec::WindowsD3D11EncoderBackend::Amf
        }
        crate::pipeline::backend_registry::BackendKind::WindowsD3D11Nvenc => {
            crate::encode::codec::WindowsD3D11EncoderBackend::Nvenc
        }
        crate::pipeline::backend_registry::BackendKind::WindowsD3D11Qsv => {
            crate::encode::codec::WindowsD3D11EncoderBackend::Qsv
        }
        crate::pipeline::backend_registry::BackendKind::WindowsD3D11Mf => {
            crate::encode::codec::WindowsD3D11EncoderBackend::Mf
        }
        _ => return Vec::new(),
    };
    crate::encode::windows::codecs::forced_candidate(parsed.codec, backend)
        .into_iter()
        .collect()
}
