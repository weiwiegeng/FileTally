use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const RING_CAP: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagEvent {
    pub ts: u64,
    pub level: String,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_id: Option<u64>,
}

static DIAG_BUF: Mutex<Vec<DiagEvent>> = Mutex::new(Vec::new());

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Append an in-memory diagnostic event (ring buffer, no secrets).
pub(crate) fn diag_log(
    level: &str,
    code: &str,
    message: impl Into<String>,
    job_id: Option<u64>,
) {
    let event = DiagEvent {
        ts: now_secs(),
        level: level.to_string(),
        code: code.to_string(),
        message: message.into(),
        job_id,
    };
    if let Ok(mut buf) = DIAG_BUF.lock() {
        if buf.len() >= RING_CAP {
            let drop_n = buf.len() - RING_CAP + 1;
            buf.drain(0..drop_n);
        }
        buf.push(event);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsExport {
    pub app_version: String,
    pub exported_at: u64,
    pub events: Vec<DiagEvent>,
}

#[tauri::command]
pub fn get_diagnostics() -> Result<Vec<DiagEvent>, String> {
    let buf = DIAG_BUF
        .lock()
        .map_err(|_| crate::err::code("diag_lock_failed"))?;
    Ok(buf.clone())
}

#[tauri::command]
pub fn clear_diagnostics() -> Result<(), String> {
    let mut buf = DIAG_BUF
        .lock()
        .map_err(|_| crate::err::code("diag_lock_failed"))?;
    buf.clear();
    Ok(())
}

/// JSON export for support — no passwords or credential payloads.
#[tauri::command]
pub fn export_diagnostics() -> Result<String, String> {
    let buf = DIAG_BUF
        .lock()
        .map_err(|_| crate::err::code("diag_lock_failed"))?;
    let payload = DiagnosticsExport {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        exported_at: now_secs(),
        events: buf.clone(),
    };
    serde_json::to_string_pretty(&payload).map_err(|e| crate::err::with_detail("diag_serialize", e))
}