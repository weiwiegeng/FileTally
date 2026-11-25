use std::sync::atomic::{AtomicBool, Ordering};

/// Runtime prefs shared between the FE settings and native window/tray behavior.
pub struct AppPrefs {
    close_to_tray: AtomicBool,
}

impl Default for AppPrefs {
    fn default() -> Self {
        Self {
            close_to_tray: AtomicBool::new(true),
        }
    }
}

impl AppPrefs {
    pub fn close_to_tray(&self) -> bool {
        self.close_to_tray.load(Ordering::Relaxed)
    }

    pub fn set_close_to_tray(&self, value: bool) {
        self.close_to_tray.store(value, Ordering::Relaxed);
    }
}

#[tauri::command]
pub fn set_close_to_tray(
    prefs: tauri::State<'_, std::sync::Arc<AppPrefs>>,
    enabled: bool,
) -> Result<(), String> {
    prefs.set_close_to_tray(enabled);
    Ok(())
}
