use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchOpItem {
    pub path: String,
    /// `copy` | `move`
    pub op: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchOpPreviewEntry {
    pub source_path: String,
    pub dest_path: String,
    pub op: String,
    pub exists_at_dest: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchOpPreview {
    pub entries: Vec<BatchOpPreviewEntry>,
    pub unsupported: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchOpApplyResult {
    pub applied: usize,
    pub skipped: usize,
    pub failed: usize,
    pub errors: Vec<String>,
}

fn validate_op(op: &str) -> Result<(), String> {
    match op {
        "copy" | "move" => Ok(()),
        _ => Err(crate::err::with_detail("batch_invalid_op", op)),
    }
}

fn validate_conflict(resolution: &str) -> Result<&str, String> {
    match resolution {
        "skip" | "overwrite" | "rename" => Ok(resolution),
        other => Err(crate::err::with_detail("invalid_conflict_resolution", other)),
    }
}

fn dest_for(source: &Path, dest_dir: &Path) -> PathBuf {
    let name = source
        .file_name()
        .map(|n| n.to_owned())
        .unwrap_or_else(|| std::ffi::OsString::from("unknown"));
    dest_dir.join(name)
}

fn unique_dest_name(path: &Path) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("file");
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    for i in 1..10_000 {
        let candidate = parent.join(format!("{stem} ({i}){ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    parent.join(format!(
        "{stem}_{}{ext}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ))
}

fn remove_existing(path: &Path) -> Result<(), String> {
    if path.is_dir() {
        fs::remove_dir_all(path).map_err(|e| crate::err::with_detail("batch_overwrite_failed", e))
    } else {
        fs::remove_file(path).map_err(|e| crate::err::with_detail("batch_overwrite_failed", e))
    }
}

#[tauri::command]
pub fn preview_batch_ops(items: Vec<BatchOpItem>, dest: String) -> Result<BatchOpPreview, String> {
    crate::path_util::validate_user_path(&dest)?;
    if crate::path_util::is_remote_path(&dest) {
        return Err(crate::err::code("batch_remote_unsupported"));
    }
    let dest_dir = Path::new(&dest);
    if !dest_dir.is_dir() {
        return Err(crate::err::code("target_not_dir"));
    }

    let mut entries = Vec::new();
    let mut unsupported = Vec::new();

    for item in items {
        validate_op(&item.op)?;
        if crate::path_util::is_remote_path(&item.path) {
            unsupported.push(item.path);
            continue;
        }
        crate::path_util::validate_user_path(&item.path)?;
        let src = Path::new(&item.path);
        if !src.exists() {
            unsupported.push(item.path);
            continue;
        }
        let target = dest_for(src, dest_dir);
        entries.push(BatchOpPreviewEntry {
            source_path: item.path,
            dest_path: target.to_string_lossy().to_string(),
            op: item.op,
            exists_at_dest: target.exists(),
        });
    }

    Ok(BatchOpPreview {
        entries,
        unsupported,
    })
}

#[tauri::command]
pub fn apply_batch_ops(
    items: Vec<BatchOpItem>,
    dest: String,
    archive_zip: Option<bool>,
    conflict_resolution: Option<String>,
) -> Result<BatchOpApplyResult, String> {
    if archive_zip.unwrap_or(false) {
        return Err(crate::err::code("batch_zip_unsupported"));
    }
    let resolution = validate_conflict(conflict_resolution.as_deref().unwrap_or("skip"))?;

    let preview = preview_batch_ops(items, dest)?;
    let mut applied = 0usize;
    let mut skipped = 0usize;
    let mut failed = 0usize;
    let mut errors = Vec::new();

    for entry in preview.entries {
        let src = Path::new(&entry.source_path);
        let mut dst = PathBuf::from(&entry.dest_path);

        if entry.exists_at_dest || dst.exists() {
            match resolution {
                "skip" => {
                    skipped += 1;
                    continue;
                }
                "rename" => {
                    dst = unique_dest_name(&dst);
                }
                "overwrite" => {
                    if let Err(e) = remove_existing(&dst) {
                        failed += 1;
                        errors.push(e);
                        continue;
                    }
                }
                _ => unreachable!(),
            }
        }

        if let Some(parent) = dst.parent() {
            if let Err(e) = fs::create_dir_all(parent) {
                failed += 1;
                errors.push(crate::err::with_detail("batch_mkdir_failed", e));
                continue;
            }
        }
        let result = match entry.op.as_str() {
            "copy" => {
                if src.is_dir() {
                    copy_dir_all(src, &dst)
                } else {
                    fs::copy(src, &dst).map(|_| ())
                }
            }
            "move" => fs::rename(src, &dst),
            _ => {
                failed += 1;
                errors.push(crate::err::with_detail("batch_invalid_op", &entry.op));
                continue;
            }
        };
        match result {
            Ok(()) => applied += 1,
            Err(e) => {
                failed += 1;
                errors.push(crate::err::with_detail(
                    "batch_apply_failed",
                    format!("{} -> {}: {}", entry.source_path, dst.display(), e),
                ));
            }
        }
    }

    failed += preview.unsupported.len();
    for p in preview.unsupported {
        errors.push(crate::err::with_detail("batch_unsupported_path", p));
    }

    Ok(BatchOpApplyResult {
        applied,
        skipped,
        failed,
        errors,
    })
}

fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir_all(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}
