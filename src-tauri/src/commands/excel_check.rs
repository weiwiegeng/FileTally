use calamine::{Reader, Xlsx, open_workbook, Data};
use rust_xlsxwriter::{Workbook, Format, Color, FormatBorder};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use walkdir::WalkDir;

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

/// 列索引转字母
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

/// 读取 Excel 文件信息
#[tauri::command]
pub async fn read_excel_info(file_path: String, sheet_index: Option<usize>) -> Result<ExcelFileInfo, String> {
    crate::path_util::validate_user_path(&file_path)?;
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
    let sheet_name = sheet_names.get(sheet_idx)
        .ok_or_else(|| crate::err::code("excel_sheet_index_invalid"))?
        .clone();

    let range = workbook.worksheet_range(&sheet_name)
        .map_err(|e| crate::err::with_detail("excel_sheet_read_failed", e))?;

    let mut columns: Vec<ExcelColumnInfo> = Vec::new();
    let row_count = range.height();

    // 获取第一行作为列名
    if let Some(first_row) = range.rows().next() {
        for (idx, cell) in first_row.iter().enumerate() {
            let name = match cell {
                Data::String(s) => s.clone(),
                Data::Int(i) => i.to_string(),
                Data::Float(f) => f.to_string(),
                _ => format!("Column{}", idx + 1),
            };

            // 获取样本值 (最多5个)
            let mut sample_values: Vec<String> = Vec::new();
            for (row_idx, row) in range.rows().enumerate() {
                if row_idx == 0 {
                    continue; // 跳过标题行
                }
                if sample_values.len() >= 5 {
                    break;
                }
                if let Some(cell) = row.get(idx) {
                    let value = match cell {
                        Data::String(s) => s.clone(),
                        Data::Int(i) => i.to_string(),
                        Data::Float(f) => f.to_string(),
                        _ => String::new(),
                    };
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
        row_count: if row_count > 0 { row_count - 1 } else { 0 }, // 减去标题行
    })
}

/// Excel 比对 - 与文件夹匹配
#[tauri::command]
pub async fn match_excel_with_folder(
    excel_path: String,
    sheet_index: usize,
    column_index: usize,
    folder_path: String,
    match_mode: String, // "exact" | "contains" | "starts_with"
    mark_color: String, // "red" | "yellow" | "green"
    output_path: Option<String>,
) -> Result<ExcelMatchResult, String> {
    crate::path_util::validate_user_path(&excel_path)?;
    crate::path_util::validate_user_path(&folder_path)?;
    if let Some(ref out) = output_path {
        crate::path_util::validate_user_path(out)?;
    }
    // 读取 Excel
    let mut workbook: Xlsx<_> = open_workbook(&excel_path)
        .map_err(|e| crate::err::with_detail("excel_open_failed", e))?;

    let sheet_names: Vec<String> = workbook.sheet_names().to_vec();
    let sheet_name = sheet_names.get(sheet_index)
        .ok_or_else(|| crate::err::code("excel_sheet_index_invalid"))?
        .clone();

    let range = workbook.worksheet_range(&sheet_name)
        .map_err(|e| crate::err::with_detail("excel_sheet_read_failed", e))?;

    // 收集文件夹中的文件名
    let mut file_names: HashSet<String> = HashSet::new();
    let mut truncated = false;
    let folder = Path::new(&folder_path);
    
    if folder.exists() {
        // 递归遍历（限深/限量，避免超大目录 OOM）
        let mut count = 0usize;
        for entry in WalkDir::new(&folder_path)
            .follow_links(false)
            .max_depth(16)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if entry.path() == folder {
                continue;
            }
            count += 1;
            if count > 200_000 {
                truncated = true;
                break;
            }
            if let Some(name) = entry.path().file_name() {
                let name_str = name.to_string_lossy().to_string();
                file_names.insert(name_str);
                if let Some(stem) = entry.path().file_stem() {
                    file_names.insert(stem.to_string_lossy().to_string());
                }
            }
        }
    }

    // 执行匹配
    let mut items: Vec<MatchResultItem> = Vec::new();
    let mut matched_count = 0;
    let mut total_rows = 0;

    for (row_idx, row) in range.rows().enumerate() {
        if row_idx == 0 {
            continue; // 跳过标题行
        }
        total_rows += 1;

        let value = row.get(column_index)
            .map(|cell| match cell {
                Data::String(s) => s.clone(),
                Data::Int(i) => i.to_string(),
                Data::Float(f) => f.to_string(),
                _ => String::new(),
            })
            .unwrap_or_default();

        if value.is_empty() {
            items.push(MatchResultItem {
                row_index: row_idx,
                value: value.clone(),
                matched: false,
                matched_file: None,
            });
            continue;
        }

        // 根据匹配模式检查
        let mut matched = false;
        let mut matched_file: Option<String> = None;

        for file_name in &file_names {
            let is_match = match match_mode.as_str() {
                "exact" => {
                    file_name == &value
                        || Path::new(file_name)
                            .file_stem()
                            .and_then(|s| s.to_str())
                            .map(|stem| stem == value)
                            .unwrap_or(false)
                }
                "contains" => file_name.contains(&value),
                "starts_with" => file_name.starts_with(&value),
                _ => file_name.contains(&value),
            };

            if is_match {
                matched = true;
                matched_file = Some(file_name.clone());
                break;
            }
        }

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

    let missing_count = total_rows - matched_count;

    // 如果指定了输出路径，生成带颜色标注的 Excel
    let final_output_path = if let Some(out_path) = output_path {
        // 创建新的 Excel 工作簿
        let mut new_workbook = Workbook::new();
        let worksheet = new_workbook.add_worksheet();

        // 设置标注颜色格式
        let mark_format = Format::new()
            .set_background_color(match mark_color.as_str() {
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

        // 写入数据
        for (row_idx, row) in range.rows().enumerate() {
            let is_header = row_idx == 0;
            let is_missing = if row_idx > 0 {
                items.get(row_idx - 1).map(|item| !item.matched).unwrap_or(false)
            } else {
                false
            };

            for (col_idx, cell) in row.iter().enumerate() {
                let value = match cell {
                    Data::String(s) => s.clone(),
                    Data::Int(i) => i.to_string(),
                    Data::Float(f) => f.to_string(),
                    Data::Bool(b) => b.to_string(),
                    _ => String::new(),
                };

                let format = if is_header {
                    &header_format
                } else if is_missing {
                    &mark_format
                } else {
                    &normal_format
                };

                worksheet.write_string_with_format(row_idx as u32, col_idx as u16, &value, format)
                    .map_err(|e| crate::err::with_detail("excel_write_cell_failed", e))?;
            }

            // 添加匹配状态列
            if is_header {
                worksheet.write_string_with_format(row_idx as u32, range.width() as u16, "Match Status", &header_format)
                    .map_err(|e| crate::err::with_detail("excel_write_cell_failed", e))?;
            } else if row_idx > 0 {
                let status = if items.get(row_idx - 1).map(|item| item.matched).unwrap_or(false) {
                    "Matched"
                } else {
                    "Missing"
                };
                let format = if is_missing { &mark_format } else { &normal_format };
                worksheet.write_string_with_format(row_idx as u32, range.width() as u16, status, format)
                    .map_err(|e| crate::err::with_detail("excel_write_cell_failed", e))?;
            }
        }

        new_workbook.save(&out_path)
            .map_err(|e| crate::err::with_detail("excel_save_failed", e))?;

        Some(out_path)
    } else {
        None
    };

    Ok(ExcelMatchResult {
        total_rows,
        matched_count,
        missing_count,
        items,
        output_path: final_output_path,
        truncated,
    })
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

/// 判断是否为 CJK 统一汉字
fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0xF900..=0xFAFF
    )
}

/// 从文件夹名提取姓名
fn extract_name_from_folder(folder_name: &str, pattern: &str) -> String {
    // 常见模式: "2025-0001王宏琳" -> "王宏琳"
    if pattern == "auto" || pattern.is_empty() {
        // 自动提取：取最后一段连续 CJK 字符
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
        // 限制正则长度，降低 ReDoS 风险
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

/// 模板内容是否匹配期望名（精确或「文件名 stem」）
fn template_content_matches(content: &str, expected_name: &str) -> bool {
    if content == expected_name {
        return true;
    }
    // 期望名无扩展名时，允许 content 的 stem 精确等于期望名
    if !expected_name.contains('.') {
        if let Some(stem) = Path::new(content).file_stem().and_then(|s| s.to_str()) {
            return stem == expected_name;
        }
    }
    false
}

/// 文件夹完整性检查
#[tauri::command]
pub async fn check_folder_integrity(
    target_folder: String,
    templates: Vec<String>, // 如 ["{name}.docx", "{name}照片", "委托书.pdf"]
    name_pattern: String, // 提取姓名的模式，"auto" 为自动提取
    output_path: Option<String>,
) -> Result<BatchIntegrityResult, String> {
    crate::path_util::validate_user_path(&target_folder)?;
    if let Some(ref out) = output_path {
        crate::path_util::validate_user_path(out)?;
    }
    let folder = Path::new(&target_folder);
    if !folder.exists() {
        return Err(crate::err::code("target_folder_missing"));
    }

    const INTEGRITY_FOLDER_CAP: usize = 50_000;
    let mut results: Vec<FolderIntegrityResult> = Vec::new();
    let mut complete_count = 0;
    let mut truncated = false;

    // 遍历子文件夹
    for entry in fs::read_dir(&folder).map_err(|e| crate::err::with_detail("read_dir_failed", e))? {
        let entry = entry.map_err(|e| crate::err::with_detail("read_dir_failed", e))?;
        let path = entry.path();
        
        if !path.is_dir() {
            continue;
        }
        if results.len() >= INTEGRITY_FOLDER_CAP {
            truncated = true;
            break;
        }

        let folder_name = path.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        // 提取姓名
        let extracted_name = extract_name_from_folder(&folder_name, &name_pattern);

        // 收集本层 + 一层子目录中的文件名（模板常落在子文件夹）
        let mut contents: HashSet<String> = HashSet::new();
        let mut content_paths: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        let mut collect_entry = |entry_path: &Path| {
            if let Some(name) = entry_path.file_name().map(|n| n.to_string_lossy().to_string()) {
                contents.insert(name.clone());
                content_paths.entry(name).or_insert_with(|| entry_path.to_string_lossy().to_string());
                if let Some(stem) = entry_path.file_stem().map(|s| s.to_string_lossy().to_string()) {
                    contents.insert(stem.clone());
                    content_paths.entry(stem).or_insert_with(|| entry_path.to_string_lossy().to_string());
                }
            }
        };
        for item in fs::read_dir(&path).map_err(|e| crate::err::with_detail("read_dir_failed", e))? {
            let item = item.map_err(|e| crate::err::with_detail("read_dir_failed", e))?;
            let item_path = item.path();
            collect_entry(&item_path);
            if item_path.is_dir() {
                if let Ok(nested) = fs::read_dir(&item_path) {
                    for nested_item in nested.flatten() {
                        collect_entry(&nested_item.path());
                    }
                }
            }
        }

        // 检查每个模板
        let mut check_items: Vec<IntegrityCheckItem> = Vec::new();
        let mut is_complete = true;

        for template in &templates {
            let expected_name = template.replace("{name}", &extracted_name);
            
            // 检查是否存在
            let mut exists = false;
            let mut found_path: Option<String> = None;

            for content in &contents {
                if template_content_matches(content, &expected_name) {
                    exists = true;
                    found_path = content_paths.get(content).cloned().or_else(|| {
                        let candidate = path.join(content);
                        Some(candidate.to_string_lossy().to_string())
                    });
                    break;
                }
            }

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
            folder_path: path.to_string_lossy().to_string(),
            folder_name,
            extracted_name,
            is_complete,
            check_items,
        });
    }

    let total_folders = results.len();
    let incomplete_count = total_folders - complete_count;

    // 如果指定了输出路径，生成报告 Excel
    let final_output_path = if let Some(out_path) = output_path {
        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();

        let header_format = Format::new()
            .set_bold()
            .set_background_color(Color::RGB(0xE8E8E8))
            .set_border(FormatBorder::Thin);

        let ok_format = Format::new()
            .set_background_color(Color::RGB(0xD4EDDA));

        let missing_format = Format::new()
            .set_background_color(Color::RGB(0xFF6B6B));

        // 写入标题
        worksheet.write_string_with_format(0, 0, "Folder", &header_format).ok();
        worksheet.write_string_with_format(0, 1, "Name", &header_format).ok();
        
        for (idx, template) in templates.iter().enumerate() {
            worksheet.write_string_with_format(0, (idx + 2) as u16, template, &header_format).ok();
        }
        worksheet.write_string_with_format(0, (templates.len() + 2) as u16, "Status", &header_format).ok();

        // 写入数据
        for (row_idx, result) in results.iter().enumerate() {
            let row = (row_idx + 1) as u32;
            
            let row_format = if result.is_complete { &ok_format } else { &missing_format };
            
            worksheet.write_string_with_format(row, 0, &result.folder_name, row_format).ok();
            worksheet.write_string_with_format(row, 1, &result.extracted_name, row_format).ok();

            for (col_idx, item) in result.check_items.iter().enumerate() {
                let status = if item.exists { "✓" } else { "✗" };
                let format = if item.exists { &ok_format } else { &missing_format };
                worksheet.write_string_with_format(row, (col_idx + 2) as u16, status, format).ok();
            }

            let status = if result.is_complete { "Complete" } else { "Missing" };
            worksheet.write_string_with_format(row, (templates.len() + 2) as u16, status, row_format).ok();
        }

        workbook.save(&out_path)
            .map_err(|e| crate::err::with_detail("excel_save_failed", e))?;

        Some(out_path)
    } else {
        None
    };

    Ok(BatchIntegrityResult {
        total_folders,
        complete_count,
        incomplete_count,
        results,
        output_path: final_output_path,
        truncated,
    })
}

/// 扫描文件夹目录树
#[tauri::command]
pub async fn scan_folder_tree(folder_path: String, max_depth: Option<usize>) -> Result<FolderTreeResult, String> {
    crate::path_util::validate_user_path(&folder_path)?;
    let folder = Path::new(&folder_path);
    if !folder.exists() {
        return Err(crate::err::code("folder_not_found"));
    }

    // null/None → 16 层（平衡完整性与性能），显式传入时上限 32
    let depth = max_depth.unwrap_or(16).clamp(1, 32);
    let mut total_files = 0;
    let mut total_folders = 0;
    const TREE_ENTRY_CAP: usize = 50_000;

    fn build_tree(
        path: &Path,
        current_depth: usize,
        max_depth: usize,
        total_files: &mut usize,
        total_folders: &mut usize,
        truncated: &mut bool,
        entry_cap: usize,
    ) -> FileTreeNode {
        let name = path.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string_lossy().to_string());
        
        let is_dir = path.is_dir();
        let mut children = Vec::new();

        if is_dir {
            *total_folders += 1;
            if *truncated {
                // Cap already hit higher up — keep node stub without walking further.
            } else if current_depth < max_depth {
                if let Ok(entries) = fs::read_dir(path) {
                    let mut entries_vec: Vec<_> = entries.filter_map(|e| e.ok()).collect();
                    // 排序：文件夹在前，文件在后
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
            } else if fs::read_dir(path).map(|mut e| e.next().is_some()).unwrap_or(false) {
                *truncated = true;
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
        TREE_ENTRY_CAP,
    );

    Ok(FolderTreeResult {
        root,
        total_files,
        total_folders,
        truncated,
    })
}

/// 基于 Excel 的完整性检查（在原 Excel 上标注结果）
#[tauri::command]
pub async fn check_integrity_with_excel(
    excel_path: String,
    sheet_index: usize,
    name_column_index: usize,  // 姓名列索引
    target_folder: String,     // 目标文件夹
    templates: Vec<String>,    // 模板列表
    folder_match_mode: String, // 文件夹匹配模式: "exact" | "contains" | "starts_with"
    output_path: Option<String>,
) -> Result<ExcelIntegrityResult, String> {
    crate::path_util::validate_user_path(&excel_path)?;
    crate::path_util::validate_user_path(&target_folder)?;
    if let Some(ref out) = output_path {
        crate::path_util::validate_user_path(out)?;
    }
    // 读取 Excel
    let mut workbook: Xlsx<_> = open_workbook(&excel_path)
        .map_err(|e| crate::err::with_detail("excel_open_failed", e))?;

    let sheet_names: Vec<String> = workbook.sheet_names().to_vec();
    let sheet_name = sheet_names.get(sheet_index)
        .ok_or_else(|| crate::err::code("excel_sheet_index_invalid"))?
        .clone();

    let range = workbook.worksheet_range(&sheet_name)
        .map_err(|e| crate::err::with_detail("excel_sheet_read_failed", e))?;

    // 检查目标文件夹是否存在
    let folder = Path::new(&target_folder);
    if !folder.exists() {
        return Err(crate::err::code("target_folder_missing"));
    }

    // 收集所有子文件夹（完整名 + 提取名分别索引，冲突时优先保留完整文件夹名）
    let mut folders_by_full_name: std::collections::HashMap<String, std::path::PathBuf> =
        std::collections::HashMap::new();
    let mut folders_by_extracted: std::collections::HashMap<String, Vec<std::path::PathBuf>> =
        std::collections::HashMap::new();
    for entry in fs::read_dir(&folder).map_err(|e| crate::err::with_detail("read_dir_failed", e))? {
        let entry = entry.map_err(|e| crate::err::with_detail("read_dir_failed", e))?;
        let path = entry.path();
        if path.is_dir() {
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
    }

    let mut items: Vec<ExcelIntegrityItem> = Vec::new();
    // excel_row -> item index（用于导出对齐；空姓名行不入 items）
    let mut row_to_item: std::collections::HashMap<usize, usize> = std::collections::HashMap::new();
    let mut complete_count = 0;
    let mut incomplete_count = 0;
    let mut not_found_count = 0;
    let mut processed_rows = 0;
    let mut truncated = false;
    const INTEGRITY_ROW_CAP: usize = 50_000;

    // 遍历 Excel 行（跳过标题行）
    for (row_idx, row) in range.rows().enumerate() {
        if row_idx == 0 {
            continue; // 跳过标题行
        }

        // 获取姓名列的值
        let name = row.get(name_column_index)
            .map(|cell| match cell {
                Data::String(s) => s.clone(),
                Data::Int(i) => i.to_string(),
                Data::Float(f) => f.to_string(),
                _ => String::new(),
            })
            .unwrap_or_default();

        if name.trim().is_empty() {
            continue;
        }
        if processed_rows >= INTEGRITY_ROW_CAP {
            truncated = true;
            break;
        }
        processed_rows += 1;

        // 查找匹配的文件夹：先完整名，再提取名；exact 模式下不模糊
        let mut matched_folder: Option<std::path::PathBuf> = None;

        if let Some(path) = folders_by_full_name.get(&name) {
            matched_folder = Some(path.clone());
        } else {
            match folder_match_mode.as_str() {
                "exact" => {
                    // 提取名冲突时宁可不匹配，避免错绑文件夹
                    if let Some(paths) = folders_by_extracted.get(&name) {
                        if paths.len() == 1 {
                            matched_folder = Some(paths[0].clone());
                        }
                    }
                }
                "starts_with" => {
                    // 仅在唯一命中时绑定，避免模糊匹配绑错文件夹
                    let full_hits: Vec<_> = folders_by_full_name
                        .iter()
                        .filter(|(folder_name, _)| folder_name.starts_with(&name))
                        .map(|(_, path)| path.clone())
                        .collect();
                    if full_hits.len() == 1 {
                        matched_folder = Some(full_hits[0].clone());
                    } else if full_hits.is_empty() {
                        let mut extracted_hits = Vec::new();
                        for (extracted, paths) in &folders_by_extracted {
                            if extracted.starts_with(&name) {
                                extracted_hits.extend(paths.iter().cloned());
                            }
                        }
                        if extracted_hits.len() == 1 {
                            matched_folder = Some(extracted_hits[0].clone());
                        }
                    }
                }
                _ => {
                    let full_hits: Vec<_> = folders_by_full_name
                        .iter()
                        .filter(|(folder_name, _)| folder_name.contains(&name))
                        .map(|(_, path)| path.clone())
                        .collect();
                    if full_hits.len() == 1 {
                        matched_folder = Some(full_hits[0].clone());
                    } else if full_hits.is_empty() {
                        let mut extracted_hits = Vec::new();
                        for (extracted, paths) in &folders_by_extracted {
                            if extracted.contains(&name) {
                                extracted_hits.extend(paths.iter().cloned());
                            }
                        }
                        if extracted_hits.len() == 1 {
                            matched_folder = Some(extracted_hits[0].clone());
                        }
                    }
                }
            }
        }

        let folder_found = matched_folder.is_some();
        let folder_path = matched_folder.as_ref().map(|p| p.to_string_lossy().to_string());

        // 检查模板文件是否存在
        let mut check_results: Vec<TemplateCheckResult> = Vec::new();
        let mut is_complete = folder_found;

        if let Some(ref matched_path) = matched_folder {
            // 本层 + 一层子目录
            let mut contents: HashSet<String> = HashSet::new();
            let mut collect_entry = |entry_path: &Path| {
                if let Some(name) = entry_path.file_name().map(|n| n.to_string_lossy().to_string()) {
                    contents.insert(name);
                    if let Some(stem) = entry_path.file_stem().map(|s| s.to_string_lossy().to_string()) {
                        contents.insert(stem);
                    }
                }
            };
            if let Ok(entries) = fs::read_dir(matched_path) {
                for item in entries.flatten() {
                    let item_path = item.path();
                    collect_entry(&item_path);
                    if item_path.is_dir() {
                        if let Ok(nested) = fs::read_dir(&item_path) {
                            for nested_item in nested.flatten() {
                                collect_entry(&nested_item.path());
                            }
                        }
                    }
                }
            }

            // 检查每个模板
            for template in &templates {
                let expected_name = template.replace("{name}", &name);
                let mut exists = false;

                for content in &contents {
                    if template_content_matches(content, &expected_name) {
                        exists = true;
                        break;
                    }
                }

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
            // 文件夹未找到，所有模板都标记为不存在
            for template in &templates {
                check_results.push(TemplateCheckResult {
                    template: template.clone(),
                    expected_name: template.replace("{name}", &name),
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

        row_to_item.insert(row_idx, items.len());
        items.push(ExcelIntegrityItem {
            row_index: row_idx,
            name: name.clone(),
            folder_found,
            folder_path,
            is_complete,
            check_results,
        });
    }

    let total_rows = processed_rows;

    // 如果指定了输出路径，在原 Excel 基础上标注
    let final_output_path = if let Some(out_path) = output_path {
        let mut new_workbook = Workbook::new();
        let worksheet = new_workbook.add_worksheet();

        // 定义格式
        let header_format = Format::new()
            .set_bold()
            .set_background_color(Color::RGB(0xE8E8E8))
            .set_border(FormatBorder::Thin);

        let ok_format = Format::new()
            .set_background_color(Color::RGB(0xD4EDDA));

        let missing_format = Format::new()
            .set_background_color(Color::RGB(0xFF6B6B));

        let not_found_format = Format::new()
            .set_background_color(Color::RGB(0xFFE66D));

        let normal_format = Format::new();

        // 写入原始数据 + 新增的检查结果列
        let original_width = range.width();

        for (row_idx, row) in range.rows().enumerate() {
            let is_header = row_idx == 0;
            
            // 按 Excel 原始行号对齐检查结果（跳过空姓名行）
            let item = if row_idx > 0 {
                row_to_item.get(&row_idx).and_then(|idx| items.get(*idx))
            } else {
                None
            };

            // 确定行格式
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

            // 写入原始列
            for (col_idx, cell) in row.iter().enumerate() {
                let value = match cell {
                    Data::String(s) => s.clone(),
                    Data::Int(i) => i.to_string(),
                    Data::Float(f) => f.to_string(),
                    Data::Bool(b) => b.to_string(),
                    _ => String::new(),
                };
                worksheet.write_string_with_format(row_idx as u32, col_idx as u16, &value, row_format)
                    .map_err(|e| crate::err::with_detail("excel_write_cell_failed", e))?;
            }

            // 写入检查结果列
            if is_header {
                // 写入模板列标题
                for (idx, template) in templates.iter().enumerate() {
                    worksheet.write_string_with_format(
                        0, 
                        (original_width + idx) as u16, 
                        template, 
                        &header_format
                    ).ok();
                }
                // 写入状态列标题
                worksheet.write_string_with_format(
                    0, 
                    (original_width + templates.len()) as u16, 
                    "Check Result", 
                    &header_format
                ).ok();
            } else if let Some(item) = item {
                // 写入每个模板的检查结果
                for (idx, check) in item.check_results.iter().enumerate() {
                    let status = if check.exists { "✓" } else { "✗" };
                    let format = if check.exists { &ok_format } else { &missing_format };
                    worksheet.write_string_with_format(
                        row_idx as u32, 
                        (original_width + idx) as u16, 
                        status, 
                        format
                    ).ok();
                }

                // 写入总状态
                let status = if item.is_complete {
                    "Complete"
                } else if item.folder_found {
                    "Missing Files"
                } else {
                    "Folder Not Found"
                };
                worksheet.write_string_with_format(
                    row_idx as u32, 
                    (original_width + templates.len()) as u16, 
                    status, 
                    row_format
                ).ok();
            }
        }

        new_workbook.save(&out_path)
            .map_err(|e| crate::err::with_detail("excel_save_failed", e))?;

        Some(out_path)
    } else {
        None
    };

    Ok(ExcelIntegrityResult {
        total_rows,
        complete_count,
        incomplete_count,
        not_found_count,
        items,
        output_path: final_output_path,
        truncated,
    })
}
