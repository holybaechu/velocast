//! Owned frame handoff shared by native browser hosts.
use crate::capture::windows_d3d11::OwnedTextureLease;
#[cfg(windows)]
use crate::capture::windows_d3d11::OwnedTexturePool;
use crate::surface::TextureSourceRect;
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;
use tokio::time::{timeout_at, Instant};

const PAINT_INTENT_NONE: u8 = 0;
const PAINT_INTENT_OBSERVE: u8 = 1;
const PAINT_INTENT_COPY: u8 = 2;

#[derive(Debug)]
pub struct AcceleratedFrame {
    pub software_capture_backend: &'static str,
    pub generation: u64,
    pub width: u32,
    pub height: u32,
    pub texture_width: u32,
    pub texture_height: u32,
    pub source_rect: TextureSourceRect,
    pub color_type_debug: String,
    pub platform_handle_debug: String,
    pub owned_texture: Option<OwnedTextureLease>,
    pub bgra: Option<Vec<u8>>,
}

#[derive(Debug, Clone)]
pub struct PaintState {
    last_frame: Arc<Mutex<Option<AcceleratedFrame>>>,
    paint_error: Arc<Mutex<Option<String>>>,
    #[cfg(windows)]
    owned_texture_pool: Arc<Mutex<Option<OwnedTexturePool>>>,
    paint_intent: Arc<AtomicU8>,
    generation: Arc<AtomicU64>,
    paint_sequence: Arc<AtomicU64>,
    paint_notify: Arc<Notify>,
}

impl Default for PaintState {
    fn default() -> Self {
        Self {
            last_frame: Arc::new(Mutex::new(None)),
            paint_error: Arc::new(Mutex::new(None)),
            #[cfg(windows)]
            owned_texture_pool: Arc::new(Mutex::new(None)),
            paint_intent: Arc::new(AtomicU8::new(PAINT_INTENT_NONE)),
            generation: Arc::new(AtomicU64::new(0)),
            paint_sequence: Arc::new(AtomicU64::new(0)),
            paint_notify: Arc::new(Notify::new()),
        }
    }
}

impl PaintState {
    pub fn begin_frame_capture(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::AcqRel) + 1
    }

    pub fn current_generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    pub fn current_paint_sequence(&self) -> u64 {
        self.paint_sequence.load(Ordering::Acquire)
    }

    pub fn store_accelerated_frame(&self, frame: AcceleratedFrame) {
        *self.last_frame.lock().expect("paint mutex poisoned") = Some(frame);
        self.paint_sequence.fetch_add(1, Ordering::AcqRel);
        self.paint_notify.notify_waiters();
    }

    #[cfg(test)]
    pub fn store_paint_error(&self, error: impl Into<String>) {
        *self.paint_error.lock().expect("paint error mutex poisoned") = Some(error.into());
        self.paint_sequence.fetch_add(1, Ordering::AcqRel);
        self.paint_notify.notify_waiters();
    }

    /// Takes ownership of a packed BGRA frame after a browser has completed its lease.
    pub(crate) fn store_software_frame(
        &self,
        capture_backend: &'static str,
        generation: u64,
        width: u32,
        height: u32,
        pixels: Vec<u8>,
    ) -> anyhow::Result<()> {
        let expected = width
            .checked_mul(height)
            .and_then(|n| n.checked_mul(4))
            .and_then(|n| usize::try_from(n).ok());
        anyhow::ensure!(
            width > 0 && height > 0 && expected == Some(pixels.len()),
            "capture.invalid_software_frame: expected packed BGRA pixels for {width}x{height}"
        );
        self.store_accelerated_frame(AcceleratedFrame {
            software_capture_backend: capture_backend,
            generation,
            width,
            height,
            texture_width: width,
            texture_height: height,
            source_rect: TextureSourceRect::full(width, height),
            color_type_debug: "software_bgra".to_owned(),
            platform_handle_debug: "software".to_owned(),
            owned_texture: None,
            bgra: Some(pixels),
        });
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn request_software_paint(&self) {
        self.request_owned_texture_copy();
    }

    pub fn take_paint_error(&self) -> Option<String> {
        self.paint_error
            .lock()
            .expect("paint error mutex poisoned")
            .take()
    }

    #[cfg(windows)]
    pub(crate) fn install_owned_texture_pool(&self, pool: OwnedTexturePool) -> anyhow::Result<()> {
        let previous = self
            .owned_texture_pool
            .lock()
            .expect("owned texture pool mutex poisoned")
            .replace(pool);
        if let Some(previous) = previous {
            let outstanding = previous.shutdown();
            if outstanding != 0 {
                return Err(anyhow::anyhow!(
                    "capture.d3d11_pool_leaked: replaced pool still had {outstanding} leased texture(s)"
                ));
            }
        }
        let _ = self.take_last_frame();
        let _ = self.take_paint_error();
        Ok(())
    }

    #[cfg(windows)]
    pub(crate) fn install_standalone_owned_texture_pool(&self) -> anyhow::Result<()> {
        self.install_owned_texture_pool(OwnedTexturePool::create()?)
    }

    #[cfg(not(windows))]
    pub(crate) fn install_standalone_owned_texture_pool(&self) -> anyhow::Result<()> {
        Ok(())
    }

    pub(crate) fn request_paint_observation(&self) {
        self.paint_intent
            .store(PAINT_INTENT_OBSERVE, Ordering::Release);
    }

    pub(crate) fn request_owned_texture_copy(&self) {
        self.paint_intent
            .store(PAINT_INTENT_COPY, Ordering::Release);
    }

    #[cfg(windows)]
    pub(crate) fn copy_owned_texture_from_nt_handle(
        &self,
        handle: usize,
        width: u32,
        height: u32,
        texture_width: u32,
        texture_height: u32,
        source_rect: TextureSourceRect,
    ) -> anyhow::Result<OwnedTextureLease> {
        let pool = self
            .owned_texture_pool
            .lock()
            .expect("owned texture pool mutex poisoned")
            .clone()
            .ok_or_else(|| anyhow::anyhow!("capture.d3d11_pool_unavailable"))?;
        pool.copy_from_nt_handle(
            handle,
            width,
            height,
            texture_width,
            texture_height,
            source_rect,
        )
    }

    fn take_paint_intent(&self) -> u8 {
        self.paint_intent.swap(PAINT_INTENT_NONE, Ordering::AcqRel)
    }

    /// External hosts consume intent when issuing a correlated paint request,
    /// rather than guessing intent when an unsolicited callback arrives.
    pub(crate) fn take_external_paint_intent(&self) -> Option<bool> {
        match self.take_paint_intent() {
            PAINT_INTENT_NONE => None,
            PAINT_INTENT_OBSERVE => Some(false),
            PAINT_INTENT_COPY => Some(true),
            _ => unreachable!("invalid paint intent"),
        }
    }

    pub(crate) fn shutdown_owned_texture_pool(&self) {
        let _ = self.take_last_frame();
        self.paint_intent
            .store(PAINT_INTENT_NONE, Ordering::Release);
        #[cfg(windows)]
        if let Some(pool) = self
            .owned_texture_pool
            .lock()
            .expect("owned texture pool mutex poisoned")
            .take()
        {
            let outstanding = pool.shutdown();
            if outstanding != 0 {
                tracing::debug!(
                    outstanding,
                    "owned texture pool shutdown is waiting for outstanding leases to drop"
                );
            }
        }
    }

    pub fn take_last_frame(&self) -> Option<AcceleratedFrame> {
        self.last_frame.lock().expect("paint mutex poisoned").take()
    }

    pub async fn wait_for_paint_after(&self, sequence: u64, deadline: Instant) -> bool {
        loop {
            let notified = self.paint_notify.notified();
            tokio::pin!(notified);
            if self.current_paint_sequence() != sequence {
                return true;
            }
            if timeout_at(deadline, &mut notified).await.is_err() {
                return self.current_paint_sequence() != sequence;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn software_frame_retains_generation_and_validates_dimensions() {
        let state = PaintState::default();
        state
            .store_software_frame("electron_software_bgra", 7, 2, 1, vec![1; 8])
            .unwrap();
        let frame = state.take_last_frame().unwrap();
        assert_eq!(frame.generation, 7);
        assert_eq!(frame.software_capture_backend, "electron_software_bgra");
        assert_eq!(frame.bgra, Some(vec![1; 8]));
        for (width, height, bytes) in [(0, 1, 0), (1, 1, 3), (u32::MAX, 2, 0)] {
            assert!(state
                .store_software_frame("electron_software_bgra", 7, width, height, vec![0; bytes])
                .is_err());
        }
        assert!(state.take_last_frame().is_none());
    }

    #[test]
    fn external_paint_intent_is_consumed_once_on_every_platform() {
        let state = PaintState::default();
        assert_eq!(state.take_external_paint_intent(), None);
        state.request_paint_observation();
        assert_eq!(state.take_external_paint_intent(), Some(false));
        assert_eq!(state.take_external_paint_intent(), None);
        state.request_software_paint();
        assert_eq!(state.take_external_paint_intent(), Some(true));
        state.request_owned_texture_copy();
        state.shutdown_owned_texture_pool();
        assert_eq!(state.take_external_paint_intent(), None);
    }

    #[test]
    fn stores_and_takes_accelerated_frame() {
        let state = PaintState::default();
        state.store_accelerated_frame(AcceleratedFrame {
            software_capture_backend: "electron_software_bgra",
            generation: 0,
            width: 1200,
            height: 630,
            texture_width: 1200,
            texture_height: 630,
            source_rect: TextureSourceRect::full(1200, 630),
            color_type_debug: "format=BGRA".to_string(),
            platform_handle_debug: "d3d11".to_string(),
            owned_texture: None,
            bgra: None,
        });

        assert_eq!(state.take_last_frame().unwrap().width, 1200);
        assert!(state.take_last_frame().is_none());
    }

    #[tokio::test]
    async fn paint_waiter_resolves_when_frame_is_stored() {
        let state = PaintState::default();
        let sequence = state.current_paint_sequence();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(1);
        let waiter = state.wait_for_paint_after(sequence, deadline);

        state.store_accelerated_frame(AcceleratedFrame {
            software_capture_backend: "electron_software_bgra",
            generation: 0,
            width: 1200,
            height: 630,
            texture_width: 1200,
            texture_height: 630,
            source_rect: TextureSourceRect::full(1200, 630),
            color_type_debug: "format=BGRA".to_string(),
            platform_handle_debug: "d3d11".to_string(),
            owned_texture: None,
            bgra: None,
        });

        assert!(waiter.await);
        assert_eq!(state.current_paint_sequence(), sequence + 1);
    }

    #[tokio::test]
    async fn paint_error_advances_sequence_and_wakes_waiter() {
        let state = PaintState::default();
        let sequence = state.current_paint_sequence();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(1);
        let waiter = state.wait_for_paint_after(sequence, deadline);

        state.store_paint_error("capture.d3d11_pool_exhausted");

        assert!(waiter.await);
        assert_eq!(
            state.take_paint_error().as_deref(),
            Some("capture.d3d11_pool_exhausted")
        );
    }

    #[test]
    fn accelerated_frame_retains_only_owned_texture_lease() {
        let state = PaintState::default();
        state.store_accelerated_frame(AcceleratedFrame {
            software_capture_backend: "electron_software_bgra",
            generation: 3,
            width: 1200,
            height: 630,
            texture_width: 1200,
            texture_height: 630,
            source_rect: TextureSourceRect::full(1200, 630),
            color_type_debug: String::new(),
            platform_handle_debug: String::new(),
            owned_texture: Some(OwnedTextureLease::borrowed_for_test(1)),
            bgra: None,
        });

        let frame = state.take_last_frame().unwrap();
        assert_eq!(frame.owned_texture.as_ref().unwrap().slot_index(), 1);
        assert!(frame.bgra.is_none());
    }
}
