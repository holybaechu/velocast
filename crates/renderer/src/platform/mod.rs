pub(crate) fn verify_render_completion(
    telemetry: &crate::telemetry::RenderTelemetry,
    require_worker_compatibility: bool,
) -> anyhow::Result<()> {
    if require_worker_compatibility {
        telemetry.validate_required_acceleration()
    } else {
        telemetry.validate_required_acceleration_path()
    }
}
