//! Shared runtime for Excel smart checks: job cancel, progress, listing cache, concurrency.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

pub const SCAN_ENTRY_SOFT_CAP: usize = 2_000_000;
pub const PER_FOLDER_ENTRY_SOFT_CAP: usize = 500_000;

static EXCEL_JOB_ID: AtomicU64 = AtomicU64::new(0);
static EXCEL_CANCEL_ID: AtomicU64 = AtomicU64::new(0);

const CACHE_TTL: Duration = Duration::from_secs(90);
const CACHE_MAX_ENTRIES: usize = 16;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcelCheckProgress {
    pub job_id: u64,
    pub stage: String,
    pub current: u64,
    pub total: u64,
    pub message: String,
}

struct CachedNames {
    root_mtime: u64,
    at: Instant,
    names: HashSet<String>,
    truncated: bool,
}

struct CachedContents {
    root_mtime: u64,
    at: Instant,
    contents: HashSet<String>,
    content_paths: HashMap<String, String>,
    truncated: bool,
}

struct ListingCache {
    names: HashMap<String, CachedNames>,
    contents: HashMap<String, CachedContents>,
}

fn listing_cache() -> &'static Mutex<ListingCache> {
    static CACHE: OnceLock<Mutex<ListingCache>> = OnceLock::new();
    CACHE.get_or_init(|| {
        Mutex::new(ListingCache {
            names: HashMap::new(),
            contents: HashMap::new(),
        })
    })
}

fn begin_job() -> u64 {
    EXCEL_JOB_ID.fetch_add(1, Ordering::SeqCst) + 1
}

#[tauri::command]
pub fn prepare_excel_check() -> Result<u64, String> {
    Ok(begin_job())
}

#[tauri::command]
pub fn cancel_excel_check(job_id: Option<u64>) -> Result<(), String> {
    let id = job_id
        .filter(|v| *v > 0)
        .unwrap_or_else(|| EXCEL_JOB_ID.load(Ordering::SeqCst));
    if id > 0 {
        EXCEL_CANCEL_ID.store(id, Ordering::SeqCst);
    }
    Ok(())
}

pub fn resolve_job_id(job_id: Option<u64>) -> u64 {
    match job_id {
        Some(id) if id > 0 => id,
        _ => begin_job(),
    }
}

pub fn is_cancelled(job_id: u64) -> bool {
    EXCEL_CANCEL_ID.load(Ordering::SeqCst) == job_id
}

pub fn clear_cancel(job_id: u64) {
    let _ = EXCEL_CANCEL_ID.compare_exchange(job_id, 0, Ordering::SeqCst, Ordering::SeqCst);
}

pub fn emit_progress(
    app: &AppHandle,
    job_id: u64,
    stage: &str,
    current: u64,
    total: u64,
    message: &str,
) {
    let _ = app.emit(
        "excel-check-progress",
        ExcelCheckProgress {
            job_id,
            stage: stage.to_string(),
            current,
            total,
            message: message.to_string(),
        },
    );
}

/// Heuristic: UNC /Volumes SMB mounts / remote:// should use lower concurrency.
pub fn is_likely_network_path(path: &str) -> bool {
    if crate::path_util::is_remote_path(path) {
        return true;
    }
    let p = path.trim();
    if p.starts_with("\\\\") || p.starts_with("//") {
        return true;
    }
    // macOS network mounts
    if p.starts_with("/Volumes/") {
        return true;
    }
    // Windows drive letter mapped network shares can't be detected cheaply; keep local default.
    false
}

pub fn check_concurrency(path: &str) -> usize {
    if is_likely_network_path(path) {
        4
    } else {
        8
    }
}

fn root_mtime_secs(root: &Path) -> u64 {
    fs_mtime(root).unwrap_or(0)
}

fn fs_mtime(path: &Path) -> Option<u64> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?;
    Some(
        modified
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_secs(),
    )
}

fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn prune_names_cache(cache: &mut ListingCache) {
    let now = Instant::now();
    cache.names.retain(|_, v| now.duration_since(v.at) < CACHE_TTL);
    while cache.names.len() > CACHE_MAX_ENTRIES {
        if let Some(oldest) = cache
            .names
            .iter()
            .min_by_key(|(_, v)| v.at)
            .map(|(k, _)| k.clone())
        {
            cache.names.remove(&oldest);
        } else {
            break;
        }
    }
}

fn prune_contents_cache(cache: &mut ListingCache) {
    let now = Instant::now();
    cache.contents.retain(|_, v| now.duration_since(v.at) < CACHE_TTL);
    while cache.contents.len() > CACHE_MAX_ENTRIES {
        if let Some(oldest) = cache
            .contents
            .iter()
            .min_by_key(|(_, v)| v.at)
            .map(|(k, _)| k.clone())
        {
            cache.contents.remove(&oldest);
        } else {
            break;
        }
    }
}

/// Collect names under root (full tree), with short-lived cache keyed by path + mtime.
pub fn collect_names_under_cached(
    root: &Path,
    job_id: u64,
    progress: Option<(&AppHandle, &AtomicUsize, u64)>,
) -> (HashSet<String>, bool) {
    let key = root.to_string_lossy().to_string();
    let mtime = root_mtime_secs(root);

    if let Ok(guard) = listing_cache().lock() {
        if let Some(hit) = guard.names.get(&key) {
            if hit.root_mtime == mtime && Instant::now().duration_since(hit.at) < CACHE_TTL {
                return (hit.names.clone(), hit.truncated);
            }
        }
    }

    let (names, truncated) = collect_names_under(root, job_id, progress);

    if !is_cancelled(job_id) {
        if let Ok(mut guard) = listing_cache().lock() {
            prune_names_cache(&mut guard);
            guard.names.insert(
                key,
                CachedNames {
                    root_mtime: mtime,
                    at: Instant::now(),
                    names: names.clone(),
                    truncated,
                },
            );
        }
    }

    let _ = now_epoch();
    (names, truncated)
}

pub fn collect_contents_under_cached(
    root: &Path,
    job_id: u64,
) -> (HashSet<String>, HashMap<String, String>, bool) {
    let key = root.to_string_lossy().to_string();
    let mtime = root_mtime_secs(root);

    if let Ok(guard) = listing_cache().lock() {
        if let Some(hit) = guard.contents.get(&key) {
            if hit.root_mtime == mtime && Instant::now().duration_since(hit.at) < CACHE_TTL {
                return (
                    hit.contents.clone(),
                    hit.content_paths.clone(),
                    hit.truncated,
                );
            }
        }
    }

    let (contents, content_paths, truncated) = collect_contents_under(root, job_id);

    if !is_cancelled(job_id) {
        if let Ok(mut guard) = listing_cache().lock() {
            prune_contents_cache(&mut guard);
            guard.contents.insert(
                key,
                CachedContents {
                    root_mtime: mtime,
                    at: Instant::now(),
                    contents: contents.clone(),
                    content_paths: content_paths.clone(),
                    truncated,
                },
            );
        }
    }

    (contents, content_paths, truncated)
}

fn collect_names_under(
    root: &Path,
    job_id: u64,
    progress: Option<(&AppHandle, &AtomicUsize, u64)>,
) -> (HashSet<String>, bool) {
    let mut names: HashSet<String> = HashSet::new();
    let mut truncated = false;
    let mut count = 0usize;
    let mut last_emit = 0usize;

    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if is_cancelled(job_id) {
            break;
        }
        if entry.path() == root {
            continue;
        }
        count += 1;
        if count > SCAN_ENTRY_SOFT_CAP {
            truncated = true;
            break;
        }
        if let Some(name) = entry.path().file_name() {
            let name_str = name.to_string_lossy().to_string();
            names.insert(name_str);
            if let Some(stem) = entry.path().file_stem() {
                names.insert(stem.to_string_lossy().to_string());
            }
        }

        if let Some((app, counter, total)) = progress {
            let cur = counter.fetch_add(1, Ordering::Relaxed) + 1;
            if cur - last_emit >= 200 {
                last_emit = cur;
                emit_progress(app, job_id, "scanning", cur as u64, total, "");
            }
        }
    }

    (names, truncated)
}

fn collect_contents_under(
    root: &Path,
    job_id: u64,
) -> (HashSet<String>, HashMap<String, String>, bool) {
    let mut contents: HashSet<String> = HashSet::new();
    let mut content_paths: HashMap<String, String> = HashMap::new();
    let mut truncated = false;
    let mut count = 0usize;

    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if is_cancelled(job_id) {
            break;
        }
        if entry.path() == root {
            continue;
        }
        count += 1;
        if count > PER_FOLDER_ENTRY_SOFT_CAP {
            truncated = true;
            break;
        }
        let entry_path = entry.path();
        if let Some(name) = entry_path.file_name().map(|n| n.to_string_lossy().to_string()) {
            contents.insert(name.clone());
            content_paths
                .entry(name)
                .or_insert_with(|| entry_path.to_string_lossy().to_string());
            if let Some(stem) = entry_path.file_stem().map(|s| s.to_string_lossy().to_string()) {
                contents.insert(stem.clone());
                content_paths
                    .entry(stem)
                    .or_insert_with(|| entry_path.to_string_lossy().to_string());
            }
        }
    }

    (contents, content_paths, truncated)
}

pub fn list_person_folders(folder: &Path) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(folder).map_err(|e| crate::err::with_detail("read_dir_failed", e))?
    {
        let entry = entry.map_err(|e| crate::err::with_detail("read_dir_failed", e))?;
        let path = entry.path();
        if path.is_dir() {
            out.push(path);
        }
    }
    out.sort();
    Ok(out)
}
