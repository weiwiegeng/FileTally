//! Generic material verification: roster × scope × declarative rules × report.
//!
//! Presets package common workflows; rules are evaluated by a small declarative engine
//! (no scripting language). UI edits the same rule list ("visual" configuration).

use calamine::{open_workbook, Reader, Xlsx};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};
use walkdir::WalkDir;

use super::excel_check::{
    check_integrity_with_excel, cell_to_string, ExcelIntegrityItem, ExcelIntegrityResult,
    TemplateCheckResult,
};
use super::excel_remote::{collect_remote_names, list_remote_person_folders};
use super::excel_runtime::{emit_progress, SCAN_ENTRY_SOFT_CAP};
use super::remote::SmbSessionStore;
use super::verify_key::{archive_id_key, folder_matches_roster_name};
use crate::job_runner::{self, JobKind};
use crate::path_util;

const ROW_SOFT_CAP: usize = 500_000;
const FILE_SOFT_CAP: usize = 500_000;

/// Where candidates live relative to the target folder.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScopeKind {
    /// Immediate child directories (一人一夹).
    PersonFolders,
    /// Files directly under the target (non-recursive).
    FlatFiles,
    /// All files under the target tree.
    RecursiveFiles,
}

impl Default for ScopeKind {
    fn default() -> Self {
        ScopeKind::PersonFolders
    }
}

/// Declarative check rule (rule engine surface — no scripts).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CheckRule {
    /// Required material name pattern; `{name}` / `{key}` placeholders.
    Require { pattern: String },
    /// Soft flag when the bound path's name contains `needle`.
    FlagContains { needle: String, label: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialPreset {
    pub id: String,
    pub scope: ScopeKind,
    pub rules: Vec<CheckRule>,
    pub match_mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleOutcome {
    pub rule_type: String,
    pub label: String,
    pub expected_name: String,
    pub ok: bool,
    pub found_path: Option<String>,
    pub flagged: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialCheckItem {
    pub row_index: usize,
    pub name: String,
    pub bound: bool,
    pub bound_path: Option<String>,
    pub is_complete: bool,
    pub outcomes: Vec<RuleOutcome>,
    pub flags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialCheckResult {
    pub total_rows: usize,
    pub complete_count: usize,
    pub incomplete_count: usize,
    pub not_found_count: usize,
    pub flagged_count: usize,
    pub items: Vec<MaterialCheckItem>,
    pub output_path: Option<String>,
    pub truncated: bool,
    pub cancelled: bool,
    pub scope: ScopeKind,
}

fn builtin_presets() -> Vec<MaterialPreset> {
    vec![
        MaterialPreset {
            id: "dossier_complete".into(),
            scope: ScopeKind::PersonFolders,
            match_mode: "contains".into(),
            rules: vec![
                CheckRule::Require {
                    pattern: "{name}.docx".into(),
                },
                CheckRule::Require {
                    pattern: "{name}照片".into(),
                },
                CheckRule::Require {
                    pattern: "司法鉴定意见书.docx".into(),
                },
            ],
        },
        MaterialPreset {
            id: "flat_reconcile".into(),
            scope: ScopeKind::FlatFiles,
            match_mode: "contains".into(),
            rules: vec![CheckRule::FlagContains {
                needle: "缺病例".into(),
                label: "缺病例".into(),
            }],
        },
        MaterialPreset {
            id: "exists_only".into(),
            scope: ScopeKind::PersonFolders,
            match_mode: "contains".into(),
            rules: vec![],
        },
        MaterialPreset {
            id: "flat_exists".into(),
            scope: ScopeKind::FlatFiles,
            match_mode: "contains".into(),
            rules: vec![],
        },
        MaterialPreset {
            id: "recursive_reconcile".into(),
            scope: ScopeKind::RecursiveFiles,
            match_mode: "contains".into(),
            rules: vec![CheckRule::FlagContains {
                needle: "缺".into(),
                label: "名称含「缺」".into(),
            }],
        },
    ]
}

#[tauri::command]
pub fn list_material_presets() -> Vec<MaterialPreset> {
    builtin_presets()
}

fn require_patterns(rules: &[CheckRule]) -> Vec<String> {
    rules
        .iter()
        .filter_map(|r| match r {
            CheckRule::Require { pattern } => Some(pattern.clone()),
            _ => None,
        })
        .collect()
}

fn flag_rules(rules: &[CheckRule]) -> Vec<(String, String)> {
    rules
        .iter()
        .filter_map(|r| match r {
            CheckRule::FlagContains { needle, label } => Some((needle.clone(), label.clone())),
            _ => None,
        })
        .collect()
}

fn integrity_to_material(
    result: ExcelIntegrityResult,
    scope: ScopeKind,
    flags_cfg: &[(String, String)],
) -> MaterialCheckResult {
    let mut flagged_count = 0usize;
    let items: Vec<MaterialCheckItem> = result
        .items
        .into_iter()
        .map(|item| {
            let mut flags = Vec::new();
            if let Some(ref path) = item.folder_path {
                let name = Path::new(path)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                for (needle, label) in flags_cfg {
                    if !needle.is_empty() && name.contains(needle.as_str()) {
                        flags.push(label.clone());
                    }
                }
            }
            if !flags.is_empty() {
                flagged_count += 1;
            }
            let outcomes: Vec<RuleOutcome> = item
                .check_results
                .into_iter()
                .map(|c| RuleOutcome {
                    rule_type: "require".into(),
                    label: c.template.clone(),
                    expected_name: c.expected_name,
                    ok: c.exists,
                    found_path: c.found_path,
                    flagged: false,
                })
                .chain(flags.iter().map(|label| RuleOutcome {
                    rule_type: "flag_contains".into(),
                    label: label.clone(),
                    expected_name: label.clone(),
                    ok: true,
                    found_path: item.folder_path.clone(),
                    flagged: true,
                }))
                .collect();
            MaterialCheckItem {
                row_index: item.row_index,
                name: item.name,
                bound: item.folder_found,
                bound_path: item.folder_path,
                is_complete: item.is_complete,
                outcomes,
                flags,
            }
        })
        .collect();

    MaterialCheckResult {
        total_rows: result.total_rows,
        complete_count: result.complete_count,
        incomplete_count: result.incomplete_count,
        not_found_count: result.not_found_count,
        flagged_count,
        items,
        output_path: result.output_path,
        truncated: result.truncated,
        cancelled: result.cancelled,
        scope,
    }
}

fn list_local_files(root: &Path, recursive: bool, job_id: u64) -> (Vec<(String, PathBuf)>, bool) {
    let mut out = Vec::new();
    let mut truncated = false;
    if recursive {
        for entry in WalkDir::new(root)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if job_runner::is_cancelled(job_id) {
                break;
            }
            if !entry.file_type().is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            out.push((name, entry.path().to_path_buf()));
            if out.len() >= FILE_SOFT_CAP {
                truncated = true;
                break;
            }
        }
    } else if let Ok(rd) = fs::read_dir(root) {
        for entry in rd.flatten() {
            if job_runner::is_cancelled(job_id) {
                break;
            }
            let Ok(ft) = entry.file_type() else { continue };
            if !ft.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            out.push((name, entry.path()));
            if out.len() >= FILE_SOFT_CAP {
                truncated = true;
                break;
            }
        }
    }
    let _ = SCAN_ENTRY_SOFT_CAP;
    (out, truncated)
}

fn index_files_by_id(files: &[(String, PathBuf)]) -> HashMap<String, Vec<PathBuf>> {
    let mut map: HashMap<String, Vec<PathBuf>> = HashMap::new();
    for (name, path) in files {
        let key = archive_id_key(name);
        if key.is_empty() {
            continue;
        }
        let entry = map.entry(key).or_default();
        if !entry.iter().any(|p| p == path) {
            entry.push(path.clone());
        }
    }
    map
}

fn bind_names_to_files(
    names: &[(usize, String)],
    files: &[(String, PathBuf)],
    match_mode: &str,
) -> Vec<Option<PathBuf>> {
    let mut bound = vec![None; names.len()];
    let by_id = index_files_by_id(files);

    for (i, (_, name)) in names.iter().enumerate() {
        if name.is_empty() {
            continue;
        }
        // Exact basename
        if let Some((_, path)) = files.iter().find(|(n, _)| n == name) {
            bound[i] = Some(path.clone());
            continue;
        }
        let key = archive_id_key(name);
        if !key.is_empty() {
            if let Some(paths) = by_id.get(&key) {
                if paths.len() == 1 {
                    bound[i] = Some(paths[0].clone());
                    continue;
                }
            }
        }
        if match_mode == "exact" {
            continue;
        }
        let mut hits = Vec::new();
        for (fname, path) in files {
            if folder_matches_roster_name(fname, name, match_mode) {
                if !hits.iter().any(|p: &PathBuf| p == path) {
                    hits.push(path.clone());
                }
            }
        }
        if hits.len() == 1 {
            bound[i] = Some(hits[0].clone());
        }
    }
    bound
}

fn read_roster_names(
    excel_path: &str,
    sheet_index: usize,
    name_column_index: usize,
) -> Result<(Vec<(usize, String)>, bool), String> {
    let mut workbook: Xlsx<_> = open_workbook(excel_path)
        .map_err(|e| crate::err::with_detail("excel_open_failed", e))?;
    let sheet_names: Vec<String> = workbook.sheet_names().to_vec();
    let sheet_name = sheet_names
        .get(sheet_index)
        .ok_or_else(|| crate::err::code("excel_sheet_index_invalid"))?
        .clone();
    let range = workbook
        .worksheet_range(&sheet_name)
        .map_err(|e| crate::err::with_detail("excel_sheet_read_failed", e))?;

    let mut names = Vec::new();
    let mut truncated = false;
    for (row_idx, row) in range.rows().enumerate() {
        if row_idx == 0 {
            continue;
        }
        let name = row
            .get(name_column_index)
            .map(cell_to_string)
            .unwrap_or_default();
        if name.trim().is_empty() {
            continue;
        }
        if names.len() >= ROW_SOFT_CAP {
            truncated = true;
            break;
        }
        names.push((row_idx, name));
    }
    Ok((names, truncated))
}

fn evaluate_flat_local(
    app: &AppHandle,
    job_id: u64,
    excel_path: &str,
    sheet_index: usize,
    name_column_index: usize,
    target_folder: &str,
    scope: ScopeKind,
    match_mode: &str,
    rules: &[CheckRule],
    output_path: Option<String>,
) -> Result<MaterialCheckResult, String> {
    emit_progress(app, job_id, "reading_excel", 0, 0, "");
    let (names, mut truncated) = read_roster_names(excel_path, sheet_index, name_column_index)?;

    let folder = Path::new(target_folder);
    if !folder.exists() {
        return Err(crate::err::code("target_folder_missing"));
    }

    emit_progress(app, job_id, "listing", 0, 0, "");
    let recursive = matches!(scope, ScopeKind::RecursiveFiles);
    let (files, file_trunc) = list_local_files(folder, recursive, job_id);
    truncated |= file_trunc;

    let bound = bind_names_to_files(&names, &files, match_mode);
    let flags_cfg = flag_rules(rules);
    let requires = require_patterns(rules);

    // Sibling index by parent for require rules
    let mut siblings: HashMap<String, HashSet<String>> = HashMap::new();
    let mut sibling_paths: HashMap<String, HashMap<String, String>> = HashMap::new();
    for (name, path) in &files {
        let parent = path
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        siblings.entry(parent.clone()).or_default().insert(name.clone());
        sibling_paths
            .entry(parent)
            .or_default()
            .insert(name.clone(), path.to_string_lossy().to_string());
    }

    let total = names.len() as u64;
    emit_progress(app, job_id, "checking", 0, total, "");

    let mut items = Vec::with_capacity(names.len());
    let mut complete_count = 0;
    let mut incomplete_count = 0;
    let mut not_found_count = 0;
    let mut flagged_count = 0;

    for (i, (row_idx, name)) in names.iter().enumerate() {
        if job_runner::is_cancelled(job_id) {
            break;
        }
        let matched = bound[i].clone();
        let bound_ok = matched.is_some();
        let bound_path = matched
            .as_ref()
            .map(|p| p.to_string_lossy().to_string());

        let mut outcomes = Vec::new();
        let mut flags = Vec::new();
        let mut is_complete = bound_ok;

        if let Some(ref path) = matched {
            let file_name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            for (needle, label) in &flags_cfg {
                if !needle.is_empty() && file_name.contains(needle.as_str()) {
                    flags.push(label.clone());
                    outcomes.push(RuleOutcome {
                        rule_type: "flag_contains".into(),
                        label: label.clone(),
                        expected_name: needle.clone(),
                        ok: true,
                        found_path: Some(path.to_string_lossy().to_string()),
                        flagged: true,
                    });
                }
            }
            if !flags.is_empty() {
                flagged_count += 1;
            }

            let parent = path
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            let contents = siblings.get(&parent).cloned().unwrap_or_default();
            let content_paths = sibling_paths.get(&parent).cloned().unwrap_or_default();

            for pattern in &requires {
                let expected = pattern
                    .replace("{name}", name)
                    .replace("{key}", &archive_id_key(name));
                let mut found = contents.contains(&expected);
                let mut found_path = content_paths.get(&expected).cloned();
                if !found {
                    // Fuzzy: any sibling containing archive key + pattern stem
                    let key = archive_id_key(name);
                    let stem = Path::new(&expected)
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or(&expected);
                    for (cname, cpath) in &content_paths {
                        if cname == &file_name {
                            continue;
                        }
                        if (!key.is_empty() && cname.contains(&key))
                            && (cname.contains(stem) || stem.contains(
                                Path::new(cname)
                                    .file_stem()
                                    .and_then(|s| s.to_str())
                                    .unwrap_or(""),
                            ))
                        {
                            found = true;
                            found_path = Some(cpath.clone());
                            break;
                        }
                    }
                }
                if !found {
                    is_complete = false;
                }
                outcomes.push(RuleOutcome {
                    rule_type: "require".into(),
                    label: pattern.clone(),
                    expected_name: expected,
                    ok: found,
                    found_path,
                    flagged: false,
                });
            }
        } else {
            is_complete = false;
            for pattern in &requires {
                outcomes.push(RuleOutcome {
                    rule_type: "require".into(),
                    label: pattern.clone(),
                    expected_name: pattern
                        .replace("{name}", name)
                        .replace("{key}", &archive_id_key(name)),
                    ok: false,
                    found_path: None,
                    flagged: false,
                });
            }
        }

        if is_complete {
            complete_count += 1;
        } else if bound_ok {
            incomplete_count += 1;
        } else {
            not_found_count += 1;
        }

        items.push(MaterialCheckItem {
            row_index: *row_idx,
            name: name.clone(),
            bound: bound_ok,
            bound_path,
            is_complete,
            outcomes,
            flags,
        });

        if (i + 1) % 50 == 0 {
            emit_progress(app, job_id, "checking", (i + 1) as u64, total, "");
        }
    }

    let cancelled = job_runner::is_cancelled(job_id);
    let total_rows = items.len();

    // Reuse annotated export via ExcelIntegrityItem bridge when output requested.
    let final_output = if let Some(out) = output_path {
        emit_progress(app, job_id, "writing", total_rows as u64, total, "");
        let templates = requires.clone();
        let bridge: Vec<ExcelIntegrityItem> = items
            .iter()
            .map(|it| ExcelIntegrityItem {
                row_index: it.row_index,
                name: it.name.clone(),
                folder_found: it.bound,
                folder_path: it.bound_path.clone(),
                is_complete: it.is_complete,
                check_results: it
                    .outcomes
                    .iter()
                    .filter(|o| o.rule_type == "require")
                    .map(|o| TemplateCheckResult {
                        template: o.label.clone(),
                        expected_name: o.expected_name.clone(),
                        exists: o.ok,
                        found_path: o.found_path.clone(),
                    })
                    .collect(),
            })
            .collect();
        super::excel_check::write_excel_integrity_annotated_pub(
            excel_path,
            sheet_index,
            &templates,
            &bridge,
            &out,
        )?;
        Some(out)
    } else {
        None
    };

    emit_progress(
        app,
        job_id,
        if cancelled { "cancelled" } else { "done" },
        total_rows as u64,
        total,
        "",
    );

    Ok(MaterialCheckResult {
        total_rows,
        complete_count,
        incomplete_count,
        not_found_count,
        flagged_count,
        items,
        output_path: final_output,
        truncated,
        cancelled,
        scope,
    })
}

async fn evaluate_flat_remote(
    app: &AppHandle,
    store: &SmbSessionStore,
    job_id: u64,
    excel_path: &str,
    sheet_index: usize,
    name_column_index: usize,
    target_folder: &str,
    scope: ScopeKind,
    match_mode: &str,
    rules: &[CheckRule],
    output_path: Option<String>,
) -> Result<MaterialCheckResult, String> {
    emit_progress(app, job_id, "reading_excel", 0, 0, "");
    let excel_path_owned = excel_path.to_string();
    let (names, mut truncated) = tokio::task::spawn_blocking({
        let p = excel_path_owned.clone();
        move || read_roster_names(&p, sheet_index, name_column_index)
    })
    .await
    .map_err(|e| crate::err::with_detail("join_failed", e))??;

    emit_progress(app, job_id, "listing", 0, 0, "");
    // Remote: collect names under folder (recursive when needed).
    let recursive = matches!(scope, ScopeKind::RecursiveFiles | ScopeKind::FlatFiles);
    let (name_set, name_trunc) = if recursive {
        collect_remote_names(store, target_folder, app, job_id).await?
    } else {
        // Flat: only top-level via person-folder style listing is wrong; use names walk capped.
        collect_remote_names(store, target_folder, app, job_id).await?
    };
    truncated |= name_trunc;
    let _ = list_remote_person_folders; // keep import used for future flat remote refine

    // Build pseudo file list from name set (paths unknown → use name as path key).
    let files: Vec<(String, PathBuf)> = name_set
        .into_iter()
        .take(FILE_SOFT_CAP)
        .map(|n| {
            let path = PathBuf::from(format!("{}/{}", target_folder.trim_end_matches('/'), n));
            (n, path)
        })
        .collect();

    let bound = bind_names_to_files(&names, &files, match_mode);
    let flags_cfg = flag_rules(rules);
    let requires = require_patterns(rules);
    let total = names.len() as u64;
    emit_progress(app, job_id, "checking", 0, total, "");

    let mut items = Vec::with_capacity(names.len());
    let mut complete_count = 0;
    let mut incomplete_count = 0;
    let mut not_found_count = 0;
    let mut flagged_count = 0;

    for (i, (row_idx, name)) in names.iter().enumerate() {
        if job_runner::is_cancelled(job_id) {
            break;
        }
        let matched = bound[i].clone();
        let bound_ok = matched.is_some();
        let bound_path = matched
            .as_ref()
            .map(|p| p.to_string_lossy().to_string());
        let mut outcomes = Vec::new();
        let mut flags = Vec::new();
        let mut is_complete = bound_ok;

        if let Some(ref path) = matched {
            let file_name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            for (needle, label) in &flags_cfg {
                if !needle.is_empty() && file_name.contains(needle.as_str()) {
                    flags.push(label.clone());
                    outcomes.push(RuleOutcome {
                        rule_type: "flag_contains".into(),
                        label: label.clone(),
                        expected_name: needle.clone(),
                        ok: true,
                        found_path: bound_path.clone(),
                        flagged: true,
                    });
                }
            }
            if !flags.is_empty() {
                flagged_count += 1;
            }
            // Require patterns: search in full name set
            for pattern in &requires {
                let expected = pattern
                    .replace("{name}", name)
                    .replace("{key}", &archive_id_key(name));
                let key = archive_id_key(name);
                let found = files.iter().any(|(n, _)| {
                    n == &expected
                        || (!key.is_empty() && n.contains(&key) && n.contains(
                            Path::new(&expected)
                                .file_stem()
                                .and_then(|s| s.to_str())
                                .unwrap_or(""),
                        ))
                });
                if !found {
                    is_complete = false;
                }
                outcomes.push(RuleOutcome {
                    rule_type: "require".into(),
                    label: pattern.clone(),
                    expected_name: expected,
                    ok: found,
                    found_path: None,
                    flagged: false,
                });
            }
        } else {
            is_complete = false;
            for pattern in &requires {
                outcomes.push(RuleOutcome {
                    rule_type: "require".into(),
                    label: pattern.clone(),
                    expected_name: pattern
                        .replace("{name}", name)
                        .replace("{key}", &archive_id_key(name)),
                    ok: false,
                    found_path: None,
                    flagged: false,
                });
            }
        }

        if is_complete {
            complete_count += 1;
        } else if bound_ok {
            incomplete_count += 1;
        } else {
            not_found_count += 1;
        }

        items.push(MaterialCheckItem {
            row_index: *row_idx,
            name: name.clone(),
            bound: bound_ok,
            bound_path,
            is_complete,
            outcomes,
            flags,
        });
    }

    let cancelled = job_runner::is_cancelled(job_id);
    let total_rows = items.len();
    let final_output = if let Some(out) = output_path {
        let templates = requires.clone();
        let bridge: Vec<ExcelIntegrityItem> = items
            .iter()
            .map(|it| ExcelIntegrityItem {
                row_index: it.row_index,
                name: it.name.clone(),
                folder_found: it.bound,
                folder_path: it.bound_path.clone(),
                is_complete: it.is_complete,
                check_results: it
                    .outcomes
                    .iter()
                    .filter(|o| o.rule_type == "require")
                    .map(|o| TemplateCheckResult {
                        template: o.label.clone(),
                        expected_name: o.expected_name.clone(),
                        exists: o.ok,
                        found_path: o.found_path.clone(),
                    })
                    .collect(),
            })
            .collect();
        let excel_path = excel_path.to_string();
        tokio::task::spawn_blocking(move || {
            super::excel_check::write_excel_integrity_annotated_pub(
                &excel_path,
                sheet_index,
                &templates,
                &bridge,
                &out,
            )
            .map(|_| out)
        })
        .await
        .map_err(|e| crate::err::with_detail("join_failed", e))??
        .into()
    } else {
        None
    };

    emit_progress(
        app,
        job_id,
        if cancelled { "cancelled" } else { "done" },
        total_rows as u64,
        total,
        "",
    );

    Ok(MaterialCheckResult {
        total_rows,
        complete_count,
        incomplete_count,
        not_found_count,
        flagged_count,
        items,
        output_path: final_output,
        truncated,
        cancelled,
        scope,
    })
}

/// Unified material check entry. Person-folder + require rules reuse the existing integrity path.
#[tauri::command]
pub async fn run_material_check(
    app: AppHandle,
    store: State<'_, std::sync::Arc<SmbSessionStore>>,
    excel_path: String,
    sheet_index: usize,
    name_column_index: usize,
    target_folder: String,
    scope: Option<ScopeKind>,
    match_mode: Option<String>,
    rules: Option<Vec<CheckRule>>,
    preset_id: Option<String>,
    output_path: Option<String>,
    job_id: Option<u64>,
) -> Result<MaterialCheckResult, String> {
    path_util::validate_user_path(&excel_path)?;
    path_util::validate_user_path(&target_folder)?;

    let mut scope = scope.unwrap_or_default();
    let mut match_mode = match_mode.unwrap_or_else(|| "contains".into());
    let mut rules = rules.unwrap_or_default();

    if let Some(pid) = preset_id {
        if let Some(p) = builtin_presets().into_iter().find(|p| p.id == pid) {
            if rules.is_empty() {
                rules = p.rules;
            }
            scope = p.scope;
            if match_mode.is_empty() {
                match_mode = p.match_mode;
            }
        }
    }

    let job_id = job_runner::resolve_or_begin(job_id, JobKind::Excel);
    let flags = flag_rules(&rules);

    match scope {
        ScopeKind::PersonFolders => {
            let templates = require_patterns(&rules);
            // Existence-only: still run integrity with empty templates → complete iff folder bound.
            let integrity = check_integrity_with_excel(
                app.clone(),
                store,
                excel_path,
                sheet_index,
                name_column_index,
                target_folder,
                templates,
                match_mode,
                output_path,
                Some(job_id),
            )
            .await?;
            Ok(integrity_to_material(integrity, scope, &flags))
        }
        ScopeKind::FlatFiles | ScopeKind::RecursiveFiles => {
            let result = if path_util::is_remote_path(&target_folder) {
                evaluate_flat_remote(
                    &app,
                    store.inner(),
                    job_id,
                    &excel_path,
                    sheet_index,
                    name_column_index,
                    &target_folder,
                    scope.clone(),
                    &match_mode,
                    &rules,
                    output_path,
                )
                .await
            } else {
                let excel_path = excel_path.clone();
                let target_folder = target_folder.clone();
                let match_mode = match_mode.clone();
                let rules = rules.clone();
                let scope_c = scope.clone();
                tokio::task::spawn_blocking(move || {
                    evaluate_flat_local(
                        &app,
                        job_id,
                        &excel_path,
                        sheet_index,
                        name_column_index,
                        &target_folder,
                        scope_c,
                        &match_mode,
                        &rules,
                        output_path,
                    )
                })
                .await
                .map_err(|e| crate::err::with_detail("join_failed", e))?
            };
            job_runner::end_job(job_id);
            result
        }
    }
}
