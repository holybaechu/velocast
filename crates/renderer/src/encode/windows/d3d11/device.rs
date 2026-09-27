use anyhow::Context;
use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

pub(crate) fn initialize_com_for_d3d11_encoding() -> anyhow::Result<()> {
    unsafe {
        let result = CoInitializeEx(None, COINIT_MULTITHREADED);
        if result.is_ok() {
            return Ok(());
        }
        if result == RPC_E_CHANGED_MODE {
            return Err(anyhow::anyhow!(
                "D3D11 Media Foundation encoder requires COM MTA, but COM was already initialized in another apartment mode"
            ));
        }
        result
            .ok()
            .context("CoInitializeEx(COINIT_MULTITHREADED) failed")?;
        Ok(())
    }
}
