use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

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
    pub errors: Vec<String>,
}

/// 传输进度事件
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub current_file: String,
    pub current_index: u64,
    pub total_files: u64,
    pub stage: String,  // "counting" | "transferring"
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

/// 获取路径信息（文件或文件夹）
#[tauri::command]
pub async fn get_path_info(path: String) -> Result<PathInfo, String> {
    let p = Path::new(&path);
    
    if !p.exists() {
        return Err("路径不存在".to_string());
    }
    
    let name = p.file_name()
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
pub async fn list_folder_contents(path: String) -> Result<Vec<PathInfo>, String> {
    let dir_path = Path::new(&path);
    
    if !dir_path.exists() {
        return Err("路径不存在".to_string());
    }
    
    if !dir_path.is_dir() {
        return Err("路径不是文件夹".to_string());
    }
    
    let mut items = Vec::new();
    
    if let Ok(entries) = fs::read_dir(dir_path) {
        for entry in entries.flatten() {
            let entry_path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry_path.is_dir();
            let size = if is_dir {
                calculate_dir_size(&entry_path)
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
    
    // 排序：文件夹在前，然后按名称排序
    items.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });
    
    Ok(items)
}

/// 格式化文件大小
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
    source_paths: Vec<String>,
    target_path: String,
) -> Result<CheckConflictsResponse, String> {
    let target_dir = Path::new(&target_path);
    
    if !target_dir.exists() {
        return Err("目标目录不存在".to_string());
    }
    
    if !target_dir.is_dir() {
        return Err("目标路径不是目录".to_string());
    }
    
    let mut conflicts = Vec::new();
    
    for source_path in &source_paths {
        let source = Path::new(source_path);
        
        if !source.exists() {
            continue;
        }
        
        let file_name = source.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();
        
        let target_file_path = target_dir.join(&file_name);
        
        // 检查目标是否已存在
        if target_file_path.exists() {
            let source_size = if source.is_file() {
                fs::metadata(source).map(|m| m.len()).unwrap_or(0)
            } else {
                // 文件夹大小计算（简化版，只计算一级）
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

/// 计算目录大小
fn calculate_dir_size(path: &Path) -> u64 {
    let mut size = 0;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let entry_path = entry.path();
            if entry_path.is_file() {
                size += fs::metadata(&entry_path).map(|m| m.len()).unwrap_or(0);
            } else if entry_path.is_dir() {
                size += calculate_dir_size(&entry_path);
            }
        }
    }
    size
}

/// 执行文件传输
#[tauri::command]
pub async fn transfer_files(
    app: AppHandle,
    source_paths: Vec<String>,
    target_path: String,
    conflict_resolution: String,
) -> Result<TransferResult, String> {
    let target_dir = Path::new(&target_path);
    
    if !target_dir.exists() {
        return Err("目标目录不存在".to_string());
    }
    
    // 第一阶段：统计总文件数
    let _ = app.emit("transfer-progress", TransferProgress {
        current_file: String::new(),
        current_index: 0,
        total_files: 0,
        stage: "counting".to_string(),
        message: "正在统计文件数量...".to_string(),
    });
    
    let mut total_files: u64 = 0;
    for source_path in &source_paths {
        let source = Path::new(source_path);
        if source.exists() {
            if source.is_file() {
                total_files += 1;
            } else {
                total_files += count_files_in_dir(source);
            }
        }
    }
    
    let mut transferred = 0;
    let mut skipped = 0;
    let mut failed = 0;
    let mut errors = Vec::new();
    let processed = Arc::new(AtomicU64::new(0));
    
    for source_path in &source_paths {
        let source = Path::new(source_path);
        
        if !source.exists() {
            errors.push(format!("源文件不存在: {}", source_path));
            failed += 1;
            continue;
        }
        
        let file_name = source.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();
        
        let mut target_file_path = target_dir.join(&file_name);
        
        // 处理冲突
        if target_file_path.exists() {
            match conflict_resolution.as_str() {
                "skip" => {
                    skipped += 1;
                    continue;
                }
                "rename" => {
                    target_file_path = generate_unique_name(&target_file_path);
                }
                "overwrite" => {
                    // 先删除目标
                    if target_file_path.is_dir() {
                        if let Err(e) = fs::remove_dir_all(&target_file_path) {
                            errors.push(format!("删除目标文件夹失败: {} - {}", target_file_path.display(), e));
                            failed += 1;
                            continue;
                        }
                    } else if let Err(e) = fs::remove_file(&target_file_path) {
                        errors.push(format!("删除目标文件失败: {} - {}", target_file_path.display(), e));
                        failed += 1;
                        continue;
                    }
                }
                _ => {}
            }
        }
        
        // 发送进度
        let current = processed.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = app.emit("transfer-progress", TransferProgress {
            current_file: file_name.clone(),
            current_index: current,
            total_files,
            stage: "transferring".to_string(),
            message: format!("正在复制: {}", file_name),
        });
        
        // 执行复制
        let result = if source.is_file() {
            fs::copy(source, &target_file_path).map(|_| ())
        } else {
            copy_dir_recursive_with_progress(source, &target_file_path, &app, &processed, total_files)
        };
        
        match result {
            Ok(_) => transferred += 1,
            Err(e) => {
                errors.push(format!("复制失败: {} -> {} - {}", source_path, target_file_path.display(), e));
                failed += 1;
            }
        }
    }
    
    Ok(TransferResult {
        success: failed == 0,
        transferred,
        skipped,
        failed,
        errors,
    })
}

/// 统计目录中的文件数量
fn count_files_in_dir(path: &Path) -> u64 {
    let mut count = 0;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let entry_path = entry.path();
            if entry_path.is_file() {
                count += 1;
            } else if entry_path.is_dir() {
                count += count_files_in_dir(&entry_path);
            }
        }
    }
    count
}

/// 生成唯一文件名（添加数字后缀）
fn generate_unique_name(path: &Path) -> std::path::PathBuf {
    let parent = path.parent().unwrap_or(Path::new(""));
    let stem = path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("file");
    let extension = path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    
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
        
        // 防止无限循环，使用时间戳
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

/// 递归复制目录
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path)?;
        }
    }
    
    Ok(())
}

/// 递归复制目录（带进度回调）
fn copy_dir_recursive_with_progress(
    src: &Path,
    dst: &Path,
    app: &AppHandle,
    processed: &Arc<AtomicU64>,
    total_files: u64,
) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        
        if src_path.is_dir() {
            copy_dir_recursive_with_progress(&src_path, &dst_path, app, processed, total_files)?;
        } else {
            // 复制文件并发送进度
            let current = processed.fetch_add(1, Ordering::SeqCst) + 1;
            let file_name = src_path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("unknown")
                .to_string();
            
            let _ = app.emit("transfer-progress", TransferProgress {
                current_file: file_name.clone(),
                current_index: current,
                total_files,
                stage: "transferring".to_string(),
                message: format!("正在复制: {}", file_name),
            });
            
            fs::copy(&src_path, &dst_path)?;
        }
    }
    
    Ok(())
}
