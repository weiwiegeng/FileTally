use aho_corasick::AhoCorasick;
use calamine::{open_workbook, Data, Reader, Xlsx};
use rayon::prelude::*;
use rust_xlsxwriter::{Color, Format, FormatBorder, Workbook};
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
    scan_remote_folder_tree_shallow,
};
use super::excel_runtime::{
    check_concurrency, clear_cancel, collect_contents_under_cached, collect_names_under_cached,
    emit_progress, is_cancelled, list_person_folders, resolve_job_id,
};
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

fn cell_to_string(cell: &Data) -> String {
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

/// Bind Excel names to top-level person folders. Exact via HashMap; fuzzy via one-pass Aho-Corasick.
fn bind_names_to_folders(
    names: &[(usize, String)],
    folders_by_full_name: &HashMap<String, PathBuf>,
    folders_by_extracted: &HashMap<String, Vec<PathBuf>>,
    folder_match_mode: &str,
) -> Vec<Option<PathBuf>> {
    let mut bound: Vec<Option<PathBuf>> = vec![None; names.len()];

    // Exact full-name hits first
    for (i, (_, name)) in names.iter().enumerate() {
        if let Some(path) = folders_by_full_name.get(name) {
            bound[i] = Some(path.clone());
        }
    }

    if folder_match_mode == "exact" {
        for (i, (_, name)) in names.iter().enumerate() {
            if bound[i].is_some() {
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

    // Fuzzy: collect unique hits per name index via AC over folder names
    let owned: Vec<String> = names
        .iter()
        .map(|(_, n)| {
            if n.is_empty() {
                "\u{FFFF}\u{FFFE}".to_string()
            } else {
                n.clone()
            }
        })
        .collect();
    let Ok(ac) = AhoCorasick::new(&owned) else {
        // Fallback linear
        for (i, (_, name)) in names.iter().enumerate() {
            if bound[i].is_some() || name.is_empty() {
                continue;
            }
            let mut hits: Vec<PathBuf> = Vec::new();
            for (folder_name, path) in folders_by_full_name {
                let hit = if folder_match_mode == "starts_with" {
                    folder_name.starts_with(name)
                } else {
                    folder_name.contains(name)
                };
                if hit {
                    hits.push(path.clone());
                }
            }
            if hits.len() == 1 {
                bound[i] = Some(hits[0].clone());
            } else if hits.is_empty() {
                let mut extracted_hits = Vec::new();
                for (extracted, paths) in folders_by_extracted {
                    let hit = if folder_match_mode == "starts_with" {
                        extracted.starts_with(name)
                    } else {
                        extracted.contains(name)
                    };
                    if hit {
                        extracted_hits.extend(paths.iter().cloned());
                    }
                }
                if extracted_hits.len() == 1 {
                    bound[i] = Some(extracted_hits[0].clone());
                }
            }
        }
        return bound;
    };

    let require_prefix = folder_match_mode == "starts_with";
    // name_idx -> list of candidate paths (from full folder names)
    let mut full_hits: Vec<Vec<PathBuf>> = vec![Vec::new(); names.len()];
    for (folder_name, path) in folders_by_full_name {
        for mat in ac.find_iter(folder_name) {
            if require_prefix && mat.start() != 0 {
                continue;
            }
            let i = mat.pattern().as_usize();
            if names[i].1.is_empty() || bound[i].is_some() {
                continue;
            }
            if !full_hits[i].iter().any(|p| p == path) {
                full_hits[i].push(path.clone());
            }
        }
    }

    for (i, hits) in full_hits.iter().enumerate() {
        if bound[i].is_some() {
            continue;
        }
        if hits.len() == 1 {
            bound[i] = Some(hits[0].clone());
        }
    }

    // Extracted-name fallback only when no full-name hits
    let mut extracted_hits: Vec<Vec<PathBuf>> = vec![Vec::new(); names.len()];
    for (extracted, paths) in folders_by_extracted {
        for mat in ac.find_iter(extracted) {
            if require_prefix && mat.start() != 0 {
                continue;
            }
            let i = mat.pattern().as_usize();
            if names[i].1.is_empty() || bound[i].is_some() {
                continue;
            }
            if !full_hits[i].is_empty() {
                continue;
            }
            for path in paths {
                if !extracted_hits[i].iter().any(|p| p == path) {
                    extracted_hits[i].push(path.clone());
                }
            }
        }
    }

    for (i, hits) in extracted_hits.iter().enumerate() {
        if bound[i].is_some() {
            continue;
        }
        if hits.len() == 1 {
            bound[i] = Some(hits[0].clone());
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

fn template_content_matches(content: &str, expected_name: &str) -> bool {
    if content == expected_name {
        return true;
    }
    if !expected_name.contains('.') {
        if let Some(stem) = Path::new(content).file_stem().and_then(|s| s.to_str()) {
            return stem == expected_name;
        }
    }
    false
}

fn find_template_in_contents(
    contents: &HashSet<String>,
    content_paths: &HashMap<String, String>,
    expected_name: &str,
) -> (bool, Option<String>) {
    // Fast path: exact name / stem key
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

/// Excel 比对 - 与文件夹匹配（全树递归；一次点击扫完；支持 remote://）
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
    let job_id = resolve_job_id(job_id);

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
        clear_cancel(job_id);
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

    if is_cancelled(job_id) {
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

    let cancelled = is_cancelled(job_id);
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

/// 文件夹完整性检查（每个子文件夹下全树递归检查模板；并行限流；支持 remote://）
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
    let job_id = resolve_job_id(job_id);

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
        clear_cancel(job_id);
        return result;
    }

    tokio::task::spawn_blocking(move || {
        let result =
            check_folder_integrity_sync(app, job_id, target_folder, templates, name_pattern, output_path);
        clear_cancel(job_id);
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
        if is_cancelled(job_id) {
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
            let expected_name = template.replace("{name}", &extracted_name);
            let (exists, found_path) =
                find_template_in_contents(&contents, &content_paths, &expected_name);
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

    let cancelled = is_cancelled(job_id);
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
    if is_cancelled(job_id) {
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
        let expected_name = template.replace("{name}", &extracted_name);
        let (exists, found_path) =
            find_template_in_contents(&contents, &content_paths, &expected_name);
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
                if is_cancelled(job_id) {
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

    let cancelled = is_cancelled(job_id);
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

/// 扫描文件夹目录树（UI 预览用；默认浅层；支持 remote:// 第一层）
#[tauri::command]
pub async fn scan_folder_tree(
    store: State<'_, Arc<SmbSessionStore>>,
    folder_path: String,
    max_depth: Option<usize>,
) -> Result<FolderTreeResult, String> {
    crate::path_util::validate_user_path(&folder_path)?;
    if crate::path_util::is_remote_path(&folder_path) {
        let (children, files, folders) =
            scan_remote_folder_tree_shallow(store.as_ref(), &folder_path).await?;
        let root_name = folder_path
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or(&folder_path)
            .to_string();
        let child_nodes: Vec<FileTreeNode> = children
            .into_iter()
            .map(|(name, path, is_dir)| FileTreeNode {
                name,
                path,
                is_dir,
                children: Vec::new(),
            })
            .collect();
        return Ok(FolderTreeResult {
            root: FileTreeNode {
                name: root_name,
                path: folder_path,
                is_dir: true,
                children: child_nodes,
            },
            total_files: files,
            total_folders: folders,
            truncated: false,
        });
    }
    tokio::task::spawn_blocking(move || scan_folder_tree_sync(folder_path, max_depth))
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

    // UI preview defaults to 1 level (lazy). Explicit deeper preview allowed up to 8.
    let depth = max_depth.unwrap_or(1).clamp(1, 8);
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
    let job_id = resolve_job_id(job_id);

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
        clear_cancel(job_id);
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
        clear_cancel(job_id);
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
        if is_cancelled(job_id) {
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
        if is_cancelled(job_id) {
            break;
        }
        let matched_folder = bound[i].clone();
        let folder_found = matched_folder.is_some();
        let folder_path = matched_folder
            .as_ref()
            .map(|p| p.to_string_lossy().to_string());
        let mut check_results: Vec<TemplateCheckResult> = Vec::new();
        let mut is_complete = folder_found;

        if let Some(ref matched_path) = matched_folder {
            let key = matched_path.to_string_lossy().to_string();
            if let Some((contents, content_paths)) = cache.get(&key) {
                for template in &templates {
                    let expected_name = template.replace("{name}", name);
                    let (exists, _) =
                        find_template_in_contents(contents, content_paths, &expected_name);
                    if !exists {
                        is_complete = false;
                    }
                    check_results.push(TemplateCheckResult {
                        template: template.clone(),
                        expected_name,
                        exists,
                    });
                }
            } else {
                is_complete = false;
                for template in &templates {
                    check_results.push(TemplateCheckResult {
                        template: template.clone(),
                        expected_name: template.replace("{name}", name),
                        exists: false,
                    });
                }
            }
        } else {
            for template in &templates {
                check_results.push(TemplateCheckResult {
                    template: template.clone(),
                    expected_name: template.replace("{name}", name),
                    exists: false,
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

    let cancelled = is_cancelled(job_id);
    let total_rows = items.len();

    // Annotate export still needs original sheet — reuse local sync writer via blocking re-open
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
    let worksheet = new_workbook.add_worksheet();
    let header_format = Format::new()
        .set_bold()
        .set_background_color(Color::RGB(0xE8E8E8))
        .set_border(FormatBorder::Thin);
    let ok_format = Format::new().set_background_color(Color::RGB(0xD4EDDA));
    let missing_format = Format::new().set_background_color(Color::RGB(0xFF6B6B));
    let not_found_format = Format::new().set_background_color(Color::RGB(0xFFE66D));
    let normal_format = Format::new();
    let original_width = range.width();

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
            for (idx, template) in templates.iter().enumerate() {
                worksheet
                    .write_string_with_format(
                        0,
                        (original_width + idx) as u16,
                        template,
                        &header_format,
                    )
                    .ok();
            }
            worksheet
                .write_string_with_format(
                    0,
                    (original_width + templates.len()) as u16,
                    "Check Result",
                    &header_format,
                )
                .ok();
        } else if let Some(item) = item {
            for (idx, check) in item.check_results.iter().enumerate() {
                let status = if check.exists { "✓" } else { "✗" };
                let format = if check.exists {
                    &ok_format
                } else {
                    &missing_format
                };
                worksheet
                    .write_string_with_format(
                        row_idx as u32,
                        (original_width + idx) as u16,
                        status,
                        format,
                    )
                    .ok();
            }
            let status = if item.is_complete {
                "Complete"
            } else if item.folder_found {
                "Missing Files"
            } else {
                "Folder Not Found"
            };
            worksheet
                .write_string_with_format(
                    row_idx as u32,
                    (original_width + templates.len()) as u16,
                    status,
                    row_format,
                )
                .ok();
        }
    }

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
        if is_cancelled(job_id) {
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
            if is_cancelled(job_id) {
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
    let mut row_to_item: HashMap<usize, usize> = HashMap::new();
    let mut complete_count = 0;
    let mut incomplete_count = 0;
    let mut not_found_count = 0;

    for (i, (row_idx, name)) in names.iter().enumerate() {
        if is_cancelled(job_id) {
            break;
        }
        let matched_folder = bound[i].clone();
        let folder_found = matched_folder.is_some();
        let folder_path = matched_folder
            .as_ref()
            .map(|p| p.to_string_lossy().to_string());

        let mut check_results: Vec<TemplateCheckResult> = Vec::new();
        let mut is_complete = folder_found;

        if let Some(ref matched_path) = matched_folder {
            let key = matched_path.to_string_lossy().to_string();
            if let Some((contents, content_paths)) = cache.get(&key) {
                for template in &templates {
                    let expected_name = template.replace("{name}", name);
                    let (exists, _) =
                        find_template_in_contents(contents, content_paths, &expected_name);
                    if !exists {
                        is_complete = false;
                    }
                    check_results.push(TemplateCheckResult {
                        template: template.clone(),
                        expected_name,
                        exists,
                    });
                }
            } else {
                is_complete = false;
                for template in &templates {
                    check_results.push(TemplateCheckResult {
                        template: template.clone(),
                        expected_name: template.replace("{name}", name),
                        exists: false,
                    });
                }
            }
        } else {
            for template in &templates {
                check_results.push(TemplateCheckResult {
                    template: template.clone(),
                    expected_name: template.replace("{name}", name),
                    exists: false,
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

        row_to_item.insert(*row_idx, items.len());
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

    let cancelled = is_cancelled(job_id);
    let total_rows = items.len();

    let final_output_path = if let Some(out_path) = output_path {
        emit_progress(&app, job_id, "writing", total_rows as u64, total, "");
        let mut new_workbook = Workbook::new();
        let worksheet = new_workbook.add_worksheet();

        let header_format = Format::new()
            .set_bold()
            .set_background_color(Color::RGB(0xE8E8E8))
            .set_border(FormatBorder::Thin);

        let ok_format = Format::new().set_background_color(Color::RGB(0xD4EDDA));
        let missing_format = Format::new().set_background_color(Color::RGB(0xFF6B6B));
        let not_found_format = Format::new().set_background_color(Color::RGB(0xFFE66D));
        let normal_format = Format::new();

        let original_width = range.width();

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
                for (idx, template) in templates.iter().enumerate() {
                    worksheet
                        .write_string_with_format(
                            0,
                            (original_width + idx) as u16,
                            template,
                            &header_format,
                        )
                        .ok();
                }
                worksheet
                    .write_string_with_format(
                        0,
                        (original_width + templates.len()) as u16,
                        "Check Result",
                        &header_format,
                    )
                    .ok();
            } else if let Some(item) = item {
                for (idx, check) in item.check_results.iter().enumerate() {
                    let status = if check.exists { "✓" } else { "✗" };
                    let format = if check.exists {
                        &ok_format
                    } else {
                        &missing_format
                    };
                    worksheet
                        .write_string_with_format(
                            row_idx as u32,
                            (original_width + idx) as u16,
                            status,
                            format,
                        )
                        .ok();
                }

                let status = if item.is_complete {
                    "Complete"
                } else if item.folder_found {
                    "Missing Files"
                } else {
                    "Folder Not Found"
                };
                worksheet
                    .write_string_with_format(
                        row_idx as u32,
                        (original_width + templates.len()) as u16,
                        status,
                        row_format,
                    )
                    .ok();
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
