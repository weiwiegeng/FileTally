use regex::RegexBuilder;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

use crate::path_util;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilteredFile {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub modified: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleFilterOptions {
    pub extensions: String,
    pub min_size_bytes: Option<u64>,
    pub max_size_bytes: Option<u64>,
    pub modified_within_days: u64,
    pub path_regex: Option<String>,
    pub logic: String,
}

const FILTER_CAP: usize = 200_000;

static RULE_FILTER_JOB_ID: AtomicU64 = AtomicU64::new(0);
static RULE_FILTER_CANCEL_ID: AtomicU64 = AtomicU64::new(0);

fn begin_rule_filter_job() -> u64 {
    RULE_FILTER_JOB_ID.fetch_add(1, Ordering::SeqCst) + 1
}

fn is_rule_filter_cancelled(job_id: u64) -> bool {
    RULE_FILTER_CANCEL_ID.load(Ordering::SeqCst) == job_id
}

fn clear_rule_filter_cancel(job_id: u64) {
    let _ = RULE_FILTER_CANCEL_ID.compare_exchange(job_id, 0, Ordering::SeqCst, Ordering::SeqCst);
}

#[tauri::command]
pub fn prepare_rule_filter() -> Result<u64, String> {
    Ok(begin_rule_filter_job())
}

#[tauri::command]
pub fn cancel_rule_filter(job_id: Option<u64>) -> Result<(), String> {
    let id = job_id.unwrap_or_else(|| RULE_FILTER_JOB_ID.load(Ordering::SeqCst));
    RULE_FILTER_CANCEL_ID.store(id, Ordering::SeqCst);
    Ok(())
}

fn modified_secs(meta: &fs::Metadata) -> Option<i64> {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
}

fn parse_extensions(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|s| s.trim().trim_start_matches('.').to_lowercase())
        .filter(|s| !s.is_empty())
        .collect()
}

fn file_matches(
    path: &Path,
    rel: &str,
    meta: &fs::Metadata,
    ext_set: &[String],
    opts: &RuleFilterOptions,
    path_re: &Option<regex::Regex>,
    cutoff: Option<SystemTime>,
) -> bool {
    let mut checks: Vec<bool> = Vec::new();

    if !ext_set.is_empty() {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        checks.push(ext_set.iter().any(|e| e == &ext));
    }

    if let Some(min) = opts.min_size_bytes {
        checks.push(meta.len() >= min);
    }
    if let Some(max) = opts.max_size_bytes {
        checks.push(meta.len() <= max);
    }

    if let Some(cut) = cutoff {
        if let Ok(modified) = meta.modified() {
            checks.push(modified >= cut);
        } else {
            checks.push(false);
        }
    }

    if let Some(re) = path_re {
        checks.push(re.is_match(rel));
    }

    if checks.is_empty() {
        return true;
    }

    let use_or = opts.logic.eq_ignore_ascii_case("or");
    if use_or {
        checks.into_iter().any(|c| c)
    } else {
        checks.into_iter().all(|c| c)
    }
}

#[tauri::command]
pub fn filter_files_by_rules(
    root: String,
    options: RuleFilterOptions,
    job_id: Option<u64>,
) -> Result<Vec<FilteredFile>, String> {
    let job_id = job_id.unwrap_or_else(|| begin_rule_filter_job());
    path_util::validate_user_path(&root)?;
    if path_util::is_remote_path(&root) {
        return Err(crate::err::code("rule_filter_remote_unsupported"));
    }

    let root_path = Path::new(&root);
    if !root_path.exists() {
        return Err(crate::err::with_detail("rule_filter_root_missing", &root));
    }
    if !root_path.is_dir() {
        return Err(crate::err::code("rule_filter_root_not_dir"));
    }

    let ext_set = parse_extensions(&options.extensions);
    let path_re = options
        .path_regex
        .as_ref()
        .filter(|s| !s.trim().is_empty())
        .map(|pat| {
            RegexBuilder::new(pat)
                .case_insensitive(true)
                .build()
                .map_err(|e| crate::err::with_detail("rule_filter_regex_invalid", e))
        })
        .transpose()?;

    let cutoff = if options.modified_within_days == 0 {
        None
    } else {
        Some(SystemTime::now() - Duration::from_secs(options.modified_within_days * 86_400))
    };

    let mut out: Vec<FilteredFile> = Vec::new();
    let root_canon = root_path
        .canonicalize()
        .unwrap_or_else(|_| root_path.to_path_buf());

    for entry in WalkDir::new(&root_path)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if is_rule_filter_cancelled(job_id) {
            clear_rule_filter_cancel(job_id);
            break;
        }
        if out.len() >= FILTER_CAP {
            break;
        }
        let entry_path = entry.path();
        if !entry_path.is_file() {
            continue;
        }
        let rel = entry_path
            .strip_prefix(&root_path)
            .unwrap_or(entry_path)
            .to_string_lossy()
            .replace('\\', "/");
        let meta = match fs::metadata(entry_path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !file_matches(entry_path, &rel, &meta, &ext_set, &options, &path_re, cutoff) {
            continue;
        }
        let name = entry_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let path_str = entry_path
            .canonicalize()
            .unwrap_or_else(|_| entry_path.to_path_buf())
            .to_string_lossy()
            .to_string();
        // Keep paths under root when possible
        let path_str = if path_str.is_empty() {
            root_canon.join(&rel).to_string_lossy().to_string()
        } else {
            path_str
        };
        out.push(FilteredFile {
            path: path_str,
            name,
            size: meta.len(),
            modified: modified_secs(&meta).unwrap_or(0),
        });
    }

    clear_rule_filter_cancel(job_id);
    Ok(out)
}