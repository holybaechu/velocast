pub(crate) fn capabilities_json() -> anyhow::Result<String> {
    Ok(serde_json::to_string(
        &serde_json::json!({"outputApiVersion":velocast_protocol::OUTPUT_API_VERSION,"platform":std::env::consts::OS,"browserHosts":["electron"],"defaultBrowserHost":"electron","electronHostProtocolVersion":3,"videoEncoderBackend":"webcodecs","supportedMediaBackends":["webcodecs","native"],"mediaRuntime":"mediabunny","hardwareAccelerationGuarantee":false}),
    )?)
}
#[cfg(test)]
mod tests {
    #[test]
    fn capability_is_not_a_hardware_guarantee() {
        let value: serde_json::Value =
            serde_json::from_str(&super::capabilities_json().unwrap()).unwrap();
        assert_eq!(value["videoEncoderBackend"], "webcodecs");
        assert_eq!(value["hardwareAccelerationGuarantee"], false);
        assert_eq!(value["electronHostProtocolVersion"], 3);
        assert_eq!(
            value["supportedMediaBackends"],
            serde_json::json!(["webcodecs", "native"])
        );
    }
}
