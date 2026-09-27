//! Dynamically loaded Vulkan discovery and a Vulkan-owned NV12 frame pool.
//! This crate does not imply that a Vulkan video encoder is available.

use ash::{vk, Entry};
use serde::Serialize;
use std::ffi::{CStr, CString};

mod pool;
pub use pool::{ColorSpec, FrameDescriptor, FramePool, PoolError};

#[derive(Debug, Serialize)]
pub struct DeviceReport {
    pub index: usize,
    pub name: String,
    pub vendor_id: u32,
    pub device_id: u32,
    pub driver_version: u32,
    pub api_version: String,
    pub uuid: String,
    pub duplicate_of_index: Option<usize>,
    pub queue_families: Vec<QueueReport>,
    pub extensions: Vec<String>,
    pub nv12_optimal_transfer_src: bool,
    pub nv12_optimal_transfer_dst: bool,
    pub nv12_image_usable: Option<bool>,
    pub video_encode_extension_present: bool,
    pub h264_encode_extension_present: bool,
    pub h265_encode_extension_present: bool,
    pub video_encode_queue_present: bool,
    pub h264_profile_format_usable: Option<bool>,
    pub windows_d3d11_nt_nv12_import: Option<WindowsImportReport>,
    pub rejection_reasons: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct WindowsImportReport {
    pub handle_type: &'static str,
    pub format: &'static str,
    pub usage: &'static str,
    pub keyed_mutex_extension_present: bool,
    pub external_memory_win32_extension_present: bool,
    pub format_query_supported: bool,
    pub importable: bool,
    pub dedicated_allocation_required: bool,
    pub actual_import_tested: bool,
    pub query_result: String,
}

#[derive(Debug, Serialize)]
pub struct QueueReport {
    pub index: u32,
    pub count: u32,
    pub graphics: bool,
    pub compute: bool,
    pub transfer: bool,
    pub video_encode: bool,
    pub video_decode: bool,
}

#[derive(Debug, Serialize)]
pub struct ProbeReport {
    pub loader_api_version: String,
    pub devices: Vec<DeviceReport>,
    pub exercise: Option<ExerciseReport>,
}

#[derive(Debug, Serialize)]
pub struct ExerciseReport {
    pub device_index: usize,
    pub width: u32,
    pub height: u32,
    pub frame_slots: usize,
    pub diagnostic_readback_frames: u32,
    pub gpu_only_copies: u32,
    pub color: ColorSpec,
}

fn version(v: u32) -> String {
    format!(
        "{}.{}.{}",
        vk::api_version_major(v),
        vk::api_version_minor(v),
        vk::api_version_patch(v)
    )
}

fn c_name(bytes: &[i8]) -> String {
    let ptr = bytes.as_ptr();
    unsafe { CStr::from_ptr(ptr) }
        .to_string_lossy()
        .into_owned()
}

#[cfg(windows)]
fn windows_import_query(
    instance: &ash::Instance,
    physical: vk::PhysicalDevice,
    keyed_mutex: bool,
    external_memory_win32: bool,
) -> WindowsImportReport {
    let mut report = WindowsImportReport {
        handle_type: "D3D11_TEXTURE (NT shared handle)",
        format: "NV12 (G8_B8R8_2PLANE_420_UNORM)",
        usage: "TRANSFER_SRC",
        keyed_mutex_extension_present: keyed_mutex,
        external_memory_win32_extension_present: external_memory_win32,
        format_query_supported: false,
        importable: false,
        dedicated_allocation_required: false,
        actual_import_tested: false,
        query_result: String::new(),
    };
    if !external_memory_win32 {
        report.query_result = "VK_KHR_external_memory_win32 is absent".into();
        return report;
    }
    let mut external_info = vk::PhysicalDeviceExternalImageFormatInfo::default()
        .handle_type(vk::ExternalMemoryHandleTypeFlags::D3D11_TEXTURE);
    let info = vk::PhysicalDeviceImageFormatInfo2::default()
        .format(vk::Format::G8_B8R8_2PLANE_420_UNORM)
        .ty(vk::ImageType::TYPE_2D)
        .tiling(vk::ImageTiling::OPTIMAL)
        .usage(vk::ImageUsageFlags::TRANSFER_SRC)
        .push_next(&mut external_info);
    let mut external = vk::ExternalImageFormatProperties::default();
    let mut output = vk::ImageFormatProperties2::default().push_next(&mut external);
    match unsafe {
        instance.get_physical_device_image_format_properties2(physical, &info, &mut output)
    } {
        Ok(()) => {
            report.format_query_supported = true;
            let features = external.external_memory_properties.external_memory_features;
            report.importable = features.contains(vk::ExternalMemoryFeatureFlags::IMPORTABLE)
                && external
                    .external_memory_properties
                    .compatible_handle_types
                    .contains(vk::ExternalMemoryHandleTypeFlags::D3D11_TEXTURE);
            report.dedicated_allocation_required =
                features.contains(vk::ExternalMemoryFeatureFlags::DEDICATED_ONLY);
            report.query_result = if report.importable {
                "format query succeeded; D3D11 NT-handle import advertised".into()
            } else {
                "format query succeeded, but external memory IMPORTABLE or compatible handle type was not advertised".into()
            };
        }
        Err(error) => {
            report.query_result = format!("external NV12 image format query failed: {error:?}")
        }
    }
    report
}

fn h264_nv12_profile(
    instance: &ash::Instance,
    entry: &Entry,
    physical: vk::PhysicalDevice,
) -> Result<bool, String> {
    let video = ash::khr::video_queue::Instance::new(entry, instance);
    let mut h264_profile = vk::VideoEncodeH264ProfileInfoKHR::default().std_profile_idc(100); // High profile
    let profile = vk::VideoProfileInfoKHR::default()
        .video_codec_operation(vk::VideoCodecOperationFlagsKHR::ENCODE_H264)
        .chroma_subsampling(vk::VideoChromaSubsamplingFlagsKHR::TYPE_420)
        .luma_bit_depth(vk::VideoComponentBitDepthFlagsKHR::TYPE_8)
        .chroma_bit_depth(vk::VideoComponentBitDepthFlagsKHR::TYPE_8)
        .push_next(&mut h264_profile);
    let mut codec_caps = vk::VideoEncodeH264CapabilitiesKHR::default();
    let mut encode_caps = vk::VideoEncodeCapabilitiesKHR::default();
    encode_caps.p_next = (&mut codec_caps as *mut vk::VideoEncodeH264CapabilitiesKHR<'_>).cast();
    let mut caps = vk::VideoCapabilitiesKHR::default().push_next(&mut encode_caps);
    let result = unsafe {
        (video.fp().get_physical_device_video_capabilities_khr)(physical, &profile, &mut caps)
    };
    if result != vk::Result::SUCCESS {
        return Err(format!("H.264 High 4:2:0 8-bit profile query: {result:?}"));
    }
    let profiles = [profile];
    let mut list = vk::VideoProfileListInfoKHR::default().profiles(&profiles);
    let format_info = vk::PhysicalDeviceVideoFormatInfoKHR::default()
        .image_usage(vk::ImageUsageFlags::VIDEO_ENCODE_SRC_KHR)
        .push_next(&mut list);
    let mut count = 0;
    let result = unsafe {
        (video.fp().get_physical_device_video_format_properties_khr)(
            physical,
            &format_info,
            &mut count,
            std::ptr::null_mut(),
        )
    };
    if result != vk::Result::SUCCESS {
        return Err(format!(
            "H.264 encode source format count query: {result:?}"
        ));
    }
    if count == 0 {
        return Ok(false);
    }
    let mut formats = vec![vk::VideoFormatPropertiesKHR::default(); count as usize];
    let result = unsafe {
        (video.fp().get_physical_device_video_format_properties_khr)(
            physical,
            &format_info,
            &mut count,
            formats.as_mut_ptr(),
        )
    };
    if result != vk::Result::SUCCESS {
        return Err(format!("H.264 encode source format query: {result:?}"));
    }
    Ok(formats[..(count as usize).min(formats.len())]
        .iter()
        .any(|format| {
            format.format == vk::Format::G8_B8R8_2PLANE_420_UNORM
                && format
                    .image_usage_flags
                    .contains(vk::ImageUsageFlags::VIDEO_ENCODE_SRC_KHR)
        }))
}

pub fn probe() -> Result<ProbeReport, String> {
    let entry = unsafe { Entry::load() }.map_err(|e| format!("Vulkan loader unavailable: {e}"))?;
    let loader_version = unsafe { entry.try_enumerate_instance_version() }
        .map_err(|e| format!("Vulkan instance version query failed: {e:?}"))?
        .unwrap_or(vk::API_VERSION_1_0);
    if loader_version < vk::API_VERSION_1_1 {
        return Err(format!(
            "Vulkan 1.1 required for device UUID discovery; loader is {}",
            version(loader_version)
        ));
    }
    let app = CString::new("velocast-gpu-probe").unwrap();
    let app_info = vk::ApplicationInfo::default()
        .application_name(&app)
        .api_version(vk::API_VERSION_1_1);
    let create = vk::InstanceCreateInfo::default().application_info(&app_info);
    let instance = unsafe { entry.create_instance(&create, None) }
        .map_err(|e| format!("Vulkan instance creation failed: {e:?}"))?;
    let result = (|| {
        let devices = unsafe { instance.enumerate_physical_devices() }
            .map_err(|e| format!("Physical device enumeration failed: {e:?}"))?;
        let mut reports = Vec::with_capacity(devices.len());
        for (index, physical) in devices.into_iter().enumerate() {
            let mut id = vk::PhysicalDeviceIDProperties::default();
            let mut properties = vk::PhysicalDeviceProperties2::default().push_next(&mut id);
            unsafe { instance.get_physical_device_properties2(physical, &mut properties) };
            let raw = properties.properties;
            let uuid = id
                .device_uuid
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            let queues = unsafe { instance.get_physical_device_queue_family_properties(physical) }
                .iter()
                .enumerate()
                .map(|(i, q)| QueueReport {
                    index: i as u32,
                    count: q.queue_count,
                    graphics: q.queue_flags.contains(vk::QueueFlags::GRAPHICS),
                    compute: q.queue_flags.contains(vk::QueueFlags::COMPUTE),
                    transfer: q.queue_flags.contains(vk::QueueFlags::TRANSFER),
                    video_encode: q.queue_flags.contains(vk::QueueFlags::VIDEO_ENCODE_KHR),
                    video_decode: q.queue_flags.contains(vk::QueueFlags::VIDEO_DECODE_KHR),
                })
                .collect::<Vec<_>>();
            let extensions = unsafe { instance.enumerate_device_extension_properties(physical) }
                .map_err(|e| {
                    format!(
                        "Extension enumeration failed for {}: {e:?}",
                        c_name(&raw.device_name)
                    )
                })?
                .iter()
                .map(|e| c_name(&e.extension_name))
                .collect::<Vec<_>>();
            let has = |name: &str| extensions.iter().any(|e| e == name);
            let encode_queue = queues.iter().any(|q| q.count > 0 && q.video_encode);
            let video_encode = has("VK_KHR_video_encode_queue");
            let h264 = has("VK_KHR_video_encode_h264");
            let h265 = has("VK_KHR_video_encode_h265");
            #[cfg(windows)]
            let windows_import = Some(windows_import_query(
                &instance,
                physical,
                has("VK_KHR_win32_keyed_mutex"),
                has("VK_KHR_external_memory_win32"),
            ));
            #[cfg(not(windows))]
            let windows_import = None;
            let format_props = unsafe {
                instance.get_physical_device_format_properties(
                    physical,
                    vk::Format::G8_B8R8_2PLANE_420_UNORM,
                )
            };
            let flags = format_props.optimal_tiling_features;
            let src = flags.contains(vk::FormatFeatureFlags::TRANSFER_SRC);
            let dst = flags.contains(vk::FormatFeatureFlags::TRANSFER_DST);
            let mut rejection_reasons = Vec::new();
            if !video_encode {
                rejection_reasons.push("missing VK_KHR_video_encode_queue".to_owned());
            }
            if !h264 && !h265 {
                rejection_reasons
                    .push("missing H.264 and H.265 Vulkan encode codec extensions".to_owned());
            }
            if !encode_queue {
                rejection_reasons
                    .push("no queue family advertises VK_QUEUE_VIDEO_ENCODE_BIT_KHR".to_owned());
            }
            if !(src && dst) {
                rejection_reasons.push(
                    "NV12 optimal-tiled transfer source/destination format features unavailable"
                        .to_owned(),
                );
            }
            let h264_profile_format =
                if has("VK_KHR_video_queue") && video_encode && h264 && encode_queue {
                    match h264_nv12_profile(&instance, &entry, physical) {
                        Ok(value) => {
                            if !value {
                                rejection_reasons.push(
                                "H.264 High 4:2:0 8-bit profile has no NV12 encode source format"
                                    .into(),
                            );
                            }
                            Some(value)
                        }
                        Err(reason) => {
                            rejection_reasons.push(reason);
                            Some(false)
                        }
                    }
                } else {
                    None
                };
            if h264_profile_format.is_none() && video_encode && encode_queue {
                rejection_reasons.push("H.264 profile/format query unavailable or inapplicable; raw extensions alone do not establish encode usability".to_owned());
            }
            reports.push(DeviceReport {
                index,
                name: c_name(&raw.device_name),
                vendor_id: raw.vendor_id,
                device_id: raw.device_id,
                driver_version: raw.driver_version,
                api_version: version(raw.api_version),
                uuid,
                duplicate_of_index: None,
                queue_families: queues,
                extensions,
                nv12_optimal_transfer_src: src,
                nv12_optimal_transfer_dst: dst,
                nv12_image_usable: None, // The pool exerciser performs the allocation test.
                video_encode_extension_present: video_encode,
                h264_encode_extension_present: h264,
                h265_encode_extension_present: h265,
                video_encode_queue_present: encode_queue,
                h264_profile_format_usable: h264_profile_format,
                windows_d3d11_nt_nv12_import: windows_import,
                rejection_reasons,
            });
        }
        for i in 0..reports.len() {
            reports[i].duplicate_of_index = (0..i).find(|&j| reports[j].uuid == reports[i].uuid);
        }
        Ok(ProbeReport {
            loader_api_version: version(loader_version),
            devices: reports,
            exercise: None,
        })
    })();
    unsafe { instance.destroy_instance(None) };
    result
}
