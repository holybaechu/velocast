//! Render policy evaluated from explicit job, composition, and capability facts.
//! This crate does not load browser, GPU, or encoder runtimes.

pub mod backend_registry;
pub mod browser_surface;
pub mod codec;
pub mod encoder_plan;
pub mod paths;
pub mod render_plan;
pub mod scheduler;
pub mod settings;
pub mod windows_codecs;
