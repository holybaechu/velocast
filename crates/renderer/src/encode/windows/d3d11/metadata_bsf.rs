//! Encoded H.264 metadata only. This module never receives pixel/texture data.
use super::{frames::check_ffmpeg, shader_converter::ShaderMode};
use anyhow::ensure;
use ffmpeg_sys_next as ffmpeg;
use std::{
    ffi::{c_char, c_void, CString},
    ptr,
};

// ffmpeg-sys-next 8.1 omits libavcodec/bsf.h. This is its public, stable
// AVBSFContext ABI, verified against the linked FFmpeg 8 headers.
#[repr(C)]
struct BsfContext {
    av_class: *const ffmpeg::AVClass,
    filter: *const c_void,
    priv_data: *mut c_void,
    par_in: *mut ffmpeg::AVCodecParameters,
    par_out: *mut ffmpeg::AVCodecParameters,
    time_base_in: ffmpeg::AVRational,
    time_base_out: ffmpeg::AVRational,
}
#[link(name = "avcodec")]
extern "C" {
    fn av_bsf_get_by_name(name: *const c_char) -> *const c_void;
    fn av_bsf_alloc(filter: *const c_void, context: *mut *mut BsfContext) -> i32;
    fn av_bsf_init(context: *mut BsfContext) -> i32;
    fn av_bsf_send_packet(context: *mut BsfContext, packet: *mut ffmpeg::AVPacket) -> i32;
    fn av_bsf_receive_packet(context: *mut BsfContext, packet: *mut ffmpeg::AVPacket) -> i32;
    fn av_bsf_free(context: *mut *mut BsfContext);
}
pub(crate) struct MetadataBsf {
    context: *mut BsfContext,
}
impl MetadataBsf {
    pub(crate) unsafe fn new(
        codec: *const ffmpeg::AVCodecContext,
        mode: ShaderMode,
    ) -> anyhow::Result<Self> {
        ensure!(
            (*codec).codec_id == ffmpeg::AVCodecID::AV_CODEC_ID_H264,
            "centered shader metadata filter supports H264 only"
        );
        let filter = av_bsf_get_by_name(c"h264_metadata".as_ptr());
        ensure!(
            !filter.is_null(),
            "required h264_metadata bitstream filter unavailable"
        );
        let mut owned = Self {
            context: ptr::null_mut(),
        };
        check_ffmpeg(
            av_bsf_alloc(filter, &mut owned.context),
            "av_bsf_alloc(h264_metadata)",
        )?;
        ensure!(!owned.context.is_null(), "av_bsf_alloc returned null");
        let context = owned.context;
        check_ffmpeg(
            ffmpeg::avcodec_parameters_from_context((*context).par_in, codec),
            "copy h264_metadata input parameters",
        )?;
        (*context).time_base_in = (*codec).time_base;
        // Do not trust MF to preserve requested VUI. Rewrite both initial
        // SPS/extradata and subsequent in-band SPS consistently with pixels.
        for (name, value) in metadata_options(mode) {
            let name = CString::new(name)?;
            check_ffmpeg(
                ffmpeg::av_opt_set_int((*context).priv_data, name.as_ptr(), value, 0),
                "set h264_metadata VUI option",
            )?;
        }
        check_ffmpeg(av_bsf_init(owned.context), "av_bsf_init(h264_metadata)")?;
        (*(*context).par_out).chroma_location = ffmpeg::AVChromaLocation::AVCHROMA_LOC_CENTER;
        (*(*context).par_out).color_range = if mode.full_range() {
            ffmpeg::AVColorRange::AVCOL_RANGE_JPEG
        } else {
            ffmpeg::AVColorRange::AVCOL_RANGE_MPEG
        };
        (*(*context).par_out).color_space = if mode.full_range() {
            ffmpeg::AVColorSpace::AVCOL_SPC_BT470BG
        } else {
            ffmpeg::AVColorSpace::AVCOL_SPC_BT709
        };
        (*(*context).par_out).color_primaries = ffmpeg::AVColorPrimaries::AVCOL_PRI_BT709;
        (*(*context).par_out).color_trc = ffmpeg::AVColorTransferCharacteristic::AVCOL_TRC_GAMMA22;
        Ok(owned)
    }
    pub(crate) unsafe fn parameters(&self) -> *const ffmpeg::AVCodecParameters {
        (*self.context).par_out
    }
    pub(crate) unsafe fn time_base(&self) -> ffmpeg::AVRational {
        (*self.context).time_base_out
    }
    /// Success transfers the input packet reference to the BSF. A null packet
    /// signals EOF; each send must be followed by a complete receive drain.
    pub(crate) unsafe fn send(&self, packet: *mut ffmpeg::AVPacket) -> anyhow::Result<()> {
        check_ffmpeg(
            av_bsf_send_packet(self.context, packet),
            "av_bsf_send_packet(h264_metadata)",
        )
    }
    pub(crate) unsafe fn receive(&self, packet: *mut ffmpeg::AVPacket) -> i32 {
        av_bsf_receive_packet(self.context, packet)
    }
}
impl Drop for MetadataBsf {
    fn drop(&mut self) {
        unsafe {
            av_bsf_free(&mut self.context);
        }
    }
}
fn metadata_options(mode: ShaderMode) -> [(&'static str, i64); 5] {
    [
        ("chroma_sample_loc_type", 1),
        ("video_full_range_flag", i64::from(mode.full_range())),
        ("matrix_coefficients", if mode.full_range() { 5 } else { 1 }),
        ("colour_primaries", 1),
        ("transfer_characteristics", 4),
    ]
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_bsf_public_abi_layout() {
        let pointer = std::mem::size_of::<*const c_void>();
        assert_eq!(std::mem::offset_of!(BsfContext, av_class), 0);
        assert_eq!(std::mem::offset_of!(BsfContext, filter), pointer);
        assert_eq!(std::mem::offset_of!(BsfContext, priv_data), 2 * pointer);
        assert_eq!(std::mem::offset_of!(BsfContext, par_in), 3 * pointer);
        assert_eq!(std::mem::offset_of!(BsfContext, par_out), 4 * pointer);
        assert_eq!(std::mem::offset_of!(BsfContext, time_base_in), 5 * pointer);
        assert_eq!(
            std::mem::offset_of!(BsfContext, time_base_out),
            5 * pointer + 8
        );
        assert_eq!(std::mem::size_of::<BsfContext>(), 5 * pointer + 16);
    }
    #[test]
    fn metadata_options_match_shader_pixels() {
        assert_eq!(
            metadata_options(ShaderMode::Bt601FullCenter),
            [
                ("chroma_sample_loc_type", 1),
                ("video_full_range_flag", 1),
                ("matrix_coefficients", 5),
                ("colour_primaries", 1),
                ("transfer_characteristics", 4)
            ]
        );
        assert_eq!(
            metadata_options(ShaderMode::Bt709StudioCenter)[1],
            ("video_full_range_flag", 0)
        );
    }
    #[test]
    fn metadata_cpu_init_flush_and_unsupported_codec() {
        unsafe {
            let mut codec = ffmpeg::avcodec_alloc_context3(ptr::null());
            assert!(!codec.is_null());
            (*codec).codec_id = ffmpeg::AVCodecID::AV_CODEC_ID_HEVC;
            assert!(MetadataBsf::new(codec, ShaderMode::Bt601FullCenter).is_err());
            (*codec).codec_id = ffmpeg::AVCodecID::AV_CODEC_ID_H264;
            (*codec).time_base = ffmpeg::AVRational { num: 1, den: 60 };
            (*codec).codec_type = ffmpeg::AVMediaType::AVMEDIA_TYPE_VIDEO;
            let bsf = MetadataBsf::new(codec, ShaderMode::Bt601FullCenter).unwrap();
            assert_eq!(
                (*bsf.parameters()).chroma_location,
                ffmpeg::AVChromaLocation::AVCHROMA_LOC_CENTER
            );
            assert_eq!(
                (*bsf.parameters()).color_range,
                ffmpeg::AVColorRange::AVCOL_RANGE_JPEG
            );
            let mut packet = ffmpeg::av_packet_alloc();
            assert!(!packet.is_null());
            bsf.send(ptr::null_mut()).unwrap();
            assert_eq!(bsf.receive(packet), ffmpeg::AVERROR_EOF);
            ffmpeg::av_packet_free(&mut packet);
            ffmpeg::avcodec_free_context(&mut codec);
        }
    }
}
