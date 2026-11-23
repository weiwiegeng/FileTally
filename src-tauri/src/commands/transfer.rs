use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

/// (backup path, original target) — kept until job success so cancel can restore merges.
type BackupPair = (PathBuf, PathBuf);

const TRANSFER_MAX_DEPTH: usize = 64;

/// Per-job cancel tokens (avoids stomping concurrent/next transfers)
static TRANSFER_JOB_ID: AtomicU64 = AtomicU64::new(0);
static TRANSFER_CANCEL_ID: AtomicU64 = AtomicU64::new(0);

/// 冲突文件信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub source_path: String,
    pub target_path: String,
    pub file_name: String,
    pub source_size: u64,
    pub target_size: u64,
    pub source_size_formatted: String,
    pub target_size_formatted: String,
}

/// 检查冲突响应
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckConflictsResponse {
    pub has_conflicts: bool,
    pub conflicts: Vec<ConflictFile>,
}

/// 传输结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferResult {
    pub success: bool,
    pub transferred: usize,
    pub skipped: usize,
    pub failed: usize,
    pub cancelled: bool,
    pub truncated: bool,
    pub errors: Vec<String>,
}

/// 传输进度事件
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub current_file: String,
    pub current_index: u64,
    pub total_files: u64,
    pub stage: String, // "counting" | "transferring" | "cancelled"
    pub message: String,
}

/// 路径信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathInfo {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub size_formatted: String,
}

fn begin_transfer_job() -> u64 {
    TRANSFER_JOB_ID.fetch_add(1, Ordering::SeqCst) + 1
}

fn is_cancelled(job_id: u64) -> bool {
    TRANSFER_CANCEL_ID.load(Ordering::SeqCst) == job_id
}

/// 预分配传输 job id
#[tauri::command]
pub fn prepare_transfer() -> Result<u64, String> {
    Ok(begin_transfer_job())
}

/// 取消指定传输 job；未传 job_id 时取消当前 job
#[tauri::command]
pub fn cancel_transfer(job_id: Option<u64>) -> Result<(), String> {
    let id = job_id
        .filter(|v| *v > 0)
        .unwrap_or_else(|| TRANSFER_JOB_ID.load(Ordering::SeqCst));
    if id > 0 {
        TRANSFER_CANCEL_ID.store(id, Ordering::SeqCst);
    }
    Ok(())
}

fn rollback_created(paths: &[PathBuf]) {
    for path in paths.iter().rev() {
        if path.is_dir() {
            let _ = fs::remove_dir_all(path);
        } else if path.exists() {
            let _ = fs::remove_file(path);
        }
    }
}

const TRANSFER_COUNT_CAP: u64 = 500_000;
const TRANSFER_FILE_CAP: u64 = 500_000;
/// Disposable copy targets — safe to auto-delete on next transfer / cancel.
const STAGING_PREFIX: &str = ".filetally_staging_";
/// Crash-safety backups of originals during commit — NEVER auto-deleted by cleanup.
const BACKUP_PREFIX: &str = ".filetally_backup_";
const COPY_CHUNK_SIZE: usize = 1024 * 1024;

fn unique_sibling(target: &Path, prefix: &str) -> PathBuf {
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("item");
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    parent.join(format!("{prefix}{nonce}_{name}"))
}

/// Sibling staging path used for safe overwrite (original stays until commit).
fn staging_path_for(target: &Path) -> PathBuf {
    unique_sibling(target, STAGING_PREFIX)
}

fn backup_path_for(target: &Path) -> PathBuf {
    unique_sibling(target, BACKUP_PREFIX)
}

fn is_cross_device(err: &std::io::Error) -> bool {
    // EXDEV == 18 on Unix; Windows maps CrossesDevices similarly when available.
    matches!(err.raw_os_error(), Some(18))
        || err.kind() == std::io::ErrorKind::CrossesDevices
}

fn remove_path(path: &Path) -> std::io::Result<()> {
    let meta = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    if meta.file_type().is_symlink() || meta.is_file() {
        fs::remove_file(path)
    } else {
        fs::remove_dir_all(path)
    }
}

fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

fn is_dir_nofollow(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|m| m.is_dir())
        .unwrap_or(false)
}

fn is_file_nofollow(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|m| m.is_file())
        .unwrap_or(false)
}

/// Resolve for containment checks: canonicalize when possible; else parent+name.
fn resolve_for_compare(path: &Path) -> PathBuf {
    if let Ok(c) = fs::canonicalize(path) {
        return c;
    }
    if let Some(parent) = path.parent() {
        if let Ok(cp) = fs::canonicalize(parent) {
            if let Some(name) = path.file_name() {
                return cp.join(name);
            }
        }
    }
    path.to_path_buf()
}

/// Reject copy when dest equals src or dest lies inside src (unbounded self-copy).
fn validate_transfer_pair(src: &Path, dest: &Path) -> Result<(), String> {
    let src_r = resolve_for_compare(src);
    let dest_r = resolve_for_compare(dest);
    if src_r == dest_r {
        return Err(crate::err::with_detail(
            "transfer_into_self",
            format!("{} -> {}", src.display(), dest.display()),
        ));
    }
    if dest_r.starts_with(&src_r) {
        return Err(crate::err::with_detail(
            "transfer_into_descendant",
            format!("{} -> {}", src.display(), dest.display()),
        ));
    }
    Ok(())
}

/// Copy a directory tree (used when rename fails across devices). Skips symlinks.
fn copy_dir_tree(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        if is_symlink(&from) {
            continue;
        }
        let to = dst.join(entry.file_name());
        if is_dir_nofollow(&from) {
            copy_dir_tree(&from, &to)?;
        } else if is_file_nofollow(&from) {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Rename, or copy+delete when the filesystem rejects cross-device rename (EXDEV).
fn rename_or_copy(from: &Path, to: &Path) -> std::io::Result<()> {
    match fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(e) if is_cross_device(&e) => {
            if is_dir_nofollow(from) {
                if let Err(copy_err) = copy_dir_tree(from, to) {
                    let _ = remove_path(to);
                    return Err(copy_err);
                }
            } else {
                if let Some(parent) = to.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::copy(from, to)?;
            }
            remove_path(from)?;
            Ok(())
        }
        Err(e) => Err(e),
    }
}

fn discard_backups(backups: &[BackupPair]) {
    for (backup, _) in backups {
        let _ = remove_path(backup);
    }
}

fn restore_backups(backups: &[BackupPair]) {
    for (backup, target) in backups.iter().rev() {
        if !backup.exists() {
            continue;
        }
        let _ = remove_path(target);
        let _ = rename_or_copy(backup, target);
    }
}

/// Chunked copy that observes cancel between chunks (large files).
/// Any failure after `dst` is created removes the partial file.
fn copy_file_cancellable(src: &Path, dst: &Path, job_id: u64) -> std::io::Result<()> {
    if is_cancelled(job_id) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Interrupted,
            "cancelled",
        ));
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut reader = File::open(src)?;
    let mut writer = File::create(dst)?;
    let mut buf = vec![0u8; COPY_CHUNK_SIZE];
    let copy_result = (|| -> std::io::Result<()> {
        loop {
            if is_cancelled(job_id) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Interrupted,
                    "cancelled",
                ));
            }
            let n = reader.read(&mut buf)?;
            if n == 0 {
                break;
            }
            writer.write_all(&buf[..n])?;
        }
        writer.flush()?;
        Ok(())
    })();
    if copy_result.is_err() {
        drop(writer);
        let _ = fs::remove_file(dst);
    }
    copy_result
}

/// Drop leftover disposable staging under `dir` (recursive, multi-pass). Never touches backups.
fn cleanup_stale_staging(dir: &Path) {
    fn walk(path: &Path, remaining: &mut usize, removed: &mut usize) {
        if *remaining == 0 {
            return;
        }
        let Ok(entries) = fs::read_dir(path) else {
            return;
        };
        for entry in entries.flatten() {
            if *remaining == 0 {
                return;
            }
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let child = entry.path();
            // Never delete crash-recovery backups of originals.
            if name.starts_with(BACKUP_PREFIX) {
                continue;
            }
            if name.starts_with(STAGING_PREFIX) {
                let _ = remove_path(&child);
                *remaining = remaining.saturating_sub(1);
                *removed += 1;
                continue;
            }
            if is_dir_nofollow(&child) && !is_symlink(&child) {
                walk(&child, remaining, removed);
            }
        }
    }
    // Multi-pass so deep leftovers beyond a single budget still drain over runs.
    for _ in 0..8 {
        let mut remaining = 50_000usize;
        let mut removed = 0usize;
        walk(dir, &mut remaining, &mut removed);
        if removed == 0 {
            break;
        }
    }
}

/// Replace `target` with `staging`. On success returns a backup pair for deferred cleanup/rollback.
/// On dual failure, keeps both backup and staging and includes their paths in the error.
fn commit_overwrite(staging: &Path, target: &Path) -> std::io::Result<Option<BackupPair>> {
    if !target.exists() {
        rename_or_copy(staging, target)?;
        return Ok(None);
    }

    // Backup uses a distinct prefix so startup staging cleanup cannot wipe the only original.
    let backup = backup_path_for(target);
    rename_or_copy(target, &backup)?;
    if let Err(e) = rename_or_copy(staging, target) {
        match rename_or_copy(&backup, target) {
            Ok(()) => {
                let _ = remove_path(staging);
                Err(e)
            }
            Err(restore_err) => Err(std::io::Error::new(
                e.kind(),
                format!(
                    "{}; restore failed: {}; backup kept at {}; staging kept at {}",
                    e,
                    restore_err,
                    backup.display(),
                    staging.display()
                ),
            )),
        }
    } else {
        Ok(Some((backup, target.to_path_buf())))
    }
}

/// 获取路径信息（文件或文件夹）
#[tauri::command]
pub async fn get_path_info(
    store: tauri::State<'_, std::sync::Arc<crate::commands::remote::SmbSessionStore>>,
    path: String,
) -> Result<PathInfo, String> {
    crate::path_util::validate_user_path(&path)?;

    if crate::path_util::is_remote_path(&path) {
        let info = crate::commands::remote::remote_path_info(store, path).await?;
        return Ok(PathInfo {
            path: info.path,
            name: info.name,
            is_dir: info.is_dir,
            size: info.size,
            size_formatted: info.size_formatted,
        });
    }

    let p = Path::new(&path);
    if !p.exists() {
        return Err(crate::err::code("path_not_found"));
    }

    let name = p
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    let is_dir = p.is_dir();
    let size = if is_dir {
        calculate_dir_size(p)
    } else {
        fs::metadata(p).map(|m| m.len()).unwrap_or(0)
    };

    Ok(PathInfo {
        path,
        name,
        is_dir,
        size,
        size_formatted: format_size(size),
    })
}

/// 列出文件夹内容
#[tauri::command]
pub async fn list_folder_contents(
    store: tauri::State<'_, std::sync::Arc<crate::commands::remote::SmbSessionStore>>,
    path: String,
) -> Result<Vec<PathInfo>, String> {
    crate::path_util::validate_user_path(&path)?;

    if crate::path_util::is_remote_path(&path) {
        let entries = crate::commands::remote::list_remote_dir(store, path).await?;
        return Ok(entries
            .into_iter()
            .map(|e| PathInfo {
                path: e.path,
                name: e.name,
                is_dir: e.is_dir,
                size: e.size,
                size_formatted: e.size_formatted,
            })
            .collect());
    }

    let dir_path = Path::new(&path);
    if !dir_path.exists() {
        return Err(crate::err::code("path_not_found"));
    }

    if !dir_path.is_dir() {
        return Err(crate::err::code("path_not_dir"));
    }

    let mut items = Vec::new();

    if let Ok(entries) = fs::read_dir(dir_path) {
        for entry in entries.flatten() {
            let entry_path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry_path.is_dir();
            // 列表仅统计直属文件大小，避免深层递归卡顿
            let size = if is_dir {
                calculate_dir_size_shallow(&entry_path)
            } else {
                fs::metadata(&entry_path).map(|m| m.len()).unwrap_or(0)
            };

            items.push(PathInfo {
                path: entry_path.to_string_lossy().to_string(),
                name,
                is_dir,
                size,
                size_formatted: format_size(size),
            });
        }
    }

    items.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(items)
}

fn format_size(size: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = KB * 1024;
    const GB: u64 = MB * 1024;

    if size >= GB {
        format!("{:.2} GB", size as f64 / GB as f64)
    } else if size >= MB {
        format!("{:.2} MB", size as f64 / MB as f64)
    } else if size >= KB {
        format!("{:.2} KB", size as f64 / KB as f64)
    } else {
        format!("{} B", size)
    }
}

/// 检查文件传输冲突
#[tauri::command]
pub async fn check_transfer_conflicts(
    store: tauri::State<'_, std::sync::Arc<crate::commands::remote::SmbSessionStore>>,
    source_paths: Vec<String>,
    target_path: String,
) -> Result<CheckConflictsResponse, String> {
    crate::path_util::validate_user_path(&target_path)?;

    // Remote targets: best-effort conflict detection via SMB stat
    if crate::path_util::is_remote_path(&target_path) {
        let mut conflicts = Vec::new();
        for source_path in &source_paths {
            let name = Path::new(source_path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("unknown");
            let (conn_id, rel) = crate::path_util::parse_remote_path(&target_path)?;
            let child = if rel.is_empty() {
                name.to_string()
            } else {
                format!("{rel}/{name}")
            };
            let child_path = crate::path_util::join_remote_path(&conn_id, &child);
            if crate::commands::remote::remote_path_exists(store.clone(), child_path.clone())
                .await
                .unwrap_or(false)
            {
                conflicts.push(ConflictFile {
                    source_path: source_path.clone(),
                    target_path: child_path,
                    file_name: name.to_string(),
                    source_size: 0,
                    target_size: 0,
                    source_size_formatted: String::new(),
                    target_size_formatted: String::new(),
                });
            }
        }
        return Ok(CheckConflictsResponse {
            has_conflicts: !conflicts.is_empty(),
            conflicts,
        });
    }

    let target_dir = Path::new(&target_path);
    if !target_dir.exists() {
        return Err(crate::err::code("target_dir_missing"));
    }

    if !target_dir.is_dir() {
        return Err(crate::err::code("target_not_dir"));
    }

    let mut conflicts = Vec::new();

    for source_path in &source_paths {
        let source = Path::new(source_path);

        if !source.exists() {
            continue;
        }

        let file_name = source
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();

        let target_file_path = target_dir.join(&file_name);

        if target_file_path.exists() {
            let source_size = if source.is_file() {
                fs::metadata(source).map(|m| m.len()).unwrap_or(0)
            } else {
                calculate_dir_size(source)
            };

            let target_size = if target_file_path.is_file() {
                fs::metadata(&target_file_path).map(|m| m.len()).unwrap_or(0)
            } else {
                calculate_dir_size(&target_file_path)
            };

            conflicts.push(ConflictFile {
                source_path: source_path.clone(),
                target_path: target_file_path.to_string_lossy().to_string(),
                file_name,
                source_size,
                target_size,
                source_size_formatted: format_size(source_size),
                target_size_formatted: format_size(target_size),
            });
        }
    }

    Ok(CheckConflictsResponse {
        has_conflicts: !conflicts.is_empty(),
        conflicts,
    })
}

fn calculate_dir_size(path: &Path) -> u64 {
    let mut size = 0;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let entry_path = entry.path();
            if is_symlink(&entry_path) {
                continue;
            }
            if is_file_nofollow(&entry_path) {
                size += fs::metadata(&entry_path).map(|m| m.len()).unwrap_or(0);
            } else if is_dir_nofollow(&entry_path) {
                size += calculate_dir_size(&entry_path);
            }
        }
    }
    size
}

/// 仅统计一级文件大小（不含子目录递归）
fn calculate_dir_size_shallow(path: &Path) -> u64 {
    let mut size = 0;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let entry_path = entry.path();
            if is_symlink(&entry_path) {
                continue;
            }
            if is_file_nofollow(&entry_path) {
                size += fs::metadata(&entry_path).map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    size
}

fn validate_conflict_resolution(resolution: &str) -> Result<&str, String> {
    match resolution {
        "skip" | "rename" | "overwrite" => Ok(resolution),
        _ => Err(crate::err::with_detail("invalid_conflict_resolution", resolution)),
    }
}

/// 执行文件传输
#[tauri::command]
pub async fn transfer_files(
    app: AppHandle,
    store: tauri::State<'_, std::sync::Arc<crate::commands::remote::SmbSessionStore>>,
    source_paths: Vec<String>,
    target_path: String,
    conflict_resolution: String,
    job_id: Option<u64>,
) -> Result<TransferResult, String> {
    let involves_remote = crate::path_util::is_remote_path(&target_path)
        || source_paths
            .iter()
            .any(|p| crate::path_util::is_remote_path(p));

    if involves_remote {
        return crate::commands::remote::transfer_files_remote(
            store,
            source_paths,
            target_path,
            conflict_resolution,
        )
        .await;
    }

    tokio::task::spawn_blocking(move || {
        transfer_files_sync(app, source_paths, target_path, conflict_resolution, job_id)
    })
    .await
    .map_err(|e| crate::err::with_detail("analysis_task_failed", e))?
}

fn transfer_files_sync(
    app: AppHandle,
    source_paths: Vec<String>,
    target_path: String,
    conflict_resolution: String,
    job_id: Option<u64>,
) -> Result<TransferResult, String> {
    let resolution = validate_conflict_resolution(&conflict_resolution)?;
    let job_id = match job_id {
        Some(id) if id > 0 => id,
        _ => begin_transfer_job(),
    };

    crate::path_util::validate_user_path(&target_path)?;
    for p in &source_paths {
        crate::path_util::validate_user_path(p)?;
    }

    let target_dir = Path::new(&target_path);

    if !target_dir.exists() {
        return Err(crate::err::code("target_dir_missing"));
    }

    // Clear leftovers from crashed/cancelled overwrite runs before staging again.
    cleanup_stale_staging(target_dir);

    let _ = app.emit(
        "transfer-progress",
        TransferProgress {
            current_file: String::new(),
            current_index: 0,
            total_files: 0,
            stage: "counting".to_string(),
            message: String::new(),
        },
    );

    // Count up to CAP+1 so exact-CAP trees are not falsely marked truncated.
    let count_limit = TRANSFER_COUNT_CAP.saturating_add(1);
    let mut total_files: u64 = 0;
    for source_path in &source_paths {
        if total_files >= count_limit {
            break;
        }
        let source = Path::new(source_path);
        if source.exists() {
            if is_symlink(source) {
                continue;
            }
            if is_file_nofollow(source) {
                total_files += 1;
            } else if is_dir_nofollow(source) {
                total_files += count_files_in_dir(source, count_limit - total_files, 0);
            }
        }
    }
    let count_truncated = total_files > TRANSFER_COUNT_CAP;
    if total_files > TRANSFER_COUNT_CAP {
        total_files = TRANSFER_COUNT_CAP;
    }

    let mut skipped = 0;
    let mut failed = 0;
    let mut errors = Vec::new();
    let mut cancelled = false;
    let mut truncated = count_truncated;
    let processed = Arc::new(AtomicU64::new(0));
    let files_ok = Arc::new(AtomicU64::new(0));
    // New targets / staging dirs created this run — safe to delete on cancel.
    let mut created_targets: Vec<PathBuf> = Vec::new();
    // Overwrite backups deferred until job success (enables cancel/truncate rollback).
    let mut pending_backups: Vec<BackupPair> = Vec::new();

    for source_path in &source_paths {
        if is_cancelled(job_id) {
            cancelled = true;
            break;
        }
        if processed.load(Ordering::SeqCst) >= TRANSFER_FILE_CAP {
            truncated = true;
            break;
        }

        let source = Path::new(source_path);

        if !source.exists() {
            errors.push(crate::err::with_detail("source_missing", source_path));
            failed += 1;
            continue;
        }
        if is_symlink(source) {
            errors.push(crate::err::with_detail("transfer_symlink_skipped", source_path));
            skipped += 1;
            continue;
        }

        let file_name = source
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();

        let mut target_file_path = target_dir.join(&file_name);
        let mut staging_path: Option<PathBuf> = None;
        let mut is_new_target = !target_file_path.exists();
        // Dir→dir overwrite merges in place (per-file staging); preserves dest-only files.
        let mut merge_in_place = false;

        if target_file_path.exists() {
            match resolution {
                "skip" => {
                    skipped += 1;
                    continue;
                }
                "rename" => {
                    target_file_path = generate_unique_name(&target_file_path);
                    is_new_target = true;
                }
                "overwrite" => {
                    if is_dir_nofollow(source) && is_dir_nofollow(&target_file_path) {
                        merge_in_place = true;
                        is_new_target = false;
                    } else {
                        // File overwrite or type clash: stage then commit whole item.
                        staging_path = Some(staging_path_for(&target_file_path));
                        is_new_target = false;
                    }
                }
                _ => unreachable!(),
            }
        }

        let copy_dest = staging_path
            .as_ref()
            .cloned()
            .unwrap_or_else(|| target_file_path.clone());

        if let Err(e) = validate_transfer_pair(source, &copy_dest) {
            errors.push(e);
            failed += 1;
            continue;
        }

        let nested_resolution = if merge_in_place || staging_path.is_some() {
            "overwrite"
        } else {
            resolution
        };

        let backups_before = pending_backups.len();
        let result = if is_file_nofollow(source) {
            let current = processed.fetch_add(1, Ordering::SeqCst) + 1;
            let _ = app.emit(
                "transfer-progress",
                TransferProgress {
                    current_file: file_name.clone(),
                    current_index: current,
                    total_files,
                    stage: "transferring".to_string(),
                    message: String::new(),
                },
            );
            copy_file_cancellable(source, &copy_dest, job_id)
        } else {
            copy_dir_recursive_with_progress(
                source,
                &copy_dest,
                &app,
                &processed,
                &files_ok,
                total_files,
                nested_resolution,
                job_id,
                0,
                &mut pending_backups,
            )
        };

        match result {
            Ok(_) => {
                if let Some(ref staging) = staging_path {
                    match commit_overwrite(staging, &target_file_path) {
                        Ok(Some(pair)) => pending_backups.push(pair),
                        Ok(None) => {}
                        Err(e) => {
                            // Restore any nested backups from this item; drop orphan staging if restore worked.
                            let item_backups = pending_backups.split_off(backups_before);
                            restore_backups(&item_backups);
                            if !e.to_string().contains("staging kept at") {
                                let _ = remove_path(staging);
                            }
                            errors.push(crate::err::with_detail(
                                "copy_failed",
                                format!(
                                    "{} -> {} - commit overwrite failed: {}",
                                    source_path,
                                    target_file_path.display(),
                                    e
                                ),
                            ));
                            failed += 1;
                            continue;
                        }
                    }
                }
                if is_file_nofollow(source) {
                    files_ok.fetch_add(1, Ordering::SeqCst);
                }
                if is_cancelled(job_id) {
                    cancelled = true;
                    break;
                }
            }
            Err(e) => {
                let item_backups = pending_backups.split_off(backups_before);
                restore_backups(&item_backups);
                let interrupted = e.kind() == std::io::ErrorKind::Interrupted;
                let hit_cap = interrupted && e.to_string().contains("truncated");
                if interrupted {
                    if let Some(staging) = staging_path {
                        if staging.exists() {
                            created_targets.push(staging);
                        }
                    } else if is_new_target && target_file_path.exists() {
                        created_targets.push(target_file_path.clone());
                    } else if merge_in_place {
                        cleanup_stale_staging(&target_file_path);
                    }
                    if hit_cap {
                        truncated = true;
                    } else {
                        cancelled = true;
                    }
                    break;
                }
                if let Some(staging) = staging_path {
                    if staging.exists() {
                        rollback_created(&[staging]);
                    }
                } else if merge_in_place {
                    cleanup_stale_staging(&target_file_path);
                } else if is_new_target && target_file_path.exists() {
                    // Non-cancel failure mid-copy: drop the half-written new tree/file.
                    rollback_created(&[target_file_path.clone()]);
                }
                errors.push(crate::err::with_detail(
                    "copy_failed",
                    format!("{} -> {} - {}", source_path, target_file_path.display(), e),
                ));
                failed += 1;
            }
        }
    }

    let transferred = files_ok.load(Ordering::SeqCst) as usize;

    if cancelled {
        // Roll back overwrite commits from this job; keep dest-only files intact.
        restore_backups(&pending_backups);
        pending_backups.clear();
        rollback_created(&created_targets);
        cleanup_stale_staging(target_dir);
    } else if truncated {
        // Cap stop: keep already-committed merges; only drop disposable staging / new partials.
        discard_backups(&pending_backups);
        rollback_created(&created_targets);
        cleanup_stale_staging(target_dir);
    } else {
        discard_backups(&pending_backups);
    }
    if cancelled {
        let _ = app.emit(
            "transfer-progress",
            TransferProgress {
                current_file: String::new(),
                current_index: processed.load(Ordering::SeqCst),
                total_files,
                stage: "cancelled".to_string(),
                message: String::new(),
            },
        );
    }

    Ok(TransferResult {
        success: failed == 0 && !cancelled && !truncated,
        transferred,
        skipped,
        failed,
        cancelled,
        truncated,
        errors,
    })
}

fn count_files_in_dir(path: &Path, remaining_cap: u64, depth: usize) -> u64 {
    if remaining_cap == 0 || depth > TRANSFER_MAX_DEPTH {
        return 0;
    }
    let mut count = 0u64;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            if count >= remaining_cap {
                break;
            }
            let entry_path = entry.path();
            if is_symlink(&entry_path) {
                continue;
            }
            if is_file_nofollow(&entry_path) {
                count += 1;
            } else if is_dir_nofollow(&entry_path) {
                count += count_files_in_dir(&entry_path, remaining_cap - count, depth + 1);
            }
        }
    }
    count
}

fn generate_unique_name(path: &Path) -> std::path::PathBuf {
    let parent = path.parent().unwrap_or(Path::new(""));
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("");

    let mut counter = 1;
    loop {
        let new_name = if extension.is_empty() {
            format!("{}_{}", stem, counter)
        } else {
            format!("{}_{}.{}", stem, counter, extension)
        };

        let new_path = parent.join(&new_name);
        if !new_path.exists() {
            return new_path;
        }
        counter += 1;

        if counter > 1000 {
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let new_name = if extension.is_empty() {
                format!("{}_{}", stem, timestamp)
            } else {
                format!("{}_{}.{}", stem, timestamp, extension)
            };
            return parent.join(new_name);
        }
    }
}

fn resolve_nested_target(
    dst_path: &Path,
    resolution: &str,
) -> Result<Option<std::path::PathBuf>, std::io::Error> {
    if !dst_path.exists() {
        return Ok(Some(dst_path.to_path_buf()));
    }

    match resolution {
        "skip" => Ok(None),
        "rename" => Ok(Some(generate_unique_name(dst_path))),
        // Merge into existing dirs; files are staged by the caller — never delete-before-write.
        "overwrite" => Ok(Some(dst_path.to_path_buf())),
        _ => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "invalid conflict resolution",
        )),
    }
}

/// 递归复制目录（带进度与冲突策略）。跳过符号链接；限深防环。
fn copy_dir_recursive_with_progress(
    src: &Path,
    dst: &Path,
    app: &AppHandle,
    processed: &Arc<AtomicU64>,
    files_ok: &Arc<AtomicU64>,
    total_files: u64,
    resolution: &str,
    job_id: u64,
    depth: usize,
    backups: &mut Vec<BackupPair>,
) -> std::io::Result<()> {
    if depth > TRANSFER_MAX_DEPTH {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "transfer depth limit exceeded",
        ));
    }
    if is_cancelled(job_id) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Interrupted,
            "cancelled",
        ));
    }
    if processed.load(Ordering::SeqCst) >= TRANSFER_FILE_CAP {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Interrupted,
            "truncated",
        ));
    }
    if is_symlink(src) {
        return Ok(());
    }

    fs::create_dir_all(dst)?;

    for entry in fs::read_dir(src)? {
        if is_cancelled(job_id) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "cancelled",
            ));
        }
        if processed.load(Ordering::SeqCst) >= TRANSFER_FILE_CAP {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "truncated",
            ));
        }

        let entry = entry?;
        let src_path = entry.path();
        if is_symlink(&src_path) {
            continue;
        }
        let proposed_dst = dst.join(entry.file_name());

        if is_dir_nofollow(&src_path) {
            let Some(next_dst) = resolve_nested_target(&proposed_dst, resolution)? else {
                continue;
            };
            // Destination may already be a file (case-fold / type clash) — replace via staging.
            if next_dst.exists() && !is_dir_nofollow(&next_dst) {
                if resolution == "overwrite" {
                    let staging = staging_path_for(&next_dst);
                    if let Err(e) = copy_dir_recursive_with_progress(
                        &src_path,
                        &staging,
                        app,
                        processed,
                        files_ok,
                        total_files,
                        resolution,
                        job_id,
                        depth + 1,
                        backups,
                    ) {
                        let _ = remove_path(&staging);
                        return Err(e);
                    }
                    match commit_overwrite(&staging, &next_dst) {
                        Ok(Some(pair)) => backups.push(pair),
                        Ok(None) => {}
                        Err(e) => {
                            if !e.to_string().contains("staging kept at") {
                                let _ = remove_path(&staging);
                            }
                            return Err(e);
                        }
                    }
                }
                continue;
            }
            copy_dir_recursive_with_progress(
                &src_path,
                &next_dst,
                app,
                processed,
                files_ok,
                total_files,
                resolution,
                job_id,
                depth + 1,
                backups,
            )?;
        } else if is_file_nofollow(&src_path) {
            let exists = proposed_dst.exists();
            if exists && resolution == "skip" {
                continue;
            }
            let target = if exists && resolution == "rename" {
                generate_unique_name(&proposed_dst)
            } else {
                proposed_dst.clone()
            };
            let staging = if exists && resolution == "overwrite" {
                Some(staging_path_for(&target))
            } else {
                None
            };
            let copy_dest = staging.clone().unwrap_or_else(|| target.clone());

            // Destination may be a directory — overwrite replaces it after staged copy.
            if copy_dest.exists() && is_dir_nofollow(&copy_dest) && staging.is_none() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    format!("destination is a directory: {}", copy_dest.display()),
                ));
            }

            let current = processed.fetch_add(1, Ordering::SeqCst) + 1;
            let file_name = src_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("unknown")
                .to_string();

            let _ = app.emit(
                "transfer-progress",
                TransferProgress {
                    current_file: file_name,
                    current_index: current,
                    total_files,
                    stage: "transferring".to_string(),
                    message: String::new(),
                },
            );

            if let Err(e) = copy_file_cancellable(&src_path, &copy_dest, job_id) {
                if let Some(ref staging_path) = staging {
                    let _ = remove_path(staging_path);
                }
                return Err(e);
            }
            if let Some(ref staging_path) = staging {
                match commit_overwrite(staging_path, &target) {
                    Ok(Some(pair)) => backups.push(pair),
                    Ok(None) => {}
                    Err(e) => {
                        if !e.to_string().contains("staging kept at") {
                            let _ = remove_path(staging_path);
                        }
                        return Err(e);
                    }
                }
            }
            files_ok.fetch_add(1, Ordering::SeqCst);
        }
    }

    Ok(())
}
