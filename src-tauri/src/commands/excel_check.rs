use aho_corasick::AhoCorasick;
use calamine::{open_workbook, Data, Reader, Xlsx};
use rayon::prelude::*;
use rust_xlsxwriter::{Color, Format, FormatBorder, FormatUnderline, Url, Workbook};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::sync::Arc;
use tauri::{AppHandle, State};

use super::excel_remote::{
    collect_remote_contents, collect_remote_names, list_remote_person_folders,
    scan_remote_folder_tree, RemoteTreeNode,
};
use super::excel_runtime::{
    check_concurrency, collect_contents_under_cached, collect_names_under_cached, emit_progress,
    list_person_folders,
};
use crate::job_runner::{self, JobKind};
use super::remote::SmbSessionStore;

const INTEGRITY_PERSON_FOLDER_SOFT_CAP: usize = 500_000;
const INTEGRITY_ROW_SOFT_CAP: usize = 500_000;
const TREE_ENTRY_SOFT_CAP: usize = 500_000;

/// Excel 列信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcelColumnInfo {
    pub index: usize,
    pub name: String,
    pub letter: String,
    pub sample_values: Vec<String>,
}

/// Excel 文件信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcelFileInfo {
    pub sheets: Vec<String>,
    pub columns: Vec<ExcelColumnInfo>,
    pub row_count: usize,
}

/// 匹配结果项
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchResultItem {
    pub row_index: usize,
    pub value: String,
    pub matched: bool,
    pub matched_file: Option<String>,
}

/// Excel 比对结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcelMatchResult {
    pub total_rows: usize,
    pub matched_count: usize,
    pub missing_count: usize,
    pub items: Vec<MatchResultItem>,
    pub output_path: Option<String>,
    pub truncated: bool,
    pub cancelled: bool,
}

/// 完整性检查项
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityCheckItem {
    pub template: String,
    pub expected_name: String,
    pub exists: bool,
    pub found_path: Option<String>,
}

/// 文件夹完整性检查结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderIntegrityResult {
    pub folder_path: String,
    pub folder_name: String,
    pub extracted_name: String,
    pub is_complete: bool,
    pub check_items: Vec<IntegrityCheckItem>,
}

/// 批量完整性检查结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchIntegrityResult {
    pub total_folders: usize,
    pub complete_count: usize,
    pub incomplete_count: usize,
    pub results: Vec<FolderIntegrityResult>,
    pub output_path: Option<String>,
    pub truncated: bool,
    pub cancelled: bool,
}

/// 文件树节点
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTreeNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Vec<FileTreeNode>,
}

/// 文件树扫描结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderTreeResult {
    pub root: FileTreeNode,
    pub total_files: usize,
    pub total_folders: usize,
    pub truncated: bool,
}

/// 基于 Excel 的完整性检查结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcelIntegrityResult {
    pub total_rows: usize,
    pub complete_count: usize,
    pub incomplete_count: usize,
    pub not_found_count: usize,
    pub items: Vec<ExcelIntegrityItem>,
    pub output_path: Option<String>,
    pub truncated: bool,
    pub cancelled: bool,
}

/// 基于 Excel 的完整性检查项
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcelIntegrityItem {
    pub row_index: usize,
    pub name: String,
    pub folder_found: bool,
    pub folder_path: Option<String>,
    pub is_complete: bool,
    pub check_results: Vec<TemplateCheckResult>,
}

/// 模板检查结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateCheckResult {
    pub template: String,
    pub expected_name: String,
    pub exists: bool,
    pub found_path: Option<String>,
}

fn to_file_url(path: &str) -> Option<String> {
    if path.trim().is_empty() || crate::path_util::is_remote_path(path) {
        return None;
    }
    let normalized = path.replace('\\', "/");
    if normalized.starts_with('/') {
        Some(format!("file://{normalized}"))
    } else {
        // Windows drive path e.g. C:/foo
        Some(format!("file:///{normalized}"))
    }
}

fn write_path_cell(
    worksheet: &mut rust_xlsxwriter::Worksheet,
    row: u32,
    col: u16,
    path: &str,
    format: &Format,
) -> Result<(), String> {
    if let Some(url) = to_file_url(path) {
        let name = Path::new(path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(path);
        worksheet
            .write_url_with_format(row, col, Url::new(url).set_text(name), format)
            .map_err(|e| crate::err::with_detail("excel_write_cell_failed", e))?;
    } else {
        worksheet
            .write_string_with_format(row, col, path, format)
            .map_err(|e| crate::err::with_detail("excel_write_cell_failed", e))?;
    }
    Ok(())
}

fn column_index_to_letter(index: usize) -> String {
    let mut result = String::new();
    let mut n = index;
    loop {
        result.insert(0, (b'A' + (n % 26) as u8) as char);
        if n < 26 {
            break;
        }
        n = n / 26 - 1;
    }
    result
}

pub(crate) fn cell_to_string(cell: &Data) -> String {
    match cell {
        Data::String(s) => s.clone(),
        Data::Int(i) => i.to_string(),
        Data::Float(f) => f.to_string(),
        Data::Bool(b) => b.to_string(),
        _ => String::new(),
    }
}

fn join_error(e: impl std::fmt::Display) -> String {
    crate::err::with_detail("task_join_failed", e)
}

/// Match Excel values against collected names. Exact uses HashSet; fuzzy uses Aho-Corasick (one pass).
fn match_rows_against_names(
    values: &[(usize, String)],
    file_names: &HashSet<String>,
    match_mode: &str,
) -> Vec<(bool, Option<String>)> {
    let mut out: Vec<(bool, Option<String>)> = values
        .iter()
        .map(|(_, v)| {
            if v.is_empty() {
                (false, None)
            } else {
                (false, None)
            }
        })
        .collect();

    match match_mode {
        "exact" => {
            for (i, (_, value)) in values.iter().enumerate() {
                if value.is_empty() {
                    continue;
                }
                if file_names.contains(value) {
                    out[i] = (true, Some(value.clone()));
                }
            }
        }
        "starts_with" | "contains" => {
            let patterns: Vec<&str> = values
                .iter()
                .map(|(_, v)| v.as_str())
                .collect();
            // Empty pattern set → nothing to match
            if patterns.iter().all(|p| p.is_empty()) {
                return out;
            }
            // AhoCorasick rejects empty patterns; replace empties with unlikely sentinel (won't match).
            let owned: Vec<String> = patterns
                .iter()
                .map(|p| {
                    if p.is_empty() {
                        "\u{FFFF}\u{FFFE}".to_string()
                    } else {
                        (*p).to_string()
                    }
                })
                .collect();
            let Ok(ac) = AhoCorasick::new(&owned) else {
                // Fallback: linear scan
                for (i, (_, value)) in values.iter().enumerate() {
                    if value.is_empty() {
                        continue;
                    }
                    for name in file_names {
                        let hit = if match_mode == "starts_with" {
                            name.starts_with(value)
                        } else {
                            name.contains(value)
                        };
                        if hit {
                            out[i] = (true, Some(name.clone()));
                            break;
                        }
                    }
                }
                return out;
            };

            let require_prefix = match_mode == "starts_with";
            for name in file_names {
                for mat in ac.find_iter(name) {
                    if require_prefix && mat.start() != 0 {
                        continue;
                    }
                    let i = mat.pattern().as_usize();
                    if values[i].1.is_empty() {
                        continue;
                    }
                    if out[i].1.is_none() {
                        out[i] = (true, Some(name.clone()));
                    }
                }
            }
        }
        _ => {
            // Default: contains
            return match_rows_against_names(values, file_names, "contains");
        }
    }

    out
}

use super::verify_key::{
    archive_id_key, folder_matches_roster_name, normalize_archive_id,
};

fn index_folders_by_archive_id(
    folders_by_full_name: &HashMap<String, PathBuf>,
) -> HashMap<String, Vec<PathBuf>> {
    let mut by_id: HashMap<String, Vec<PathBuf>> = HashMap::new();
    for (folder_name, path) in folders_by_full_name {
        let key = archive_id_key(folder_name);
        if key.is_empty() {
            continue;
        }
        let entry = by_id.entry(key).or_default();
        if !entry.iter().any(|p| p == path) {
            entry.push(path.clone());
        }
    }
    by_id
}

/// Bind Excel names to top-level person folders.
/// Always tries archive-id fuzzy first (`S2026-0008` ↔ `2026-0008 刘澎`), then mode-specific fallback.
fn bind_names_to_folders(
    names: &[(usize, String)],
    folders_by_full_name: &HashMap<String, PathBuf>,
    folders_by_extracted: &HashMap<String, Vec<PathBuf>>,
    folder_match_mode: &str,
) -> Vec<Option<PathBuf>> {
    let mut bound: Vec<Option<PathBuf>> = vec![None; names.len()];
    let folders_by_id = index_folders_by_archive_id(folders_by_full_name);

    // 1) Exact folder-name equality
    for (i, (_, name)) in names.iter().enumerate() {
        if let Some(path) = folders_by_full_name.get(name) {
            bound[i] = Some(path.clone());
        }
    }

    // 2) Archive-id fuzzy (strip S / leading zeros) — unique hit only
    for (i, (_, name)) in names.iter().enumerate() {
        if bound[i].is_some() || name.is_empty() {
            continue;
        }
        let key = archive_id_key(name);
        if key.is_empty() {
            continue;
        }
        if let Some(paths) = folders_by_id.get(&key) {
            if paths.len() == 1 {
                bound[i] = Some(paths[0].clone());
            }
        }
    }

    if folder_match_mode == "exact" {
        // Extracted person-name exact (unique)
        for (i, (_, name)) in names.iter().enumerate() {
            if bound[i].is_some() || name.is_empty() {
                continue;
            }
            if let Some(paths) = folders_by_extracted.get(name) {
                if paths.len() == 1 {
                    bound[i] = Some(paths[0].clone());
                }
            }
        }
        return bound;
    }

    // 3) Mode fallback: contains / starts_with on full folder name or extracted name
    for (i, (_, name)) in names.iter().enumerate() {
        if bound[i].is_some() || name.is_empty() {
            continue;
        }
        let mut hits: Vec<PathBuf> = Vec::new();
        for (folder_name, path) in folders_by_full_name {
            if folder_matches_roster_name(folder_name, name, folder_match_mode) {
                if !hits.iter().any(|p| p == path) {
                    hits.push(path.clone());
                }
            }
        }
        if hits.len() == 1 {
            bound[i] = Some(hits[0].clone());
            continue;
        }
        if !hits.is_empty() {
            continue; // ambiguous — leave unbound
        }
        let mut extracted_hits = Vec::new();
        for (extracted, paths) in folders_by_extracted {
            let hit = if folder_match_mode == "starts_with" {
                extracted.starts_with(name) || name.starts_with(extracted)
            } else {
                // fuzzy: name contains person name, or person name contains name
                (!extracted.is_empty() && name.contains(extracted.as_str()))
                    || extracted.contains(name)
            };
            if hit {
                extracted_hits.extend(paths.iter().cloned());
            }
        }
        extracted_hits.sort();
        extracted_hits.dedup();
        if extracted_hits.len() == 1 {
            bound[i] = Some(extracted_hits[0].clone());
        }
    }

    bound
}

fn is_cjk(c: char) -> bool {
    matches!(
        c as u32,
        0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0xF900..=0xFAFF
    )
}

fn extract_name_from_folder(folder_name: &str, pattern: &str) -> String {
    if pattern == "auto" || pattern.is_empty() {
        let chars: Vec<char> = folder_name.chars().collect();
        let mut end = None;
        let mut start = None;

        for (i, c) in chars.iter().enumerate().rev() {
            if is_cjk(*c) {
                if end.is_none() {
                    end = Some(i);
                }
                start = Some(i);
            } else if end.is_some() {
                break;
            }
        }

        if let (Some(s), Some(e)) = (start, end) {
            return chars[s..=e].iter().collect();
        }

        folder_name.to_string()
    } else {
        if pattern.len() > 200 {
            return folder_name.to_string();
        }
        if let Ok(re) = regex::Regex::new(pattern) {
            if let Some(caps) = re.captures(folder_name) {
                if let Some(m) = caps.get(1) {
                    return m.as_str().to_string();
                }
            }
        }
        folder_name.to_string()
    }
}

fn stem_core(name: &str) -> String {
    let stem = Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(name);
    strip_alias_parens(stem)
}

fn template_content_matches(content: &str, expected_name: &str) -> bool {
    if content == expected_name {
        return true;
    }
    let content_stem = Path::new(content)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(content);
    let expected_stem = Path::new(expected_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(expected_name);
    if content_stem == expected_stem || content_stem == expected_name || content == expected_stem {
        return true;
    }
    // `司法鉴定意见书 (11).docx` ↔ `司法鉴定意见书.docx` (ignore copy suffix in parentheses)
    let content_core = stem_core(content);
    let expected_core = stem_core(expected_name);
    !content_core.is_empty() && content_core == expected_core
}

/// Drop alias in parentheses: `惠春菊（李兆瑞）` → `惠春菊`, `2026-109惠春菊（李兆瑞）` → `2026-109惠春菊`.
fn strip_alias_parens(s: &str) -> String {
    let mut out = String::new();
    let mut depth_cjk = 0i32;
    let mut depth_ascii = 0i32;
    for ch in s.chars() {
        match ch {
            '（' => depth_cjk += 1,
            '）' => depth_cjk = (depth_cjk - 1).max(0),
            '(' => depth_ascii += 1,
            ')' => depth_ascii = (depth_ascii - 1).max(0),
            _ if depth_cjk == 0 && depth_ascii == 0 => out.push(ch),
            _ => {}
        }
    }
    out.trim().to_string()
}

/// Name variants for template expansion: roster id, stripped-S id, folder basename, `id 姓名`.
fn roster_name_variants(roster_name: &str, folder_name: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let push = |buf: &mut Vec<String>, s: String| {
        let s = s.trim().to_string();
        if s.is_empty() || buf.iter().any(|x| x == &s) {
            return;
        }
        buf.push(s.clone());
        let stripped = strip_alias_parens(&s);
        if stripped != s && !stripped.is_empty() && !buf.iter().any(|x| x == &stripped) {
            buf.push(stripped);
        }
    };
    push(&mut out, roster_name.to_string());
    let plain = normalize_archive_id(roster_name);
    push(&mut out, plain.clone());
    let key = archive_id_key(roster_name);
    if key != plain {
        push(&mut out, key.clone());
    }
    if let Some(folder) = folder_name {
        push(&mut out, folder.to_string());
        let person = extract_name_from_folder(folder, "auto");
        let person_main = strip_alias_parens(&person);
        if !plain.is_empty() && !person.is_empty() && person != folder {
            push(&mut out, format!("{} {}", plain, person));
            push(&mut out, format!("{}{}", plain, person)); // e.g. 2026-0008刘澎
        }
        if !plain.is_empty() && !person_main.is_empty() && person_main != person {
            push(&mut out, format!("{}{}", plain, person_main));
            push(&mut out, format!("{} {}", plain, person_main));
        }
        if !key.is_empty() && !person.is_empty() && person != folder {
            push(&mut out, format!("{} {}", key, person));
            push(&mut out, format!("{}{}", key, person));
        }
        if !key.is_empty() && !person_main.is_empty() {
            push(&mut out, format!("{}{}", key, person_main));
            push(&mut out, format!("{} {}", key, person_main));
        }
    }
    out
}

fn template_expected_variants(template: &str, name_variants: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let push = |buf: &mut Vec<String>, s: String| {
        if !s.is_empty() && !buf.iter().any(|x| x == &s) {
            buf.push(s);
        }
    };
    for name in name_variants {
        let expected = template.replace("{name}", name);
        push(&mut out, expected.clone());
        if let Some(stem) = expected.strip_suffix(".docx") {
            push(&mut out, format!("{stem}.doc"));
        } else if let Some(stem) = expected.strip_suffix(".doc") {
            push(&mut out, format!("{stem}.docx"));
        }
    }
    out
}

fn find_template_in_contents(
    contents: &HashSet<String>,
    content_paths: &HashMap<String, String>,
    expected_name: &str,
) -> (bool, Option<String>) {
    if contents.contains(expected_name) {
        return (true, content_paths.get(expected_name).cloned());
    }
    for content in contents {
        if template_content_matches(content, expected_name) {
            return (true, content_paths.get(content).cloned());
        }
    }
    (false, None)
}

fn find_template_with_variants(
    contents: &HashSet<String>,
    content_paths: &HashMap<String, String>,
    template: &str,
    roster_name: &str,
    folder_name: Option<&str>,
) -> (bool, Option<String>, String) {
    let variants = roster_name_variants(roster_name, folder_name);
    let expected_list = template_expected_variants(template, &variants);
    let primary = expected_list
        .first()
        .cloned()
        .unwrap_or_else(|| template.replace("{name}", roster_name));
    for expected in &expected_list {
        let (exists, path) = find_template_in_contents(contents, content_paths, expected);
        if exists {
            return (true, path, primary);
        }
    }
    (false, None, primary)
}

/// 读取 Excel 文件信息
#[tauri::command]
pub async fn read_excel_info(
    file_path: String,
    sheet_index: Option<usize>,
) -> Result<ExcelFileInfo, String> {
    crate::path_util::validate_user_path(&file_path)?;
    tokio::task::spawn_blocking(move || read_excel_info_sync(file_path, sheet_index))
        .await
        .map_err(join_error)?
}

fn read_excel_info_sync(
    file_path: String,
    sheet_index: Option<usize>,
) -> Result<ExcelFileInfo, String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err(crate::err::code("file_not_found"));
    }

    let mut workbook: Xlsx<_> = open_workbook(&file_path)
        .map_err(|e| crate::err::with_detail("excel_open_failed", e))?;

    let sheet_names: Vec<String> = workbook.sheet_names().to_vec();

    if sheet_names.is_empty() {
        return Err(crate::err::code("excel_no_sheets"));
    }

    let sheet_idx = sheet_index.unwrap_or(0);
    let sheet_name = sheet_names
        .get(sheet_idx)
        .ok_or_else(|| crate::err::code("excel_sheet_index_invalid"))?
        .clone();

    let range = workbook
        .worksheet_range(&sheet_name)
        .map_err(|e| crate::err::with_detail("excel_sheet_read_failed", e))?;

    let mut columns: Vec<ExcelColumnInfo> = Vec::new();
    let row_count = range.height();

    if let Some(first_row) = range.rows().next() {
        for (idx, cell) in first_row.iter().enumerate() {
            let name = cell_to_string(cell);
            let name = if name.is_empty() {
                format!("Column{}", idx + 1)
            } else {
                name
            };

            let mut sample_values: Vec<String> = Vec::new();
            for (row_idx, row) in range.rows().enumerate() {
                if row_idx == 0 {
                    continue;
                }
                if sample_values.len() >= 5 {
                    break;
                }
                if let Some(cell) = row.get(idx) {
                    let value = cell_to_string(cell);
                    if !value.is_empty() {
                        sample_values.push(value);
                    }
                }
            }

            columns.push(ExcelColumnInfo {
                index: idx,
                name,
                letter: column_index_to_letter(idx),
                sample_values,
            });
        }
    }

    Ok(ExcelFileInfo {
        sheets: sheet_names,
        columns,
        row_count: if row_count > 0 { row_count - 1 } else { 0 },
    })
}

/// Legacy roster-only match (kept for reference; UI removed).
#[allow(dead_code)]
#[tauri::command]
pub async fn match_excel_with_folder(
    app: AppHandle,
    store: State<'_, Arc<SmbSessionStore>>,
    excel_path: String,
    sheet_index: usize,
    column_index: usize,
    folder_path: String,
    match_mode: String,
    mark_color: String,
    output_path: Option<String>,
    job_id: Option<u64>,
) -> Result<ExcelMatchResult, String> {
    crate::path_util::validate_user_path(&excel_path)?;
    crate::path_util::validate_user_path(&folder_path)?;
    if let Some(ref out) = output_path {
        crate::path_util::validate_user_path(out)?;
    }
    let job_id = job_runner::resolve_or_begin(job_id, JobKind::Excel);

    let pre_names = if crate::path_util::is_remote_path(&folder_path) {
        emit_progress(&app, job_id, "scanning", 0, 0, "");
        let names = collect_remote_names(store.as_ref(), &folder_path, &app, job_id).await?;
        Some(names)
    } else {
        None
    };

    let result = tokio::task::spawn_blocking(move || {
        let result = match_excel_with_folder_sync(
            app,
            job_id,
            excel_path,
            sheet_index,
            column_index,
            folder_path,
            match_mode,
            mark_color,
            output_path,
            pre_names,
        );
        job_runner::end_job(job_id);
        result
    })
    .await
    .map_err(join_error)?;
    result
}

fn match_excel_with_folder_sync(
    app: AppHandle,
    job_id: u64,
    excel_path: String,
    sheet_index: usize,
    column_index: usize,
    folder_path: String,
    match_mode: String,
    mark_color: String,
    output_path: Option<String>,
    pre_names: Option<(HashSet<String>, bool)>,
) -> Result<ExcelMatchResult, String> {
    emit_progress(&app, job_id, "reading_excel", 0, 0, "");

    let mut workbook: Xlsx<_> = open_workbook(&excel_path)
        .map_err(|e| crate::err::with_detail("excel_open_failed", e))?;

    let sheet_names: Vec<String> = workbook.sheet_names().to_vec();
    let sheet_name = sheet_names
        .get(sheet_index)
        .ok_or_else(|| crate::err::code("excel_sheet_index_invalid"))?
        .clone();

    let range = workbook
        .worksheet_range(&sheet_name)
        .map_err(|e| crate::err::with_detail("excel_sheet_read_failed", e))?;

    if job_runner::is_cancelled(job_id) {
        return Ok(ExcelMatchResult {
            total_rows: 0,
            matched_count: 0,
            missing_count: 0,
            items: vec![],
            output_path: None,
            truncated: false,
            cancelled: true,
        });
    }

    let (file_names, truncated) = if let Some(pre) = pre_names {
        pre
    } else {
        emit_progress(&app, job_id, "scanning", 0, 0, "");
        let folder = Path::new(&folder_path);
        let counter = AtomicUsize::new(0);
        if folder.exists() {
            collect_names_under_cached(folder, job_id, Some((&app, &counter, 0)))
        } else {
            (HashSet::new(), false)
        }
    };

    let cancelled = job_runner::is_cancelled(job_id);
    emit_progress(&app, job_id, "matching", 0, 0, "");

    let mut values: Vec<(usize, String)> = Vec::new();
    for (row_idx, row) in range.rows().enumerate() {
        if row_idx == 0 {
            continue;
        }
        let value = row
            .get(column_index)
            .map(cell_to_string)
            .unwrap_or_default();
        values.push((row_idx, value));
    }

    let match_results = match_rows_against_names(&values, &file_names, &match_mode);

    let mut items: Vec<MatchResultItem> = Vec::with_capacity(values.len());
    let mut matched_count = 0usize;
    for (i, (row_idx, value)) in values.into_iter().enumerate() {
        let (matched, matched_file) = match_results[i].clone();
        if matched {
            matched_count += 1;
        }
        items.push(MatchResultItem {
            row_index: row_idx,
            value,
            matched,
            matched_file,
        });
    }

    let total_rows = items.len();
    let missing_count = total_rows - matched_count;

    // Incremental / partial export: still write whatever we have (including after cancel).
    let final_output_path = if let Some(out_path) = output_path {
        emit_progress(&app, job_id, "writing", 0, total_rows as u64, "");
        let mut new_workbook = Workbook::new();
        let worksheet = new_workbook.add_worksheet();

        let mark_format = Format::new().set_background_color(match mark_color.as_str() {
            "red" => Color::RGB(0xFF6B6B),
            "yellow" => Color::RGB(0xFFE66D),
            "green" => Color::RGB(0x6BCB77),
            _ => Color::RGB(0xFF6B6B),
        });

        let normal_format = Format::new();
        let header_format = Format::new()
            .set_bold()
            .set_background_color(Color::RGB(0xE8E8E8))
            .set_border(FormatBorder::Thin);

        for (row_idx, row) in range.rows().enumerate() {
            let is_header = row_idx == 0;
            let is_missing = if row_idx > 0 {
                items
                    .get(row_idx - 1)
                    .map(|item| !item.matched)
                    .unwrap_or(false)
            } else {
                false
            };

            for (col_idx, cell) in row.iter().enumerate() {
                let value = cell_to_string(cell);
                let format = if is_header {
                    &header_format
                } else if is_missing {
                    &mark_format
                } else {
                    &normal_format
                };

                worksheet
                    .write_string_with_format(row_idx as u32, col_idx as u16, &value, format)
                    .map_err(|e| crate::err::with_detail("excel_write_cell_failed", e))?;
            }

            if is_header {
                worksheet
                    .write_string_with_format(
                        row_idx as u32,
                        range.width() as u16,
                        "Match Status",
                        &header_format,
                    )
                    .map_err(|e| crate::err::with_detail("excel_write_cell_failed", e))?;
            } else if row_idx > 0 {
                let status = if items
                    .get(row_idx - 1)
                    .map(|item| item.matched)
                    .unwrap_or(false)
                {
                    "Matched"
                } else {
                    "Missing"
                };
                let format = if is_missing {
                    &mark_format
                } else {
                    &normal_format
                };
                worksheet
                    .write_string_with_format(
                        row_idx as u32,
                        range.width() as u16,
                        status,
                        format,
                    )
                    .map_err(|e| crate::err::with_detail("excel_write_cell_failed", e))?;
            }
        }

        new_workbook
            .save(&out_path)
            .map_err(|e| crate::err::with_detail("excel_save_failed", e))?;

        Some(out_path)
    } else {
        None
    };

    emit_progress(
        &app,
        job_id,
        if cancelled { "cancelled" } else { "done" },
        total_rows as u64,
        total_rows as u64,
        "",
    );

    Ok(ExcelMatchResult {
        total_rows,
        matched_count,
        missing_count,
        items,
        output_path: final_output_path,
        truncated,
        cancelled,
    })
}

/// Legacy folder-scan integrity (kept for reference; UI removed).
#[allow(dead_code)]
#[tauri::command]
pub async fn check_folder_integrity(
    app: AppHandle,
    store: State<'_, Arc<SmbSessionStore>>,
    target_folder: String,
    templates: Vec<String>,
    name_pattern: String,
    output_path: Option<String>,
    job_id: Option<u64>,
) -> Result<BatchIntegrityResult, String> {
    crate::path_util::validate_user_path(&target_folder)?;
    if let Some(ref out) = output_path {
        crate::path_util::validate_user_path(out)?;
    }
    let job_id = job_runner::resolve_or_begin(job_id, JobKind::Excel);

    if crate::path_util::is_remote_path(&target_folder) {
        let result = check_folder_integrity_remote(
            app,
            store.as_ref(),
            job_id,
            target_folder,
            templates,
            name_pattern,
            output_path,
        )
        .await;
        job_runner::end_job(job_id);
        return result;
    }

    tokio::task::spawn_blocking(move || {
        let result =
            check_folder_integrity_sync(app, job_id, target_folder, templates, name_pattern, output_path);
        job_runner::end_job(job_id);
        result
    })
    .await
    .map_err(join_error)?
}

async fn check_folder_integrity_remote(
    app: AppHandle,
    store: &SmbSessionStore,
    job_id: u64,
    target_folder: String,
    templates: Vec<String>,
    name_pattern: String,
    output_path: Option<String>,
) -> Result<BatchIntegrityResult, String> {
    emit_progress(&app, job_id, "listing", 0, 0, "");
    let mut person_folders = list_remote_person_folders(store, &target_folder).await?;
    let mut truncated = false;
    if person_folders.len() > INTEGRITY_PERSON_FOLDER_SOFT_CAP {
        person_folders.truncate(INTEGRITY_PERSON_FOLDER_SOFT_CAP);
        truncated = true;
    }
    let total = person_folders.len() as u64;
    emit_progress(&app, job_id, "checking", 0, total, "");

    let mut results: Vec<FolderIntegrityResult> = Vec::new();
    let mut complete_count = 0usize;

    for (idx, (folder_name, folder_path)) in person_folders.into_iter().enumerate() {
        if job_runner::is_cancelled(job_id) {
            break;
        }
        let extracted_name = extract_name_from_folder(&folder_name, &name_pattern);
        let (contents, content_paths, folder_truncated) =
            collect_remote_contents(store, &folder_path, &app, job_id).await?;
        if folder_truncated {
            truncated = true;
        }

        let mut check_items: Vec<IntegrityCheckItem> = Vec::new();
        let mut is_complete = true;
        for template in &templates {
            let (exists, found_path, expected_name) = find_template_with_variants(
                &contents,
                &content_paths,
                template,
                &extracted_name,
                Some(&folder_name),
            );
            if !exists {
                is_complete = false;
            }
            check_items.push(IntegrityCheckItem {
                template: template.clone(),
                expected_name,
                exists,
                found_path,
            });
        }
        if is_complete {
            complete_count += 1;
        }
        results.push(FolderIntegrityResult {
            folder_path,
            folder_name,
            extracted_name,
            is_complete,
            check_items,
        });
        let cur = (idx + 1) as u64;
        if cur == 1 || cur % 5 == 0 || cur == total {
            emit_progress(&app, job_id, "checking", cur, total, "");
        }
    }

    let cancelled = job_runner::is_cancelled(job_id);
    let total_folders = results.len();
    let incomplete_count = total_folders - complete_count;

    let final_output_path = if let Some(out_path) = output_path {
        emit_progress(&app, job_id, "writing", total_folders as u64, total, "");
        let templates_c = templates.clone();
        let results_c = results.clone();
        let out_path_c = out_path.clone();
        tokio::task::spawn_blocking(move || {
            write_batch_integrity_report(&out_path_c, &templates_c, &results_c)
        })
        .await
        .map_err(join_error)??;
        Some(out_path)
    } else {
        None
    };

    emit_progress(
        &app,
        job_id,
        if cancelled { "cancelled" } else { "done" },
        total_folders as u64,
        total,
        "",
    );

    Ok(BatchIntegrityResult {
        total_folders,
        complete_count,
        incomplete_count,
        results,
        output_path: final_output_path,
        truncated,
        cancelled,
    })
}

fn write_batch_integrity_report(
    out_path: &str,
    templates: &[String],
    results: &[FolderIntegrityResult],
) -> Result<(), String> {
    let mut workbook = Workbook::new();
    let worksheet = workbook.add_worksheet();
    let header_format = Format::new()
        .set_bold()
        .set_background_color(Color::RGB(0xE8E8E8))
        .set_border(FormatBorder::Thin);
    let ok_format = Format::new().set_background_color(Color::RGB(0xD4EDDA));
    let missing_format = Format::new().set_background_color(Color::RGB(0xFF6B6B));
    worksheet
        .write_string_with_format(0, 0, "Folder", &header_format)
        .ok();
    worksheet
        .write_string_with_format(0, 1, "Name", &header_format)
        .ok();
    for (idx, template) in templates.iter().enumerate() {
        worksheet
            .write_string_with_format(0, (idx + 2) as u16, template, &header_format)
            .ok();
    }
    worksheet
        .write_string_with_format(0, (templates.len() + 2) as u16, "Status", &header_format)
        .ok();
    for (row_idx, result) in results.iter().enumerate() {
        let row = (row_idx + 1) as u32;
        let row_format = if result.is_complete {
            &ok_format
        } else {
            &missing_format
        };
        worksheet
            .write_string_with_format(row, 0, &result.folder_name, row_format)
            .ok();
        worksheet
            .write_string_with_format(row, 1, &result.extracted_name, row_format)
            .ok();
        for (col_idx, item) in result.check_items.iter().enumerate() {
            let status = if item.exists { "✓" } else { "✗" };
            let format = if item.exists {
                &ok_format
            } else {
                &missing_format
            };
            worksheet
                .write_string_with_format(row, (col_idx + 2) as u16, status, format)
                .ok();
        }
        let status = if result.is_complete {
            "Complete"
        } else {
            "Missing"
        };
        worksheet
            .write_string_with_format(row, (templates.len() + 2) as u16, status, row_format)
            .ok();
    }
    workbook
        .save(out_path)
        .map_err(|e| crate::err::with_detail("excel_save_failed", e))?;
    Ok(())
}

fn check_one_person_folder(
    path: &Path,
    templates: &[String],
    name_pattern: &str,
    job_id: u64,
) -> Option<(FolderIntegrityResult, bool)> {
    if job_runner::is_cancelled(job_id) {
        return None;
    }
    let folder_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let extracted_name = extract_name_from_folder(&folder_name, name_pattern);
    let (contents, content_paths, folder_truncated) =
        collect_contents_under_cached(path, job_id);

    let mut check_items: Vec<IntegrityCheckItem> = Vec::new();
    let mut is_complete = true;
    for template in templates {
        let (exists, found_path, expected_name) = find_template_with_variants(
            &contents,
            &content_paths,
            template,
            &extracted_name,
            Some(&folder_name),
        );
        if !exists {
            is_complete = false;
        }
        check_items.push(IntegrityCheckItem {
            template: template.clone(),
            expected_name,
            exists,
            found_path,
        });
    }

    Some((
        FolderIntegrityResult {
            folder_path: path.to_string_lossy().to_string(),
            folder_name,
            extracted_name,
            is_complete,
            check_items,
        },
        folder_truncated,
    ))
}

fn check_folder_integrity_sync(
    app: AppHandle,
    job_id: u64,
    target_folder: String,
    templates: Vec<String>,
    name_pattern: String,
    output_path: Option<String>,
) -> Result<BatchIntegrityResult, String> {
    let folder = Path::new(&target_folder);
    if !folder.exists() {
        return Err(crate::err::code("target_folder_missing"));
    }

    emit_progress(&app, job_id, "listing", 0, 0, "");
    let mut person_folders = list_person_folders(folder)?;
    let mut truncated = false;
    if person_folders.len() > INTEGRITY_PERSON_FOLDER_SOFT_CAP {
        person_folders.truncate(INTEGRITY_PERSON_FOLDER_SOFT_CAP);
        truncated = true;
    }
    let total = person_folders.len() as u64;
    emit_progress(&app, job_id, "checking", 0, total, "");

    let done = AtomicUsize::new(0);
    let trunc_flag = AtomicUsize::new(if truncated { 1 } else { 0 });
    let concurrency = check_concurrency(&target_folder);
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(concurrency)
        .build()
        .map_err(|e| crate::err::with_detail("thread_pool_failed", e))?;

    let results: Vec<FolderIntegrityResult> = pool.install(|| {
        person_folders
            .par_iter()
            .filter_map(|path| {
                if job_runner::is_cancelled(job_id) {
                    return None;
                }
                let outcome = check_one_person_folder(path, &templates, &name_pattern, job_id)?;
                if outcome.1 {
                    trunc_flag.store(1, Ordering::Relaxed);
                }
                let cur = done.fetch_add(1, Ordering::Relaxed) + 1;
                if cur == 1 || cur % 10 == 0 || cur as u64 == total {
                    emit_progress(&app, job_id, "checking", cur as u64, total, "");
                }
                Some(outcome.0)
            })
            .collect()
    });

    let cancelled = job_runner::is_cancelled(job_id);
    truncated = trunc_flag.load(Ordering::Relaxed) > 0;
    let complete_count = results.iter().filter(|r| r.is_complete).count();
    let total_folders = results.len();
    let incomplete_count = total_folders - complete_count;

    let final_output_path = if let Some(out_path) = output_path {
        emit_progress(&app, job_id, "writing", total_folders as u64, total, "");
        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();

        let header_format = Format::new()
            .set_bold()
            .set_background_color(Color::RGB(0xE8E8E8))
            .set_border(FormatBorder::Thin);

        let ok_format = Format::new().set_background_color(Color::RGB(0xD4EDDA));
        let missing_format = Format::new().set_background_color(Color::RGB(0xFF6B6B));

        worksheet
            .write_string_with_format(0, 0, "Folder", &header_format)
            .ok();
        worksheet
            .write_string_with_format(0, 1, "Name", &header_format)
            .ok();

        for (idx, template) in templates.iter().enumerate() {
            worksheet
                .write_string_with_format(0, (idx + 2) as u16, template, &header_format)
                .ok();
        }
        worksheet
            .write_string_with_format(0, (templates.len() + 2) as u16, "Status", &header_format)
            .ok();

        for (row_idx, result) in results.iter().enumerate() {
            let row = (row_idx + 1) as u32;
            let row_format = if result.is_complete {
                &ok_format
            } else {
                &missing_format
            };

            worksheet
                .write_string_with_format(row, 0, &result.folder_name, row_format)
                .ok();
            worksheet
                .write_string_with_format(row, 1, &result.extracted_name, row_format)
                .ok();

            for (col_idx, item) in result.check_items.iter().enumerate() {
                let status = if item.exists { "✓" } else { "✗" };
                let format = if item.exists {
                    &ok_format
                } else {
                    &missing_format
                };
                worksheet
                    .write_string_with_format(row, (col_idx + 2) as u16, status, format)
                    .ok();
            }

            let status = if result.is_complete {
                "Complete"
            } else {
                "Missing"
            };
            worksheet
                .write_string_with_format(row, (templates.len() + 2) as u16, status, row_format)
                .ok();
        }

        workbook
            .save(&out_path)
            .map_err(|e| crate::err::with_detail("excel_save_failed", e))?;

        Some(out_path)
    } else {
        None
    };

    emit_progress(
        &app,
        job_id,
        if cancelled { "cancelled" } else { "done" },
        total_folders as u64,
        total,
        "",
    );

    Ok(BatchIntegrityResult {
        total_folders,
        complete_count,
        incomplete_count,
        results,
        output_path: final_output_path,
        truncated,
        cancelled,
    })
}

fn remote_tree_to_file_node(node: RemoteTreeNode) -> FileTreeNode {
    FileTreeNode {
        name: node.name,
        path: node.path,
        is_dir: node.is_dir,
        children: node.children.into_iter().map(remote_tree_to_file_node).collect(),
    }
}

/// 扫描文件夹目录树（UI 预览用；默认多层；支持 remote://）
#[tauri::command]
pub async fn scan_folder_tree(
    store: State<'_, Arc<SmbSessionStore>>,
    folder_path: String,
    max_depth: Option<usize>,
) -> Result<FolderTreeResult, String> {
    crate::path_util::validate_user_path(&folder_path)?;
    let depth = max_depth.unwrap_or(8).clamp(1, 8);
    if crate::path_util::is_remote_path(&folder_path) {
        let (children, files, folders, truncated) =
            scan_remote_folder_tree(store.as_ref(), &folder_path, depth, TREE_ENTRY_SOFT_CAP)
                .await?;
        let root_name = folder_path
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or(&folder_path)
            .to_string();
        let child_nodes: Vec<FileTreeNode> =
            children.into_iter().map(remote_tree_to_file_node).collect();
        return Ok(FolderTreeResult {
            root: FileTreeNode {
                name: root_name,
                path: folder_path,
                is_dir: true,
                children: child_nodes,
            },
            total_files: files,
            total_folders: folders,
            truncated,
        });
    }
    tokio::task::spawn_blocking(move || scan_folder_tree_sync(folder_path, Some(depth)))
        .await
        .map_err(join_error)?
}

fn scan_folder_tree_sync(
    folder_path: String,
    max_depth: Option<usize>,
) -> Result<FolderTreeResult, String> {
    let folder = Path::new(&folder_path);
    if !folder.exists() {
        return Err(crate::err::code("folder_not_found"));
    }

    // UI preview defaults to full practical depth (up to 8).
    let depth = max_depth.unwrap_or(8).clamp(1, 8);
    let mut total_files = 0;
    let mut total_folders = 0;

    fn build_tree(
        path: &Path,
        current_depth: usize,
        max_depth: usize,
        total_files: &mut usize,
        total_folders: &mut usize,
        truncated: &mut bool,
        entry_cap: usize,
    ) -> FileTreeNode {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string_lossy().to_string());

        let is_dir = path.is_dir();
        let mut children = Vec::new();

        if is_dir {
            *total_folders += 1;
            if !*truncated && current_depth < max_depth {
                if let Ok(entries) = fs::read_dir(path) {
                    let mut entries_vec: Vec<_> = entries.filter_map(|e| e.ok()).collect();
                    entries_vec.sort_by(|a, b| {
                        let a_is_dir = a.path().is_dir();
                        let b_is_dir = b.path().is_dir();
                        match (a_is_dir, b_is_dir) {
                            (true, false) => std::cmp::Ordering::Less,
                            (false, true) => std::cmp::Ordering::Greater,
                            _ => a.file_name().cmp(&b.file_name()),
                        }
                    });

                    for entry in entries_vec {
                        if *total_files + *total_folders >= entry_cap {
                            *truncated = true;
                            break;
                        }
                        let child = build_tree(
                            &entry.path(),
                            current_depth + 1,
                            max_depth,
                            total_files,
                            total_folders,
                            truncated,
                            entry_cap,
                        );
                        children.push(child);
                    }
                }
            }
        } else {
            *total_files += 1;
        }

        FileTreeNode {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir,
            children,
        }
    }

    let mut truncated = false;
    let root = build_tree(
        folder,
        0,
        depth,
        &mut total_files,
        &mut total_folders,
        &mut truncated,
        TREE_ENTRY_SOFT_CAP,
    );

    Ok(FolderTreeResult {
        root,
        total_files,
        total_folders,
        truncated,
    })
}

/// 基于 Excel 的完整性检查（人名文件夹下全树递归找模板；支持 remote://）
#[tauri::command]
pub async fn check_integrity_with_excel(
    app: AppHandle,
    store: State<'_, Arc<SmbSessionStore>>,
    excel_path: String,
    sheet_index: usize,
    name_column_index: usize,
    target_folder: String,
    templates: Vec<String>,
    folder_match_mode: String,
    output_path: Option<String>,
    job_id: Option<u64>,
) -> Result<ExcelIntegrityResult, String> {
    crate::path_util::validate_user_path(&excel_path)?;
    crate::path_util::validate_user_path(&target_folder)?;
    if let Some(ref out) = output_path {
        crate::path_util::validate_user_path(out)?;
    }
    let job_id = job_runner::resolve_or_begin(job_id, JobKind::Excel);

    if crate::path_util::is_remote_path(&target_folder) {
        let result = check_integrity_with_excel_remote(
            app,
            store.as_ref(),
            job_id,
            excel_path,
            sheet_index,
            name_column_index,
            target_folder,
            templates,
            folder_match_mode,
            output_path,
        )
        .await;
        job_runner::end_job(job_id);
        return result;
    }

    tokio::task::spawn_blocking(move || {
        let result = check_integrity_with_excel_sync(
            app,
            job_id,
            excel_path,
            sheet_index,
            name_column_index,
            target_folder,
            templates,
            folder_match_mode,
            output_path,
        );
        job_runner::end_job(job_id);
        result
    })
    .await
    .map_err(join_error)?
}

async fn check_integrity_with_excel_remote(
    app: AppHandle,
    store: &SmbSessionStore,
    job_id: u64,
    excel_path: String,
    sheet_index: usize,
    name_column_index: usize,
    target_folder: String,
    templates: Vec<String>,
    folder_match_mode: String,
    output_path: Option<String>,
) -> Result<ExcelIntegrityResult, String> {
    emit_progress(&app, job_id, "listing", 0, 0, "");
    let person_folders = list_remote_person_folders(store, &target_folder).await?;
    let mut truncated = person_folders.len() > INTEGRITY_PERSON_FOLDER_SOFT_CAP;
    let person_folders: Vec<_> = person_folders
        .into_iter()
        .take(INTEGRITY_PERSON_FOLDER_SOFT_CAP)
        .collect();

    let mut folders_by_full_name: HashMap<String, PathBuf> = HashMap::new();
    let mut folders_by_extracted: HashMap<String, Vec<PathBuf>> = HashMap::new();
    for (folder_name, folder_path) in &person_folders {
        let path = PathBuf::from(folder_path);
        folders_by_full_name.insert(folder_name.clone(), path.clone());
        let extracted = extract_name_from_folder(folder_name, "auto");
        folders_by_extracted
            .entry(extracted)
            .or_default()
            .push(path);
    }

    emit_progress(&app, job_id, "reading_excel", 0, 0, "");
    let names: Vec<(usize, String)> = tokio::task::spawn_blocking({
        let excel_path = excel_path.clone();
        move || -> Result<Vec<(usize, String)>, String> {
            let mut workbook: Xlsx<_> = open_workbook(&excel_path)
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
                if names.len() >= INTEGRITY_ROW_SOFT_CAP {
                    break;
                }
                names.push((row_idx, name));
            }
            Ok(names)
        }
    })
    .await
    .map_err(join_error)??;

    if names.len() >= INTEGRITY_ROW_SOFT_CAP {
        truncated = true;
    }

    let bound = bind_names_to_folders(
        &names,
        &folders_by_full_name,
        &folders_by_extracted,
        &folder_match_mode,
    );

    let mut unique_paths: Vec<PathBuf> = Vec::new();
    {
        let mut seen = HashSet::new();
        for p in bound.iter().flatten() {
            let key = p.to_string_lossy().to_string();
            if seen.insert(key) {
                unique_paths.push(p.clone());
            }
        }
    }

    emit_progress(&app, job_id, "scanning", 0, unique_paths.len() as u64, "");
    let mut cache: HashMap<String, (HashSet<String>, HashMap<String, String>)> = HashMap::new();
    for (i, matched_path) in unique_paths.iter().enumerate() {
        if job_runner::is_cancelled(job_id) {
            break;
        }
        let key = matched_path.to_string_lossy().to_string();
        let (contents, content_paths, folder_truncated) =
            collect_remote_contents(store, &key, &app, job_id).await?;
        if folder_truncated {
            truncated = true;
        }
        cache.insert(key, (contents, content_paths));
        let cur = (i + 1) as u64;
        if cur == 1 || cur % 5 == 0 {
            emit_progress(&app, job_id, "scanning", cur, unique_paths.len() as u64, "");
        }
    }

    let total = names.len() as u64;
    emit_progress(&app, job_id, "checking", 0, total, "");
    let mut items: Vec<ExcelIntegrityItem> = Vec::with_capacity(names.len());
    let mut complete_count = 0;
    let mut incomplete_count = 0;
    let mut not_found_count = 0;

    for (i, (row_idx, name)) in names.iter().enumerate() {
        if job_runner::is_cancelled(job_id) {
            break;
        }
        let matched_folder = bound[i].clone();
        let folder_found = matched_folder.is_some();
        let folder_path = matched_folder
            .as_ref()
            .map(|p| p.to_string_lossy().to_string());
        let mut check_results: Vec<TemplateCheckResult> = Vec::new();
        let mut is_complete = folder_found;

        let folder_basename = matched_folder
            .as_ref()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_string()));
        if let Some(ref matched_path) = matched_folder {
            let key = matched_path.to_string_lossy().to_string();
            if let Some((contents, content_paths)) = cache.get(&key) {
                for template in &templates {
                    let (exists, found_path, expected_name) = find_template_with_variants(
                        contents,
                        content_paths,
                        template,
                        name,
                        folder_basename.as_deref(),
                    );
                    if !exists {
                        is_complete = false;
                    }
                    check_results.push(TemplateCheckResult {
                        template: template.clone(),
                        expected_name,
                        exists,
                        found_path,
                    });
                }
            } else {
                is_complete = false;
                for template in &templates {
                    check_results.push(TemplateCheckResult {
                        template: template.clone(),
                        expected_name: template.replace("{name}", name),
                        exists: false,
                        found_path: None,
                    });
                }
            }
        } else {
            for template in &templates {
                check_results.push(TemplateCheckResult {
                    template: template.clone(),
                    expected_name: template.replace("{name}", name),
                    exists: false,
                    found_path: None,
                });
            }
        }

        if is_complete {
            complete_count += 1;
        } else if folder_found {
            incomplete_count += 1;
        } else {
            not_found_count += 1;
        }

        items.push(ExcelIntegrityItem {
            row_index: *row_idx,
            name: name.clone(),
            folder_found,
            folder_path,
            is_complete,
            check_results,
        });
    }

    let cancelled = job_runner::is_cancelled(job_id);
    let total_rows = items.len();

    let final_output_path = if let Some(out_path) = output_path {
        emit_progress(&app, job_id, "writing", total_rows as u64, total, "");
        let items_c = items.clone();
        let templates_c = templates.clone();
        let out_path_c = out_path.clone();
        let excel_path_c = excel_path.clone();
        tokio::task::spawn_blocking(move || {
            write_excel_integrity_annotated(
                &excel_path_c,
                sheet_index,
                &templates_c,
                &items_c,
                &out_path_c,
            )
        })
        .await
        .map_err(join_error)??;
        Some(out_path)
    } else {
        None
    };

    emit_progress(
        &app,
        job_id,
        if cancelled { "cancelled" } else { "done" },
        total_rows as u64,
        total,
        "",
    );

    Ok(ExcelIntegrityResult {
        total_rows,
        complete_count,
        incomplete_count,
        not_found_count,
        items,
        output_path: final_output_path,
        truncated,
        cancelled,
    })
}

/// Export: original roster sheet (annotated) + 已完成 / 资料不全 / 未匹配 detail sheets.
pub(crate) fn write_excel_integrity_annotated_pub(
    excel_path: &str,
    sheet_index: usize,
    templates: &[String],
    items: &[ExcelIntegrityItem],
    out_path: &str,
) -> Result<(), String> {
    write_excel_integrity_annotated(excel_path, sheet_index, templates, items, out_path)
}

fn write_excel_integrity_annotated(
    excel_path: &str,
    sheet_index: usize,
    templates: &[String],
    items: &[ExcelIntegrityItem],
    out_path: &str,
) -> Result<(), String> {
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

    let mut row_to_item: HashMap<usize, usize> = HashMap::new();
    for (idx, item) in items.iter().enumerate() {
        row_to_item.insert(item.row_index, idx);
    }

    let mut new_workbook = Workbook::new();
    let header_format = Format::new()
        .set_bold()
        .set_background_color(Color::RGB(0xE8E8E8))
        .set_border(FormatBorder::Thin);
    let ok_format = Format::new().set_background_color(Color::RGB(0xD4EDDA));
    let missing_format = Format::new().set_background_color(Color::RGB(0xFF6B6B));
    let not_found_format = Format::new().set_background_color(Color::RGB(0xFFE66D));
    let normal_format = Format::new();
    let link_format = Format::new()
        .set_font_color(Color::RGB(0x0563C1))
        .set_underline(FormatUnderline::Single);

    const SHEET_COMPLETE: &str = "已完成";
    const SHEET_INCOMPLETE: &str = "资料不全";
    const SHEET_MISSING: &str = "未匹配";

    // Track detail-sheet row numbers (1-based Excel rows) for internal links.
    let mut complete_excel_row: HashMap<usize, u32> = HashMap::new();
    let mut incomplete_excel_row: HashMap<usize, u32> = HashMap::new();
    let mut missing_excel_row: HashMap<usize, u32> = HashMap::new();
    let mut complete_row: u32 = 1;
    let mut incomplete_row: u32 = 1;
    let mut missing_row: u32 = 1;
    for item in items {
        if item.is_complete {
            complete_row += 1;
            complete_excel_row.insert(item.row_index, complete_row);
        } else if item.folder_found {
            incomplete_row += 1;
            incomplete_excel_row.insert(item.row_index, incomplete_row);
        } else {
            missing_row += 1;
            missing_excel_row.insert(item.row_index, missing_row);
        }
    }

    // --- Original roster sheet (annotated) ---
    {
        let worksheet = new_workbook.add_worksheet();
        let _ = worksheet.set_name(&sheet_name);
        let original_width = range.width();
        let status_col = original_width as u16;
        let detail_col = (original_width + 1) as u16;

        for (row_idx, row) in range.rows().enumerate() {
            let is_header = row_idx == 0;
            let item = if row_idx > 0 {
                row_to_item.get(&row_idx).and_then(|idx| items.get(*idx))
            } else {
                None
            };
            let row_format = if is_header {
                &header_format
            } else if let Some(item) = item {
                if item.is_complete {
                    &ok_format
                } else if item.folder_found {
                    &missing_format
                } else {
                    &not_found_format
                }
            } else {
                &normal_format
            };

            for (col_idx, cell) in row.iter().enumerate() {
                let value = cell_to_string(cell);
                worksheet
                    .write_string_with_format(row_idx as u32, col_idx as u16, &value, row_format)
                    .map_err(|e| crate::err::with_detail("excel_write_cell_failed", e))?;
            }

            if is_header {
                worksheet
                    .write_string_with_format(0, status_col, "检查状态", &header_format)
                    .ok();
                worksheet
                    .write_string_with_format(0, detail_col, "详情", &header_format)
                    .ok();
                for (idx, template) in templates.iter().enumerate() {
                    worksheet
                        .write_string_with_format(
                            0,
                            detail_col + 1 + idx as u16,
                            template,
                            &header_format,
                        )
                        .ok();
                }
            } else if let Some(item) = item {
                let (status, target_sheet, target_row) = if item.is_complete {
                    (
                        "已完成",
                        SHEET_COMPLETE,
                        complete_excel_row.get(&item.row_index).copied(),
                    )
                } else if item.folder_found {
                    (
                        "资料不全",
                        SHEET_INCOMPLETE,
                        incomplete_excel_row.get(&item.row_index).copied(),
                    )
                } else {
                    (
                        "未匹配",
                        SHEET_MISSING,
                        missing_excel_row.get(&item.row_index).copied(),
                    )
                };
                worksheet
                    .write_string_with_format(row_idx as u32, status_col, status, row_format)
                    .ok();
                if let Some(r) = target_row {
                    let link = format!("internal:'{target_sheet}'!A{r}");
                    worksheet
                        .write_url_with_format(
                            row_idx as u32,
                            detail_col,
                            Url::new(link).set_text("查看"),
                            &link_format,
                        )
                        .ok();
                }
                for (idx, check) in item.check_results.iter().enumerate() {
                    let cell = if check.exists {
                        if let Some(ref p) = check.found_path {
                            Path::new(p)
                                .file_name()
                                .and_then(|n| n.to_str())
                                .unwrap_or("✓")
                                .to_string()
                        } else {
                            "✓".into()
                        }
                    } else {
                        "✗".into()
                    };
                    let format = if check.exists {
                        &ok_format
                    } else {
                        &missing_format
                    };
                    if check.exists {
                        if let Some(ref p) = check.found_path {
                            let _ = write_path_cell(
                                worksheet,
                                row_idx as u32,
                                detail_col + 1 + idx as u16,
                                p,
                                format,
                            );
                        } else {
                            worksheet
                                .write_string_with_format(
                                    row_idx as u32,
                                    detail_col + 1 + idx as u16,
                                    &cell,
                                    format,
                                )
                                .ok();
                        }
                    } else {
                        worksheet
                            .write_string_with_format(
                                row_idx as u32,
                                detail_col + 1 + idx as u16,
                                &cell,
                                format,
                            )
                            .ok();
                    }
                }
            }
        }
    }

    // --- Detail sheets ---
    let write_detail_sheet = |book: &mut Workbook,
                              title: &str,
                              filter: &dyn Fn(&ExcelIntegrityItem) -> bool,
                              include_missing_col: bool|
     -> Result<(), String> {
        let worksheet = book.add_worksheet();
        let _ = worksheet.set_name(title);
        let mut headers: Vec<String> = vec![
            "原表行号".into(),
            "名单值".into(),
            "文件夹路径".into(),
        ];
        if include_missing_col {
            headers.push("缺失资料".into());
        }
        headers.push("已有资料".into());
        headers.push("资料路径".into());
        for (i, h) in headers.iter().enumerate() {
            worksheet
                .write_string_with_format(0, i as u16, h, &header_format)
                .map_err(|e| crate::err::with_detail("excel_write_cell_failed", e))?;
        }
        let mut excel_row = 1u32;
        for item in items.iter().filter(|i| filter(i)) {
            worksheet
                .write_number(excel_row, 0, (item.row_index + 1) as f64)
                .map_err(|e| crate::err::with_detail("excel_write_cell_failed", e))?;
            worksheet
                .write_string(excel_row, 1, &item.name)
                .map_err(|e| crate::err::with_detail("excel_write_cell_failed", e))?;
            if let Some(ref folder) = item.folder_path {
                write_path_cell(worksheet, excel_row, 2, folder, &link_format)?;
            } else {
                worksheet
                    .write_string(excel_row, 2, "")
                    .map_err(|e| crate::err::with_detail("excel_write_cell_failed", e))?;
            }

            let missing: Vec<&str> = item
                .check_results
                .iter()
                .filter(|c| !c.exists)
                .map(|c| c.expected_name.as_str())
                .collect();
            let present: Vec<&str> = item
                .check_results
                .iter()
                .filter(|c| c.exists)
                .map(|c| c.expected_name.as_str())
                .collect();
            let paths: Vec<&str> = item
                .check_results
                .iter()
                .filter_map(|c| c.found_path.as_deref())
                .collect();

            let mut col = 3u16;
            if include_missing_col {
                worksheet
                    .write_string(excel_row, col, &missing.join("；"))
                    .map_err(|e| crate::err::with_detail("excel_write_cell_failed", e))?;
                col += 1;
            }
            worksheet
                .write_string(excel_row, col, &present.join("；"))
                .map_err(|e| crate::err::with_detail("excel_write_cell_failed", e))?;
            col += 1;
            // First path as clickable; full list as text if multiple
            if let Some(first) = paths.first() {
                write_path_cell(worksheet, excel_row, col, first, &link_format)?;
                if paths.len() > 1 {
                    worksheet
                        .write_string(excel_row, col + 1, &paths[1..].join("\n"))
                        .ok();
                }
            }
            excel_row += 1;
        }
        Ok(())
    };

    write_detail_sheet(
        &mut new_workbook,
        SHEET_COMPLETE,
        &|i| i.is_complete,
        false,
    )?;
    write_detail_sheet(
        &mut new_workbook,
        SHEET_INCOMPLETE,
        &|i| i.folder_found && !i.is_complete,
        true,
    )?;
    write_detail_sheet(
        &mut new_workbook,
        SHEET_MISSING,
        &|i| !i.folder_found,
        false,
    )?;

    new_workbook
        .save(out_path)
        .map_err(|e| crate::err::with_detail("excel_save_failed", e))?;
    Ok(())
}

fn check_integrity_with_excel_sync(
    app: AppHandle,
    job_id: u64,
    excel_path: String,
    sheet_index: usize,
    name_column_index: usize,
    target_folder: String,
    templates: Vec<String>,
    folder_match_mode: String,
    output_path: Option<String>,
) -> Result<ExcelIntegrityResult, String> {
    emit_progress(&app, job_id, "reading_excel", 0, 0, "");
    let mut workbook: Xlsx<_> = open_workbook(&excel_path)
        .map_err(|e| crate::err::with_detail("excel_open_failed", e))?;

    let sheet_names: Vec<String> = workbook.sheet_names().to_vec();
    let sheet_name = sheet_names
        .get(sheet_index)
        .ok_or_else(|| crate::err::code("excel_sheet_index_invalid"))?
        .clone();

    let range = workbook
        .worksheet_range(&sheet_name)
        .map_err(|e| crate::err::with_detail("excel_sheet_read_failed", e))?;

    let folder = Path::new(&target_folder);
    if !folder.exists() {
        return Err(crate::err::code("target_folder_missing"));
    }

    emit_progress(&app, job_id, "listing", 0, 0, "");
    let mut folders_by_full_name: HashMap<String, PathBuf> = HashMap::new();
    let mut folders_by_extracted: HashMap<String, Vec<PathBuf>> = HashMap::new();
    let mut folder_count = 0usize;
    let mut truncated = false;

    for path in list_person_folders(folder)? {
        if job_runner::is_cancelled(job_id) {
            break;
        }
        folder_count += 1;
        if folder_count > INTEGRITY_PERSON_FOLDER_SOFT_CAP {
            truncated = true;
            break;
        }
        if let Some(name) = path.file_name() {
            let folder_name = name.to_string_lossy().to_string();
            folders_by_full_name.insert(folder_name.clone(), path.clone());
            let extracted = extract_name_from_folder(&folder_name, "auto");
            folders_by_extracted
                .entry(extracted)
                .or_default()
                .push(path);
        }
    }

    let mut names: Vec<(usize, String)> = Vec::new();
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
        if names.len() >= INTEGRITY_ROW_SOFT_CAP {
            truncated = true;
            break;
        }
        names.push((row_idx, name));
    }

    let bound = bind_names_to_folders(
        &names,
        &folders_by_full_name,
        &folders_by_extracted,
        &folder_match_mode,
    );

    // Unique matched folders — walk in parallel (cached)
    let mut unique_paths: Vec<PathBuf> = Vec::new();
    {
        let mut seen = HashSet::new();
        for p in bound.iter().flatten() {
            let key = p.to_string_lossy().to_string();
            if seen.insert(key) {
                unique_paths.push(p.clone());
            }
        }
    }

    let total = names.len() as u64;
    emit_progress(&app, job_id, "scanning", 0, unique_paths.len() as u64, "");

    let concurrency = check_concurrency(&target_folder);
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(concurrency)
        .build()
        .map_err(|e| crate::err::with_detail("thread_pool_failed", e))?;

    let scanned = AtomicUsize::new(0);
    let trunc_flag = AtomicUsize::new(if truncated { 1 } else { 0 });
    let contents_cache: Mutex<HashMap<String, (HashSet<String>, HashMap<String, String>)>> =
        Mutex::new(HashMap::new());

    pool.install(|| {
        unique_paths.par_iter().for_each(|matched_path| {
            if job_runner::is_cancelled(job_id) {
                return;
            }
            let (contents, content_paths, folder_truncated) =
                collect_contents_under_cached(matched_path, job_id);
            if folder_truncated {
                trunc_flag.store(1, Ordering::Relaxed);
            }
            let key = matched_path.to_string_lossy().to_string();
            if let Ok(mut guard) = contents_cache.lock() {
                guard.insert(key, (contents, content_paths));
            }
            let cur = scanned.fetch_add(1, Ordering::Relaxed) + 1;
            if cur == 1 || cur % 8 == 0 {
                emit_progress(
                    &app,
                    job_id,
                    "scanning",
                    cur as u64,
                    unique_paths.len() as u64,
                    "",
                );
            }
        });
    });

    emit_progress(&app, job_id, "checking", 0, total, "");
    let cache = contents_cache.into_inner().unwrap_or_default();
    truncated = trunc_flag.load(Ordering::Relaxed) > 0;

    let mut items: Vec<ExcelIntegrityItem> = Vec::with_capacity(names.len());
    let mut complete_count = 0;
    let mut incomplete_count = 0;
    let mut not_found_count = 0;

    for (i, (row_idx, name)) in names.iter().enumerate() {
        if job_runner::is_cancelled(job_id) {
            break;
        }
        let matched_folder = bound[i].clone();
        let folder_found = matched_folder.is_some();
        let folder_path = matched_folder
            .as_ref()
            .map(|p| p.to_string_lossy().to_string());

        let mut check_results: Vec<TemplateCheckResult> = Vec::new();
        let mut is_complete = folder_found;

        let folder_basename = matched_folder
            .as_ref()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_string()));
        if let Some(ref matched_path) = matched_folder {
            let key = matched_path.to_string_lossy().to_string();
            if let Some((contents, content_paths)) = cache.get(&key) {
                for template in &templates {
                    let (exists, found_path, expected_name) = find_template_with_variants(
                        contents,
                        content_paths,
                        template,
                        name,
                        folder_basename.as_deref(),
                    );
                    if !exists {
                        is_complete = false;
                    }
                    check_results.push(TemplateCheckResult {
                        template: template.clone(),
                        expected_name,
                        exists,
                        found_path,
                    });
                }
            } else {
                is_complete = false;
                for template in &templates {
                    check_results.push(TemplateCheckResult {
                        template: template.clone(),
                        expected_name: template.replace("{name}", name),
                        exists: false,
                        found_path: None,
                    });
                }
            }
        } else {
            for template in &templates {
                check_results.push(TemplateCheckResult {
                    template: template.clone(),
                    expected_name: template.replace("{name}", name),
                    exists: false,
                    found_path: None,
                });
            }
        }

        if is_complete {
            complete_count += 1;
        } else if folder_found {
            incomplete_count += 1;
        } else {
            not_found_count += 1;
        }

        items.push(ExcelIntegrityItem {
            row_index: *row_idx,
            name: name.clone(),
            folder_found,
            folder_path,
            is_complete,
            check_results,
        });

        if (i + 1) % 50 == 0 {
            emit_progress(&app, job_id, "checking", (i + 1) as u64, total, "");
        }
    }

    let cancelled = job_runner::is_cancelled(job_id);
    let total_rows = items.len();

    let final_output_path = if let Some(out_path) = output_path {
        emit_progress(&app, job_id, "writing", total_rows as u64, total, "");
        write_excel_integrity_annotated(
            &excel_path,
            sheet_index,
            &templates,
            &items,
            &out_path,
        )?;
        Some(out_path)
    } else {
        None
    };

    emit_progress(
        &app,
        job_id,
        if cancelled { "cancelled" } else { "done" },
        total_rows as u64,
        total,
        "",
    );

    Ok(ExcelIntegrityResult {
        total_rows,
        complete_count,
        incomplete_count,
        not_found_count,
        items,
        output_path: final_output_path,
        truncated,
        cancelled,
    })
}

#[cfg(test)]
mod archive_match_tests {
    use super::*;
    use std::collections::HashMap;
    use std::path::PathBuf;

    #[test]
    fn strips_s_prefix_and_zero_padding() {
        assert_eq!(archive_id_key("S2026-0008"), "2026-8");
        assert_eq!(archive_id_key("2026-0008 刘澎"), "2026-8");
        assert_eq!(archive_id_key("S2026-0109"), "2026-109");
        assert_eq!(archive_id_key("2026-109 惠春菊"), "2026-109");
    }

    #[test]
    fn fuzzy_binds_s_prefix_roster_to_named_folder() {
        let mut folders = HashMap::new();
        folders.insert(
            "2026-0008 刘澎".to_string(),
            PathBuf::from("/tmp/2026-0008 刘澎"),
        );
        folders.insert(
            "2026-0019 马小东".to_string(),
            PathBuf::from("/tmp/2026-0019 马小东"),
        );
        let extracted = HashMap::new();
        let names = vec![
            (1, "S2026-0008".to_string()),
            (2, "S2026-0019".to_string()),
            (3, "S2026-9999".to_string()),
        ];
        let bound = bind_names_to_folders(&names, &folders, &extracted, "contains");
        assert_eq!(
            bound[0].as_ref().map(|p| p.to_string_lossy().into_owned()),
            Some("/tmp/2026-0008 刘澎".into())
        );
        assert_eq!(
            bound[1].as_ref().map(|p| p.to_string_lossy().into_owned()),
            Some("/tmp/2026-0019 马小东".into())
        );
        assert!(bound[2].is_none());
    }

    #[test]
    fn template_variants_match_doc_and_photo_folder() {
        let mut contents = HashSet::new();
        contents.insert("2026-0019 马小东.doc".to_string());
        contents.insert("2026-0019 马小东照片".to_string());
        let mut paths = HashMap::new();
        paths.insert(
            "2026-0019 马小东.doc".to_string(),
            "/tmp/f/2026-0019 马小东.doc".to_string(),
        );
        paths.insert(
            "2026-0019 马小东照片".to_string(),
            "/tmp/f/2026-0019 马小东照片".to_string(),
        );
        let (ok_doc, _, _) = find_template_with_variants(
            &contents,
            &paths,
            "{name}.docx",
            "S2026-0019",
            Some("2026-0019 马小东"),
        );
        let (ok_photo, _, _) = find_template_with_variants(
            &contents,
            &paths,
            "{name}照片",
            "S2026-0019",
            Some("2026-0019 马小东"),
        );
        assert!(ok_doc);
        assert!(ok_photo);
    }

    #[test]
    fn matches_glued_name_and_strips_alias_parens() {
        let mut contents = HashSet::new();
        contents.insert("2026-109惠春菊.doc".to_string());
        contents.insert("2026-109惠春菊照片".to_string());
        contents.insert("司法鉴定意见书.docx".to_string());
        let mut paths = HashMap::new();
        for name in [
            "2026-109惠春菊.doc",
            "2026-109惠春菊照片",
            "司法鉴定意见书.docx",
        ] {
            paths.insert(name.to_string(), format!("/tmp/f/{name}"));
        }
        let folder = "2026-109惠春菊（李兆瑞）";
        let (ok_doc, _, _) = find_template_with_variants(
            &contents,
            &paths,
            "{name}.docx",
            "S2026-0109",
            Some(folder),
        );
        let (ok_photo, _, _) = find_template_with_variants(
            &contents,
            &paths,
            "{name}照片",
            "S2026-0109",
            Some(folder),
        );
        let (ok_fixed, _, _) = find_template_with_variants(
            &contents,
            &paths,
            "司法鉴定意见书.docx",
            "S2026-0109",
            Some(folder),
        );
        assert!(ok_doc);
        assert!(ok_photo);
        assert!(ok_fixed);
    }

    #[test]
    fn matches_opinion_doc_with_copy_suffix() {
        let mut contents = HashSet::new();
        contents.insert("司法鉴定意见书 (11).docx".to_string());
        let mut paths = HashMap::new();
        paths.insert(
            "司法鉴定意见书 (11).docx".to_string(),
            "/tmp/f/司法鉴定意见书 (11).docx".to_string(),
        );
        let (ok, found, _) = find_template_with_variants(
            &contents,
            &paths,
            "司法鉴定意见书.docx",
            "S2026-0155",
            Some("2026-155王占刚"),
        );
        assert!(ok);
        assert!(found.unwrap().contains("司法鉴定意见书 (11).docx"));
        // still must not treat bare person folder as photo
        let mut photo_only = HashSet::new();
        photo_only.insert("朱鹏飞".to_string());
        let mut photo_paths = HashMap::new();
        photo_paths.insert("朱鹏飞".to_string(), "/tmp/f/朱鹏飞".to_string());
        let (ok_photo, _, _) = find_template_with_variants(
            &photo_only,
            &photo_paths,
            "{name}照片",
            "S2026-0135",
            Some("2026-135朱鹏飞"),
        );
        assert!(!ok_photo);
    }
}
