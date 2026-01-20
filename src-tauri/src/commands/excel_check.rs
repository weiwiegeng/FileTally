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
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err("文件不存在".to_string());
    }

    let mut workbook: Xlsx<_> = open_workbook(&file_path)
        .map_err(|e| format!("无法打开 Excel 文件: {}", e))?;

    let sheet_names: Vec<String> = workbook.sheet_names().to_vec();
    
    if sheet_names.is_empty() {
        return Err("Excel 文件没有工作表".to_string());
    }

    let sheet_idx = sheet_index.unwrap_or(0);
    let sheet_name = sheet_names.get(sheet_idx)
        .ok_or("工作表索引无效")?
        .clone();

    let range = workbook.worksheet_range(&sheet_name)
        .map_err(|e| format!("无法读取工作表: {}", e))?;

    let mut columns: Vec<ExcelColumnInfo> = Vec::new();
    let row_count = range.height();

    // 获取第一行作为列名
    if let Some(first_row) = range.rows().next() {
        for (idx, cell) in first_row.iter().enumerate() {
            let name = match cell {
                Data::String(s) => s.clone(),
                Data::Int(i) => i.to_string(),
                Data::Float(f) => f.to_string(),
                _ => format!("列{}", idx + 1),
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
    // 读取 Excel
    let mut workbook: Xlsx<_> = open_workbook(&excel_path)
        .map_err(|e| format!("无法打开 Excel 文件: {}", e))?;

    let sheet_names: Vec<String> = workbook.sheet_names().to_vec();
    let sheet_name = sheet_names.get(sheet_index)
        .ok_or("工作表索引无效")?
        .clone();

    let range = workbook.worksheet_range(&sheet_name)
        .map_err(|e| format!("无法读取工作表: {}", e))?;

    // 收集文件夹中的文件名
    let mut file_names: HashSet<String> = HashSet::new();
    let folder = Path::new(&folder_path);
    
    if folder.exists() {
        // 递归遍历所有子文件夹中的文件
        for entry in WalkDir::new(&folder_path).into_iter().filter_map(|e| e.ok()) {
            if entry.path() != folder {
                if let Some(name) = entry.path().file_name() {
                    let name_str = name.to_string_lossy().to_string();
                    file_names.insert(name_str.clone());
                    // 也添加不带扩展名的版本
                    if let Some(stem) = entry.path().file_stem() {
                        file_names.insert(stem.to_string_lossy().to_string());
                    }
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
                "exact" => file_name == &value || file_name.contains(&value),
                "contains" => file_name.contains(&value) || value.contains(file_name),
                "starts_with" => file_name.starts_with(&value) || value.starts_with(file_name),
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
                    .map_err(|e| format!("写入单元格失败: {}", e))?;
            }

            // 添加匹配状态列
            if is_header {
                worksheet.write_string_with_format(row_idx as u32, range.width() as u16, "匹配状态", &header_format)
                    .map_err(|e| format!("写入单元格失败: {}", e))?;
            } else if row_idx > 0 {
                let status = if items.get(row_idx - 1).map(|item| item.matched).unwrap_or(false) {
                    "✓ 已匹配"
                } else {
                    "✗ 缺失"
                };
                let format = if is_missing { &mark_format } else { &normal_format };
                worksheet.write_string_with_format(row_idx as u32, range.width() as u16, status, format)
                    .map_err(|e| format!("写入单元格失败: {}", e))?;
            }
        }

        new_workbook.save(&out_path)
            .map_err(|e| format!("保存 Excel 失败: {}", e))?;

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
    })
}

/// 从文件夹名提取姓名
fn extract_name_from_folder(folder_name: &str, pattern: &str) -> String {
    // 常见模式: "2025-0001王宏琳" -> "王宏琳"
    // 尝试提取中文部分
    if pattern == "auto" || pattern.is_empty() {
        // 自动提取：找到最后的中文字符序列
        let chars: Vec<char> = folder_name.chars().collect();
        let mut name_start = None;
        
        for (i, c) in chars.iter().enumerate() {
            if c.is_alphabetic() && *c as u32 > 127 {
                // 中文字符
                if name_start.is_none() {
                    name_start = Some(i);
                }
            }
        }
        
        if let Some(start) = name_start {
            return chars[start..].iter().collect();
        }
        
        // 如果没有中文，返回原名
        folder_name.to_string()
    } else {
        // 使用正则表达式模式
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

/// 文件夹完整性检查
#[tauri::command]
pub async fn check_folder_integrity(
    target_folder: String,
    templates: Vec<String>, // 如 ["{name}.docx", "{name}照片", "委托书.pdf"]
    name_pattern: String, // 提取姓名的模式，"auto" 为自动提取
    output_path: Option<String>,
) -> Result<BatchIntegrityResult, String> {
    let folder = Path::new(&target_folder);
    if !folder.exists() {
        return Err("目标文件夹不存在".to_string());
    }

    let mut results: Vec<FolderIntegrityResult> = Vec::new();
    let mut complete_count = 0;

    // 遍历子文件夹
    for entry in fs::read_dir(&folder).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        
        if !path.is_dir() {
            continue;
        }

        let folder_name = path.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        // 提取姓名
        let extracted_name = extract_name_from_folder(&folder_name, &name_pattern);

        // 获取文件夹内的所有文件和子文件夹
        let mut contents: HashSet<String> = HashSet::new();
        for item in fs::read_dir(&path).map_err(|e| e.to_string())? {
            if let Ok(item) = item {
                if let Some(name) = item.path().file_name() {
                    contents.insert(name.to_string_lossy().to_string());
                    // 也添加不带扩展名的版本
                    if let Some(stem) = item.path().file_stem() {
                        contents.insert(stem.to_string_lossy().to_string());
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
                if content == &expected_name || content.starts_with(&expected_name) {
                    exists = true;
                    found_path = Some(path.join(content).to_string_lossy().to_string());
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
        worksheet.write_string_with_format(0, 0, "文件夹", &header_format).ok();
        worksheet.write_string_with_format(0, 1, "姓名", &header_format).ok();
        
        for (idx, template) in templates.iter().enumerate() {
            worksheet.write_string_with_format(0, (idx + 2) as u16, template, &header_format).ok();
        }
        worksheet.write_string_with_format(0, (templates.len() + 2) as u16, "状态", &header_format).ok();

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

            let status = if result.is_complete { "完整" } else { "缺失" };
            worksheet.write_string_with_format(row, (templates.len() + 2) as u16, status, row_format).ok();
        }

        workbook.save(&out_path)
            .map_err(|e| format!("保存 Excel 失败: {}", e))?;

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
    })
}

/// 扫描文件夹目录树
#[tauri::command]
pub async fn scan_folder_tree(folder_path: String, max_depth: Option<usize>) -> Result<FolderTreeResult, String> {
    let folder = Path::new(&folder_path);
    if !folder.exists() {
        return Err("文件夹不存在".to_string());
    }

    let depth = max_depth.unwrap_or(usize::MAX); // 默认不限制层数
    let mut total_files = 0;
    let mut total_folders = 0;

    fn build_tree(path: &Path, current_depth: usize, max_depth: usize, total_files: &mut usize, total_folders: &mut usize) -> FileTreeNode {
        let name = path.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string_lossy().to_string());
        
        let is_dir = path.is_dir();
        let mut children = Vec::new();

        if is_dir {
            *total_folders += 1;
            if current_depth < max_depth {
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
                        let child = build_tree(&entry.path(), current_depth + 1, max_depth, total_files, total_folders);
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

    let root = build_tree(folder, 0, depth, &mut total_files, &mut total_folders);

    Ok(FolderTreeResult {
        root,
        total_files,
        total_folders,
    })
}
