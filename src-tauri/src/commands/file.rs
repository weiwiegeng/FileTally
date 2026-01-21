use crate::models::{DirectoryScanResult, FileMetadata, FileNode, FilePreviewInfo};
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

/// Generate a unique ID for file node
fn generate_id(path: &Path) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    
    let mut hasher = DefaultHasher::new();
    path.to_string_lossy().hash(&mut hasher);
    format!("{:x}", hasher.finish())
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

/// Scan a directory and return first-level children (lazy loading)
#[tauri::command]
pub fn scan_directory(path: String) -> Result<Vec<FileNode>, String> {
    let dir_path = Path::new(&path);
    
    if !dir_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    
    if !dir_path.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    let mut nodes: Vec<FileNode> = Vec::new();
    
    let entries = fs::read_dir(dir_path)
        .map_err(|e| format!("Failed to read directory: {}", e))?;

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

        // Count children for directories
        let children_count = if is_dir {
            fs::read_dir(&entry_path)
                .map(|entries| entries.count())
                .ok()
        } else {
            None
        };

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
    
    // Sort: directories first, then by name
    nodes.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });
    
    Ok(nodes)
}

/// Scan directory recursively with depth limit
#[tauri::command]
pub fn scan_directory_recursive(path: String, max_depth: usize) -> Result<DirectoryScanResult, String> {
    let dir_path = Path::new(&path);
    
    if !dir_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    let mut nodes: Vec<FileNode> = Vec::new();
    let mut total_files: usize = 0;
    let mut total_dirs: usize = 0;
    let mut total_size: u64 = 0;

    for entry in WalkDir::new(dir_path)
        .max_depth(max_depth)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if entry.path() == dir_path {
            continue; // Skip root
        }
        
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        
        let name = entry.file_name().to_string_lossy().to_string();
        let is_hidden = name.starts_with('.');
        let is_dir = metadata.is_dir();
        
        if is_dir {
            total_dirs += 1;
        } else {
            total_files += 1;
            total_size += metadata.len();
        }
        
        let extension = if is_dir {
            String::new()
        } else {
            entry.path()
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

        let node = FileNode {
            id: generate_id(entry.path()),
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir,
            size,
            modified_time,
            created_time,
            extension,
            children: None,
            is_loaded: false,
            children_count: None,
            is_hidden,
        };
        
        nodes.push(node);
    }

    Ok(DirectoryScanResult {
        root_path: path,
        nodes,
        total_files,
        total_dirs,
        total_size,
    })
}

/// Get file preview information
#[tauri::command]
pub fn get_file_preview(path: String) -> Result<FilePreviewInfo, String> {
    let file_path = Path::new(&path);
    
    if !file_path.exists() {
        return Err(format!("File does not exist: {}", path));
    }
    
    let metadata = fs::metadata(&file_path)
        .map_err(|e| format!("Failed to get metadata: {}", e))?;
    
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
    } else if preview_type == "pdf" && metadata.len() < 50 * 1024 * 1024 {
        // Extract PDF text for files smaller than 50MB
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
        .ok_or_else(|| "Failed to get home directory".to_string())
}

/// Check if a path exists
#[tauri::command]
pub fn check_path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

/// List mounted volumes (for macOS)
#[tauri::command]
pub fn list_volumes() -> Result<Vec<String>, String> {
    let volumes_path = Path::new("/Volumes");
    
    if !volumes_path.exists() {
        return Ok(vec![]);
    }
    
    let entries = fs::read_dir(volumes_path)
        .map_err(|e| format!("Failed to read /Volumes: {}", e))?;
    
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
    let old_path = Path::new(&old_path);
    
    // 检查原路径是否存在
    if !old_path.exists() {
        return Ok(RenameResult {
            success: false,
            new_path: String::new(),
            new_name: String::new(),
            error: Some("文件或文件夹不存在".to_string()),
        });
    }
    
    // 检查新名称是否合法
    if new_name.is_empty() {
        return Ok(RenameResult {
            success: false,
            new_path: String::new(),
            new_name: String::new(),
            error: Some("名称不能为空".to_string()),
        });
    }
    
    // 检查非法字符
    let invalid_chars = ['/', '\\', ':', '*', '?', '"', '<', '>', '|'];
    if new_name.chars().any(|c| invalid_chars.contains(&c)) {
        return Ok(RenameResult {
            success: false,
            new_path: String::new(),
            new_name: String::new(),
            error: Some("名称包含非法字符 (/ \\ : * ? \" < > |)".to_string()),
        });
    }
    
    // 构建新路径
    let parent = old_path.parent().ok_or("无法获取父目录")?;
    let new_path = parent.join(&new_name);
    
    // 检查新路径是否已存在
    if new_path.exists() {
        return Ok(RenameResult {
            success: false,
            new_path: String::new(),
            new_name: String::new(),
            error: Some("同名文件或文件夹已存在".to_string()),
        });
    }
    
    // 执行重命名
    match fs::rename(old_path, &new_path) {
        Ok(_) => Ok(RenameResult {
            success: true,
            new_path: new_path.to_string_lossy().to_string(),
            new_name,
            error: None,
        }),
        Err(e) => Ok(RenameResult {
            success: false,
            new_path: String::new(),
            new_name: String::new(),
            error: Some(format!("重命名失败: {}", e)),
        }),
    }
}
