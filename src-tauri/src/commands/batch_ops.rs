use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::State;

use crate::commands::remote::{
    delete_remote_path, remote_path_exists_inner, transfer_local_to_remote_job,
    transfer_remote_to_local_job, transfer_remote_to_remote_job, RemoteSessionStore,
};
use crate::path_util::{self, join_remote_path, parse_remote_path};

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

pub(crate) fn validate_conflict(resolution: &str) -> Result<&str, String> {
    match resolution {
        "skip" | "overwrite" | "rename" => Ok(resolution),
        other => Err(crate::err::with_detail("invalid_conflict_resolution", other)),
    }
}

fn file_name_from_source(source: &str) -> Result<String, String> {
    if path_util::is_remote_path(source) {
        let (_, rel) = parse_remote_path(source)?;
        Ok(rel
            .rsplit('/')
            .find(|s| !s.is_empty())
            .unwrap_or("unknown")
            .to_string())
    } else {
        let src = Path::new(source);
        Ok(src
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string())
    }
}

fn dest_for_local(source: &Path, dest_dir: &Path) -> PathBuf {
    let name = source
        .file_name()
        .map(|n| n.to_owned())
        .unwrap_or_else(|| std::ffi::OsString::from("unknown"));
    dest_dir.join(name)
}

fn remote_parent_dir(remote_path: &str) -> Result<String, String> {
    let (conn_id, rel) = parse_remote_path(remote_path)?;
    let parent_rel = rel.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
    Ok(join_remote_path(&conn_id, parent_rel))
}

fn dest_path_for(source: &str, dest: &str) -> Result<String, String> {
    let name = file_name_from_source(source)?;
    if path_util::is_remote_path(dest) {
        let (conn_id, dest_rel) = parse_remote_path(dest)?;
        let joined = if dest_rel.is_empty() {
            name
        } else {
            format!("{dest_rel}/{name}")
        };
        Ok(join_remote_path(&conn_id, &joined))
    } else {
        Ok(dest_for_local(Path::new(source), Path::new(dest))
            .to_string_lossy()
            .to_string())
    }
}

async fn validate_dest_dir(store: &RemoteSessionStore, dest: &str) -> Result<(), String> {
    crate::path_util::validate_user_path(dest)?;
    if path_util::is_remote_path(dest) {
        if !remote_path_exists_inner(store, dest).await.unwrap_or(false) {
            return Err(crate::err::code("target_not_dir"));
        }
        Ok(())
    } else {
        let dest_dir = Path::new(dest);
        if !dest_dir.is_dir() {
            return Err(crate::err::code("target_not_dir"));
        }
        Ok(())
    }
}

async fn path_exists(store: &RemoteSessionStore, path: &str) -> bool {
    if path_util::is_remote_path(path) {
        remote_path_exists_inner(store, path)
            .await
            .unwrap_or(false)
    } else {
        Path::new(path).exists()
    }
}

pub(crate) fn unique_dest_name(path: &Path) -> PathBuf {
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

async fn build_batch_preview(
    store: &RemoteSessionStore,
    items: Vec<BatchOpItem>,
    dest: String,
) -> Result<BatchOpPreview, String> {
    validate_dest_dir(store, &dest).await?;

    let mut entries = Vec::new();
    let mut unsupported = Vec::new();

    for item in items {
        validate_op(&item.op)?;
        crate::path_util::validate_user_path(&item.path)?;
        if !path_exists(store, &item.path).await {
            unsupported.push(item.path);
            continue;
        }
        let target = dest_path_for(&item.path, &dest)?;
        let exists_at_dest = path_exists(store, &target).await;
        entries.push(BatchOpPreviewEntry {
            source_path: item.path,
            dest_path: target,
            op: item.op,
            exists_at_dest,
        });
    }

    Ok(BatchOpPreview {
        entries,
        unsupported,
    })
}

#[tauri::command]
pub async fn preview_batch_ops(
    store: State<'_, Arc<RemoteSessionStore>>,
    items: Vec<BatchOpItem>,
    dest: String,
) -> Result<BatchOpPreview, String> {
    build_batch_preview(store.inner().as_ref(), items, dest).await
}

#[tauri::command]
pub async fn apply_batch_ops(
    store: State<'_, Arc<RemoteSessionStore>>,
    items: Vec<BatchOpItem>,
    dest: String,
    archive_zip: Option<bool>,
    conflict_resolution: Option<String>,
) -> Result<BatchOpApplyResult, String> {
    if archive_zip.unwrap_or(false) {
        return Err(crate::err::code("batch_zip_unsupported"));
    }
    let resolution = validate_conflict(conflict_resolution.as_deref().unwrap_or("skip"))?;

    let preview = build_batch_preview(store.inner().as_ref(), items, dest.clone()).await?;
    let dest_is_remote = path_util::is_remote_path(&dest);
    let mut applied = 0usize;
    let mut skipped = 0usize;
    let mut failed = 0usize;
    let mut errors = Vec::new();

    for entry in preview.entries {
        let src_is_remote = path_util::is_remote_path(&entry.source_path);
        let involves_remote = src_is_remote || dest_is_remote;

        if involves_remote {
            let store_ref = store.inner().as_ref();
            let job_result = if src_is_remote && dest_is_remote {
                let target_dir = remote_parent_dir(&entry.dest_path)?;
                transfer_remote_to_remote_job(
                    store_ref,
                    &entry.source_path,
                    &target_dir,
                    resolution,
                    0,
                )
                .await
            } else if src_is_remote {
                transfer_remote_to_local_job(
                    store_ref,
                    &entry.source_path,
                    Path::new(&dest),
                    resolution,
                    0,
                )
                .await
            } else {
                transfer_local_to_remote_job(
                    store_ref,
                    Path::new(&entry.source_path),
                    &dest,
                    resolution,
                    0,
                )
                .await
            };

            match job_result {
                Ok((t, s, f, e)) => {
                    applied += t as usize;
                    skipped += s as usize;
                    failed += f as usize;
                    errors.extend(e);

                    if entry.op == "move" && t > 0 && f == 0 {
                        if src_is_remote {
                            if let Err(e) = delete_remote_path(store_ref, &entry.source_path).await
                            {
                                errors.push(crate::err::with_detail(
                                    "batch_apply_failed",
                                    format!("{}: move delete remote source: {}", entry.source_path, e),
                                ));
                            }
                        } else {
                            let src = Path::new(&entry.source_path);
                            let del = if src.is_dir() {
                                fs::remove_dir_all(src)
                            } else {
                                fs::remove_file(src)
                            };
                            if let Err(e) = del {
                                errors.push(crate::err::with_detail(
                                    "batch_apply_failed",
                                    format!(
                                        "{}: move delete local source: {}",
                                        entry.source_path, e
                                    ),
                                ));
                            }
                        }
                    }
                }
                Err(e) => {
                    failed += 1;
                    errors.push(e);
                }
            }
            continue;
        }

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;

    #[test]
    fn validate_conflict_accepts_standard_modes() {
        assert_eq!(validate_conflict("skip").unwrap(), "skip");
        assert_eq!(validate_conflict("rename").unwrap(), "rename");
        assert!(validate_conflict("invalid").is_err());
    }

    #[test]
    fn unique_dest_name_appends_suffix() {
        let dir = std::env::temp_dir().join(format!(
            "filetally_batch_test_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let base = dir.join("doc.txt");
        File::create(&base).unwrap().write_all(b"x").unwrap();

        let alt = unique_dest_name(&base);
        assert_ne!(alt, base);
        assert!(alt
            .file_name()
            .unwrap()
            .to_string_lossy()
            .contains("(1)"));
        assert!(!alt.exists());

        let _ = fs::remove_dir_all(&dir);
    }
}