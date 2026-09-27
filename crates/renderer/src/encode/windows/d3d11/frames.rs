use std::ffi::{c_void, CStr, CString};
use std::ptr;
use std::time::Instant;

use anyhow::Context;
use ffmpeg_sys_next as ffmpeg;
use windows::core::Interface;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Texture2D, D3D11_BIND_RENDER_TARGET, D3D11_BIND_VIDEO_ENCODER,
};

use crate::encoder::EncoderSettings;
use crate::surface::TextureSourceRect;

use super::converter::D3D11VideoProcessorConverter;

const ENCODER_FRAME_POOL_SIZE: i32 = 0;

#[repr(C)]
pub(crate) struct AVD3D11VADeviceContext {
    pub(crate) device: *mut c_void,
    pub(crate) device_context: *mut c_void,
    pub(crate) video_device: *mut c_void,
    pub(crate) video_context: *mut c_void,
    pub(crate) lock: Option<unsafe extern "C" fn(*mut c_void)>,
    pub(crate) unlock: Option<unsafe extern "C" fn(*mut c_void)>,
    pub(crate) lock_ctx: *mut c_void,
}

#[repr(C)]
struct AVD3D11FrameDescriptor {
    texture: *mut c_void,
    index: isize,
}

#[repr(C)]
#[allow(non_snake_case)]
struct AVD3D11VAFramesContext {
    texture: *mut c_void,
    BindFlags: u32,
    MiscFlags: u32,
    texture_infos: *mut AVD3D11FrameDescriptor,
}
pub(crate) struct OwnedFrame {
    frame: *mut ffmpeg::AVFrame,
}

impl OwnedFrame {
    pub(crate) fn as_ptr(&self) -> *const ffmpeg::AVFrame {
        self.frame
    }

    pub(crate) unsafe fn d3d11_texture(&self) -> anyhow::Result<ID3D11Texture2D> {
        let raw = (*self.frame).data[0].cast::<c_void>();
        ID3D11Texture2D::from_raw_borrowed(&raw)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("encoder frame did not contain a D3D11 texture"))
    }

    pub(crate) unsafe fn d3d11_texture_index(&self) -> anyhow::Result<u32> {
        let index = (*self.frame).data[1] as usize;
        u32::try_from(index).context("encoder frame D3D11 texture index did not fit in u32")
    }
}

impl Drop for OwnedFrame {
    fn drop(&mut self) {
        unsafe {
            if !self.frame.is_null() {
                ffmpeg::av_frame_free(&mut self.frame);
            }
        }
    }
}
pub(crate) unsafe fn create_hw_frames_context(
    hw_device_ref: *mut ffmpeg::AVBufferRef,
    width: u32,
    height: u32,
) -> anyhow::Result<*mut ffmpeg::AVBufferRef> {
    let hw_frames_ref = ffmpeg::av_hwframe_ctx_alloc(hw_device_ref);
    if hw_frames_ref.is_null() {
        return Err(anyhow::anyhow!("av_hwframe_ctx_alloc returned null"));
    }

    let frames_context = (*hw_frames_ref).data as *mut ffmpeg::AVHWFramesContext;
    if frames_context.is_null() {
        let mut owned = hw_frames_ref;
        ffmpeg::av_buffer_unref(&mut owned);
        return Err(anyhow::anyhow!("AVHWFramesContext is unavailable"));
    }

    (*frames_context).format = ffmpeg::AVPixelFormat::AV_PIX_FMT_D3D11;
    (*frames_context).sw_format = ffmpeg::AVPixelFormat::AV_PIX_FMT_NV12;
    (*frames_context).width = width as i32;
    (*frames_context).height = height as i32;
    (*frames_context).initial_pool_size = ENCODER_FRAME_POOL_SIZE;

    let d3d11_frames_context = (*frames_context).hwctx as *mut AVD3D11VAFramesContext;
    if d3d11_frames_context.is_null() {
        let mut owned = hw_frames_ref;
        ffmpeg::av_buffer_unref(&mut owned);
        return Err(anyhow::anyhow!("AVD3D11VAFramesContext is unavailable"));
    }
    (*d3d11_frames_context).BindFlags =
        (D3D11_BIND_VIDEO_ENCODER.0 | D3D11_BIND_RENDER_TARGET.0) as u32;

    if let Err(error) = check_ffmpeg(
        ffmpeg::av_hwframe_ctx_init(hw_frames_ref),
        "av_hwframe_ctx_init",
    ) {
        let mut owned = hw_frames_ref;
        ffmpeg::av_buffer_unref(&mut owned);
        return Err(error);
    }

    Ok(hw_frames_ref)
}

pub(crate) unsafe fn create_codec_context(
    codec: *const ffmpeg::AVCodec,
    hw_frames_ref: *mut ffmpeg::AVBufferRef,
    settings: &EncoderSettings,
    time_base: ffmpeg::AVRational,
    frame_rate: ffmpeg::AVRational,
    conversion_mode: super::conversion_mode::ConversionMode,
) -> anyhow::Result<*mut ffmpeg::AVCodecContext> {
    if conversion_mode.shader_mode().is_some() && (*codec).id != ffmpeg::AVCodecID::AV_CODEC_ID_H264
    {
        return Err(anyhow::anyhow!(
            "centered shader currently supports only H264 metadata filtering"
        ));
    }
    let codec_context = ffmpeg::avcodec_alloc_context3(codec);
    if codec_context.is_null() {
        return Err(anyhow::anyhow!("avcodec_alloc_context3 returned null"));
    }

    (*codec_context).codec_type = ffmpeg::AVMediaType::AVMEDIA_TYPE_VIDEO;
    (*codec_context).codec_id = (*codec).id;
    (*codec_context).width = settings.width as i32;
    (*codec_context).height = settings.height as i32;
    (*codec_context).time_base = time_base;
    (*codec_context).framerate = frame_rate;
    (*codec_context).pkt_timebase = time_base;
    (*codec_context).pix_fmt = ffmpeg::AVPixelFormat::AV_PIX_FMT_D3D11;
    (*codec_context).sw_pix_fmt = ffmpeg::AVPixelFormat::AV_PIX_FMT_NV12;
    // Derive matrix/range/siting from the bound converter, not mutable
    // environment or codec defaults. The BSF also enforces H264 VUI.
    (*codec_context).colorspace = ffmpeg::AVColorSpace::AVCOL_SPC_BT709;
    if conversion_mode.shader_mode().is_some() {
        (*codec_context).chroma_sample_location = ffmpeg::AVChromaLocation::AVCHROMA_LOC_CENTER;
    }
    (*codec_context).color_range = ffmpeg::AVColorRange::AVCOL_RANGE_MPEG;
    if conversion_mode.full_range() {
        (*codec_context).color_range = ffmpeg::AVColorRange::AVCOL_RANGE_JPEG;
    }
    if conversion_mode.bt601() {
        (*codec_context).colorspace = ffmpeg::AVColorSpace::AVCOL_SPC_BT470BG;
    }
    (*codec_context).color_primaries = ffmpeg::AVColorPrimaries::AVCOL_PRI_BT709;
    (*codec_context).color_trc = ffmpeg::AVColorTransferCharacteristic::AVCOL_TRC_GAMMA22;
    let target_bitrate_bps = settings.d3d11_target_bitrate_bps();
    (*codec_context).bit_rate = target_bitrate_bps.min(i64::MAX as u64) as i64;
    (*codec_context).rc_max_rate = target_bitrate_bps.saturating_mul(2).min(i64::MAX as u64) as i64;
    (*codec_context).rc_buffer_size = target_bitrate_bps.min(i32::MAX as u64) as i32;
    (*codec_context).gop_size = settings.fps.saturating_mul(2) as i32;
    (*codec_context).max_b_frames = 0;
    (*codec_context).flags |= ffmpeg::AV_CODEC_FLAG_GLOBAL_HEADER as i32;
    (*codec_context).hw_frames_ctx = ffmpeg::av_buffer_ref(hw_frames_ref);
    if (*codec_context).hw_frames_ctx.is_null() {
        let mut owned = codec_context;
        ffmpeg::avcodec_free_context(&mut owned);
        return Err(anyhow::anyhow!(
            "av_buffer_ref(hw_frames_ctx) returned null"
        ));
    }

    let mut options = codec_open_options(codec, settings)?;
    let open_result = check_ffmpeg(
        ffmpeg::avcodec_open2(codec_context, codec, &mut options),
        "avcodec_open2",
    );
    if !options.is_null() {
        ffmpeg::av_dict_free(&mut options);
    }
    if let Err(error) = open_result {
        let mut owned = codec_context;
        ffmpeg::avcodec_free_context(&mut owned);
        return Err(error);
    }

    Ok(codec_context)
}

unsafe fn codec_open_options(
    codec: *const ffmpeg::AVCodec,
    _settings: &EncoderSettings,
) -> anyhow::Result<*mut ffmpeg::AVDictionary> {
    let mut options: *mut ffmpeg::AVDictionary = ptr::null_mut();
    let codec_name = selected_codec_name(codec);
    if codec_name.ends_with("_mf") {
        set_codec_option(&mut options, "hw_encoding", "1")?;
        set_codec_option(&mut options, "scenario", "archive")?;
    } else if codec_name.ends_with("_nvenc") {
        set_codec_option(&mut options, "preset", "p7")?;
        set_codec_option(&mut options, "tune", "hq")?;
        set_codec_option(&mut options, "rc", "vbr")?;
        set_codec_option(&mut options, "cq", "16")?;
    } else if codec_name.ends_with("_amf") {
        set_codec_option(&mut options, "usage", "high_quality")?;
        set_codec_option(&mut options, "quality", "quality")?;
        set_codec_option(&mut options, "rc", "hqvbr")?;
    }

    Ok(options)
}

pub(crate) unsafe fn selected_codec_name(codec: *const ffmpeg::AVCodec) -> String {
    if codec.is_null() || (*codec).name.is_null() {
        return "<unknown>".to_string();
    }

    CStr::from_ptr((*codec).name).to_string_lossy().into_owned()
}

unsafe fn set_codec_option(
    options: &mut *mut ffmpeg::AVDictionary,
    key: &str,
    value: &str,
) -> anyhow::Result<()> {
    let key = CString::new(key)?;
    let value = CString::new(value)?;
    check_ffmpeg(
        ffmpeg::av_dict_set(options, key.as_ptr(), value.as_ptr(), 0),
        "av_dict_set(encoder option)",
    )
}

pub(crate) unsafe fn create_output_context(
    output: &str,
    codec_context: *mut ffmpeg::AVCodecContext,
    codec: *const ffmpeg::AVCodec,
    time_base: ffmpeg::AVRational,
    filtered_parameters: Option<*const ffmpeg::AVCodecParameters>,
) -> anyhow::Result<*mut ffmpeg::AVFormatContext> {
    let output = CString::new(output)?;
    let mut format_context: *mut ffmpeg::AVFormatContext = ptr::null_mut();
    check_ffmpeg(
        ffmpeg::avformat_alloc_output_context2(
            &mut format_context,
            ptr::null(),
            ptr::null(),
            output.as_ptr(),
        ),
        "avformat_alloc_output_context2",
    )?;
    if format_context.is_null() {
        return Err(anyhow::anyhow!(
            "avformat_alloc_output_context2 returned null"
        ));
    }

    let stream = ffmpeg::avformat_new_stream(format_context, codec);
    if stream.is_null() {
        ffmpeg::avformat_free_context(format_context);
        return Err(anyhow::anyhow!("avformat_new_stream returned null"));
    }
    (*stream).time_base = time_base;
    (*stream).avg_frame_rate = ffmpeg::AVRational {
        num: time_base.den,
        den: time_base.num,
    };

    if ((*(*format_context).oformat).flags & ffmpeg::AVFMT_GLOBALHEADER) != 0 {
        (*codec_context).flags |= ffmpeg::AV_CODEC_FLAG_GLOBAL_HEADER as i32;
    }

    if let Err(error) = check_ffmpeg(
        match filtered_parameters {
            Some(parameters) => ffmpeg::avcodec_parameters_copy((*stream).codecpar, parameters),
            None => ffmpeg::avcodec_parameters_from_context((*stream).codecpar, codec_context),
        },
        "avcodec_parameters_from_context",
    ) {
        ffmpeg::avformat_free_context(format_context);
        return Err(error);
    }

    if ((*(*format_context).oformat).flags & ffmpeg::AVFMT_NOFILE) == 0 {
        if let Err(error) = check_ffmpeg(
            ffmpeg::avio_open(
                &mut (*format_context).pb,
                output.as_ptr(),
                ffmpeg::AVIO_FLAG_WRITE,
            ),
            "avio_open",
        ) {
            ffmpeg::avformat_free_context(format_context);
            return Err(error);
        }
    }

    if let Err(error) = check_ffmpeg(
        ffmpeg::avformat_write_header(format_context, ptr::null_mut()),
        "avformat_write_header",
    ) {
        if !(*format_context).pb.is_null()
            && ((*(*format_context).oformat).flags & ffmpeg::AVFMT_NOFILE) == 0
        {
            ffmpeg::avio_closep(&mut (*format_context).pb);
        }
        ffmpeg::avformat_free_context(format_context);
        return Err(error);
    }

    Ok(format_context)
}

pub(crate) unsafe fn first_stream(
    format_context: *mut ffmpeg::AVFormatContext,
) -> anyhow::Result<*mut ffmpeg::AVStream> {
    if (*format_context).nb_streams == 0 || (*format_context).streams.is_null() {
        return Err(anyhow::anyhow!("output format has no video stream"));
    }

    let stream = *(*format_context).streams;
    if stream.is_null() {
        return Err(anyhow::anyhow!("output video stream is unavailable"));
    }
    Ok(stream)
}

pub(crate) unsafe fn allocate_packet() -> anyhow::Result<*mut ffmpeg::AVPacket> {
    let packet = ffmpeg::av_packet_alloc();
    if packet.is_null() {
        return Err(anyhow::anyhow!("av_packet_alloc returned null"));
    }
    Ok(packet)
}

pub(crate) unsafe fn create_encoder_frame(
    video_processor: &mut D3D11VideoProcessorConverter,
    texture: &ID3D11Texture2D,
    source_rect: TextureSourceRect,
    hw_frames_ref: *mut ffmpeg::AVBufferRef,
    width: u32,
    height: u32,
    pts: i64,
) -> anyhow::Result<(OwnedFrame, u128)> {
    let frame = ffmpeg::av_frame_alloc();
    if frame.is_null() {
        return Err(anyhow::anyhow!("av_frame_alloc returned null"));
    }

    let frame = OwnedFrame { frame };
    (*frame.frame).format = ffmpeg::AVPixelFormat::AV_PIX_FMT_D3D11 as i32;
    (*frame.frame).width = width as i32;
    (*frame.frame).height = height as i32;
    check_ffmpeg(
        ffmpeg::av_hwframe_get_buffer(hw_frames_ref, frame.frame, 0),
        "av_hwframe_get_buffer",
    )?;
    (*frame.frame).pts = pts;
    (*frame.frame).colorspace = ffmpeg::AVColorSpace::AVCOL_SPC_BT709;
    if video_processor.shader_mode().is_some() {
        (*frame.frame).chroma_location = ffmpeg::AVChromaLocation::AVCHROMA_LOC_CENTER;
    }
    (*frame.frame).color_range = ffmpeg::AVColorRange::AVCOL_RANGE_MPEG;
    if video_processor.mode().full_range() {
        (*frame.frame).color_range = ffmpeg::AVColorRange::AVCOL_RANGE_JPEG;
    }
    if video_processor.mode().bt601() {
        (*frame.frame).colorspace = ffmpeg::AVColorSpace::AVCOL_SPC_BT470BG;
    }
    (*frame.frame).color_primaries = ffmpeg::AVColorPrimaries::AVCOL_PRI_BT709;
    (*frame.frame).color_trc = ffmpeg::AVColorTransferCharacteristic::AVCOL_TRC_GAMMA22;
    let conversion_started_at = Instant::now();
    video_processor.convert_bgra_texture_to_encoder_frame(texture, source_rect, &frame)?;
    Ok((frame, conversion_started_at.elapsed().as_millis()))
}

pub(crate) fn validate_source_rect(
    texture_width: u32,
    texture_height: u32,
    source_rect: TextureSourceRect,
) -> anyhow::Result<()> {
    let right = source_rect
        .left
        .checked_add(source_rect.width)
        .ok_or_else(|| anyhow::anyhow!("D3D11 source rect overflow"))?;
    let bottom = source_rect
        .top
        .checked_add(source_rect.height)
        .ok_or_else(|| anyhow::anyhow!("D3D11 source rect overflow"))?;
    if source_rect.width == 0
        || source_rect.height == 0
        || right > texture_width
        || bottom > texture_height
    {
        return Err(anyhow::anyhow!(
            "D3D11 source rect {} {} {} {} exceeded texture {}x{}",
            source_rect.left,
            source_rect.top,
            source_rect.width,
            source_rect.height,
            texture_width,
            texture_height
        ));
    }

    Ok(())
}

pub(crate) fn check_ffmpeg(ret: i32, context: &str) -> anyhow::Result<()> {
    if ret >= 0 {
        return Ok(());
    }

    Err(ffmpeg_error(ret, context))
}

fn ffmpeg_error(ret: i32, context: &str) -> anyhow::Error {
    let mut buffer = [0_i8; 256];
    unsafe {
        let message = if ffmpeg::av_strerror(ret, buffer.as_mut_ptr(), buffer.len()) == 0 {
            CStr::from_ptr(buffer.as_ptr())
                .to_string_lossy()
                .into_owned()
        } else {
            "unknown FFmpeg error".to_string()
        };
        anyhow::anyhow!("{context} failed: {message} ({ret})")
    }
}
