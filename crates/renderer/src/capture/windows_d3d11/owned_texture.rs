const OWNED_TEXTURE_POOL_CAPACITY: usize = 2;

#[derive(Debug)]
struct PoolLedger {
    in_use: Vec<bool>,
    shutdown: bool,
}

impl PoolLedger {
    fn new(capacity: usize) -> Self {
        Self {
            in_use: vec![false; capacity],
            shutdown: false,
        }
    }

    fn acquire(&mut self) -> anyhow::Result<usize> {
        if self.shutdown {
            return Err(anyhow::anyhow!("capture.d3d11_pool_shutdown"));
        }
        let index = self
            .in_use
            .iter()
            .position(|in_use| !*in_use)
            .ok_or_else(|| anyhow::anyhow!("capture.d3d11_pool_exhausted"))?;
        self.in_use[index] = true;
        Ok(index)
    }

    fn release(&mut self, index: usize) {
        if let Some(in_use) = self.in_use.get_mut(index) {
            *in_use = false;
        }
    }

    fn shutdown(&mut self) {
        self.shutdown = true;
    }

    fn in_use_count(&self) -> usize {
        self.in_use.iter().filter(|in_use| **in_use).count()
    }
}

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use anyhow::Context;
    use windows::core::Interface;
    use windows::Win32::Foundation::{HANDLE, HMODULE};
    use windows::Win32::Graphics::Direct3D::{
        D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1,
    };
    use windows::Win32::Graphics::Direct3D11::{
        D3D11CreateDevice, ID3D11Device, ID3D11Device1, ID3D11DeviceContext, ID3D11Multithread,
        ID3D11Query, ID3D11Resource, ID3D11Texture2D, D3D11_BOX, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        D3D11_CREATE_DEVICE_VIDEO_SUPPORT, D3D11_QUERY_DESC, D3D11_QUERY_EVENT, D3D11_SDK_VERSION,
        D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
    };
    use windows::Win32::Graphics::Dxgi::Common::{
        DXGI_FORMAT, DXGI_FORMAT_B8G8R8A8_TYPELESS, DXGI_FORMAT_B8G8R8A8_UNORM,
        DXGI_FORMAT_B8G8R8A8_UNORM_SRGB,
    };
    use windows::Win32::Graphics::Dxgi::IDXGIDevice;

    use crate::surface::TextureSourceRect;

    use super::{PoolLedger, OWNED_TEXTURE_POOL_CAPACITY};

    const GPU_OPERATION_TIMEOUT: Duration = Duration::from_secs(2);

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    struct PoolDescription {
        width: u32,
        height: u32,
        format: DXGI_FORMAT,
        bind_flags: u32,
    }

    #[derive(Debug, Clone, Copy)]
    struct CallbackGeometry {
        output_width: u32,
        output_height: u32,
        texture_width: u32,
        texture_height: u32,
        source_rect: TextureSourceRect,
    }

    struct OwnedTextureSlot {
        texture: ID3D11Texture2D,
        copy_complete: ID3D11Query,
        consumer_complete: ID3D11Query,
    }

    struct PoolState {
        description: Option<PoolDescription>,
        slots: Vec<OwnedTextureSlot>,
        ledger: PoolLedger,
        allocations: usize,
    }

    struct OwnedTexturePoolInner {
        device: ID3D11Device,
        context: ID3D11DeviceContext,
        state: Mutex<PoolState>,
    }

    #[derive(Clone)]
    pub(crate) struct OwnedTexturePool {
        inner: Arc<OwnedTexturePoolInner>,
    }

    impl std::fmt::Debug for OwnedTexturePool {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            let state = self
                .inner
                .state
                .lock()
                .expect("owned texture pool poisoned");
            formatter
                .debug_struct("OwnedTexturePool")
                .field("capacity", &OWNED_TEXTURE_POOL_CAPACITY)
                .field("allocations", &state.allocations)
                .field("in_use", &state.ledger.in_use_count())
                .finish()
        }
    }

    pub(crate) struct OwnedTextureLease {
        texture: Option<ID3D11Texture2D>,
        capture_backend: &'static str,
        pool: Option<Arc<OwnedTexturePoolInner>>,
        slot_index: usize,
        consumer_finished: bool,
    }

    impl std::fmt::Debug for OwnedTextureLease {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter
                .debug_struct("OwnedTextureLease")
                .field("slot_index", &self.slot_index)
                .field("owned", &self.pool.is_some())
                .field("consumer_finished", &self.consumer_finished)
                .finish()
        }
    }

    impl OwnedTextureLease {
        #[cfg(test)]
        pub(crate) fn borrowed_for_test(slot_index: usize) -> Self {
            Self {
                texture: None,
                capture_backend: "electron_d3d11_shared_texture",
                pool: None,
                slot_index,
                consumer_finished: false,
            }
        }

        pub(crate) fn texture(&self) -> anyhow::Result<&ID3D11Texture2D> {
            self.texture
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("owned D3D11 texture is unavailable"))
        }

        pub(crate) fn capture_backend_label(&self) -> &'static str {
            self.capture_backend
        }

        pub(crate) fn finish_gpu_use(&mut self) -> anyhow::Result<()> {
            if self.consumer_finished {
                return Ok(());
            }
            let Some(pool) = &self.pool else {
                self.consumer_finished = true;
                return Ok(());
            };
            let query = {
                let state = pool.state.lock().expect("owned texture pool poisoned");
                state
                    .slots
                    .get(self.slot_index)
                    .map(|slot| slot.consumer_complete.clone())
                    .ok_or_else(|| anyhow::anyhow!("owned texture slot is unavailable"))?
            };
            wait_for_gpu_operation(&pool.context, &query, "owned texture consumer")?;
            self.consumer_finished = true;
            Ok(())
        }

        #[cfg(test)]
        pub(crate) fn slot_index(&self) -> usize {
            self.slot_index
        }
    }

    impl Drop for OwnedTextureLease {
        fn drop(&mut self) {
            if let Some(pool) = self.pool.take() {
                pool.state
                    .lock()
                    .expect("owned texture pool poisoned")
                    .ledger
                    .release(self.slot_index);
            }
        }
    }

    impl OwnedTexturePool {
        pub(crate) fn create() -> anyhow::Result<Self> {
            let (device, context) = create_d3d11_device()?;
            Ok(Self::from_device(device, context))
        }

        pub(crate) fn from_device(device: ID3D11Device, context: ID3D11DeviceContext) -> Self {
            Self {
                inner: Arc::new(OwnedTexturePoolInner {
                    device,
                    context,
                    state: Mutex::new(PoolState {
                        description: None,
                        slots: Vec::new(),
                        ledger: PoolLedger::new(OWNED_TEXTURE_POOL_CAPACITY),
                        allocations: 0,
                    }),
                }),
            }
        }

        /// Electron exports an NT handle duplicated into this process. Import it
        /// directly instead of interpreting it as a legacy shared KMT handle.
        pub(crate) fn copy_from_nt_handle(
            &self,
            handle: usize,
            output_width: u32,
            output_height: u32,
            texture_width: u32,
            texture_height: u32,
            source_rect: TextureSourceRect,
        ) -> anyhow::Result<OwnedTextureLease> {
            let device: ID3D11Device1 = self.inner.device.cast()?;
            let source = unsafe {
                device.OpenSharedResource1::<ID3D11Texture2D>(HANDLE(handle as *mut c_void))
            }
            .context(
                "capture.d3d11_copy_failed: failed to open Electron NT texture on encoder device",
            )?;
            self.copy_from_source(
                source,
                output_width,
                output_height,
                texture_width,
                texture_height,
                source_rect,
            )
        }

        fn copy_from_source(
            &self,
            source: ID3D11Texture2D,
            output_width: u32,
            output_height: u32,
            texture_width: u32,
            texture_height: u32,
            source_rect: TextureSourceRect,
        ) -> anyhow::Result<OwnedTextureLease> {
            let source_desc = texture_description(&source);
            let geometry = CallbackGeometry {
                output_width,
                output_height,
                texture_width,
                texture_height,
                source_rect,
            };
            validate_source(&self.inner.device, &source, &source_desc, geometry)?;
            let description = PoolDescription {
                width: output_width,
                height: output_height,
                format: source_desc.Format,
                bind_flags: source_desc.BindFlags,
            };

            let (slot_index, destination, copy_complete) = {
                let mut state = self
                    .inner
                    .state
                    .lock()
                    .expect("owned texture pool poisoned");
                ensure_pool_initialized(&self.inner.device, &mut state, description)?;
                if state.description != Some(description) {
                    return Err(anyhow::anyhow!(
                        "capture.d3d11_mismatch: callback texture description changed after pool warm-up"
                    ));
                }
                let slot_index = state.ledger.acquire()?;
                let slot = &state.slots[slot_index];
                (slot_index, slot.texture.clone(), slot.copy_complete.clone())
            };
            let lease = OwnedTextureLease {
                texture: Some(destination.clone()),
                capture_backend: "electron_d3d11_shared_texture",
                pool: Some(self.inner.clone()),
                slot_index,
                consumer_finished: false,
            };

            unsafe {
                let source_resource: ID3D11Resource = source
                    .cast()
                    .context("capture.d3d11_copy_failed: source resource cast failed")?;
                let destination_resource: ID3D11Resource = destination
                    .cast()
                    .context("capture.d3d11_copy_failed: owned resource cast failed")?;
                let source_box = D3D11_BOX {
                    left: source_rect.left,
                    top: source_rect.top,
                    front: 0,
                    right: source_rect.left + source_rect.width,
                    bottom: source_rect.top + source_rect.height,
                    back: 1,
                };
                self.inner.context.CopySubresourceRegion(
                    &destination_resource,
                    0,
                    0,
                    0,
                    0,
                    &source_resource,
                    0,
                    Some(&source_box),
                );
            }
            wait_for_gpu_operation(&self.inner.context, &copy_complete, "owned texture copy")
                .context("capture.d3d11_copy_failed")?;
            Ok(lease)
        }

        pub(crate) fn shutdown(&self) -> usize {
            let mut state = self
                .inner
                .state
                .lock()
                .expect("owned texture pool poisoned");
            state.ledger.shutdown();
            state.ledger.in_use_count()
        }

        #[cfg(test)]
        pub(crate) fn stats(&self) -> (usize, usize) {
            let state = self
                .inner
                .state
                .lock()
                .expect("owned texture pool poisoned");
            (state.allocations, state.ledger.in_use_count())
        }
    }

    fn ensure_pool_initialized(
        device: &ID3D11Device,
        state: &mut PoolState,
        description: PoolDescription,
    ) -> anyhow::Result<()> {
        if state.description.is_some() {
            return Ok(());
        }
        let texture_desc = D3D11_TEXTURE2D_DESC {
            Width: description.width,
            Height: description.height,
            MipLevels: 1,
            ArraySize: 1,
            Format: description.format,
            SampleDesc: windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: description.bind_flags,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let query_desc = D3D11_QUERY_DESC {
            Query: D3D11_QUERY_EVENT,
            MiscFlags: 0,
        };
        let mut slots = Vec::with_capacity(OWNED_TEXTURE_POOL_CAPACITY);
        for _ in 0..OWNED_TEXTURE_POOL_CAPACITY {
            let mut texture = None;
            let mut copy_complete = None;
            let mut consumer_complete = None;
            unsafe {
                device
                    .CreateTexture2D(&texture_desc, None, Some(&mut texture))
                    .context("capture.d3d11_copy_failed: owned texture allocation failed")?;
                device
                    .CreateQuery(&query_desc, Some(&mut copy_complete))
                    .context("capture.d3d11_copy_failed: copy query allocation failed")?;
                device
                    .CreateQuery(&query_desc, Some(&mut consumer_complete))
                    .context("capture.d3d11_copy_failed: consumer query allocation failed")?;
            }
            slots.push(OwnedTextureSlot {
                texture: texture.context("owned D3D11 texture is unavailable")?,
                copy_complete: copy_complete.context("owned copy query is unavailable")?,
                consumer_complete: consumer_complete
                    .context("owned consumer query is unavailable")?,
            });
        }
        state.allocations += slots.len();
        state.slots = slots;
        state.description = Some(description);
        Ok(())
    }

    fn validate_source(
        target_device: &ID3D11Device,
        source: &ID3D11Texture2D,
        source_desc: &D3D11_TEXTURE2D_DESC,
        geometry: CallbackGeometry,
    ) -> anyhow::Result<()> {
        if source_desc.Width != geometry.texture_width
            || source_desc.Height != geometry.texture_height
        {
            return Err(anyhow::anyhow!(
                "capture.d3d11_mismatch: opened texture {}x{} did not match callback metadata {}x{}",
                source_desc.Width,
                source_desc.Height,
                geometry.texture_width,
                geometry.texture_height
            ));
        }
        if source_desc.MipLevels != 1
            || source_desc.ArraySize != 1
            || source_desc.SampleDesc.Count != 1
            || !is_bgra_compatible_format(source_desc.Format)
        {
            return Err(anyhow::anyhow!(
                "capture.d3d11_mismatch: unsupported Electron texture description"
            ));
        }
        if geometry.source_rect.width != geometry.output_width
            || geometry.source_rect.height != geometry.output_height
        {
            return Err(anyhow::anyhow!(
                "capture.d3d11_mismatch: source rect {}x{} did not match output {}x{}",
                geometry.source_rect.width,
                geometry.source_rect.height,
                geometry.output_width,
                geometry.output_height
            ));
        }
        let right = geometry
            .source_rect
            .left
            .checked_add(geometry.source_rect.width)
            .ok_or_else(|| anyhow::anyhow!("capture.d3d11_mismatch: source rect overflow"))?;
        let bottom = geometry
            .source_rect
            .top
            .checked_add(geometry.source_rect.height)
            .ok_or_else(|| anyhow::anyhow!("capture.d3d11_mismatch: source rect overflow"))?;
        if right > geometry.texture_width || bottom > geometry.texture_height {
            return Err(anyhow::anyhow!(
                "capture.d3d11_mismatch: source rect exceeded callback texture"
            ));
        }

        let source_device = unsafe { source.GetDevice() }
            .context("capture.d3d11_mismatch: source device missing")?;
        if adapter_luid(&source_device)? != adapter_luid(target_device)? {
            return Err(anyhow::anyhow!(
                "capture.d3d11_mismatch: Electron texture adapter did not match Velocast device adapter"
            ));
        }
        Ok(())
    }

    fn texture_description(texture: &ID3D11Texture2D) -> D3D11_TEXTURE2D_DESC {
        let mut description = D3D11_TEXTURE2D_DESC::default();
        unsafe { texture.GetDesc(&mut description) };
        description
    }

    fn adapter_luid(device: &ID3D11Device) -> anyhow::Result<(u32, i32)> {
        let dxgi_device: IDXGIDevice = device
            .cast()
            .context("capture.d3d11_mismatch: failed to query DXGI device")?;
        let adapter = unsafe { dxgi_device.GetAdapter() }
            .context("capture.d3d11_mismatch: failed to query DXGI adapter")?;
        let description = unsafe { adapter.GetDesc() }
            .context("capture.d3d11_mismatch: failed to query DXGI adapter description")?;
        Ok((
            description.AdapterLuid.LowPart,
            description.AdapterLuid.HighPart,
        ))
    }

    fn is_bgra_compatible_format(format: DXGI_FORMAT) -> bool {
        matches!(
            format,
            DXGI_FORMAT_B8G8R8A8_UNORM
                | DXGI_FORMAT_B8G8R8A8_UNORM_SRGB
                | DXGI_FORMAT_B8G8R8A8_TYPELESS
        )
    }

    fn wait_for_gpu_operation(
        context: &ID3D11DeviceContext,
        query: &ID3D11Query,
        operation: &str,
    ) -> anyhow::Result<()> {
        unsafe {
            context.End(query);
            context.Flush();
            let deadline = Instant::now() + GPU_OPERATION_TIMEOUT;
            loop {
                let mut complete = 0_i32;
                context.GetData(
                    query,
                    Some(std::ptr::from_mut(&mut complete).cast::<c_void>()),
                    std::mem::size_of::<i32>() as u32,
                    0,
                )?;
                if complete != 0 {
                    return Ok(());
                }
                if Instant::now() >= deadline {
                    return Err(anyhow::anyhow!("{operation} timed out"));
                }
                std::thread::yield_now();
            }
        }
    }

    pub(crate) fn create_d3d11_device() -> anyhow::Result<(ID3D11Device, ID3D11DeviceContext)> {
        unsafe {
            let mut device = None;
            let mut context = None;
            let mut feature_level = D3D_FEATURE_LEVEL_11_0;
            let feature_levels = [D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0];
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                Some(&feature_levels),
                D3D11_SDK_VERSION,
                Some(&mut device),
                Some(&mut feature_level),
                Some(&mut context),
            )
            .context("D3D11CreateDevice failed")?;
            let device = device.context("D3D11 device is unavailable")?;
            let context = context.context("D3D11 device context is unavailable")?;
            let multithread: ID3D11Multithread = context
                .cast()
                .context("failed to enable D3D11 multithread protection")?;
            let _ = multithread.SetMultithreadProtected(true);
            Ok((device, context))
        }
    }
}

#[cfg(not(windows))]
mod imp {
    #[derive(Debug)]
    pub(crate) struct OwnedTextureLease {
        slot_index: usize,
    }

    impl OwnedTextureLease {
        pub(crate) fn capture_backend_label(&self) -> &'static str {
            "electron_d3d11_shared_texture"
        }

        #[cfg(test)]
        pub(crate) fn borrowed_for_test(slot_index: usize) -> Self {
            Self { slot_index }
        }

        #[cfg(test)]
        pub(crate) fn slot_index(&self) -> usize {
            self.slot_index
        }
    }
}

pub(crate) use imp::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ledger_is_bounded_and_reuses_only_released_slots() {
        let mut ledger = PoolLedger::new(2);
        let first = ledger.acquire().unwrap();
        let second = ledger.acquire().unwrap();

        assert_ne!(first, second);
        assert_eq!(ledger.in_use_count(), 2);
        assert!(ledger
            .acquire()
            .unwrap_err()
            .to_string()
            .contains("pool_exhausted"));

        ledger.release(first);
        assert_eq!(ledger.acquire().unwrap(), first);
        assert_eq!(ledger.in_use_count(), 2);
    }

    #[test]
    fn ledger_shutdown_rejects_new_leases_but_allows_outstanding_release() {
        let mut ledger = PoolLedger::new(2);
        let slot = ledger.acquire().unwrap();
        ledger.shutdown();

        assert!(ledger
            .acquire()
            .unwrap_err()
            .to_string()
            .contains("pool_shutdown"));
        ledger.release(slot);
        assert_eq!(ledger.in_use_count(), 0);
    }

    #[test]
    fn test_lease_carries_only_owned_slot_identity() {
        let lease = OwnedTextureLease::borrowed_for_test(7);

        assert_eq!(lease.slot_index(), 7);
    }

    #[test]
    fn pool_capacity_stays_fixed() {
        assert_eq!(OWNED_TEXTURE_POOL_CAPACITY, 2);
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use anyhow::Context;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows::core::Interface;
    use windows::Win32::Graphics::Direct3D11::{
        ID3D11Device, ID3D11DeviceContext, ID3D11Resource, ID3D11Texture2D,
        D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_CPU_ACCESS_READ,
        D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ, D3D11_RESOURCE_MISC_SHARED,
        D3D11_RESOURCE_MISC_SHARED_NTHANDLE, D3D11_SUBRESOURCE_DATA, D3D11_TEXTURE2D_DESC,
        D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING,
    };
    use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
    use windows::Win32::Graphics::Dxgi::{IDXGIResource1, DXGI_SHARED_RESOURCE_READ};

    use crate::surface::TextureSourceRect;

    use super::{create_d3d11_device, OwnedTextureLease, OwnedTexturePool};

    fn shared_source_texture(
        device: &ID3D11Device,
        pixels: &[u8; 16],
    ) -> anyhow::Result<(ID3D11Texture2D, OwnedHandle)> {
        let description = D3D11_TEXTURE2D_DESC {
            Width: 2,
            Height: 2,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE).0 as u32,
            CPUAccessFlags: 0,
            // This fixture models externally synchronized NT textures. A keyed
            // mutex texture needs a different per-resource acquisition protocol.
            MiscFlags: (D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED).0 as u32,
        };
        let initial = D3D11_SUBRESOURCE_DATA {
            pSysMem: pixels.as_ptr().cast(),
            SysMemPitch: 8,
            SysMemSlicePitch: 16,
        };
        let mut texture = None;
        unsafe {
            device
                .CreateTexture2D(&description, Some(&initial), Some(&mut texture))
                .context("failed to create test source texture")?;
        }
        let texture = texture.context("test source texture is unavailable")?;
        let resource: IDXGIResource1 = texture.cast()?;
        let handle = unsafe {
            resource.CreateSharedHandle(
                None,
                DXGI_SHARED_RESOURCE_READ.0,
                windows::core::PCWSTR::null(),
            )?
        };
        Ok((texture, unsafe { OwnedHandle::from_raw_handle(handle.0) }))
    }

    fn overwrite_source(
        context: &ID3D11DeviceContext,
        texture: &ID3D11Texture2D,
        pixels: &[u8; 16],
    ) -> anyhow::Result<()> {
        let resource: ID3D11Resource = texture.cast()?;
        unsafe {
            context.UpdateSubresource(&resource, 0, None, pixels.as_ptr().cast(), 8, 16);
            context.Flush();
        }
        Ok(())
    }

    fn read_owned_pixels(
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        lease: &OwnedTextureLease,
    ) -> anyhow::Result<[u8; 16]> {
        let mut description = D3D11_TEXTURE2D_DESC::default();
        unsafe { lease.texture()?.GetDesc(&mut description) };
        description.Usage = D3D11_USAGE_STAGING;
        description.BindFlags = 0;
        description.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
        description.MiscFlags = 0;
        let mut staging = None;
        unsafe {
            device.CreateTexture2D(&description, None, Some(&mut staging))?;
        }
        let staging = staging.context("test staging texture is unavailable")?;
        let source: ID3D11Resource = lease.texture()?.cast()?;
        let destination: ID3D11Resource = staging.cast()?;
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe {
            context.CopyResource(&destination, &source);
            context.Map(&destination, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
        }
        let mut pixels = [0_u8; 16];
        unsafe {
            for row in 0..2_usize {
                let source_row = mapped
                    .pData
                    .cast::<u8>()
                    .add(row * mapped.RowPitch as usize);
                std::ptr::copy_nonoverlapping(source_row, pixels.as_mut_ptr().add(row * 8), 8);
            }
            context.Unmap(&destination, 0);
        }
        Ok(pixels)
    }

    #[test]
    fn nt_handle_copy_survives_source_recycle_and_pool_never_grows_after_warmup() {
        let original = [1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255];
        let recycled = [
            99, 98, 97, 255, 96, 95, 94, 255, 93, 92, 91, 255, 90, 89, 88, 255,
        ];
        let (device, context) = create_d3d11_device().unwrap();
        let pool = OwnedTexturePool::from_device(device.clone(), context.clone());
        let (source, handle) = shared_source_texture(&device, &original).unwrap();

        let first = pool
            .copy_from_nt_handle(
                handle.as_raw_handle() as usize,
                2,
                2,
                2,
                2,
                TextureSourceRect::full(2, 2),
            )
            .unwrap();
        overwrite_source(&context, &source, &recycled).unwrap();
        assert_eq!(
            read_owned_pixels(&device, &context, &first).unwrap(),
            original
        );

        let second = pool
            .copy_from_nt_handle(
                handle.as_raw_handle() as usize,
                2,
                2,
                2,
                2,
                TextureSourceRect::full(2, 2),
            )
            .unwrap();
        assert_eq!(
            read_owned_pixels(&device, &context, &second).unwrap(),
            recycled
        );
        assert_eq!(pool.stats(), (2, 2));
        assert!(pool
            .copy_from_nt_handle(
                handle.as_raw_handle() as usize,
                2,
                2,
                2,
                2,
                TextureSourceRect::full(2, 2)
            )
            .unwrap_err()
            .to_string()
            .contains("pool_exhausted"));

        drop(first);
        let replacement = pool
            .copy_from_nt_handle(
                handle.as_raw_handle() as usize,
                2,
                2,
                2,
                2,
                TextureSourceRect::full(2, 2),
            )
            .unwrap();
        assert_eq!(pool.stats(), (2, 2));
        drop((second, replacement));
        assert_eq!(pool.stats(), (2, 0));
    }

    #[test]
    fn shutdown_rejects_new_nt_handle_copies_and_outstanding_drop_reclaims_slot() {
        let pixels = [0_u8; 16];
        let (device, context) = create_d3d11_device().unwrap();
        let pool = OwnedTexturePool::from_device(device.clone(), context);
        let (_source, handle) = shared_source_texture(&device, &pixels).unwrap();
        let lease = pool
            .copy_from_nt_handle(
                handle.as_raw_handle() as usize,
                2,
                2,
                2,
                2,
                TextureSourceRect::full(2, 2),
            )
            .unwrap();

        assert_eq!(pool.shutdown(), 1);
        assert!(pool
            .copy_from_nt_handle(
                handle.as_raw_handle() as usize,
                2,
                2,
                2,
                2,
                TextureSourceRect::full(2, 2)
            )
            .unwrap_err()
            .to_string()
            .contains("pool_shutdown"));
        drop(lease);
        assert_eq!(pool.stats(), (2, 0));
    }
}
