//! OS keychain storage for remote connection passwords.

use keyring::Entry;

const SERVICE: &str = "FileTally";

fn entry_for(connection_id: &str) -> Result<Entry, String> {
    let id = connection_id.trim();
    if id.is_empty() {
        return Err(crate::err::code("credential_id_empty"));
    }
    Entry::new(SERVICE, id).map_err(|e| crate::err::with_detail("credential_keyring_error", e))
}

#[tauri::command]
pub fn save_connection_password(connection_id: String, password: String) -> Result<(), String> {
    let entry = entry_for(&connection_id)?;
    entry
        .set_password(&password)
        .map_err(|e| crate::err::with_detail("credential_save_failed", e))
}

#[tauri::command]
pub fn load_connection_password(connection_id: String) -> Result<Option<String>, String> {
    let entry = entry_for(&connection_id)?;
    match entry.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(crate::err::with_detail("credential_load_failed", e)),
    }
}

#[tauri::command]
pub fn delete_connection_password(connection_id: String) -> Result<(), String> {
    let entry = entry_for(&connection_id)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(crate::err::with_detail("credential_delete_failed", e)),
    }
}