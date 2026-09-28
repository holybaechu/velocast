use clap::Parser;
use velocast_protocol::RenderJob;

#[derive(Debug, Parser)]
pub struct Args {
    #[arg(
        long,
        conflicts_with = "capabilities_json",
        required_unless_present = "capabilities_json"
    )]
    pub job_json: Option<String>,
    #[arg(long)]
    pub capabilities_json: bool,
}

impl Args {
    pub fn parse_job(&self) -> anyhow::Result<RenderJob> {
        let job_json = self
            .job_json
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("--job-json is required"))?;
        Ok(serde_json::from_str(job_json)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use velocast_protocol::RenderMode;

    #[test]
    fn parses_render_job_from_cli_json() {
        let args = Args::try_parse_from([
            "velocast-renderer",
            "--job-json",
            r#"{"mode":"composition","composition_id":"product-hero","serve_url":"http://127.0.0.1:4545","selector":null,"output":"out/hero.mp4","codec":"h264"}"#,
        ])
        .unwrap();

        let job = args.parse_job().unwrap();

        assert_eq!(job.mode, RenderMode::Composition);
        assert_eq!(job.composition_id.as_deref(), Some("product-hero"));
        assert_eq!(job.codec, "h264");
    }

    #[test]
    fn parses_capabilities_json_flag_without_a_render_job() {
        let args = Args::try_parse_from(["velocast-renderer", "--capabilities-json"]).unwrap();

        assert!(args.capabilities_json);
        assert!(args.job_json.is_none());
    }

    #[test]
    fn rejects_capabilities_json_with_a_render_job() {
        let error = Args::try_parse_from([
            "velocast-renderer",
            "--capabilities-json",
            "--job-json",
            r#"{"mode":"composition","composition_id":"product-hero","serve_url":"http://127.0.0.1:4545","selector":null,"output":"out/hero.mp4","codec":"h264"}"#,
        ])
        .unwrap_err()
        .to_string();

        assert!(error.contains("cannot be used with"));
    }
}
