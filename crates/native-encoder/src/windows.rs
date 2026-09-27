use crate::settings::{ColorSpace, Config, Frame};
use anyhow::{ensure, Context, Result};
use ffmpeg_sys_next as ff;
use std::{
    collections::VecDeque,
    ffi::{c_void, CStr, CString},
    ptr,
    time::Instant,
};
use windows::{
    core::Interface,
    Win32::{
        Foundation::{HANDLE, S_OK},
        Graphics::{
            Direct3D11::*,
            Dxgi::Common::DXGI_FORMAT_NV12,
            Dxgi::{IDXGIDevice, IDXGIKeyedMutex},
        },
        System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED},
    },
};

const EAGAIN: i32 = -11;
const MAX_RETAINED_FRAMES: usize = 32;

// Public FFmpeg ABI from libavutil/hwcontext_d3d11va.h (not emitted by bindgen).
#[repr(C)]
struct DeviceContext {
    device: *mut c_void,
    context: *mut c_void,
    video_device: *mut c_void,
    video_context: *mut c_void,
    lock: Option<unsafe extern "C" fn(*mut c_void)>,
    unlock: Option<unsafe extern "C" fn(*mut c_void)>,
    lock_ctx: *mut c_void,
}
#[repr(C)]
struct FramesContext {
    texture: *mut c_void,
    bind_flags: u32,
    misc_flags: u32,
    texture_infos: *mut c_void,
}

struct Apartment;
impl Apartment {
    unsafe fn new() -> Result<Self> {
        CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}
struct OwnedFrame(*mut ff::AVFrame);
impl Drop for OwnedFrame {
    fn drop(&mut self) {
        unsafe {
            ff::av_frame_free(&mut self.0);
        }
    }
}
struct KeyedLock(Option<IDXGIKeyedMutex>);
impl Drop for KeyedLock {
    fn drop(&mut self) {
        unsafe {
            if let Some(mutex) = self.0.take() {
                let _ = mutex.ReleaseSync(0);
            }
        }
    }
}

pub struct Encoder {
    config: Config,
    device: Option<ID3D11Device>,
    context: Option<ID3D11DeviceContext>,
    hw_device: *mut ff::AVBufferRef,
    hw_frames: *mut ff::AVBufferRef,
    qsv_device: *mut ff::AVBufferRef,
    qsv_frames: *mut ff::AVBufferRef,
    codec: *mut ff::AVCodecContext,
    format: *mut ff::AVFormatContext,
    packet: *mut ff::AVPacket,
    retained: VecDeque<OwnedFrame>,
    encoder: String,
    adapter: String,
    submitted: u64,
    packets: u64,
    last_frame: Option<u64>,
    completed: bool,
    owns_output: bool,
    // Last field: COM must outlive all owned interfaces and FFmpeg contexts.
    _apartment: Apartment,
}

impl Encoder {
    pub fn open(config: Config) -> Result<Self> {
        unsafe {
            config.validate()?;
            ensure!(
                !std::path::Path::new(&config.output).exists(),
                "staged output already exists"
            );
            let mut enc = Self {
                config,
                device: None,
                context: None,
                hw_device: ptr::null_mut(),
                hw_frames: ptr::null_mut(),
                qsv_device: ptr::null_mut(),
                qsv_frames: ptr::null_mut(),
                codec: ptr::null_mut(),
                format: ptr::null_mut(),
                packet: ptr::null_mut(),
                retained: VecDeque::new(),
                encoder: String::new(),
                adapter: String::new(),
                submitted: 0,
                packets: 0,
                last_frame: None,
                completed: false,
                owns_output: false,
                _apartment: Apartment::new()?,
            };
            check(
                ff::av_hwdevice_ctx_create(
                    &mut enc.hw_device,
                    ff::AVHWDeviceType::AV_HWDEVICE_TYPE_D3D11VA,
                    ptr::null(),
                    ptr::null_mut(),
                    0,
                ),
                "create D3D11 hardware device",
            )?;
            let hw = (*enc.hw_device).data as *mut ff::AVHWDeviceContext;
            let d3d = (*hw).hwctx as *mut DeviceContext;
            ensure!(!d3d.is_null(), "missing D3D11 context");
            enc.device = ID3D11Device::from_raw_borrowed(&(*d3d).device).cloned();
            enc.context = ID3D11DeviceContext::from_raw_borrowed(&(*d3d).context).cloned();
            let device = enc.device.as_ref().context("missing D3D11 device")?;
            ensure!(enc.context.is_some(), "missing immediate context");
            // FFmpeg enables ID3D10Multithread protection when available. Enforce
            // it here as well: codec workers share this immediate context with
            // our direct copy/query calls, which do not take FFmpeg's own mutex.
            let multithread: ID3D11Multithread = enc
                .context
                .as_ref()
                .unwrap()
                .cast()
                .context("D3D11 immediate context requires multithread protection")?;
            let _ = multithread.SetMultithreadProtected(true);
            ensure!(
                multithread.GetMultithreadProtected().as_bool(),
                "D3D11 immediate-context multithread protection is unavailable"
            );
            let dxgi: IDXGIDevice = device.cast()?;
            let desc = dxgi.GetAdapter()?.GetDesc()?;
            enc.adapter = String::from_utf16_lossy(
                &desc.Description[..desc
                    .Description
                    .iter()
                    .position(|v| *v == 0)
                    .unwrap_or(desc.Description.len())],
            );
            enc.hw_frames = ff::av_hwframe_ctx_alloc(enc.hw_device);
            ensure!(!enc.hw_frames.is_null(), "allocate hardware frame context");
            let frames = (*enc.hw_frames).data as *mut ff::AVHWFramesContext;
            (*frames).format = ff::AVPixelFormat::AV_PIX_FMT_D3D11;
            (*frames).sw_format = ff::AVPixelFormat::AV_PIX_FMT_NV12;
            // Hardware codec surfaces use macroblock-aligned allocation; the
            // codec and AVFrame visible dimensions remain the requested size.
            (*frames).width = enc.config.width.div_ceil(32) as i32 * 32;
            (*frames).height = enc.config.height.div_ceil(32) as i32 * 32;
            (*frames).initial_pool_size = 0;
            let d3d_frames = (*frames).hwctx as *mut FramesContext;
            (*d3d_frames).bind_flags =
                (D3D11_BIND_VIDEO_ENCODER.0 | D3D11_BIND_RENDER_TARGET.0) as u32;
            check(
                ff::av_hwframe_ctx_init(enc.hw_frames),
                "initialize NV12 hardware frames",
            )?;
            // Prefer the adapter's hardware encoder. Never select a CPU encoder.
            let candidates = match desc.VendorId {
                0x8086 => ["h264_qsv", "h264_nvenc", "h264_amf"],
                0x10de => ["h264_nvenc", "h264_amf", "h264_qsv"],
                _ => ["h264_amf", "h264_qsv", "h264_nvenc"],
            };
            let mut failures = Vec::new();
            for candidate in candidates {
                match enc.open_codec(candidate) {
                    Ok(()) => {
                        enc.encoder = candidate.into();
                        break;
                    }
                    Err(e) => {
                        failures.push(format!("{candidate}: {e:#}"));
                        ff::avcodec_free_context(&mut enc.codec);
                    }
                }
            }
            ensure!(
                !enc.codec.is_null(),
                "no hardware H264 encoder available: {}",
                failures.join("; ")
            );
            let output = CString::new(enc.config.output.as_str())?;
            let mp4 = CString::new("mp4")?;
            check(
                ff::avformat_alloc_output_context2(
                    &mut enc.format,
                    ptr::null(),
                    mp4.as_ptr(),
                    output.as_ptr(),
                ),
                "allocate MP4 muxer",
            )?;
            ensure!(!enc.format.is_null(), "missing MP4 muxer");
            let stream = ff::avformat_new_stream(enc.format, ptr::null());
            ensure!(!stream.is_null(), "allocate video stream");
            (*stream).time_base = (*enc.codec).time_base;
            (*stream).avg_frame_rate = (*enc.codec).framerate;
            check(
                ff::avcodec_parameters_from_context((*stream).codecpar, enc.codec),
                "copy video parameters",
            )?;
            // Reserve the staging path atomically before FFmpeg opens it.
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&enc.config.output)?;
            enc.owns_output = true;
            check(
                ff::avio_open(&mut (*enc.format).pb, output.as_ptr(), ff::AVIO_FLAG_WRITE),
                "open MP4 output",
            )?;
            check(
                ff::avformat_write_header(enc.format, ptr::null_mut()),
                "write MP4 header",
            )?;
            enc.packet = ff::av_packet_alloc();
            ensure!(!enc.packet.is_null(), "allocate packet");
            Ok(enc)
        }
    }

    unsafe fn open_codec(&mut self, name: &str) -> Result<()> {
        let qsv = name == "h264_qsv";
        if qsv {
            check(
                ff::av_hwdevice_ctx_create_derived(
                    &mut self.qsv_device,
                    ff::AVHWDeviceType::AV_HWDEVICE_TYPE_QSV,
                    self.hw_device,
                    0,
                ),
                "derive QSV device from D3D11",
            )?;
            check(
                ff::av_hwframe_ctx_create_derived(
                    &mut self.qsv_frames,
                    ff::AVPixelFormat::AV_PIX_FMT_QSV,
                    self.qsv_device,
                    self.hw_frames,
                    ff::AV_HWFRAME_MAP_READ as i32 | ff::AV_HWFRAME_MAP_DIRECT as i32,
                ),
                "derive direct QSV hardware frame mapping",
            )?;
        }
        let name = CString::new(name)?;
        let codec = ff::avcodec_find_encoder_by_name(name.as_ptr());
        ensure!(!codec.is_null(), "encoder missing from FFmpeg");
        self.codec = ff::avcodec_alloc_context3(codec);
        ensure!(!self.codec.is_null(), "allocate encoder");
        let c = &mut *self.codec;
        c.width = self.config.width as i32;
        c.height = self.config.height as i32;
        c.time_base = ff::AVRational {
            num: 1,
            den: self.config.fps as i32,
        };
        c.pkt_timebase = c.time_base;
        c.framerate = ff::AVRational {
            num: self.config.fps as i32,
            den: 1,
        };
        c.pix_fmt = if qsv {
            ff::AVPixelFormat::AV_PIX_FMT_QSV
        } else {
            ff::AVPixelFormat::AV_PIX_FMT_D3D11
        };
        c.sw_pix_fmt = ff::AVPixelFormat::AV_PIX_FMT_NV12;
        c.color_primaries = ff::AVColorPrimaries::AVCOL_PRI_BT709;
        c.color_trc = ff::AVColorTransferCharacteristic::AVCOL_TRC_BT709;
        c.colorspace = ff::AVColorSpace::AVCOL_SPC_BT709;
        c.color_range = ff::AVColorRange::AVCOL_RANGE_MPEG;
        c.bit_rate = self.bitrate() as i64;
        c.rc_max_rate = c.bit_rate;
        c.rc_buffer_size = c.bit_rate.min(i32::MAX as i64) as i32;
        c.gop_size = (self.config.fps * 2) as i32;
        c.max_b_frames = 0;
        c.flags |= ff::AV_CODEC_FLAG_GLOBAL_HEADER as i32;
        c.hw_frames_ctx = ff::av_buffer_ref(if qsv { self.qsv_frames } else { self.hw_frames });
        ensure!(!c.hw_frames_ctx.is_null(), "retain hardware context");
        let mut options = ptr::null_mut();
        if name.to_bytes() == b"h264_qsv" {
            option(&mut options, "async_depth", "1")?;
            option(&mut options, "look_ahead", "0")?;
        }
        let result = check(
            ff::avcodec_open2(self.codec, codec, &mut options),
            "open hardware H264 encoder",
        );
        ff::av_dict_free(&mut options);
        result
    }

    fn bitrate(&self) -> u64 {
        self.config.bitrate_bps.unwrap_or(
            (self.config.width as u64 * self.config.height as u64 * self.config.fps as u64 / 6)
                .clamp(1_000_000, 200_000_000),
        )
    }
    pub fn report(&self) -> String {
        serde_json::json!({"captureBackend":"electron_native_nv12","conversionBackend":"d3d11_nv12_copy","encoder":self.encoder,"adapter":self.adapter,"width":self.config.width,"height":self.config.height,"fps":self.config.fps,"bitrateBps":self.bitrate(),"pixelFormat":"nv12","colorSpace":ColorSpace::rec709(),"submittedFrames":self.submitted,"encodedPackets":self.packets,"gpuCopies":self.submitted,"cpuReadbackFrames":0,"cpuReadbackBytes":0,"rawFrameIpcBytes":0,"queueCapacity":2}).to_string()
    }

    pub fn encode(&mut self, source: Frame) -> Result<String> {
        unsafe {
            source.validate(&self.config, self.submitted, self.last_frame)?;
            ensure!(
                self.retained.len() < MAX_RETAINED_FRAMES,
                "hardware encoder retained too many frames without producing packets"
            );
            let started = Instant::now();
            let device = self.device.as_ref().unwrap();
            let device1: ID3D11Device1 = device.cast()?;
            let imported: ID3D11Texture2D = device1
                .OpenSharedResource1(HANDLE(source.handle_value()? as *mut c_void))
                .context("open Electron same-process NT texture (adapter must match)")?;
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            imported.GetDesc(&mut desc);
            ensure!(
                desc.Format == DXGI_FORMAT_NV12
                    && desc.Width == source.texture_width
                    && desc.Height == source.texture_height
                    && desc.ArraySize == 1
                    && desc.MipLevels == 1
                    && desc.SampleDesc.Count == 1,
                "shared texture descriptor differs from NV12 frame metadata"
            );
            ensure!(
                desc.MiscFlags & D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX.0 as u32 != 0,
                "Electron texture requires keyed mutex synchronization"
            );
            let mutex: IDXGIKeyedMutex = imported.cast()?;
            let frame = OwnedFrame(ff::av_frame_alloc());
            ensure!(!frame.0.is_null(), "allocate AVFrame");
            check(
                ff::av_hwframe_get_buffer(self.hw_frames, frame.0, 0),
                "allocate owned NV12 encoder texture",
            )?;
            (*frame.0).pts = source.pts;
            (*frame.0).width = self.config.width as i32;
            (*frame.0).height = self.config.height as i32;
            (*frame.0).color_primaries = ff::AVColorPrimaries::AVCOL_PRI_BT709;
            (*frame.0).color_trc = ff::AVColorTransferCharacteristic::AVCOL_TRC_BT709;
            (*frame.0).colorspace = ff::AVColorSpace::AVCOL_SPC_BT709;
            (*frame.0).color_range = ff::AVColorRange::AVCOL_RANGE_MPEG;
            let raw = (*frame.0).data[0] as *mut c_void;
            let target =
                ID3D11Texture2D::from_raw_borrowed(&raw).context("AVFrame has no D3D11 texture")?;
            let context = self.context.as_ref().unwrap();
            let mut query = None;
            device.CreateQuery(
                &D3D11_QUERY_DESC {
                    Query: D3D11_QUERY_EVENT,
                    MiscFlags: 0,
                },
                Some(&mut query),
            )?;
            let query = query.context("create GPU completion query")?;
            let import_ms = started.elapsed().as_secs_f64() * 1000.0;
            let wait_started = Instant::now();
            // Chromium uses key zero for BOTH acquisition and release. WAIT_TIMEOUT and
            // WAIT_ABANDONED are nonnegative HRESULTs, so require exact S_OK.
            let hr = (Interface::vtable(&mutex).AcquireSync)(Interface::as_raw(&mutex), 0, 5000);
            ensure!(hr == S_OK, "AcquireSync(0) failed or timed out: {hr:?}");
            let mut guard = KeyedLock(Some(mutex));
            let rect = &source.source_rect;
            let bounds = D3D11_BOX {
                left: rect.left,
                top: rect.top,
                front: 0,
                right: rect.left + rect.width,
                bottom: rect.top + rect.height,
                back: 1,
            };
            context.CopySubresourceRegion(
                target,
                (*frame.0).data[1] as usize as u32,
                0,
                0,
                0,
                &imported,
                0,
                Some(&bounds),
            );
            context.End(&query);
            context.Flush();
            // Never let a timeout/cancellation release the JS lease while commands can
            // still read it. A completed query or removed device is the safe boundary.
            loop {
                let mut complete = 0u32;
                let status = (Interface::vtable(context).GetData)(
                    Interface::as_raw(context),
                    Interface::as_raw(&query),
                    (&mut complete as *mut u32).cast(),
                    4,
                    0,
                );
                if status == S_OK && complete != 0 {
                    break;
                }
                if status.is_err() {
                    device
                        .GetDeviceRemovedReason()
                        .context("GPU removed during NV12 copy")?;
                }
                device
                    .GetDeviceRemovedReason()
                    .context("GPU removed during NV12 copy")?;
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            guard
                .0
                .as_ref()
                .unwrap()
                .ReleaseSync(0)
                .context("release shared NV12 keyed mutex")?;
            guard.0.take();
            let wait_ms = wait_started.elapsed().as_secs_f64() * 1000.0;
            let packet_started = Instant::now();
            let frame = if self.encoder == "h264_qsv" {
                let mapped = OwnedFrame(ff::av_frame_alloc());
                ensure!(!mapped.0.is_null(), "allocate QSV AVFrame");
                (*mapped.0).format = ff::AVPixelFormat::AV_PIX_FMT_QSV as i32;
                (*mapped.0).hw_frames_ctx = ff::av_buffer_ref(self.qsv_frames);
                ensure!(
                    !(*mapped.0).hw_frames_ctx.is_null(),
                    "retain QSV hardware context"
                );
                check(
                    ff::av_hwframe_map(
                        mapped.0,
                        frame.0,
                        ff::AV_HWFRAME_MAP_READ as i32 | ff::AV_HWFRAME_MAP_DIRECT as i32,
                    ),
                    "map owned D3D11 NV12 texture directly to QSV",
                )?;
                check(
                    ff::av_frame_copy_props(mapped.0, frame.0),
                    "copy QSV frame color and timing",
                )?;
                // The hardware mapping retains the source frame's texture.
                mapped
            } else {
                frame
            };
            let mut result = ff::avcodec_send_frame(self.codec, frame.0);
            if result == EAGAIN {
                self.drain(false)?;
                result = ff::avcodec_send_frame(self.codec, frame.0);
            }
            check(result, "send owned NV12 frame")?;
            self.retained.push_back(frame);
            self.submitted += 1;
            self.last_frame = Some(source.frame);
            self.drain(false)?;
            Ok(serde_json::json!({"gpuImportMs":import_ms,"gpuSyncWaitMs":wait_ms,"packetWriteMs":packet_started.elapsed().as_secs_f64()*1000.0,"gpuCopies":1,"cpuReadbackBytes":0,"pts":source.pts}).to_string())
        }
    }

    unsafe fn drain(&mut self, flushing: bool) -> Result<()> {
        loop {
            let result = ff::avcodec_receive_packet(self.codec, self.packet);
            if result == ff::AVERROR_EOF {
                return Ok(());
            }
            if result == EAGAIN {
                ensure!(!flushing, "encoder requested input after flush");
                return Ok(());
            }
            check(result, "receive encoded packet")?;
            // max_b_frames=0: packet PTS identifies the input whose hardware work
            // has completed. FFmpeg also retains its own AVBufferRef as required.
            let pts = (*self.packet).pts;
            while self
                .retained
                .front()
                .is_some_and(|frame| (*frame.0).pts <= pts)
            {
                self.retained.pop_front();
            }
            let stream = *(*self.format).streams;
            ff::av_packet_rescale_ts(self.packet, (*self.codec).time_base, (*stream).time_base);
            (*self.packet).stream_index = (*stream).index;
            let result = ff::av_interleaved_write_frame(self.format, self.packet);
            ff::av_packet_unref(self.packet);
            check(result, "mux H264 packet")?;
            self.packets += 1;
        }
    }

    pub fn finish(&mut self) -> Result<String> {
        unsafe {
            ensure!(self.submitted > 0, "cannot finish an empty recording");
            ensure!(
                self.config
                    .expected_frames
                    .is_none_or(|n| n == self.submitted),
                "recording frame count differs from expectedFrames"
            );
            self.drain(false)?;
            check(
                ff::avcodec_send_frame(self.codec, ptr::null()),
                "flush H264 encoder",
            )?;
            self.drain(true)?;
            ensure!(
                self.packets == self.submitted,
                "encoded packet count differs from submitted frames"
            );
            check(ff::av_write_trailer(self.format), "finish MP4 output")?;
            check(ff::avio_closep(&mut (*self.format).pb), "close MP4 output")?;
            self.completed = true;
            Ok(self.report())
        }
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        unsafe {
            ff::avcodec_free_context(&mut self.codec);
            self.retained.clear();
            ff::av_packet_free(&mut self.packet);
            if !self.format.is_null() {
                if !(*self.format).pb.is_null() {
                    ff::avio_closep(&mut (*self.format).pb);
                }
                ff::avformat_free_context(self.format);
            }
            ff::av_buffer_unref(&mut self.hw_frames);
            ff::av_buffer_unref(&mut self.qsv_frames);
            ff::av_buffer_unref(&mut self.qsv_device);
            ff::av_buffer_unref(&mut self.hw_device);
            if self.owns_output && !self.completed {
                let _ = std::fs::remove_file(&self.config.output);
            }
        }
    }
}

unsafe fn option(options: &mut *mut ff::AVDictionary, key: &str, value: &str) -> Result<()> {
    let key = CString::new(key)?;
    let value = CString::new(value)?;
    check(
        ff::av_dict_set(options, key.as_ptr(), value.as_ptr(), 0),
        "set encoder option",
    )
}
fn check(code: i32, operation: &str) -> Result<()> {
    if code >= 0 {
        return Ok(());
    }
    let mut message = [0i8; 256];
    unsafe {
        ff::av_strerror(code, message.as_mut_ptr(), message.len());
    }
    anyhow::bail!(
        "{operation}: {} ({code})",
        unsafe { CStr::from_ptr(message.as_ptr()) }.to_string_lossy()
    )
}
