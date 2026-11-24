use crate::models::{FileMetadata, FileNode, FilePreviewInfo};
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

/// Generate a unique ID for file node
fn generate_id(path: &Path) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    
    let mut hasher = DefaultHasher::new();
    path.to_string_lossy().hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

/// 自然排序比较函数，支持数字按数值排序
/// 例如: "file1" < "file2" < "file10" (而不是 "file1" < "file10" < "file2")
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    
    let a_chars: Vec<char> = a.chars().collect();
    let b_chars: Vec<char> = b.chars().collect();
    let mut i = 0;
    let mut j = 0;
    
    while i < a_chars.len() && j < b_chars.len() {
        let a_is_digit = a_chars[i].is_ascii_digit();
        let b_is_digit = b_chars[j].is_ascii_digit();
        
        match (a_is_digit, b_is_digit) {
            (true, true) => {
                // 提取数字
                let mut a_num = 0u64;
                while i < a_chars.len() && a_chars[i].is_ascii_digit() {
                    a_num = a_num * 10 + a_chars[i].to_digit(10).unwrap() as u64;
                    i += 1;
                }
                let mut b_num = 0u64;
                while j < b_chars.len() && b_chars[j].is_ascii_digit() {
                    b_num = b_num * 10 + b_chars[j].to_digit(10).unwrap() as u64;
                    j += 1;
                }
                match a_num.cmp(&b_num) {
                    Ordering::Equal => continue,
                    other => return other,
                }
            }
            (true, false) => return Ordering::Less,
            (false, true) => return Ordering::Greater,
            (false, false) => {
                // 比较字符（忽略大小写）
                let a_lower = a_chars[i].to_lowercase().next().unwrap_or(a_chars[i]);
                let b_lower = b_chars[j].to_lowercase().next().unwrap_or(b_chars[j]);
                match a_lower.cmp(&b_lower) {
                    Ordering::Equal => {
                        i += 1;
                        j += 1;
                        continue;
                    }
                    other => return other,
                }
            }
        }
    }
    
    // 比较剩余长度
    a_chars.len().cmp(&b_chars.len())
}

/// Format file size for display
fn format_size(size: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = KB * 1024;
    const GB: u64 = MB * 1024;
    const TB: u64 = GB * 1024;

    if size >= TB {
        format!("{:.2} TB", size as f64 / TB as f64)
    } else if size >= GB {
        format!("{:.2} GB", size as f64 / GB as f64)
    } else if size >= MB {
        format!("{:.2} MB", size as f64 / MB as f64)
    } else if size >= KB {
        format!("{:.2} KB", size as f64 / KB as f64)
    } else {
        format!("{} B", size)
    }
}

/// Get MIME type from extension
fn get_mime_type(extension: &str) -> String {
    match extension.to_lowercase().as_str() {
        // Images
        "jpg" | "jpeg" => "image/jpeg".to_string(),
        "png" => "image/png".to_string(),
        "gif" => "image/gif".to_string(),
        "webp" => "image/webp".to_string(),
        "svg" => "image/svg+xml".to_string(),
        "bmp" => "image/bmp".to_string(),
        // Documents
        "pdf" => "application/pdf".to_string(),
        "doc" | "docx" => "application/msword".to_string(),
        "xls" | "xlsx" => "application/vnd.ms-excel".to_string(),
        "ppt" | "pptx" => "application/vnd.ms-powerpoint".to_string(),
        // Text
        "txt" => "text/plain".to_string(),
        "md" => "text/markdown".to_string(),
        "json" => "application/json".to_string(),
        "xml" => "application/xml".to_string(),
        "html" | "htm" => "text/html".to_string(),
        "css" => "text/css".to_string(),
        // Code
        "js" => "application/javascript".to_string(),
        "ts" => "application/typescript".to_string(),
        "py" => "text/x-python".to_string(),
        "rs" => "text/x-rust".to_string(),
        "go" => "text/x-go".to_string(),
        "java" => "text/x-java".to_string(),
        "c" | "cpp" | "h" | "hpp" => "text/x-c".to_string(),
        // Media
        "mp3" => "audio/mpeg".to_string(),
        "wav" => "audio/wav".to_string(),
        "mp4" => "video/mp4".to_string(),
        "webm" => "video/webm".to_string(),
        "mov" => "video/quicktime".to_string(),
        // Archives
        "zip" => "application/zip".to_string(),
        "rar" => "application/x-rar-compressed".to_string(),
        "7z" => "application/x-7z-compressed".to_string(),
        "tar" => "application/x-tar".to_string(),
        "gz" => "application/gzip".to_string(),
        _ => "application/octet-stream".to_string(),
    }
}

fn remote_entry_to_node(entry: &crate::commands::remote::RemoteDirEntry) -> FileNode {
    let path = Path::new(&entry.path);
    let extension = if entry.is_dir {
        String::new()
    } else {
        path.extension()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_default()
    };
    let is_hidden = entry.name.starts_with('.');
    FileNode {
        id: generate_id(path),
        name: entry.name.clone(),
        path: entry.path.clone(),
        is_dir: entry.is_dir,
        size: entry.size,
        modified_time: 0,
        created_time: 0,
        extension,
        children: None,
        is_loaded: false,
        children_count: None,
        is_hidden,
    }
}

/// Scan a directory and return first-level children (lazy loading)
#[tauri::command]
pub async fn scan_directory(
    store: tauri::State<'_, std::sync::Arc<crate::commands::remote::RemoteSessionStore>>,
    path: String,
) -> Result<Vec<FileNode>, String> {
    crate::path_util::validate_user_path(&path)?;
    if crate::path_util::is_remote_path(&path) {
        let entries = crate::commands::remote::list_remote_dir_inner(store.as_ref(), &path).await?;
        return Ok(entries.iter().map(remote_entry_to_node).collect());
    }
    tokio::task::spawn_blocking(move || scan_directory_sync(path))
        .await
        .map_err(|e| crate::err::with_detail("task_join_failed", e))?
}

fn scan_directory_sync(path: String) -> Result<Vec<FileNode>, String> {
    let dir_path = Path::new(&path);
    
    if !dir_path.exists() {
        return Err(crate::err::with_detail("path_not_found", &path));
    }
    
    if !dir_path.is_dir() {
        return Err(crate::err::with_detail("path_not_dir", &path));
    }

    let mut nodes: Vec<FileNode> = Vec::new();
    
    let entries = fs::read_dir(dir_path)
        .map_err(|e| crate::err::with_detail("read_dir_failed", e))?;

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        
        let entry_path = entry.path();
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        
        let name = entry.file_name().to_string_lossy().to_string();
        let is_hidden = name.starts_with('.');
        let is_dir = metadata.is_dir();
        
        let extension = if is_dir {
            String::new()
        } else {
            entry_path
                .extension()
                .map(|e| e.to_string_lossy().to_string())
                .unwrap_or_default()
        };
        
        let size = if is_dir { 0 } else { metadata.len() };
        
        let modified_time = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
            
        let created_time = metadata
            .created()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        // Skip children_count: an extra read_dir per folder doubles NAS/UNC RTT.
        // UI tree is lazy-loaded; count is optional chrome, not required for expand.
        let children_count = None;

        let node = FileNode {
            id: generate_id(&entry_path),
            name,
            path: entry_path.to_string_lossy().to_string(),
            is_dir,
            size,
            modified_time,
            created_time,
            extension,
            children: None,
            is_loaded: false,
            children_count,
            is_hidden,
        };
        
        nodes.push(node);
    }
    
    // Sort: directories first, then by name (natural sort)
    nodes.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => natural_cmp(&a.name, &b.name),
        }
    });
    
    Ok(nodes)
}

const REMOTE_PREVIEW_MAX: u64 = 30 * 1024 * 1024;

/// Get file preview information
#[tauri::command]
pub async fn get_file_preview(
    store: tauri::State<'_, std::sync::Arc<crate::commands::remote::RemoteSessionStore>>,
    path: String,
) -> Result<FilePreviewInfo, String> {
    crate::path_util::validate_user_path(&path)?;

    if crate::path_util::is_remote_path(&path) {
        let info = crate::commands::remote::remote_path_info(store.clone(), path.clone()).await?;
        if info.is_dir {
            return Err(crate::err::code("path_not_file"));
        }
        if info.size > REMOTE_PREVIEW_MAX {
            return Ok(remote_metadata_only_preview(&path, &info));
        }
        let bytes = crate::commands::remote::read_remote_file_bytes(store.as_ref(), &path, REMOTE_PREVIEW_MAX).await?;
        let temp_dir = std::env::temp_dir().join("filetally_remote_preview");
        std::fs::create_dir_all(&temp_dir).map_err(|e| crate::err::with_detail("preview_temp_failed", e))?;
        let temp_path = temp_dir.join(format!(
            "{:x}_{}",
            {
                use std::collections::hash_map::DefaultHasher;
                use std::hash::{Hash, Hasher};
                let mut hasher = DefaultHasher::new();
                path.hash(&mut hasher);
                hasher.finish()
            },
            info.name.replace('/', "_")
        ));
        std::fs::write(&temp_path, &bytes).map_err(|e| crate::err::with_detail("preview_temp_failed", e))?;
        let temp_str = temp_path.to_string_lossy().to_string();
        let cleanup = temp_path.clone();
        let preview = tokio::task::spawn_blocking(move || get_file_preview_sync(temp_str))
            .await
            .map_err(|e| crate::err::with_detail("task_join_failed", e))??;
        let _ = std::fs::remove_file(cleanup);
        return Ok(FilePreviewInfo {
            metadata: FileMetadata {
                path: path.clone(),
                ..preview.metadata
            },
            ..preview
        });
    }

    tokio::task::spawn_blocking(move || get_file_preview_sync(path))
        .await
        .map_err(|e| crate::err::with_detail("task_join_failed", e))?
}

fn remote_metadata_only_preview(path: &str, info: &crate::commands::remote::RemoteDirEntry) -> FilePreviewInfo {
    let extension = Path::new(&info.name)
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default();
    let mime_type = get_mime_type(&extension);
    FilePreviewInfo {
        preview_type: "unsupported".to_string(),
        content: None,
        metadata: FileMetadata {
            name: info.name.clone(),
            path: path.to_string(),
            size: info.size,
            size_formatted: info.size_formatted.clone(),
            modified_time: "Unknown".to_string(),
            created_time: "Unknown".to_string(),
            extension,
            mime_type,
        },
    }
}

fn get_file_preview_sync(path: String) -> Result<FilePreviewInfo, String> {
    let file_path = Path::new(&path);
    
    if !file_path.exists() {
        return Err(crate::err::with_detail("file_not_found", &path));
    }
    
    let metadata = fs::metadata(&file_path)
        .map_err(|e| crate::err::with_detail("read_dir_failed", e))?;
    
    let name = file_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
        
    let extension = file_path
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default();
        
    let mime_type = get_mime_type(&extension);
    
    let modified_time = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| {
            let secs = d.as_secs() as i64;
            chrono::DateTime::from_timestamp(secs, 0)
                .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
                .unwrap_or_else(|| "Unknown".to_string())
        })
        .unwrap_or_else(|| "Unknown".to_string());
        
    let created_time = metadata
        .created()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| {
            let secs = d.as_secs() as i64;
            chrono::DateTime::from_timestamp(secs, 0)
                .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
                .unwrap_or_else(|| "Unknown".to_string())
        })
        .unwrap_or_else(|| "Unknown".to_string());
    
    let file_metadata = FileMetadata {
        name,
        path: path.clone(),
        size: metadata.len(),
        size_formatted: format_size(metadata.len()),
        modified_time,
        created_time,
        extension: extension.clone(),
        mime_type: mime_type.clone(),
    };
    
    // Determine preview type
    let preview_type = if mime_type.starts_with("image/") {
        "image"
    } else if mime_type == "application/pdf" {
        "pdf"
    } else if mime_type.starts_with("text/") || 
              mime_type == "application/json" || 
              mime_type == "application/javascript" ||
              mime_type == "application/typescript" {
        "text"
    } else if mime_type.starts_with("video/") {
        "video"
    } else if mime_type.starts_with("audio/") {
        "audio"
    } else {
        "unsupported"
    };
    
    // Read content based on file type
    let content = if preview_type == "text" && metadata.len() < 1024 * 1024 {
        // Only read text files smaller than 1MB
        fs::read_to_string(&file_path).ok()
    } else if preview_type == "pdf" && metadata.len() < 15 * 1024 * 1024 {
        // Cap PDF text extract — heavy files should open in dedicated preview, not metadata IPC
        extract_pdf_text_safe(&file_path)
    } else {
        None
    };
    
    Ok(FilePreviewInfo {
        preview_type: preview_type.to_string(),
        content,
        metadata: file_metadata,
    })
}

/// 安全地提取 PDF 文本内容
fn extract_pdf_text_safe(path: &Path) -> Option<String> {
    // 使用 catch_unwind 来捕获 pdf-extract 的 panic
    std::panic::catch_unwind(|| {
        pdf_extract::extract_text(path).ok()
    }).ok().flatten()
}

/// Get home directory path
#[tauri::command]
pub fn get_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| crate::err::code("home_dir_missing"))
}

/// Check if a path exists (local FS or in-app SMB `remote://`)
#[tauri::command]
pub async fn check_path_exists(
    store: tauri::State<'_, std::sync::Arc<crate::commands::remote::SmbSessionStore>>,
    path: String,
) -> Result<bool, String> {
    if crate::path_util::is_remote_path(&path) {
        crate::commands::remote::remote_path_exists(store, path).await
    } else {
        Ok(Path::new(&path).exists())
    }
}

/// List mounted volumes (for macOS)
#[tauri::command]
pub fn list_volumes() -> Result<Vec<String>, String> {
    let volumes_path = Path::new("/Volumes");
    
    if !volumes_path.exists() {
        return Ok(vec![]);
    }
    
    let entries = fs::read_dir(volumes_path)
        .map_err(|e| crate::err::with_detail("volumes_list_failed", e))?;
    
    let mut volumes = Vec::new();
    for entry in entries {
        if let Ok(entry) = entry {
            let path = entry.path();
            if path.is_dir() {
                volumes.push(path.to_string_lossy().to_string());
            }
        }
    }
    
    Ok(volumes)
}

/// 重命名响应
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameResult {
    pub success: bool,
    pub new_path: String,
    pub new_name: String,
    pub error: Option<String>,
}

/// 重命名文件或文件夹
#[tauri::command]
pub fn rename_file(old_path: String, new_name: String) -> Result<RenameResult, String> {
    crate::path_util::validate_user_path(&old_path)?;
    if crate::path_util::is_remote_path(&old_path) {
        return Ok(RenameResult {
            success: false,
            new_path: String::new(),
            new_name: String::new(),
            error: Some(crate::err::code("rename_remote_unsupported")),
        });
    }
    let old_path = Path::new(&old_path);
    
    // 检查原路径是否存在
    if !old_path.exists() {
        return Ok(RenameResult {
            success: false,
            new_path: String::new(),
            new_name: String::new(),
            error: Some(crate::err::code("rename_source_missing")),
        });
    }
    
    let trimmed = match crate::path_util::validate_file_name(&new_name) {
        Ok(name) => name,
        Err(msg) => {
            return Ok(RenameResult {
                success: false,
                new_path: String::new(),
                new_name: String::new(),
                error: Some(msg),
            });
        }
    };
    
    // 构建新路径
    let parent = old_path.parent().ok_or_else(|| crate::err::code("rename_no_parent"))?;
    let new_path = parent.join(trimmed);

    // 确保仍在同一父目录内（防止路径穿越）
    let canonical_parent = parent.canonicalize().unwrap_or_else(|_| parent.to_path_buf());
    if let Ok(canonical_new) = new_path.canonicalize() {
        if canonical_new.parent() != Some(canonical_parent.as_path()) {
            return Ok(RenameResult {
                success: false,
                new_path: String::new(),
                new_name: String::new(),
                error: Some(crate::err::code("rename_path_escape")),
            });
        }
    } else {
        // 新路径尚不存在时，检查 join 后的父路径
        let joined_parent = new_path.parent().map(|p| p.to_path_buf());
        if joined_parent.as_deref() != Some(parent) {
            return Ok(RenameResult {
                success: false,
                new_path: String::new(),
                new_name: String::new(),
                error: Some(crate::err::code("rename_path_escape")),
            });
        }
    }
    
    // 检查新路径是否已存在
    if new_path.exists() {
        return Ok(RenameResult {
            success: false,
            new_path: String::new(),
            new_name: String::new(),
            error: Some(crate::err::code("rename_target_exists")),
        });
    }
    
    // 执行重命名
    match fs::rename(old_path, &new_path) {
        Ok(_) => Ok(RenameResult {
            success: true,
            new_path: new_path.to_string_lossy().to_string(),
            new_name: trimmed.to_string(),
            error: None,
        }),
        Err(e) => Ok(RenameResult {
            success: false,
            new_path: String::new(),
            new_name: String::new(),
            error: Some(crate::err::with_detail("rename_failed", e)),
        }),
    }
}
