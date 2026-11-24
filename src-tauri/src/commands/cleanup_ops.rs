use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    pub id: String,
    pub original_path: String,
    pub name: String,
    pub size: u64,
    pub deleted_at: u64,
    pub trashed_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TrashManifestItem {
    original_path: String,
    trashed_rel: String,
    name: String,
    size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TrashBatch {
    id: String,
    deleted_at: u64,
    items: Vec<TrashManifestItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TrashManifest {
    batches: Vec<TrashBatch>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteCleanupResult {
    pub deleted: usize,
    pub failed: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoCleanupResult {
    pub restored: usize,
    pub failed: usize,
    pub errors: Vec<String>,
}

fn app_data_dir() -> Result<PathBuf, String> {
    let base = dirs::data_dir().ok_or_else(|| crate::err::code("cleanup_data_dir_missing"))?;
    let dir = base.join("FileTally");
    fs::create_dir_all(&dir).map_err(|e| crate::err::with_detail("cleanup_dir_failed", e))?;
    Ok(dir)
}

fn trash_root() -> Result<PathBuf, String> {
    let dir = app_data_dir()?.join("Trash");
    fs::create_dir_all(&dir).map_err(|e| crate::err::with_detail("cleanup_dir_failed", e))?;
    Ok(dir)
}

fn manifest_path() -> Result<PathBuf, String> {
    Ok(trash_root()?.join("manifest.json"))
}

fn load_manifest() -> Result<TrashManifest, String> {
    let path = manifest_path()?;
    if !path.exists() {
        return Ok(TrashManifest { batches: vec![] });
    }
    let data = fs::read_to_string(&path)
        .map_err(|e| crate::err::with_detail("cleanup_manifest_read_failed", e))?;
    serde_json::from_str(&data).map_err(|e| crate::err::with_detail("cleanup_manifest_read_failed", e))
}

fn save_manifest(manifest: &TrashManifest) -> Result<(), String> {
    let path = manifest_path()?;
    let data = serde_json::to_string_pretty(manifest)
        .map_err(|e| crate::err::with_detail("cleanup_manifest_write_failed", e))?;
    fs::write(&path, data).map_err(|e| crate::err::with_detail("cleanup_manifest_write_failed", e))
}

/// Paths eligible for cleanup delete (aligned with scan_cleanup_suggestions categories).
fn is_cleanup_allowed_path(path: &Path) -> bool {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return false,
    };

    let allowed_roots = [
        home.join("Library/Caches"),
        PathBuf::from("/private/var/folders"),
        PathBuf::from("/tmp"),
        PathBuf::from("/private/tmp"),
        home.join(".Trash"),
        home.join("Downloads"),
        home.join("Library/Logs"),
    ];

    let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    for root in &allowed_roots {
        if !root.exists() {
            continue;
        }
        let root_canon = fs::canonicalize(root).unwrap_or_else(|_| root.clone());
        if canonical.starts_with(&root_canon) {
            return true;
        }
    }

    // Single log files directly under ~/Library/Logs or with .log suffix in known log roots
    if path.extension().and_then(|e| e.to_str()) == Some("log") {
        let parent = path.parent().unwrap_or(path);
        if let Ok(pc) = fs::canonicalize(parent) {
            let logs = home.join("Library/Logs");
            if let Ok(lc) = fs::canonicalize(&logs) {
                if pc.starts_with(&lc) {
                    return true;
                }
            }
        }
    }

    false
}

fn validate_cleanup_paths(paths: &[String]) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    for p in paths {
        crate::path_util::validate_user_path(p)?;
        if crate::path_util::is_remote_path(p) {
            return Err(crate::err::code("cleanup_remote_unsupported"));
        }
        let path = Path::new(p);
        if !is_cleanup_allowed_path(path) {
            return Err(crate::err::with_detail("cleanup_path_not_allowed", p));
        }
        if !path.exists() {
            return Err(crate::err::with_detail("path_not_found", p));
        }
        out.push(path.to_path_buf());
    }
    Ok(out)
}

fn unique_trash_name(base: &str) -> String {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{base}_{nonce}")
}

fn move_to_trash_batch(paths: &[PathBuf]) -> Result<TrashBatch, String> {
    let batch_id = unique_trash_name("batch");
    let batch_dir = trash_root()?.join(&batch_id);
    fs::create_dir_all(&batch_dir).map_err(|e| crate::err::with_detail("cleanup_trash_failed", e))?;

    let deleted_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let mut items = Vec::new();
    for src in paths {
        let name = src
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("item")
            .to_string();
        let trashed_rel = format!("{batch_id}/{name}");
        let dest = trash_root()?.join(&trashed_rel);
        if dest.exists() {
            return Err(crate::err::with_detail("cleanup_trash_collision", dest.display()));
        }
        fs::rename(src, &dest).map_err(|e| crate::err::with_detail("cleanup_trash_failed", e))?;
        let size = entry_size(&dest);
        items.push(TrashManifestItem {
            original_path: src.to_string_lossy().to_string(),
            trashed_rel,
            name,
            size,
        });
    }

    Ok(TrashBatch {
        id: batch_id,
        deleted_at,
        items,
    })
}

fn entry_size(path: &Path) -> u64 {
    if path.is_file() {
        fs::metadata(path).map(|m| m.len()).unwrap_or(0)
    } else if path.is_dir() {
        walkdir::WalkDir::new(path)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
            .filter_map(|e| fs::metadata(e.path()).ok())
            .map(|m| m.len())
            .sum()
    } else {
        0
    }
}

fn remove_path_permanent(path: &Path) -> Result<(), String> {
    if path.is_dir() {
        fs::remove_dir_all(path).map_err(|e| crate::err::with_detail("cleanup_delete_failed", e))
    } else {
        fs::remove_file(path).map_err(|e| crate::err::with_detail("cleanup_delete_failed", e))
    }
}

#[tauri::command]
pub fn delete_cleanup_items(paths: Vec<String>, to_trash: bool) -> Result<DeleteCleanupResult, String> {
    let validated = validate_cleanup_paths(&paths)?;
    let mut deleted = 0usize;
    let mut failed = 0usize;
    let mut errors = Vec::new();

    if to_trash {
        match move_to_trash_batch(&validated) {
            Ok(batch) => {
                let mut manifest = load_manifest()?;
                manifest.batches.push(batch);
                save_manifest(&manifest)?;
                deleted = validated.len();
            }
            Err(e) => {
                failed = validated.len();
                errors.push(e);
            }
        }
    } else {
        for path in validated {
            match remove_path_permanent(&path) {
                Ok(()) => deleted += 1,
                Err(e) => {
                    failed += 1;
                    errors.push(e);
                }
            }
        }
    }

    Ok(DeleteCleanupResult {
        deleted,
        failed,
        errors,
    })
}

#[tauri::command]
pub fn undo_cleanup_delete() -> Result<UndoCleanupResult, String> {
    let mut manifest = load_manifest()?;
    let batch = match manifest.batches.pop() {
        Some(b) => b,
        None => return Err(crate::err::code("cleanup_undo_empty")),
    };

    let mut restored = 0usize;
    let mut failed = 0usize;
    let mut errors = Vec::new();

    for item in batch.items.iter().rev() {
        let from = trash_root()?.join(&item.trashed_rel);
        let to = Path::new(&item.original_path);
        if !from.exists() {
            failed += 1;
            errors.push(crate::err::with_detail("cleanup_restore_missing", &item.trashed_rel));
            continue;
        }
        if let Some(parent) = to.parent() {
            if let Err(e) = fs::create_dir_all(parent) {
                failed += 1;
                errors.push(crate::err::with_detail("cleanup_restore_failed", e));
                continue;
            }
        }
        if to.exists() {
            failed += 1;
            errors.push(crate::err::with_detail("cleanup_restore_exists", &item.original_path));
            continue;
        }
        match fs::rename(&from, to) {
            Ok(()) => restored += 1,
            Err(e) => {
                failed += 1;
                errors.push(crate::err::with_detail("cleanup_restore_failed", e));
            }
        }
    }

  // Remove empty batch dir
    let batch_dir = trash_root()?.join(&batch.id);
    let _ = fs::remove_dir_all(&batch_dir);

    save_manifest(&manifest)?;

    Ok(UndoCleanupResult {
        restored,
        failed,
        errors,
    })
}

#[tauri::command]
pub fn list_trash() -> Result<Vec<TrashItem>, String> {
    let manifest = load_manifest()?;
    let mut out = Vec::new();
    for batch in &manifest.batches {
        for item in &batch.items {
            out.push(TrashItem {
                id: format!("{}/{}", batch.id, item.name),
                original_path: item.original_path.clone(),
                name: item.name.clone(),
                size: item.size,
                deleted_at: batch.deleted_at,
                trashed_path: trash_root()?
                    .join(&item.trashed_rel)
                    .to_string_lossy()
                    .to_string(),
            });
        }
    }
    out.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    Ok(out)
}

#[tauri::command]
pub fn restore_trash_item(id: String) -> Result<(), String> {
    let (batch_id, name) = id
        .split_once('/')
        .ok_or_else(|| crate::err::with_detail("trash_id_invalid", &id))?;

    let mut manifest = load_manifest()?;
    let batch_idx = manifest
        .batches
        .iter()
        .position(|b| b.id == batch_id)
        .ok_or_else(|| crate::err::with_detail("trash_item_missing", &id))?;
    let item_idx = manifest.batches[batch_idx]
        .items
        .iter()
        .position(|i| i.name == name)
        .ok_or_else(|| crate::err::with_detail("trash_item_missing", &id))?;

    let item = manifest.batches[batch_idx].items.remove(item_idx);
    if manifest.batches[batch_idx].items.is_empty() {
        let removed = manifest.batches.remove(batch_idx);
        let _ = fs::remove_dir_all(trash_root()?.join(&removed.id));
    }

    let from = trash_root()?.join(&item.trashed_rel);
    let to = Path::new(&item.original_path);
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|e| crate::err::with_detail("cleanup_restore_failed", e))?;
    }
    if to.exists() {
        return Err(crate::err::with_detail("cleanup_restore_exists", &item.original_path));
    }
    fs::rename(&from, to).map_err(|e| crate::err::with_detail("cleanup_restore_failed", e))?;
    save_manifest(&manifest)
}

#[tauri::command]
pub fn empty_trash() -> Result<u64, String> {
    let manifest = load_manifest()?;
    let mut removed = 0u64;
    for batch in manifest.batches {
        for item in batch.items {
            let p = trash_root()?.join(&item.trashed_rel);
            if p.exists() {
                if p.is_dir() {
                    let _ = fs::remove_dir_all(&p);
                } else {
                    let _ = fs::remove_file(&p);
                }
                removed += 1;
            }
        }
        let _ = fs::remove_dir_all(trash_root()?.join(&batch.id));
    }
    save_manifest(&TrashManifest { batches: vec![] })?;
    Ok(removed)
}

#[allow(dead_code)]
fn path_has_parent_escape(path: &Path) -> bool {
    for c in path.components() {
        if matches!(c, Component::ParentDir) {
            return true;
        }
    }
    false
}