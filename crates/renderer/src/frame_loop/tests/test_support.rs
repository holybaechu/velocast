use super::*;
use crate::browser_protocol::BrowserDriver;
use crate::surface::TextureSourceRect;
use std::cell::{Cell, RefCell};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use std::time::{SystemTime, UNIX_EPOCH};
use velocast_protocol::CompositionManifest;

pub(super) struct FakeBrowser {
    frames: RefCell<Vec<u32>>,
    pending_frame: Cell<Option<u32>>,
    paint_state: PaintState,
}

impl FakeBrowser {
    pub(super) fn new(paint_state: PaintState) -> Self {
        Self {
            frames: RefCell::new(Vec::new()),
            pending_frame: Cell::new(None),
            paint_state,
        }
    }

    pub(super) fn frames(&self) -> Vec<u32> {
        self.frames.borrow().clone()
    }
}

impl BrowserDriver for FakeBrowser {
    fn render_frame(&self, _script: &str, frame: u32) -> anyhow::Result<()> {
        self.frames.borrow_mut().push(frame);
        self.pending_frame.set(Some(frame));
        Ok(())
    }

    fn request_paint(&self) -> anyhow::Result<()> {
        let frame = self.pending_frame.get().unwrap_or(0);
        self.paint_state.store_accelerated_frame(AcceleratedFrame {
            software_capture_backend: "electron_software_bgra",
            generation: self.paint_state.current_generation(),
            width: 1,
            height: 1,
            texture_width: 1,
            texture_height: 1,
            source_rect: TextureSourceRect::full(1, 1),
            color_type_debug: "format=software-bgra".to_string(),
            platform_handle_debug: "test".to_string(),
            owned_texture: None,
            bgra: Some(vec![frame as u8, 0, 0, 255]),
        });
        Ok(())
    }

    fn pump(&self) {}
}

/// Preparation deliberately returns without painting. Capture callbacks arrive
/// only when pumped, including stale and mismatched callbacks before valid ones.
pub(super) struct NonblockingPreparationBrowser {
    paint_state: PaintState,
    frame: Cell<u32>,
    generation_before_capture: Cell<u64>,
    preparations: Cell<usize>,
    requests_this_frame: Cell<usize>,
    capture_copy_intents: RefCell<Vec<bool>>,
    pending_paint: RefCell<Option<(u64, u32, Vec<u8>)>>,
}

impl NonblockingPreparationBrowser {
    pub(super) fn new(paint_state: PaintState) -> Self {
        Self {
            paint_state,
            frame: Cell::new(0),
            generation_before_capture: Cell::new(0),
            preparations: Cell::new(0),
            requests_this_frame: Cell::new(0),
            capture_copy_intents: RefCell::new(Vec::new()),
            pending_paint: RefCell::new(None),
        }
    }

    pub(super) fn preparations(&self) -> usize {
        self.preparations.get()
    }

    pub(super) fn capture_copy_intents(&self) -> Vec<bool> {
        self.capture_copy_intents.borrow().clone()
    }
}

impl BrowserDriver for NonblockingPreparationBrowser {
    fn render_frame(&self, _script: &str, frame: u32) -> anyhow::Result<()> {
        self.frame.set(frame);
        self.generation_before_capture
            .set(self.paint_state.current_generation());
        self.requests_this_frame.set(0);
        Ok(())
    }

    fn invalidate_for_next_capture(&self) -> anyhow::Result<()> {
        self.preparations.set(self.preparations.get() + 1);
        assert_eq!(self.paint_state.take_external_paint_intent(), Some(false));
        assert!(self.pending_paint.borrow().is_none());
        Ok(())
    }

    fn request_paint(&self) -> anyhow::Result<()> {
        let generation = self.paint_state.current_generation();
        anyhow::ensure!(
            generation > self.generation_before_capture.get(),
            "capture paint requested before beginning its generation"
        );
        let copy = self
            .paint_state
            .take_external_paint_intent()
            .expect("capture paint intent");
        self.capture_copy_intents.borrow_mut().push(copy);
        let request = self.requests_this_frame.get() + 1;
        self.requests_this_frame.set(request);
        let generation = if request == 1 {
            generation - 1
        } else {
            generation
        };
        let width = if request == 2 { 2 } else { 1 };
        let value = if request <= 4 {
            222
        } else {
            self.frame.get() as u8
        };
        let pixels = [value, 0, 0, 255].repeat(width as usize);
        *self.pending_paint.borrow_mut() = Some((generation, width, pixels));
        Ok(())
    }

    fn pump(&self) {
        if let Some((generation, width, pixels)) = self.pending_paint.borrow_mut().take() {
            self.paint_state
                .store_software_frame("test_software_bgra", generation, width, 1, pixels)
                .expect("valid fixture paint");
        }
    }
}

pub(super) struct StaleThenCurrentPaintBrowser {
    frames: RefCell<Vec<u32>>,
    pending_frame: Cell<Option<u32>>,
    stale_sent: Cell<bool>,
    paint_state: PaintState,
}

impl StaleThenCurrentPaintBrowser {
    pub(super) fn new(paint_state: PaintState) -> Self {
        Self {
            frames: RefCell::new(Vec::new()),
            pending_frame: Cell::new(None),
            stale_sent: Cell::new(false),
            paint_state,
        }
    }

    pub(super) fn frames(&self) -> Vec<u32> {
        self.frames.borrow().clone()
    }
}

impl BrowserDriver for StaleThenCurrentPaintBrowser {
    fn render_frame(&self, _script: &str, frame: u32) -> anyhow::Result<()> {
        self.frames.borrow_mut().push(frame);
        self.pending_frame.set(Some(frame));
        self.stale_sent.set(false);
        Ok(())
    }

    fn request_paint(&self) -> anyhow::Result<()> {
        let generation = self.paint_state.current_generation();
        if generation == 0 {
            return Ok(());
        }

        if !self.stale_sent.replace(true) {
            self.paint_state.store_accelerated_frame(AcceleratedFrame {
                software_capture_backend: "electron_software_bgra",
                generation: generation.saturating_sub(1),
                width: 1,
                height: 1,
                texture_width: 1,
                texture_height: 1,
                source_rect: TextureSourceRect::full(1, 1),
                color_type_debug: "format=software-bgra".to_string(),
                platform_handle_debug: "stale-after-capture-generation".to_string(),
                owned_texture: None,
                bgra: Some(vec![72, 0, 0, 255]),
            });
            return Ok(());
        }

        if let Some(frame) = self.pending_frame.get() {
            self.paint_state.store_accelerated_frame(AcceleratedFrame {
                software_capture_backend: "electron_software_bgra",
                generation,
                width: 1,
                height: 1,
                texture_width: 1,
                texture_height: 1,
                source_rect: TextureSourceRect::full(1, 1),
                color_type_debug: "format=software-bgra".to_string(),
                platform_handle_debug: "current-after-stale".to_string(),
                owned_texture: None,
                bgra: Some(vec![frame as u8, 0, 0, 255]),
            });
        }
        Ok(())
    }

    fn pump(&self) {}
}

pub(super) struct MismatchedThenCurrentPaintBrowser {
    frames: RefCell<Vec<u32>>,
    pending_frame: Cell<Option<u32>>,
    mismatch_sent: Cell<bool>,
    paint_state: PaintState,
}

impl MismatchedThenCurrentPaintBrowser {
    pub(super) fn new(paint_state: PaintState) -> Self {
        Self {
            frames: RefCell::new(Vec::new()),
            pending_frame: Cell::new(None),
            mismatch_sent: Cell::new(false),
            paint_state,
        }
    }

    pub(super) fn frames(&self) -> Vec<u32> {
        self.frames.borrow().clone()
    }
}

impl BrowserDriver for MismatchedThenCurrentPaintBrowser {
    fn render_frame(&self, _script: &str, frame: u32) -> anyhow::Result<()> {
        self.frames.borrow_mut().push(frame);
        self.pending_frame.set(Some(frame));
        self.mismatch_sent.set(false);
        Ok(())
    }

    fn request_paint(&self) -> anyhow::Result<()> {
        let generation = self.paint_state.current_generation();
        if generation == 0 {
            return Ok(());
        }

        if !self.mismatch_sent.replace(true) {
            self.paint_state.store_accelerated_frame(AcceleratedFrame {
                software_capture_backend: "electron_software_bgra",
                generation,
                width: 2,
                height: 2,
                texture_width: 2,
                texture_height: 2,
                source_rect: TextureSourceRect::full(2, 2),
                color_type_debug: "format=software-bgra".to_string(),
                platform_handle_debug: "mismatched-after-capture-generation".to_string(),
                owned_texture: None,
                bgra: Some(vec![72, 0, 0, 255]),
            });
            return Ok(());
        }

        if let Some(frame) = self.pending_frame.get() {
            self.paint_state.store_accelerated_frame(AcceleratedFrame {
                software_capture_backend: "electron_software_bgra",
                generation,
                width: 1,
                height: 1,
                texture_width: 1,
                texture_height: 1,
                source_rect: TextureSourceRect::full(1, 1),
                color_type_debug: "format=software-bgra".to_string(),
                platform_handle_debug: "current-after-mismatch".to_string(),
                owned_texture: None,
                bgra: Some(vec![frame as u8, 0, 0, 255]),
            });
        }
        Ok(())
    }

    fn pump(&self) {}
}

pub(super) struct DelayedPaintBrowser {
    frames: RefCell<Vec<u32>>,
    pending_frame: Cell<Option<u32>>,
    pump_count: Cell<u32>,
    paint_state: PaintState,
}

impl DelayedPaintBrowser {
    pub(super) fn new(paint_state: PaintState) -> Self {
        Self {
            frames: RefCell::new(Vec::new()),
            pending_frame: Cell::new(None),
            pump_count: Cell::new(0),
            paint_state,
        }
    }

    pub(super) fn frames(&self) -> Vec<u32> {
        self.frames.borrow().clone()
    }
}

impl BrowserDriver for DelayedPaintBrowser {
    fn render_frame(&self, _script: &str, frame: u32) -> anyhow::Result<()> {
        self.frames.borrow_mut().push(frame);
        self.pending_frame.set(Some(frame));
        self.pump_count.set(0);
        Ok(())
    }

    fn pump(&self) {
        let pump_count = self.pump_count.get() + 1;
        self.pump_count.set(pump_count);
        if pump_count < 2 {
            return;
        }

        if let Some(frame) = self.pending_frame.get() {
            self.paint_state.store_accelerated_frame(AcceleratedFrame {
                software_capture_backend: "electron_software_bgra",
                generation: self.paint_state.current_generation(),
                width: 1,
                height: 1,
                texture_width: 1,
                texture_height: 1,
                source_rect: TextureSourceRect::full(1, 1),
                color_type_debug: "format=software-bgra".to_string(),
                platform_handle_debug: "delayed-paint".to_string(),
                owned_texture: None,
                bgra: Some(vec![frame as u8, 0, 0, 255]),
            });
        }
    }
}

pub(super) struct StaleDuringRenderBrowser {
    frames: RefCell<Vec<u32>>,
    pending_frame: Cell<Option<u32>>,
    pump_count: Cell<u32>,
    paint_state: PaintState,
}

impl StaleDuringRenderBrowser {
    pub(super) fn new(paint_state: PaintState) -> Self {
        Self {
            frames: RefCell::new(Vec::new()),
            pending_frame: Cell::new(None),
            pump_count: Cell::new(0),
            paint_state,
        }
    }

    pub(super) fn frames(&self) -> Vec<u32> {
        self.frames.borrow().clone()
    }
}

impl BrowserDriver for StaleDuringRenderBrowser {
    fn render_frame(&self, _script: &str, frame: u32) -> anyhow::Result<()> {
        self.frames.borrow_mut().push(frame);
        self.pending_frame.set(Some(frame));
        self.pump_count.set(0);
        self.paint_state.store_accelerated_frame(AcceleratedFrame {
            software_capture_backend: "electron_software_bgra",
            generation: self.paint_state.current_generation().saturating_sub(1),
            width: 1,
            height: 1,
            texture_width: 1,
            texture_height: 1,
            source_rect: TextureSourceRect::full(1, 1),
            color_type_debug: "format=software-bgra".to_string(),
            platform_handle_debug: "stale-preview-during-render-frame".to_string(),
            owned_texture: None,
            bgra: Some(vec![72, 0, 0, 255]),
        });
        Ok(())
    }

    fn pump(&self) {
        let pump_count = self.pump_count.get() + 1;
        self.pump_count.set(pump_count);
        if pump_count < 2 {
            return;
        }

        if let Some(frame) = self.pending_frame.get() {
            self.paint_state.store_accelerated_frame(AcceleratedFrame {
                software_capture_backend: "electron_software_bgra",
                generation: self.paint_state.current_generation(),
                width: 1,
                height: 1,
                texture_width: 1,
                texture_height: 1,
                source_rect: TextureSourceRect::full(1, 1),
                color_type_debug: "format=software-bgra".to_string(),
                platform_handle_debug: "delayed-target-paint".to_string(),
                owned_texture: None,
                bgra: Some(vec![frame as u8, 0, 0, 255]),
            });
        }
    }
}

pub(super) struct SlowPostRequestPaintBrowser {
    frames: RefCell<Vec<u32>>,
    pending_frame: Cell<Option<u32>>,
    pump_count: Cell<u32>,
    paint_state: PaintState,
}

impl SlowPostRequestPaintBrowser {
    pub(super) fn new(paint_state: PaintState) -> Self {
        Self {
            frames: RefCell::new(Vec::new()),
            pending_frame: Cell::new(None),
            pump_count: Cell::new(0),
            paint_state,
        }
    }

    pub(super) fn frames(&self) -> Vec<u32> {
        self.frames.borrow().clone()
    }
}

impl BrowserDriver for SlowPostRequestPaintBrowser {
    fn render_frame(&self, _script: &str, frame: u32) -> anyhow::Result<()> {
        self.frames.borrow_mut().push(frame);
        self.pending_frame.set(Some(frame));
        self.pump_count.set(0);
        self.paint_state.store_accelerated_frame(AcceleratedFrame {
            software_capture_backend: "electron_software_bgra",
            generation: self.paint_state.current_generation().saturating_sub(1),
            width: 1,
            height: 1,
            texture_width: 1,
            texture_height: 1,
            source_rect: TextureSourceRect::full(1, 1),
            color_type_debug: "format=software-bgra".to_string(),
            platform_handle_debug: "slow-stale-preview-during-render-frame".to_string(),
            owned_texture: None,
            bgra: Some(vec![72, 0, 0, 255]),
        });
        Ok(())
    }

    fn pump(&self) {
        let pump_count = self.pump_count.get() + 1;
        self.pump_count.set(pump_count);
        if pump_count < 4 {
            return;
        }

        if let Some(frame) = self.pending_frame.get() {
            self.paint_state.store_accelerated_frame(AcceleratedFrame {
                software_capture_backend: "electron_software_bgra",
                generation: self.paint_state.current_generation(),
                width: 1,
                height: 1,
                texture_width: 1,
                texture_height: 1,
                source_rect: TextureSourceRect::full(1, 1),
                color_type_debug: "format=software-bgra".to_string(),
                platform_handle_debug: "slow-delayed-target-paint".to_string(),
                owned_texture: None,
                bgra: Some(vec![frame as u8, 0, 0, 255]),
            });
        }
    }
}

pub(super) struct PaintDuringRenderBrowser {
    frames: RefCell<Vec<u32>>,
    pending_frame: Cell<Option<u32>>,
    pump_count: Cell<u32>,
    paint_state: PaintState,
}

impl PaintDuringRenderBrowser {
    pub(super) fn new(paint_state: PaintState) -> Self {
        Self {
            frames: RefCell::new(Vec::new()),
            pending_frame: Cell::new(None),
            pump_count: Cell::new(0),
            paint_state,
        }
    }

    pub(super) fn frames(&self) -> Vec<u32> {
        self.frames.borrow().clone()
    }
}

impl BrowserDriver for PaintDuringRenderBrowser {
    fn render_frame(&self, _script: &str, frame: u32) -> anyhow::Result<()> {
        self.frames.borrow_mut().push(frame);
        self.pending_frame.set(Some(frame));
        self.pump_count.set(0);
        self.paint_state.store_accelerated_frame(AcceleratedFrame {
            software_capture_backend: "electron_software_bgra",
            generation: self.paint_state.current_generation(),
            width: 1,
            height: 1,
            texture_width: 1,
            texture_height: 1,
            source_rect: TextureSourceRect::full(1, 1),
            color_type_debug: "format=software-bgra".to_string(),
            platform_handle_debug: "premature-paint-during-render-frame".to_string(),
            owned_texture: None,
            bgra: Some(vec![72, 0, 0, 255]),
        });
        Ok(())
    }

    fn pump(&self) {
        let pump_count = self.pump_count.get() + 1;
        self.pump_count.set(pump_count);
        if pump_count < 2 {
            return;
        }

        if let Some(frame) = self.pending_frame.get() {
            self.paint_state.store_accelerated_frame(AcceleratedFrame {
                software_capture_backend: "electron_software_bgra",
                generation: self.paint_state.current_generation(),
                width: 1,
                height: 1,
                texture_width: 1,
                texture_height: 1,
                source_rect: TextureSourceRect::full(1, 1),
                color_type_debug: "format=software-bgra".to_string(),
                platform_handle_debug: "post-request-target-paint".to_string(),
                owned_texture: None,
                bgra: Some(vec![frame as u8, 0, 0, 255]),
            });
        }
    }
}

pub(super) struct StaleFirstPostRenderPaintBrowser {
    frames: RefCell<Vec<u32>>,
    paint_requests: Cell<u32>,
    pump_count: Cell<u32>,
    paint_state: PaintState,
}

impl StaleFirstPostRenderPaintBrowser {
    pub(super) fn new(paint_state: PaintState) -> Self {
        Self {
            frames: RefCell::new(Vec::new()),
            paint_requests: Cell::new(0),
            pump_count: Cell::new(0),
            paint_state,
        }
    }

    pub(super) fn frames(&self) -> Vec<u32> {
        self.frames.borrow().clone()
    }
}

impl BrowserDriver for StaleFirstPostRenderPaintBrowser {
    fn render_frame(&self, _script: &str, frame: u32) -> anyhow::Result<()> {
        self.frames.borrow_mut().push(frame);
        self.paint_requests.set(0);
        self.pump_count.set(0);
        Ok(())
    }

    fn request_paint(&self) -> anyhow::Result<()> {
        self.paint_requests.set(self.paint_requests.get() + 1);
        Ok(())
    }

    fn pump(&self) {
        let pump_count = self.pump_count.get() + 1;
        self.pump_count.set(pump_count);

        let frame = self.frames.borrow().last().copied().unwrap_or_default();
        let stale = self.paint_requests.get() == 1 && pump_count == 1;
        let pixel_frame = if stale {
            frame.saturating_sub(1)
        } else {
            frame
        };

        self.paint_state.store_accelerated_frame(AcceleratedFrame {
            software_capture_backend: "electron_software_bgra",
            generation: self.paint_state.current_generation(),
            width: 1,
            height: 1,
            texture_width: 1,
            texture_height: 1,
            source_rect: TextureSourceRect::full(1, 1),
            color_type_debug: "format=software-bgra".to_string(),
            platform_handle_debug: if stale {
                "stale-first-post-render-surface".to_string()
            } else {
                "settled-post-render-surface".to_string()
            },
            owned_texture: None,
            bgra: Some(vec![pixel_frame as u8, 0, 0, 255]),
        });
    }
}

pub(super) struct VerySlowPostRequestPaintBrowser {
    frames: RefCell<Vec<u32>>,
    pending_frame: Cell<Option<u32>>,
    pump_count: Cell<u32>,
    paint_state: PaintState,
}

impl VerySlowPostRequestPaintBrowser {
    pub(super) fn new(paint_state: PaintState) -> Self {
        Self {
            frames: RefCell::new(Vec::new()),
            pending_frame: Cell::new(None),
            pump_count: Cell::new(0),
            paint_state,
        }
    }

    pub(super) fn frames(&self) -> Vec<u32> {
        self.frames.borrow().clone()
    }
}

impl BrowserDriver for VerySlowPostRequestPaintBrowser {
    fn render_frame(&self, _script: &str, frame: u32) -> anyhow::Result<()> {
        self.frames.borrow_mut().push(frame);
        self.pending_frame.set(Some(frame));
        self.pump_count.set(0);
        self.paint_state.store_accelerated_frame(AcceleratedFrame {
            software_capture_backend: "electron_software_bgra",
            generation: self.paint_state.current_generation().saturating_sub(1),
            width: 1,
            height: 1,
            texture_width: 1,
            texture_height: 1,
            source_rect: TextureSourceRect::full(1, 1),
            color_type_debug: "format=software-bgra".to_string(),
            platform_handle_debug: "very-slow-stale-preview-during-render-frame".to_string(),
            owned_texture: None,
            bgra: Some(vec![72, 0, 0, 255]),
        });
        Ok(())
    }

    fn pump(&self) {
        let pump_count = self.pump_count.get() + 1;
        self.pump_count.set(pump_count);
        if pump_count < 6 {
            return;
        }

        if let Some(frame) = self.pending_frame.get() {
            self.paint_state.store_accelerated_frame(AcceleratedFrame {
                software_capture_backend: "electron_software_bgra",
                generation: self.paint_state.current_generation(),
                width: 1,
                height: 1,
                texture_width: 1,
                texture_height: 1,
                source_rect: TextureSourceRect::full(1, 1),
                color_type_debug: "format=software-bgra".to_string(),
                platform_handle_debug: "very-slow-delayed-target-paint".to_string(),
                owned_texture: None,
                bgra: Some(vec![frame as u8, 0, 0, 255]),
            });
        }
    }
}

pub(super) struct LateInitialPreviewPaintBrowser {
    frames: RefCell<Vec<u32>>,
    pending_frame: Cell<Option<u32>>,
    paint_requests: Cell<u32>,
    delivered_requests: Cell<u32>,
    pump_count_for_request: Cell<u32>,
    paint_state: PaintState,
}

impl LateInitialPreviewPaintBrowser {
    pub(super) fn new(paint_state: PaintState) -> Self {
        Self {
            frames: RefCell::new(Vec::new()),
            pending_frame: Cell::new(None),
            paint_requests: Cell::new(0),
            delivered_requests: Cell::new(0),
            pump_count_for_request: Cell::new(0),
            paint_state,
        }
    }

    pub(super) fn frames(&self) -> Vec<u32> {
        self.frames.borrow().clone()
    }
}

impl BrowserDriver for LateInitialPreviewPaintBrowser {
    fn render_frame(&self, _script: &str, frame: u32) -> anyhow::Result<()> {
        self.frames.borrow_mut().push(frame);
        self.pending_frame.set(Some(frame));
        Ok(())
    }

    fn request_paint(&self) -> anyhow::Result<()> {
        self.paint_requests.set(self.paint_requests.get() + 1);
        self.pump_count_for_request.set(0);
        Ok(())
    }

    fn requires_initial_post_render_paint_settle(&self) -> bool {
        true
    }

    fn pump(&self) {
        let requests = self.paint_requests.get();
        if requests == self.delivered_requests.get() {
            return;
        }
        let pump_count = self.pump_count_for_request.get() + 1;
        self.pump_count_for_request.set(pump_count);
        if pump_count < 2 {
            return;
        }
        self.delivered_requests.set(requests);

        let pixel_frame = if requests == 1 {
            72
        } else {
            self.pending_frame.get().unwrap_or_default() as u8
        };
        self.paint_state.store_accelerated_frame(AcceleratedFrame {
            software_capture_backend: "electron_software_bgra",
            generation: self.paint_state.current_generation(),
            width: 1,
            height: 1,
            texture_width: 1,
            texture_height: 1,
            source_rect: TextureSourceRect::full(1, 1),
            color_type_debug: "format=software-bgra".to_string(),
            platform_handle_debug: if requests == 1 {
                "late-initial-preview-surface".to_string()
            } else {
                "settled-current-surface".to_string()
            },
            owned_texture: None,
            bgra: Some(vec![pixel_frame, 0, 0, 255]),
        });
    }
}

pub(super) struct ReorderedInitialPreviewPaintBrowser {
    frames: RefCell<Vec<u32>>,
    pending_frame: Cell<Option<u32>>,
    paint_requests: Cell<u32>,
    delivered_requests: Cell<u32>,
    paint_state: PaintState,
}

impl ReorderedInitialPreviewPaintBrowser {
    pub(super) fn new(paint_state: PaintState) -> Self {
        Self {
            frames: RefCell::new(Vec::new()),
            pending_frame: Cell::new(None),
            paint_requests: Cell::new(0),
            delivered_requests: Cell::new(0),
            paint_state,
        }
    }

    pub(super) fn frames(&self) -> Vec<u32> {
        self.frames.borrow().clone()
    }
}

impl BrowserDriver for ReorderedInitialPreviewPaintBrowser {
    fn render_frame(&self, _script: &str, frame: u32) -> anyhow::Result<()> {
        self.frames.borrow_mut().push(frame);
        self.pending_frame.set(Some(frame));
        Ok(())
    }

    fn request_paint(&self) -> anyhow::Result<()> {
        self.paint_requests.set(self.paint_requests.get() + 1);
        Ok(())
    }

    fn requires_initial_post_render_paint_settle(&self) -> bool {
        true
    }

    fn pump(&self) {
        let requests = self.paint_requests.get();
        if requests == self.delivered_requests.get() {
            return;
        }
        self.delivered_requests.set(requests);

        let pixel_frame = if requests == 2 {
            72
        } else {
            self.pending_frame.get().unwrap_or_default() as u8
        };
        self.paint_state.store_accelerated_frame(AcceleratedFrame {
            software_capture_backend: "electron_software_bgra",
            generation: self.paint_state.current_generation(),
            width: 1,
            height: 1,
            texture_width: 1,
            texture_height: 1,
            source_rect: TextureSourceRect::full(1, 1),
            color_type_debug: "format=software-bgra".to_string(),
            platform_handle_debug: if requests == 2 {
                "reordered-initial-preview-surface".to_string()
            } else {
                "settled-current-surface".to_string()
            },
            owned_texture: None,
            bgra: Some(vec![pixel_frame, 0, 0, 255]),
        });
    }
}

pub(super) struct MultipleInitialPreviewPaintBrowser {
    frames: RefCell<Vec<u32>>,
    pending_frame: Cell<Option<u32>>,
    paint_requests: Cell<u32>,
    delivered_requests: Cell<u32>,
    paint_state: PaintState,
}

impl MultipleInitialPreviewPaintBrowser {
    pub(super) fn new(paint_state: PaintState) -> Self {
        Self {
            frames: RefCell::new(Vec::new()),
            pending_frame: Cell::new(None),
            paint_requests: Cell::new(0),
            delivered_requests: Cell::new(0),
            paint_state,
        }
    }

    pub(super) fn frames(&self) -> Vec<u32> {
        self.frames.borrow().clone()
    }
}

impl BrowserDriver for MultipleInitialPreviewPaintBrowser {
    fn render_frame(&self, _script: &str, frame: u32) -> anyhow::Result<()> {
        self.frames.borrow_mut().push(frame);
        self.pending_frame.set(Some(frame));
        Ok(())
    }

    fn request_paint(&self) -> anyhow::Result<()> {
        self.paint_requests.set(self.paint_requests.get() + 1);
        Ok(())
    }

    fn requires_initial_post_render_paint_settle(&self) -> bool {
        true
    }

    fn pump(&self) {
        let requests = self.paint_requests.get();
        if requests == self.delivered_requests.get() {
            return;
        }
        self.delivered_requests.set(requests);

        let pixel_frame = if requests <= 4 {
            72
        } else {
            self.pending_frame.get().unwrap_or_default() as u8
        };
        self.paint_state.store_accelerated_frame(AcceleratedFrame {
            software_capture_backend: "electron_software_bgra",
            generation: self.paint_state.current_generation(),
            width: 1,
            height: 1,
            texture_width: 1,
            texture_height: 1,
            source_rect: TextureSourceRect::full(1, 1),
            color_type_debug: "format=software-bgra".to_string(),
            platform_handle_debug: if requests <= 4 {
                "multiple-initial-preview-surface".to_string()
            } else {
                "settled-current-surface".to_string()
            },
            owned_texture: None,
            bgra: Some(vec![pixel_frame, 0, 0, 255]),
        });
    }
}

pub(super) struct SecondRequestPaintBrowser {
    frames: RefCell<Vec<u32>>,
    pending_frame: Cell<Option<u32>>,
    paint_requests: Cell<u32>,
    paint_state: PaintState,
}

impl SecondRequestPaintBrowser {
    pub(super) fn new(paint_state: PaintState) -> Self {
        Self {
            frames: RefCell::new(Vec::new()),
            pending_frame: Cell::new(None),
            paint_requests: Cell::new(0),
            paint_state,
        }
    }

    pub(super) fn frames(&self) -> Vec<u32> {
        self.frames.borrow().clone()
    }

    pub(super) fn requests(&self) -> u32 {
        self.paint_requests.get()
    }
}

impl BrowserDriver for SecondRequestPaintBrowser {
    fn render_frame(&self, _script: &str, frame: u32) -> anyhow::Result<()> {
        self.frames.borrow_mut().push(frame);
        self.pending_frame.set(Some(frame));
        self.paint_requests.set(0);
        Ok(())
    }

    fn request_paint(&self) -> anyhow::Result<()> {
        let requests = self.paint_requests.get() + 1;
        self.paint_requests.set(requests);
        if requests < 2 {
            return Ok(());
        }

        if let Some(frame) = self.pending_frame.get() {
            self.paint_state.store_accelerated_frame(AcceleratedFrame {
                software_capture_backend: "electron_software_bgra",
                generation: self.paint_state.current_generation(),
                width: 1,
                height: 1,
                texture_width: 1,
                texture_height: 1,
                source_rect: TextureSourceRect::full(1, 1),
                color_type_debug: "format=software-bgra".to_string(),
                platform_handle_debug: "second-request-target-paint".to_string(),
                owned_texture: None,
                bgra: Some(vec![frame as u8, 0, 0, 255]),
            });
        }
        Ok(())
    }

    fn pump(&self) {}
}

pub(super) struct MismatchedPaintBrowser {
    frames: RefCell<Vec<u32>>,
    pending_frame: Cell<Option<u32>>,
    pump_count: Cell<u32>,
    paint_state: PaintState,
}

pub(super) struct FailingRenderBrowser;

impl BrowserDriver for FailingRenderBrowser {
    fn render_frame(&self, _script: &str, _frame: u32) -> anyhow::Result<()> {
        Err(anyhow::anyhow!("render script failed"))
    }

    fn request_paint(&self) -> anyhow::Result<()> {
        Ok(())
    }

    fn pump(&self) {}
}

#[derive(Debug)]
pub(super) struct RecordingEncoder {
    pub(super) aborted: Arc<AtomicBool>,
    pub(super) finished: Arc<AtomicBool>,
    pub(super) writes: Arc<AtomicUsize>,
    fail_after_writes: Option<usize>,
}

impl RecordingEncoder {
    pub(super) fn with_writes(writes: Arc<AtomicUsize>) -> Self {
        Self {
            aborted: Arc::new(AtomicBool::new(false)),
            finished: Arc::new(AtomicBool::new(false)),
            writes,
            fail_after_writes: None,
        }
    }

    pub(super) fn failing_after(mut self, successful_writes: usize) -> Self {
        self.fail_after_writes = Some(successful_writes);
        self
    }
}

impl FrameEncoder for RecordingEncoder {
    async fn write_frame(
        &mut self,
        _absolute_frame: u32,
        _frame: CapturedFrame,
    ) -> anyhow::Result<FrameEncodeStats> {
        if self.fail_after_writes == Some(self.writes.load(Ordering::SeqCst)) {
            return Err(anyhow::anyhow!("frame encode failed"));
        }
        self.writes.fetch_add(1, Ordering::SeqCst);
        Ok(FrameEncodeStats::default())
    }

    async fn finish(self) -> Result<(), RendererError> {
        self.finished.store(true, Ordering::SeqCst);
        Ok(())
    }

    async fn abort(self) -> Result<(), RendererError> {
        self.aborted.store(true, Ordering::SeqCst);
        Ok(())
    }
}

pub(super) struct StatsEncoder {
    pub(super) stats: crate::encoder::FrameEncodeStats,
    pub(super) writes: Arc<AtomicUsize>,
}

impl FrameEncoder for StatsEncoder {
    async fn write_frame(
        &mut self,
        _absolute_frame: u32,
        _frame: CapturedFrame,
    ) -> anyhow::Result<crate::encoder::FrameEncodeStats> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        Ok(self.stats)
    }

    async fn finish(self) -> Result<(), RendererError> {
        Ok(())
    }

    async fn abort(self) -> Result<(), RendererError> {
        Ok(())
    }
}

pub(super) struct SameSizeStaleAfterRenderBrowser {
    frames: RefCell<Vec<u32>>,
    pending_frame: Cell<Option<u32>>,
    pump_count: Cell<u32>,
    paint_state: PaintState,
}

impl SameSizeStaleAfterRenderBrowser {
    pub(super) fn new(paint_state: PaintState) -> Self {
        Self {
            frames: RefCell::new(Vec::new()),
            pending_frame: Cell::new(None),
            pump_count: Cell::new(0),
            paint_state,
        }
    }

    pub(super) fn frames(&self) -> Vec<u32> {
        self.frames.borrow().clone()
    }
}

impl BrowserDriver for SameSizeStaleAfterRenderBrowser {
    fn render_frame(&self, _script: &str, frame: u32) -> anyhow::Result<()> {
        self.frames.borrow_mut().push(frame);
        self.pending_frame.set(Some(frame));
        self.pump_count.set(0);
        Ok(())
    }

    fn request_paint(&self) -> anyhow::Result<()> {
        self.paint_state.store_accelerated_frame(AcceleratedFrame {
            software_capture_backend: "electron_software_bgra",
            generation: self.paint_state.current_generation().saturating_sub(1),
            width: 1,
            height: 1,
            texture_width: 1,
            texture_height: 1,
            source_rect: TextureSourceRect::full(1, 1),
            color_type_debug: "format=software-bgra".to_string(),
            platform_handle_debug: "same-size-stale-after-request-paint".to_string(),
            owned_texture: None,
            bgra: Some(vec![72, 0, 0, 255]),
        });
        Ok(())
    }

    fn pump(&self) {
        let pump_count = self.pump_count.get() + 1;
        self.pump_count.set(pump_count);
        if pump_count < 2 {
            return;
        }

        if let Some(frame) = self.pending_frame.get() {
            self.paint_state.store_accelerated_frame(AcceleratedFrame {
                software_capture_backend: "electron_software_bgra",
                generation: self.paint_state.current_generation(),
                width: 1,
                height: 1,
                texture_width: 1,
                texture_height: 1,
                source_rect: TextureSourceRect::full(1, 1),
                color_type_debug: "format=software-bgra".to_string(),
                platform_handle_debug: "current-frame-after-request-paint".to_string(),
                owned_texture: None,
                bgra: Some(vec![frame as u8, 0, 0, 255]),
            });
        }
    }
}

pub(super) struct DelayedPreviousPaintTaggedCurrentBrowser {
    frames: RefCell<Vec<u32>>,
    pending_frame: Cell<Option<u32>>,
    last_painted_frame: Cell<Option<u32>>,
    render_start_generation: Cell<u64>,
    delayed_previous_paints: u32,
    sent_delayed_previous: Cell<u32>,
    paint_state: PaintState,
}

impl DelayedPreviousPaintTaggedCurrentBrowser {
    pub(super) fn new(paint_state: PaintState, delayed_previous_paints: u32) -> Self {
        Self {
            frames: RefCell::new(Vec::new()),
            pending_frame: Cell::new(None),
            last_painted_frame: Cell::new(None),
            render_start_generation: Cell::new(0),
            delayed_previous_paints,
            sent_delayed_previous: Cell::new(0),
            paint_state,
        }
    }

    pub(super) fn frames(&self) -> Vec<u32> {
        self.frames.borrow().clone()
    }
}

impl BrowserDriver for DelayedPreviousPaintTaggedCurrentBrowser {
    fn render_frame(&self, _script: &str, frame: u32) -> anyhow::Result<()> {
        self.frames.borrow_mut().push(frame);
        self.pending_frame.set(Some(frame));
        self.render_start_generation
            .set(self.paint_state.current_generation());
        self.sent_delayed_previous.set(0);
        Ok(())
    }

    fn pump(&self) {
        let generation = self.paint_state.current_generation();
        if generation <= self.render_start_generation.get() {
            return;
        }

        let Some(frame) = self.pending_frame.get() else {
            return;
        };
        let previous_frame = self.last_painted_frame.get();
        let delayed_previous = previous_frame.is_some()
            && self.sent_delayed_previous.get() < self.delayed_previous_paints;
        let pixel_frame = if delayed_previous {
            self.sent_delayed_previous
                .set(self.sent_delayed_previous.get() + 1);
            previous_frame.unwrap()
        } else {
            self.last_painted_frame.set(Some(frame));
            frame
        };

        self.paint_state.store_accelerated_frame(AcceleratedFrame {
            software_capture_backend: "electron_software_bgra",
            generation,
            width: 1,
            height: 1,
            texture_width: 1,
            texture_height: 1,
            source_rect: TextureSourceRect::full(1, 1),
            color_type_debug: "format=software-bgra".to_string(),
            platform_handle_debug: if delayed_previous {
                "delayed-previous-tagged-current".to_string()
            } else {
                "current-frame-after-delayed-previous".to_string()
            },
            owned_texture: None,
            bgra: Some(vec![pixel_frame as u8, 0, 0, 255]),
        });
    }
}

impl MismatchedPaintBrowser {
    pub(super) fn new(paint_state: PaintState) -> Self {
        Self {
            frames: RefCell::new(Vec::new()),
            pending_frame: Cell::new(None),
            pump_count: Cell::new(0),
            paint_state,
        }
    }

    pub(super) fn frames(&self) -> Vec<u32> {
        self.frames.borrow().clone()
    }
}

impl BrowserDriver for MismatchedPaintBrowser {
    fn render_frame(&self, _script: &str, frame: u32) -> anyhow::Result<()> {
        self.frames.borrow_mut().push(frame);
        self.pending_frame.set(Some(frame));
        self.pump_count.set(0);
        Ok(())
    }

    fn pump(&self) {
        let pump_count = self.pump_count.get() + 1;
        self.pump_count.set(pump_count);
        if pump_count == 1 {
            self.paint_state.store_accelerated_frame(AcceleratedFrame {
                software_capture_backend: "electron_software_bgra",
                generation: self.paint_state.current_generation(),
                width: 2,
                height: 2,
                texture_width: 2,
                texture_height: 2,
                source_rect: TextureSourceRect::full(2, 2),
                color_type_debug: "format=software-bgra".to_string(),
                platform_handle_debug: "previous-viewport-paint".to_string(),
                owned_texture: None,
                bgra: Some(vec![72, 0, 0, 255]),
            });
            return;
        }
        if pump_count < 3 {
            return;
        }

        if let Some(frame) = self.pending_frame.get() {
            self.paint_state.store_accelerated_frame(AcceleratedFrame {
                software_capture_backend: "electron_software_bgra",
                generation: self.paint_state.current_generation(),
                width: 1,
                height: 1,
                texture_width: 1,
                texture_height: 1,
                source_rect: TextureSourceRect::full(1, 1),
                color_type_debug: "format=software-bgra".to_string(),
                platform_handle_debug: "current-viewport-paint".to_string(),
                owned_texture: None,
                bgra: Some(vec![frame as u8, 0, 0, 255]),
            });
        }
    }
}

pub(super) fn temp_chunk_path() -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "velocast-test-chunk-{}.bgra",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

pub(super) fn manifest(id: &str) -> CompositionManifest {
    CompositionManifest {
        id: id.to_string(),
        width: 1,
        height: 1,
        fps: 30,
        duration_frames: 90,
        target: Some(format!("#{id}")),
        url: None,
        max_concurrency: None,
    }
}

pub(super) fn composition_manifest() -> CompositionManifest {
    manifest("hero")
}

pub(super) fn render_job() -> RenderJob {
    RenderJob {
        operation: velocast_protocol::RenderOperation::Render,
        output_frame: None,
        output_range: None,
        result_path: None,
        mode: velocast_protocol::RenderMode::Composition,
        composition_id: Some("hero".to_string()),
        composition: None,
        serve_url: "http://127.0.0.1:4545".to_string(),
        selector: None,
        output: "out.mp4".to_string(),
        codec: "h264".to_string(),
        pixel_format: Some("yuv444p".to_string()),
        bitrate_bps: None,
        acceleration: velocast_protocol::RendererAcceleration::Auto,
        concurrency: None,
        assembly_mode: velocast_protocol::RendererAssemblyMode::Auto,
        capture_probe: None,
        report_path: None,
        worker_report_path: None,
        event_log_path: None,
        input_props_path: None,
        render_session: None,
        verify_segments: false,
        frame_start: None,
        frame_end: None,
        frame_step: None,
        chunk_output: None,
    }
}
