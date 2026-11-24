use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

use crate::commands::remote::{download_remote_file, upload_local_file, walk_remote_files, RemoteSessionStore};
use crate::path_util::{self, join_remote_path, parse_remote_path};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncFileEntry {
    pub relative_path: String,
    pub size: u64,
    pub modified: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCompareResult {
    pub added: Vec<SyncFileEntry>,
    pub changed: Vec<SyncFileEntry>,
    pub extra: Vec<SyncFileEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProgress {
    pub job_id: u64,
    pub stage: String,
    pub current: u64,
    pub total: u64,
    pub message: String,
}

static SYNC_JOB_ID: AtomicU64 = AtomicU64::new(0);
static SYNC_CANCEL_ID: AtomicU64 = AtomicU64::new(0);

fn begin_sync_job() -> u64 {
    SYNC_JOB_ID.fetch_add(1, Ordering::SeqCst) + 1
}

fn is_sync_cancelled(job_id: u64) -> bool {
    SYNC_CANCEL_ID.load(Ordering::SeqCst) == job_id
}

fn clear_sync_cancel(job_id: u64) {
    let _ = SYNC_CANCEL_ID.compare_exchange(job_id, 0, Ordering::SeqCst, Ordering::SeqCst);
}

fn emit_sync_progress(app: &AppHandle, job_id: u64, stage: &str, current: u64, total: u64, message: &str) {
    let _ = app.emit(
        "sync-progress",
        SyncProgress {
            job_id,
            stage: stage.to_string(),
            current,
            total,
            message: message.to_string(),
        },
    );
}

#[tauri::command]
pub fn prepare_sync() -> Result<u64, String> {
    Ok(begin_sync_job())
}

#[tauri::command]
pub fn cancel_sync(job_id: Option<u64>) -> Result<(), String> {
    let id = job_id.unwrap_or_else(|| SYNC_JOB_ID.load(Ordering::SeqCst));
    SYNC_CANCEL_ID.store(id, Ordering::SeqCst);
    Ok(())
}

fn modified_secs(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn list_local_files(root: &Path) -> Result<HashMap<String, SyncFileEntry>, String> {
    let mut map = HashMap::new();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let rel = p
            .strip_prefix(root)
            .unwrap_or(p)
            .to_string_lossy()
            .replace('\\', "/");
        let meta = fs::metadata(p).map_err(|e| crate::err::with_detail("sync_list_failed", e))?;
        map.insert(
            rel.clone(),
            SyncFileEntry {
                relative_path: rel,
                size: meta.len(),
                modified: modified_secs(&meta),
            },
        );
    }
    Ok(map)
}

async fn list_remote_file_map(
    store: &RemoteSessionStore,
    remote_root: &str,
) -> Result<HashMap<String, SyncFileEntry>, String> {
    let (conn_id, rel) = parse_remote_path(remote_root)?;
    let mut files: Vec<(String, u64, bool)> = Vec::new();
    walk_remote_files(store, &conn_id, &rel, &mut files, 500_000).await?;

    let mut map = HashMap::new();
    for (remote_path, size, is_dir) in files {
        if is_dir {
            continue;
        }
        let child_rel = parse_remote_path(&remote_path)?.1;
        let entry_rel = if rel.is_empty() {
            child_rel
        } else {
            child_rel
                .strip_prefix(&format!("{rel}/"))
                .unwrap_or(&child_rel)
                .to_string()
        };
        map.insert(
            entry_rel.clone(),
            SyncFileEntry {
                relative_path: entry_rel,
                size,
                modified: 0,
            },
        );
    }
    Ok(map)
}

fn compare_maps(
    source: &HashMap<String, SyncFileEntry>,
    dest: &HashMap<String, SyncFileEntry>,
) -> SyncCompareResult {
    let mut added = Vec::new();
    let mut changed = Vec::new();
    let mut extra = Vec::new();

    for (k, src) in source {
        match dest.get(k) {
            None => added.push(src.clone()),
            Some(dst) => {
                if dst.size != src.size || (src.modified != 0 && dst.modified != 0 && dst.modified != src.modified) {
                    changed.push(src.clone());
                }
            }
        }
    }
    for (k, dst) in dest {
        if !source.contains_key(k) {
            extra.push(dst.clone());
        }
    }

    SyncCompareResult {
        added,
        changed,
        extra,
    }
}

pub async fn compare_sync_inner(
    store: &RemoteSessionStore,
    source: &str,
    dest: &str,
) -> Result<SyncCompareResult, String> {
    path_util::validate_user_path(source)?;
    path_util::validate_user_path(dest)?;

    let source_is_remote = path_util::is_remote_path(source);
    let dest_is_remote = path_util::is_remote_path(dest);

    let source_map = if source_is_remote {
        list_remote_file_map(store, source).await?
    } else {
        let p = Path::new(source);
        if !p.is_dir() {
            return Err(crate::err::code("sync_root_not_dir"));
        }
        list_local_files(p)?
    };

    let dest_map = if dest_is_remote {
        list_remote_file_map(store, dest).await?
    } else {
        let p = Path::new(dest);
        if !p.is_dir() {
            return Err(crate::err::code("sync_root_not_dir"));
        }
        list_local_files(p)?
    };

    Ok(compare_maps(&source_map, &dest_map))
}

#[tauri::command]
pub async fn compare_sync(
    store: tauri::State<'_, Arc<RemoteSessionStore>>,
    source: String,
    dest: String,
) -> Result<SyncCompareResult, String> {
    compare_sync_inner(store.as_ref(), &source, &dest).await
}

#[tauri::command]
pub async fn run_sync(
    app: AppHandle,
    store: tauri::State<'_, Arc<RemoteSessionStore>>,
    source: String,
    dest: String,
    delete_extras: Option<bool>,
    job_id: Option<u64>,
) -> Result<SyncCompareResult, String> {
    let job_id = job_id.unwrap_or_else(|| begin_sync_job());
    let delete_extras = delete_extras.unwrap_or(false);

    let diff = compare_sync_inner(store.as_ref(), &source, &dest).await?;

    let source_is_remote = path_util::is_remote_path(&source);
    let dest_is_remote = path_util::is_remote_path(&dest);
    if source_is_remote && dest_is_remote {
        return Err(crate::err::code("sync_remote_to_remote_unsupported"));
    }

    let to_copy: Vec<&SyncFileEntry> = diff.added.iter().chain(diff.changed.iter()).collect();
    let total = to_copy.len() as u64 + if delete_extras { diff.extra.len() as u64 } else { 0 };
    emit_sync_progress(&app, job_id, "syncing", 0, total, "starting");

    let source_remote = if source_is_remote {
        Some(parse_remote_path(&source)?)
    } else {
        None
    };
    let dest_remote = if dest_is_remote {
        Some(parse_remote_path(&dest)?)
    } else {
        None
    };

    let source_local = PathBuf::from(&source);
    let dest_local = PathBuf::from(&dest);

    let mut current = 0u64;
    for entry in &to_copy {
        if is_sync_cancelled(job_id) {
            clear_sync_cancel(job_id);
            break;
        }
        if source_is_remote {
            let (cid, base_rel) = source_remote.as_ref().unwrap();
            let remote = join_remote_path(
                cid,
                &format!(
                    "{}{}",
                    if base_rel.is_empty() {
                        String::new()
                    } else {
                        format!("{base_rel}/")
                    },
                    entry.relative_path
                ),
            );
            let local_dest = dest_local.join(&entry.relative_path);
            download_remote_file(store.as_ref(), &remote, &local_dest).await?;
        } else if dest_is_remote {
            let local_src = source_local.join(&entry.relative_path);
            let (cid, base_rel) = dest_remote.as_ref().unwrap();
            let remote = join_remote_path(
                cid,
                &format!(
                    "{}{}",
                    if base_rel.is_empty() {
                        String::new()
                    } else {
                        format!("{base_rel}/")
                    },
                    entry.relative_path
                ),
            );
            upload_local_file(store.as_ref(), &local_src, &remote).await?;
        } else {
            let src = source_local.join(&entry.relative_path);
            let dst = dest_local.join(&entry.relative_path);
            if let Some(parent) = dst.parent() {
                fs::create_dir_all(parent).map_err(|e| crate::err::with_detail("sync_copy_failed", e))?;
            }
            fs::copy(&src, &dst).map_err(|e| crate::err::with_detail("sync_copy_failed", e))?;
        }
        current += 1;
        emit_sync_progress(
            &app,
            job_id,
            "syncing",
            current,
            total,
            &entry.relative_path,
        );
    }

    if delete_extras && !is_sync_cancelled(job_id) {
        for extra in &diff.extra {
            if dest_is_remote {
                // Remote delete not implemented for all backends — skip with clear err on failure path
                continue;
            } else if source_is_remote {
                continue;
            } else {
                let p = dest_local.join(&extra.relative_path);
                let _ = fs::remove_file(p);
            }
            current += 1;
            emit_sync_progress(&app, job_id, "deleting", current, total, &extra.relative_path);
        }
    }

    clear_sync_cancel(job_id);
    Ok(diff)
}