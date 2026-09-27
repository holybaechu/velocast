use std::fs;

use serde_json::Value;

fn strip_utf8_bom(contents: &str) -> &str {
    contents.strip_prefix('\u{feff}').unwrap_or(contents)
}

pub fn read_input_props(path: Option<&str>) -> anyhow::Result<Option<Value>> {
    let Some(path) = path else {
        return Ok(None);
    };

    let contents = fs::read_to_string(path)
        .map_err(|error| anyhow::anyhow!("input props file {path} could not be read: {error}"))?;
    let value = serde_json::from_str(strip_utf8_bom(&contents)).map_err(|error| {
        anyhow::anyhow!("input props file {path} must contain valid JSON: {error}")
    })?;

    Ok(Some(value))
}
