use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

static NEXT_JOB_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JobKind {
    Transfer,
    Search,
    Sync,
    Analysis,
    Excel,
    RuleFilter,
    Organize,
}

struct JobRecord {
    kind: JobKind,
    cancelled: bool,
    finished: bool,
}

const JOB_REGISTRY_CAP: usize = 200;

struct Registry {
    jobs: HashMap<u64, JobRecord>,
    last_by_kind: HashMap<JobKind, u64>,
}

fn registry() -> &'static Mutex<Registry> {
    static REG: std::sync::OnceLock<Mutex<Registry>> = std::sync::OnceLock::new();
    REG.get_or_init(|| {
        Mutex::new(Registry {
            jobs: HashMap::new(),
            last_by_kind: HashMap::new(),
        })
    })
}

pub fn begin_job(kind: JobKind) -> u64 {
    prune_finished(JOB_REGISTRY_CAP);
    let id = NEXT_JOB_ID.fetch_add(1, Ordering::SeqCst) + 1;
    if let Ok(mut reg) = registry().lock() {
        reg.jobs.insert(
            id,
            JobRecord {
                kind,
                cancelled: false,
                finished: false,
            },
        );
        reg.last_by_kind.insert(kind, id);
    }
    crate::commands::diag::diag_log(
        "info",
        "job_begin",
        format!("job {id} kind={kind:?}"),
        Some(id),
    );
    id
}

pub fn request_cancel(job_id: u64) {
    if job_id == 0 {
        return;
    }
    if let Ok(mut reg) = registry().lock() {
        if let Some(rec) = reg.jobs.get_mut(&job_id) {
            rec.cancelled = true;
        }
    }
    crate::commands::diag::diag_log(
        "warn",
        "job_cancel",
        format!("cancel requested for job {job_id}"),
        Some(job_id),
    );
}

pub fn is_cancelled(job_id: u64) -> bool {
    if job_id == 0 {
        return false;
    }
    registry()
        .lock()
        .ok()
        .and_then(|reg| reg.jobs.get(&job_id).map(|r| r.cancelled))
        .unwrap_or(false)
}

pub fn clear_cancel(job_id: u64) {
    if job_id == 0 {
        return;
    }
    if let Ok(mut reg) = registry().lock() {
        if let Some(rec) = reg.jobs.get_mut(&job_id) {
            rec.cancelled = false;
        }
    }
}

/// Mark a job as finished (success, error, or cancel completed).
pub fn end_job(job_id: u64) {
    if job_id == 0 {
        return;
    }
    if let Ok(mut reg) = registry().lock() {
        if let Some(rec) = reg.jobs.get_mut(&job_id) {
            rec.finished = true;
            rec.cancelled = false;
        }
    }
    crate::commands::diag::diag_log(
        "info",
        "job_end",
        format!("job {job_id} finished"),
        Some(job_id),
    );
}

/// Drop oldest finished jobs; never remove jobs with cancel still pending (`cancelled && !finished`).
pub fn prune_finished(keep_last_n: usize) {
    if keep_last_n == 0 {
        return;
    }
    let Ok(mut reg) = registry().lock() else {
        return;
    };
    let mut finished_ids: Vec<u64> = reg
        .jobs
        .iter()
        .filter(|(_, rec)| rec.finished)
        .map(|(id, _)| *id)
        .collect();
    finished_ids.sort_unstable();
    if finished_ids.len() <= keep_last_n {
        return;
    }
    let remove_count = finished_ids.len() - keep_last_n;
    for id in finished_ids.into_iter().take(remove_count) {
        reg.jobs.remove(&id);
    }
}

#[allow(dead_code)]
pub fn job_kind(job_id: u64) -> Option<JobKind> {
    registry()
        .lock()
        .ok()
        .and_then(|reg| reg.jobs.get(&job_id).map(|r| r.kind))
}

pub fn last_job_id(kind: JobKind) -> u64 {
    registry()
        .lock()
        .ok()
        .and_then(|reg| reg.last_by_kind.get(&kind).copied())
        .unwrap_or(0)
}

/// Use an existing job id from the frontend, or allocate a new one of `kind`.
pub fn resolve_or_begin(job_id: Option<u64>, kind: JobKind) -> u64 {
    match job_id {
        Some(id) if id > 0 => id,
        _ => begin_job(kind),
    }
}

pub fn parse_job_kind(raw: &str) -> Option<JobKind> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "transfer" => Some(JobKind::Transfer),
        "search" => Some(JobKind::Search),
        "sync" => Some(JobKind::Sync),
        "analysis" => Some(JobKind::Analysis),
        "excel" => Some(JobKind::Excel),
        "rulefilter" | "rule_filter" | "ruleFilter" | "rules" => Some(JobKind::RuleFilter),
        "organize" => Some(JobKind::Organize),
        _ => None,
    }
}

#[tauri::command]
pub fn prepare_job(kind: String) -> Result<u64, String> {
    let k = parse_job_kind(&kind).ok_or_else(|| crate::err::code("job_kind_invalid"))?;
    Ok(begin_job(k))
}

/// Single cancel entry for all long-running work.
#[tauri::command]
pub fn cancel_job(
    job_id: Option<u64>,
    kind: Option<String>,
) -> Result<(), String> {
    let id = job_id.filter(|v| *v > 0).unwrap_or_else(|| {
        kind.as_deref()
            .and_then(parse_job_kind)
            .map(last_job_id)
            .unwrap_or(0)
    });
    if id > 0 {
        request_cancel(id);
    }
    Ok(())
}