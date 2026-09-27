use ash::vk::Handle;
use ash::{vk, Device, Entry, Instance};
use serde::Serialize;
use std::ffi::CString;
use std::marker::PhantomData;

#[derive(Debug)]
pub struct PoolError(pub String);
impl std::fmt::Display for PoolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for PoolError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct ColorSpec {
    pub matrix: &'static str,
    pub range: &'static str,
    pub primaries: &'static str,
    pub transfer: &'static str,
}
impl Default for ColorSpec {
    fn default() -> Self {
        Self {
            matrix: "bt709",
            range: "limited",
            primaries: "bt709",
            transfer: "bt709",
        }
    }
}

#[derive(Debug, Serialize)]
pub struct FrameDescriptor<'a> {
    pub image_handle: u64,
    pub width: u32,
    pub height: u32,
    pub format: &'static str,
    pub color: ColorSpec,
    #[serde(skip)]
    _owner: PhantomData<&'a FramePool>,
}

struct OwnedImage {
    image: vk::Image,
    memory: vk::DeviceMemory,
}

/// All images, allocations, and synchronization objects live until this pool is dropped.
/// `FrameLease` borrows the pool and ties each descriptor to its lifetime.
pub struct FramePool {
    _entry: Entry,
    instance: Instance,
    device: Device,
    images: Vec<OwnedImage>,
    physical: vk::PhysicalDevice,
    queue: vk::Queue,
    queue_family: u32,
    width: u32,
    height: u32,
    ready: Vec<bool>,
}

pub struct FrameLease<'a> {
    pool: &'a mut FramePool,
    index: usize,
}
impl FrameLease<'_> {
    pub fn descriptor(&self) -> FrameDescriptor<'_> {
        FrameDescriptor {
            image_handle: self.pool.images[self.index].image.as_raw(),
            width: self.pool.width,
            height: self.pool.height,
            format: "nv12",
            color: ColorSpec::default(),
            _owner: PhantomData,
        }
    }
}

impl FramePool {
    pub fn new(
        device_index: usize,
        width: u32,
        height: u32,
        count: usize,
    ) -> Result<Self, PoolError> {
        if width == 0 || height == 0 || width % 2 != 0 || height % 2 != 0 {
            return Err(PoolError(
                "NV12 frame dimensions must be nonzero and even".into(),
            ));
        }
        if !(2..=16).contains(&count) {
            return Err(PoolError(
                "NV12 frame pool size must be between 2 and 16".into(),
            ));
        }
        let bytes = (width as u64)
            .checked_mul(height as u64)
            .and_then(|v| v.checked_mul(3))
            .and_then(|v| v.checked_div(2))
            .ok_or_else(|| PoolError("NV12 frame dimensions overflow".into()))?;
        if bytes > usize::MAX as u64 {
            return Err(PoolError("NV12 frame exceeds host address space".into()));
        }
        let entry = unsafe { Entry::load() }
            .map_err(|e| PoolError(format!("Vulkan loader unavailable: {e}")))?;
        let name = CString::new("velocast-nv12-pool").unwrap();
        let app = vk::ApplicationInfo::default()
            .application_name(&name)
            .api_version(vk::API_VERSION_1_1);
        let info = vk::InstanceCreateInfo::default().application_info(&app);
        let instance = unsafe { entry.create_instance(&info, None) }
            .map_err(|e| PoolError(format!("Vulkan instance creation failed: {e:?}")))?;
        let early = (|| {
            let physical = unsafe { instance.enumerate_physical_devices() }
                .map_err(|e| PoolError(format!("Physical device enumeration failed: {e:?}")))?
                .get(device_index)
                .copied()
                .ok_or_else(|| {
                    PoolError(format!("Vulkan device index {device_index} does not exist"))
                })?;
            let qprops = unsafe { instance.get_physical_device_queue_family_properties(physical) };
            let queue_family = qprops
                .iter()
                .position(|q| q.queue_count > 0 && q.queue_flags.contains(vk::QueueFlags::GRAPHICS))
                .ok_or_else(|| PoolError("No graphics-capable queue for NV12 GPU copy".into()))?
                as u32;
            let priority = [1.0];
            let qinfo = [vk::DeviceQueueCreateInfo::default()
                .queue_family_index(queue_family)
                .queue_priorities(&priority)];
            let dinfo = vk::DeviceCreateInfo::default().queue_create_infos(&qinfo);
            let device = unsafe { instance.create_device(physical, &dinfo, None) }
                .map_err(|e| PoolError(format!("Vulkan logical device creation failed: {e:?}")))?;
            Ok((physical, queue_family, device))
        })();
        let (physical, queue_family, device) = match early {
            Ok(value) => value,
            Err(error) => {
                unsafe { instance.destroy_instance(None) };
                return Err(error);
            }
        };
        let queue = unsafe { device.get_device_queue(queue_family, 0) };
        let mut pool = Self {
            _entry: entry,
            instance,
            device,
            images: Vec::with_capacity(count),
            physical,
            queue,
            queue_family,
            width,
            height,
            ready: vec![false; count],
        };
        for _ in 0..count {
            pool.create_image()?;
        }
        Ok(pool)
    }

    fn create_image(&mut self) -> Result<(), PoolError> {
        let info = vk::ImageCreateInfo::default()
            .image_type(vk::ImageType::TYPE_2D)
            .format(vk::Format::G8_B8R8_2PLANE_420_UNORM)
            .extent(vk::Extent3D {
                width: self.width,
                height: self.height,
                depth: 1,
            })
            .mip_levels(1)
            .array_layers(1)
            .samples(vk::SampleCountFlags::TYPE_1)
            .tiling(vk::ImageTiling::OPTIMAL)
            .usage(vk::ImageUsageFlags::TRANSFER_SRC | vk::ImageUsageFlags::TRANSFER_DST)
            .sharing_mode(vk::SharingMode::EXCLUSIVE)
            .initial_layout(vk::ImageLayout::UNDEFINED);
        unsafe {
            let _ = self
                .instance
                .get_physical_device_image_format_properties(
                    self.physical,
                    info.format,
                    info.image_type,
                    info.tiling,
                    info.usage,
                    info.flags,
                )
                .map_err(|e| {
                    PoolError(format!(
                        "NV12 optimal image with transfer src/dst is unsupported: {e:?}"
                    ))
                })?;
            let image = self
                .device
                .create_image(&info, None)
                .map_err(|e| PoolError(format!("NV12 image creation failed: {e:?}")))?;
            let requirements = self.device.get_image_memory_requirements(image);
            let memory_type = match self.memory_type(
                requirements.memory_type_bits,
                vk::MemoryPropertyFlags::DEVICE_LOCAL,
            ) {
                Some(i) => i,
                None => {
                    self.device.destroy_image(image, None);
                    return Err(PoolError(
                        "No device-local memory type for NV12 image".into(),
                    ));
                }
            };
            let allocation = vk::MemoryAllocateInfo::default()
                .allocation_size(requirements.size)
                .memory_type_index(memory_type);
            let memory = match self.device.allocate_memory(&allocation, None) {
                Ok(m) => m,
                Err(e) => {
                    self.device.destroy_image(image, None);
                    return Err(PoolError(format!("NV12 allocation failed: {e:?}")));
                }
            };
            if let Err(e) = self.device.bind_image_memory(image, memory, 0) {
                self.device.free_memory(memory, None);
                self.device.destroy_image(image, None);
                return Err(PoolError(format!("NV12 memory binding failed: {e:?}")));
            }
            self.images.push(OwnedImage { image, memory });
        }
        Ok(())
    }

    fn memory_type(&self, bits: u32, wanted: vk::MemoryPropertyFlags) -> Option<u32> {
        let props = unsafe {
            self.instance
                .get_physical_device_memory_properties(self.physical)
        };
        (0..props.memory_type_count).find(|&i| {
            bits & (1 << i) != 0
                && props.memory_types[i as usize]
                    .property_flags
                    .contains(wanted)
        })
    }

    pub fn len(&self) -> usize {
        self.images.len()
    }
    pub fn is_empty(&self) -> bool {
        self.images.is_empty()
    }
    pub fn frame(&mut self, index: usize) -> Option<FrameLease<'_>> {
        if index < self.images.len() {
            Some(FrameLease { pool: self, index })
        } else {
            None
        }
    }

    /// Upload a limited-range neutral NV12 test image, copy it between pool images on
    /// the GPU, and read both planes back. The fence wait proves completion.
    pub fn exercise_copy(&mut self) -> Result<(), PoolError> {
        if self.images.len() < 2 {
            return Err(PoolError("GPU copy needs two pool images".into()));
        }
        let y_bytes = (self.width as u64) * (self.height as u64);
        let bytes = y_bytes * 3 / 2;
        let (upload, upload_memory) = self.buffer(bytes, vk::BufferUsageFlags::TRANSFER_SRC)?;
        let (readback, readback_memory) =
            match self.buffer(bytes, vk::BufferUsageFlags::TRANSFER_DST) {
                Ok(pair) => pair,
                Err(e) => {
                    unsafe {
                        self.device.destroy_buffer(upload, None);
                        self.device.free_memory(upload_memory, None);
                    }
                    return Err(e);
                }
            };
        let result = self.do_copy(
            upload,
            upload_memory,
            readback,
            readback_memory,
            y_bytes,
            bytes,
        );
        if result.is_ok() {
            self.ready[0] = true;
            self.ready[1] = true;
        }
        unsafe {
            self.device.destroy_buffer(upload, None);
            self.device.free_memory(upload_memory, None);
            self.device.destroy_buffer(readback, None);
            self.device.free_memory(readback_memory, None);
        }
        result
    }

    /// Copies an already populated pool image to another slot and waits for GPU completion.
    /// This path does not map or read frame pixels on the CPU. The current foundation
    /// populates slots through `exercise_copy`; external frame import is not implemented.
    pub fn copy_ready_frame(&mut self, source: usize, destination: usize) -> Result<(), PoolError> {
        if source == destination || source >= self.images.len() || destination >= self.images.len()
        {
            return Err(PoolError(
                "GPU copy requires two distinct in-bounds pool slots".into(),
            ));
        }
        if !self.ready[source] || !self.ready[destination] {
            return Err(PoolError("GPU copy requires initialized pool slots".into()));
        }
        unsafe {
            let info = vk::CommandPoolCreateInfo::default().queue_family_index(self.queue_family);
            let command_pool = self
                .device
                .create_command_pool(&info, None)
                .map_err(|e| PoolError(format!("GPU-only copy command pool failed: {e:?}")))?;
            let result = (|| {
                let info = vk::CommandBufferAllocateInfo::default()
                    .command_pool(command_pool)
                    .level(vk::CommandBufferLevel::PRIMARY)
                    .command_buffer_count(1);
                let command = self.device.allocate_command_buffers(&info).map_err(|e| {
                    PoolError(format!("GPU-only copy command allocation failed: {e:?}"))
                })?[0];
                self.device
                    .begin_command_buffer(command, &vk::CommandBufferBeginInfo::default())
                    .map_err(|e| PoolError(format!("GPU-only copy command begin failed: {e:?}")))?;
                let range = vk::ImageSubresourceRange::default()
                    .aspect_mask(vk::ImageAspectFlags::COLOR)
                    .level_count(1)
                    .layer_count(1);
                let dst = self.images[destination].image;
                let to_dst = vk::ImageMemoryBarrier::default()
                    .image(dst)
                    .subresource_range(range)
                    .old_layout(vk::ImageLayout::TRANSFER_SRC_OPTIMAL)
                    .new_layout(vk::ImageLayout::TRANSFER_DST_OPTIMAL)
                    .src_access_mask(vk::AccessFlags::TRANSFER_READ)
                    .dst_access_mask(vk::AccessFlags::TRANSFER_WRITE);
                self.device.cmd_pipeline_barrier(
                    command,
                    vk::PipelineStageFlags::TRANSFER,
                    vk::PipelineStageFlags::TRANSFER,
                    vk::DependencyFlags::empty(),
                    &[],
                    &[],
                    &[to_dst],
                );
                let copy = [
                    vk::ImageCopy::default()
                        .src_subresource(
                            vk::ImageSubresourceLayers::default()
                                .aspect_mask(vk::ImageAspectFlags::PLANE_0)
                                .layer_count(1),
                        )
                        .dst_subresource(
                            vk::ImageSubresourceLayers::default()
                                .aspect_mask(vk::ImageAspectFlags::PLANE_0)
                                .layer_count(1),
                        )
                        .extent(vk::Extent3D {
                            width: self.width,
                            height: self.height,
                            depth: 1,
                        }),
                    vk::ImageCopy::default()
                        .src_subresource(
                            vk::ImageSubresourceLayers::default()
                                .aspect_mask(vk::ImageAspectFlags::PLANE_1)
                                .layer_count(1),
                        )
                        .dst_subresource(
                            vk::ImageSubresourceLayers::default()
                                .aspect_mask(vk::ImageAspectFlags::PLANE_1)
                                .layer_count(1),
                        )
                        .extent(vk::Extent3D {
                            width: self.width / 2,
                            height: self.height / 2,
                            depth: 1,
                        }),
                ];
                self.device.cmd_copy_image(
                    command,
                    self.images[source].image,
                    vk::ImageLayout::TRANSFER_SRC_OPTIMAL,
                    dst,
                    vk::ImageLayout::TRANSFER_DST_OPTIMAL,
                    &copy,
                );
                let back = vk::ImageMemoryBarrier::default()
                    .image(dst)
                    .subresource_range(range)
                    .old_layout(vk::ImageLayout::TRANSFER_DST_OPTIMAL)
                    .new_layout(vk::ImageLayout::TRANSFER_SRC_OPTIMAL)
                    .src_access_mask(vk::AccessFlags::TRANSFER_WRITE)
                    .dst_access_mask(vk::AccessFlags::TRANSFER_READ);
                self.device.cmd_pipeline_barrier(
                    command,
                    vk::PipelineStageFlags::TRANSFER,
                    vk::PipelineStageFlags::TRANSFER,
                    vk::DependencyFlags::empty(),
                    &[],
                    &[],
                    &[back],
                );
                self.device
                    .end_command_buffer(command)
                    .map_err(|e| PoolError(format!("GPU-only copy command end failed: {e:?}")))?;
                let fence = self
                    .device
                    .create_fence(&vk::FenceCreateInfo::default(), None)
                    .map_err(|e| PoolError(format!("GPU-only copy fence failed: {e:?}")))?;
                let result = (|| {
                    let commands = [command];
                    self.device
                        .queue_submit(
                            self.queue,
                            &[vk::SubmitInfo::default().command_buffers(&commands)],
                            fence,
                        )
                        .map_err(|e| {
                            PoolError(format!("GPU-only copy submission failed: {e:?}"))
                        })?;
                    self.device
                        .wait_for_fences(&[fence], true, 10_000_000_000)
                        .map_err(|e| {
                            PoolError(format!("GPU-only copy completion failed: {e:?}"))
                        })?;
                    Ok(())
                })();
                let _ = self.device.device_wait_idle();
                self.device.destroy_fence(fence, None);
                result
            })();
            let _ = self.device.device_wait_idle();
            self.device.destroy_command_pool(command_pool, None);
            result
        }
    }

    fn buffer(
        &self,
        size: u64,
        usage: vk::BufferUsageFlags,
    ) -> Result<(vk::Buffer, vk::DeviceMemory), PoolError> {
        unsafe {
            let info = vk::BufferCreateInfo::default()
                .size(size)
                .usage(usage)
                .sharing_mode(vk::SharingMode::EXCLUSIVE);
            let buffer = self
                .device
                .create_buffer(&info, None)
                .map_err(|e| PoolError(format!("Staging buffer creation failed: {e:?}")))?;
            let req = self.device.get_buffer_memory_requirements(buffer);
            let flags =
                vk::MemoryPropertyFlags::HOST_VISIBLE | vk::MemoryPropertyFlags::HOST_COHERENT;
            let ty = match self.memory_type(req.memory_type_bits, flags) {
                Some(i) => i,
                None => {
                    self.device.destroy_buffer(buffer, None);
                    return Err(PoolError("No host-visible coherent staging memory".into()));
                }
            };
            let info = vk::MemoryAllocateInfo::default()
                .allocation_size(req.size)
                .memory_type_index(ty);
            let memory = match self.device.allocate_memory(&info, None) {
                Ok(m) => m,
                Err(e) => {
                    self.device.destroy_buffer(buffer, None);
                    return Err(PoolError(format!("Staging allocation failed: {e:?}")));
                }
            };
            if let Err(e) = self.device.bind_buffer_memory(buffer, memory, 0) {
                self.device.free_memory(memory, None);
                self.device.destroy_buffer(buffer, None);
                return Err(PoolError(format!("Staging binding failed: {e:?}")));
            }
            Ok((buffer, memory))
        }
    }

    fn do_copy(
        &self,
        upload: vk::Buffer,
        upload_memory: vk::DeviceMemory,
        readback: vk::Buffer,
        readback_memory: vk::DeviceMemory,
        y_bytes: u64,
        bytes: u64,
    ) -> Result<(), PoolError> {
        unsafe {
            let ptr = self
                .device
                .map_memory(upload_memory, 0, bytes, vk::MemoryMapFlags::empty())
                .map_err(|e| PoolError(format!("Upload mapping failed: {e:?}")))?
                as *mut u8;
            std::ptr::write_bytes(ptr, 16, y_bytes as usize);
            std::ptr::write_bytes(ptr.add(y_bytes as usize), 128, (bytes - y_bytes) as usize);
            self.device.unmap_memory(upload_memory);
            let cp_info =
                vk::CommandPoolCreateInfo::default().queue_family_index(self.queue_family);
            let command_pool = self
                .device
                .create_command_pool(&cp_info, None)
                .map_err(|e| PoolError(format!("Command pool creation failed: {e:?}")))?;
            let result = (|| {
                let alloc = vk::CommandBufferAllocateInfo::default()
                    .command_pool(command_pool)
                    .level(vk::CommandBufferLevel::PRIMARY)
                    .command_buffer_count(1);
                let command = self
                    .device
                    .allocate_command_buffers(&alloc)
                    .map_err(|e| PoolError(format!("Command allocation failed: {e:?}")))?[0];
                self.device
                    .begin_command_buffer(command, &vk::CommandBufferBeginInfo::default())
                    .map_err(|e| PoolError(format!("Command begin failed: {e:?}")))?;
                let subresource = vk::ImageSubresourceRange::default()
                    .aspect_mask(vk::ImageAspectFlags::COLOR)
                    .level_count(1)
                    .layer_count(1);
                let initial = self.images[..2]
                    .iter()
                    .map(|image| {
                        vk::ImageMemoryBarrier::default()
                            .old_layout(vk::ImageLayout::UNDEFINED)
                            .new_layout(vk::ImageLayout::TRANSFER_DST_OPTIMAL)
                            .image(image.image)
                            .subresource_range(subresource)
                            .dst_access_mask(vk::AccessFlags::TRANSFER_WRITE)
                    })
                    .collect::<Vec<_>>();
                self.device.cmd_pipeline_barrier(
                    command,
                    vk::PipelineStageFlags::TOP_OF_PIPE,
                    vk::PipelineStageFlags::TRANSFER,
                    vk::DependencyFlags::empty(),
                    &[],
                    &[],
                    &initial,
                );
                let planes = self.plane_regions(y_bytes);
                self.device.cmd_copy_buffer_to_image(
                    command,
                    upload,
                    self.images[0].image,
                    vk::ImageLayout::TRANSFER_DST_OPTIMAL,
                    &planes,
                );
                let barrier = vk::ImageMemoryBarrier::default()
                    .image(self.images[0].image)
                    .subresource_range(subresource)
                    .old_layout(vk::ImageLayout::TRANSFER_DST_OPTIMAL)
                    .new_layout(vk::ImageLayout::TRANSFER_SRC_OPTIMAL)
                    .src_access_mask(vk::AccessFlags::TRANSFER_WRITE)
                    .dst_access_mask(vk::AccessFlags::TRANSFER_READ);
                self.device.cmd_pipeline_barrier(
                    command,
                    vk::PipelineStageFlags::TRANSFER,
                    vk::PipelineStageFlags::TRANSFER,
                    vk::DependencyFlags::empty(),
                    &[],
                    &[],
                    &[barrier],
                );
                let copy = [
                    vk::ImageCopy::default()
                        .src_subresource(
                            vk::ImageSubresourceLayers::default()
                                .aspect_mask(vk::ImageAspectFlags::PLANE_0)
                                .layer_count(1),
                        )
                        .dst_subresource(
                            vk::ImageSubresourceLayers::default()
                                .aspect_mask(vk::ImageAspectFlags::PLANE_0)
                                .layer_count(1),
                        )
                        .extent(vk::Extent3D {
                            width: self.width,
                            height: self.height,
                            depth: 1,
                        }),
                    vk::ImageCopy::default()
                        .src_subresource(
                            vk::ImageSubresourceLayers::default()
                                .aspect_mask(vk::ImageAspectFlags::PLANE_1)
                                .layer_count(1),
                        )
                        .dst_subresource(
                            vk::ImageSubresourceLayers::default()
                                .aspect_mask(vk::ImageAspectFlags::PLANE_1)
                                .layer_count(1),
                        )
                        .extent(vk::Extent3D {
                            width: self.width / 2,
                            height: self.height / 2,
                            depth: 1,
                        }),
                ];
                self.device.cmd_copy_image(
                    command,
                    self.images[0].image,
                    vk::ImageLayout::TRANSFER_SRC_OPTIMAL,
                    self.images[1].image,
                    vk::ImageLayout::TRANSFER_DST_OPTIMAL,
                    &copy,
                );
                let barrier = vk::ImageMemoryBarrier::default()
                    .image(self.images[1].image)
                    .subresource_range(subresource)
                    .old_layout(vk::ImageLayout::TRANSFER_DST_OPTIMAL)
                    .new_layout(vk::ImageLayout::TRANSFER_SRC_OPTIMAL)
                    .src_access_mask(vk::AccessFlags::TRANSFER_WRITE)
                    .dst_access_mask(vk::AccessFlags::TRANSFER_READ);
                self.device.cmd_pipeline_barrier(
                    command,
                    vk::PipelineStageFlags::TRANSFER,
                    vk::PipelineStageFlags::TRANSFER,
                    vk::DependencyFlags::empty(),
                    &[],
                    &[],
                    &[barrier],
                );
                self.device.cmd_copy_image_to_buffer(
                    command,
                    self.images[1].image,
                    vk::ImageLayout::TRANSFER_SRC_OPTIMAL,
                    readback,
                    &planes,
                );
                self.device
                    .end_command_buffer(command)
                    .map_err(|e| PoolError(format!("Command end failed: {e:?}")))?;
                let fence = self
                    .device
                    .create_fence(&vk::FenceCreateInfo::default(), None)
                    .map_err(|e| PoolError(format!("Fence creation failed: {e:?}")))?;
                let submitted = (|| {
                    let commands = [command];
                    let submits = [vk::SubmitInfo::default().command_buffers(&commands)];
                    self.device
                        .queue_submit(self.queue, &submits, fence)
                        .map_err(|e| PoolError(format!("GPU copy submission failed: {e:?}")))?;
                    self.device
                        .wait_for_fences(&[fence], true, 10_000_000_000)
                        .map_err(|e| PoolError(format!("GPU copy completion failed: {e:?}")))?;
                    let ptr = self
                        .device
                        .map_memory(readback_memory, 0, bytes, vk::MemoryMapFlags::empty())
                        .map_err(|e| PoolError(format!("Readback mapping failed: {e:?}")))?
                        as *const u8;
                    let contents = std::slice::from_raw_parts(ptr, bytes as usize);
                    let correct = contents[..y_bytes as usize].iter().all(|&b| b == 16)
                        && contents[y_bytes as usize..].iter().all(|&b| b == 128);
                    self.device.unmap_memory(readback_memory);
                    if !correct {
                        return Err(PoolError("NV12 GPU copy completed but plane readback differs from uploaded values".into()));
                    }
                    Ok(())
                })();
                // A fence timeout does not cancel submitted GPU work. Preserve
                // every referenced object until completion or device loss.
                let _ = self.device.device_wait_idle();
                self.device.destroy_fence(fence, None);
                submitted
            })();
            let _ = self.device.device_wait_idle();
            self.device.destroy_command_pool(command_pool, None);
            result
        }
    }

    fn plane_regions(&self, y_bytes: u64) -> [vk::BufferImageCopy; 2] {
        [
            vk::BufferImageCopy::default()
                .image_subresource(
                    vk::ImageSubresourceLayers::default()
                        .aspect_mask(vk::ImageAspectFlags::PLANE_0)
                        .layer_count(1),
                )
                .image_extent(vk::Extent3D {
                    width: self.width,
                    height: self.height,
                    depth: 1,
                }),
            vk::BufferImageCopy::default()
                .buffer_offset(y_bytes)
                .image_subresource(
                    vk::ImageSubresourceLayers::default()
                        .aspect_mask(vk::ImageAspectFlags::PLANE_1)
                        .layer_count(1),
                )
                .image_extent(vk::Extent3D {
                    width: self.width / 2,
                    height: self.height / 2,
                    depth: 1,
                }),
        ]
    }
}

impl Drop for FramePool {
    fn drop(&mut self) {
        unsafe {
            let _ = self.device.device_wait_idle();
            for owned in self.images.drain(..) {
                self.device.destroy_image(owned.image, None);
                self.device.free_memory(owned.memory, None);
            }
            self.device.destroy_device(None);
            self.instance.destroy_instance(None);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_pool_geometry_rejected_before_loader() {
        assert!(FramePool::new(0, 1919, 1080, 2)
            .err()
            .unwrap()
            .0
            .contains("even"));
        assert!(FramePool::new(0, 1920, 1080, 17)
            .err()
            .unwrap()
            .0
            .contains("between 2 and 16"));
    }
}
