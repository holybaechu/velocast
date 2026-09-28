//! Render policy evaluated from explicit job, composition, and capability facts.
//! This crate does not load browser, GPU, or encoder runtimes.

pub mod browser_surface;
pub mod codec;
pub mod paths;
pub mod render_plan;
pub mod scheduler;
