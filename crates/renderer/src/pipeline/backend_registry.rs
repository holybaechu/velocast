pub use velocast_renderer_policy::backend_registry::*;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn backend_diagnostic_code_labels_match_generated_contract() {
        let rust_codes = backend_diagnostic_code_labels();
        let generated_codes = crate::generated::contracts::RENDERER_BACKEND_DIAGNOSTIC_CODES
            .iter()
            .map(|code| code.to_string())
            .collect::<Vec<_>>();

        assert_eq!(rust_codes, generated_codes);
    }

    fn backend_diagnostic_code_labels() -> Vec<String> {
        BackendDiagnosticCode::ALL
            .iter()
            .map(|code| code.as_str().to_string())
            .collect()
    }
}
