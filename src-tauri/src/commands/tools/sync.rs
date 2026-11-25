use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

use crate::commands::remote::{
    delete_remote_path, download_remote_file, transfer_remote_to_remote_job, upload_local_file,
    walk_remote_files, RemoteSessionStore,
};
use crate::job_runner::{self, JobKind};
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
    pub conflicts: Vec<SyncFileEntry>,
    pub mode: String,
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

fn modified_secs(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn files_differ(src: &SyncFileEntry, dst: &SyncFileEntry) -> bool {
    dst.size != src.size || (src.modified != 0 && dst.modified != 0 && dst.modified != src.modified)
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

fn compare_maps_one_way(
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
                if files_differ(src, dst) {
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
        conflicts: Vec::new(),
        mode: "one_way".into(),
    }
}

fn compare_maps_two_way(
    source: &HashMap<String, SyncFileEntry>,
    dest: &HashMap<String, SyncFileEntry>,
) -> SyncCompareResult {
    let mut added = Vec::new();
    let mut extra = Vec::new();
    let mut conflicts = Vec::new();

    for (k, src) in source {
        match dest.get(k) {
            None => added.push(src.clone()),
            Some(dst) => {
                if files_differ(src, dst) {
                    conflicts.push(src.clone());
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
        changed: Vec::new(),
        extra,
        conflicts,
        mode: "two_way".into(),
    }
}

pub async fn compare_sync_inner(
    store: &RemoteSessionStore,
    source: &str,
    dest: &str,
    mode: &str,
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

    Ok(if mode == "two_way" {
        compare_maps_two_way(&source_map, &dest_map)
    } else {
        compare_maps_one_way(&source_map, &dest_map)
    })
}

#[tauri::command]
pub async fn compare_sync(
    store: tauri::State<'_, Arc<RemoteSessionStore>>,
    source: String,
    dest: String,
    mode: Option<String>,
) -> Result<SyncCompareResult, String> {
    let mode = mode.as_deref().unwrap_or("one_way");
    compare_sync_inner(store.as_ref(), &source, &dest, mode).await
}

async fn copy_rel_path(
    store: &RemoteSessionStore,
    source: &str,
    dest: &str,
    rel: &str,
    job_id: u64,
) -> Result<(), String> {
    if job_runner::is_cancelled(job_id) {
        return Err(crate::err::code("sync_cancelled"));
    }
    let source_is_remote = path_util::is_remote_path(source);
    let dest_is_remote = path_util::is_remote_path(dest);

    if source_is_remote && dest_is_remote {
        let (cid, base_rel) = parse_remote_path(source)?;
        let remote_src = join_remote_path(
            &cid,
            &format!(
                "{}{}",
                if base_rel.is_empty() {
                    String::new()
                } else {
                    format!("{base_rel}/")
                },
                rel
            ),
        );
        let (dcid, dbase) = parse_remote_path(dest)?;
        let remote_dest_dir = if dbase.is_empty() {
            join_remote_path(&dcid, "")
        } else {
            join_remote_path(&dcid, &dbase)
        };
        let (_, _, failed, errors) = transfer_remote_to_remote_job(
            store,
            &remote_src,
            &remote_dest_dir,
            "overwrite",
            job_id,
        )
        .await?;
        if failed > 0 {
            return Err(errors
                .first()
                .cloned()
                .unwrap_or_else(|| crate::err::code("sync_copy_failed")));
        }
        return Ok(());
    }

    let source_local = PathBuf::from(source);
    let dest_local = PathBuf::from(dest);

    if source_is_remote {
        let (cid, base_rel) = parse_remote_path(source)?;
        let remote = join_remote_path(
            &cid,
            &format!(
                "{}{}",
                if base_rel.is_empty() {
                    String::new()
                } else {
                    format!("{base_rel}/")
                },
                rel
            ),
        );
        let local_dest = dest_local.join(rel);
        download_remote_file(store, &remote, &local_dest).await
    } else if dest_is_remote {
        let local_src = source_local.join(rel);
        let (cid, base_rel) = parse_remote_path(dest)?;
        let remote = join_remote_path(
            &cid,
            &format!(
                "{}{}",
                if base_rel.is_empty() {
                    String::new()
                } else {
                    format!("{base_rel}/")
                },
                rel
            ),
        );
        upload_local_file(store, &local_src, &remote).await
    } else {
        let src = source_local.join(rel);
        let dst = dest_local.join(rel);
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(|e| crate::err::with_detail("sync_copy_failed", e))?;
        }
        fs::copy(&src, &dst).map_err(|e| crate::err::with_detail("sync_copy_failed", e))?;
        Ok(())
    }
}

async fn delete_rel_at_dest(
    store: &RemoteSessionStore,
    _dest: &str,
    rel: &str,
    dest_is_remote: bool,
    dest_remote: &Option<(String, String)>,
    dest_local: &PathBuf,
) {
    if dest_is_remote {
        if let Some((cid, base_rel)) = dest_remote {
            let remote = join_remote_path(
                &cid,
                &format!(
                    "{}{}",
                    if base_rel.is_empty() {
                        String::new()
                    } else {
                        format!("{base_rel}/")
                    },
                    rel
                ),
            );
            let _ = delete_remote_path(store, &remote).await;
        }
    } else {
        let p = dest_local.join(rel);
        let _ = fs::remove_file(p);
    }
}

#[tauri::command]
pub async fn run_sync(
    app: AppHandle,
    store: tauri::State<'_, Arc<RemoteSessionStore>>,
    source: String,
    dest: String,
    delete_extras: Option<bool>,
    job_id: Option<u64>,
    mode: Option<String>,
    conflict_resolution: Option<String>,
) -> Result<SyncCompareResult, String> {
    let job_id = job_runner::resolve_or_begin(job_id, JobKind::Sync);
    let delete_extras = delete_extras.unwrap_or(false);
    let mode = mode.as_deref().unwrap_or("one_way");
    let conflict_resolution = conflict_resolution.as_deref().unwrap_or("skip");
    match conflict_resolution {
        "skip" | "prefer_source" | "prefer_dest" => {}
        _ => return Err(crate::err::code("invalid_conflict_resolution")),
    }

    let diff = compare_sync_inner(store.as_ref(), &source, &dest, mode).await?;

    let dest_is_remote = path_util::is_remote_path(&dest);

    let dest_remote = if dest_is_remote {
        Some(parse_remote_path(&dest)?)
    } else {
        None
    };
    let dest_local = PathBuf::from(&dest);

    let mut work: Vec<(String, &'static str)> = Vec::new();
    if mode == "two_way" {
        for e in &diff.added {
            work.push((e.relative_path.clone(), "push"));
        }
        for e in &diff.extra {
            work.push((e.relative_path.clone(), "pull"));
        }
        for e in &diff.conflicts {
            match conflict_resolution {
                "prefer_source" => work.push((e.relative_path.clone(), "push")),
                "prefer_dest" => work.push((e.relative_path.clone(), "pull")),
                _ => {}
            }
        }
    } else {
        for e in diff.added.iter().chain(diff.changed.iter()) {
            work.push((e.relative_path.clone(), "push"));
        }
    }

    let total = work.len() as u64
        + if delete_extras && mode == "one_way" {
            diff.extra.len() as u64
        } else {
            0
        };
    emit_sync_progress(&app, job_id, "syncing", 0, total, "starting");

    let mut current = 0u64;
    for (rel, direction) in &work {
        if job_runner::is_cancelled(job_id) {
            job_runner::clear_cancel(job_id);
            break;
        }
        let copy_res = if direction == &"pull" {
            copy_rel_path(store.as_ref(), &dest, &source, rel, job_id).await
        } else {
            copy_rel_path(store.as_ref(), &source, &dest, rel, job_id).await
        };
        if let Err(e) = copy_res {
            return Err(e);
        }
        current += 1;
        emit_sync_progress(&app, job_id, "syncing", current, total, rel);
    }

    if delete_extras && mode == "one_way" && !job_runner::is_cancelled(job_id) {
        for extra in &diff.extra {
            delete_rel_at_dest(
                store.as_ref(),
                &dest,
                &extra.relative_path,
                dest_is_remote,
                &dest_remote,
                &dest_local,
            )
            .await;
            current += 1;
            emit_sync_progress(
                &app,
                job_id,
                "deleting",
                current,
                total,
                &extra.relative_path,
            );
        }
    }

    job_runner::end_job(job_id);
    emit_sync_progress(&app, job_id, "done", total, total, "");
    Ok(diff)
}