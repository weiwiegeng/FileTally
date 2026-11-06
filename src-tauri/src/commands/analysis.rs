use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;
use tauri::{AppHandle, Emitter};

/// 进度事件结构
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisProgress {
    pub stage: String,
    pub current: u64,
    pub total: u64,
    pub message: String,
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

/// Duplicate fingerprint: SHA-256 over size + head 64KB + mid 4KB + tail 4KB.
fn calculate_file_hash(path: &Path, size: u64) -> Option<String> {
    use sha2::{Digest, Sha256};
    use std::io::{Read, Seek, SeekFrom};

    let mut file = fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    hasher.update(size.to_le_bytes());

    let mut head = vec![0u8; 64 * 1024];
    let head_read = file.read(&mut head).ok()?;
    hasher.update(&head[..head_read]);

    if size > 64 * 1024 + 8192 {
        let mid_pos = size / 2;
        file.seek(SeekFrom::Start(mid_pos.saturating_sub(2048))).ok()?;
        let mut mid = [0u8; 4096];
        let mid_read = file.read(&mut mid).ok()?;
        hasher.update(&mid[..mid_read]);

        file.seek(SeekFrom::End(-4096)).ok()?;
        let mut tail = [0u8; 4096];
        let tail_read = file.read(&mut tail).ok()?;
        hasher.update(&tail[..tail_read]);
    } else if size > 64 * 1024 {
        file.seek(SeekFrom::End(-4096.min(size as i64))).ok()?;
        let mut tail = [0u8; 4096];
        let tail_read = file.read(&mut tail).ok()?;
        hasher.update(&tail[..tail_read]);
    }

    Some(format!("{:x}", hasher.finalize()))
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTypeStats {
    pub extension: String,
    pub count: u64,
    pub total_size: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeFile {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub size_formatted: String,
    pub modified_time: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateGroup {
    pub hash: String,
    pub size: u64,
    pub size_formatted: String,
    pub files: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OldFile {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub size_formatted: String,
    /// Days since last modification (field historically misnamed as accessed).
    #[serde(rename = "lastModifiedDays", alias = "lastAccessedDays")]
    pub last_modified_days: u64,
    pub modified_time: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderAnalysisResult {
    pub path: String,
    pub total_files: u64,
    pub total_dirs: u64,
    pub total_size: u64,
    pub total_size_formatted: String,
    pub file_type_stats: Vec<FileTypeStats>,
    pub large_files: Vec<LargeFile>,
    pub duplicate_groups: Vec<DuplicateGroup>,
    pub old_files: Vec<OldFile>,
    pub analyzed_at: u64,
    pub truncated: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupItem {
    pub category: String,
    pub path: String,
    pub name: String,
    pub size: u64,
    pub size_formatted: String,
    pub description: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupSuggestion {
    pub cache_files: Vec<CleanupItem>,
    pub temp_files: Vec<CleanupItem>,
    pub download_files: Vec<CleanupItem>,
    pub log_files: Vec<CleanupItem>,
    pub total_cleanable_size: u64,
    pub total_cleanable_size_formatted: String,
    pub analyzed_at: u64,
}

const ANALYSIS_MAX_DEPTH: usize = 32;
const ANALYSIS_MAX_ENTRIES: u64 = 200_000;

/// Analyze a folder and return statistics
#[tauri::command]
pub async fn analyze_folder(
    app: AppHandle,
    path: String,
    large_file_threshold_mb: u64,
    old_file_days: u64,
) -> Result<FolderAnalysisResult, String> {
    tokio::task::spawn_blocking(move || analyze_folder_sync(app, path, large_file_threshold_mb, old_file_days))
        .await
        .map_err(|e| crate::err::with_detail("analysis_task_failed", e))?
}

fn analyze_folder_sync(
    app: AppHandle,
    path: String,
    large_file_threshold_mb: u64,
    old_file_days: u64,
) -> Result<FolderAnalysisResult, String> {
    let dir_path = Path::new(&path);
    
    crate::path_util::validate_user_path(&path)?;
    if !dir_path.exists() {
        return Err(crate::err::with_detail("path_not_found", &path));
    }
    
    if !dir_path.is_dir() {
        return Err(crate::err::with_detail("path_not_dir", &path));
    }

    let _ = app.emit("analysis-progress", AnalysisProgress {
        stage: "counting".to_string(),
        current: 0,
        total: 0,
        message: String::new(),
    });

    let total_entries: u64 = WalkDir::new(dir_path)
        .follow_links(false)
        .max_depth(ANALYSIS_MAX_DEPTH)
        .into_iter()
        .filter_map(|e| e.ok())
        .take(ANALYSIS_MAX_ENTRIES as usize)
        .count() as u64;

    let large_file_threshold = large_file_threshold_mb * 1024 * 1024;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let old_threshold_secs = old_file_days * 24 * 60 * 60;

    let mut total_files: u64 = 0;
    let mut total_dirs: u64 = 0;
    let mut total_size: u64 = 0;
    let mut type_stats: HashMap<String, (u64, u64)> = HashMap::new(); // (count, size)
    let mut large_files: Vec<LargeFile> = Vec::new();
    let mut old_files: Vec<OldFile> = Vec::new();
    let mut file_hashes: HashMap<String, Vec<(String, u64)>> = HashMap::new(); // hash -> [(path, size)]
    
    let mut processed: u64 = 0;
    let mut last_emit: u64 = 0;
    let mut truncated = false;

    for entry in WalkDir::new(dir_path)
        .follow_links(false)
        .max_depth(ANALYSIS_MAX_DEPTH)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        processed += 1;
        if processed > ANALYSIS_MAX_ENTRIES {
            truncated = true;
            break;
        }
        
        if processed - last_emit >= 100 || (total_entries > 0 && processed * 100 / total_entries > last_emit * 100 / total_entries.max(1)) {
            last_emit = processed;
            let _ = app.emit("analysis-progress", AnalysisProgress {
                stage: "analyzing".to_string(),
                current: processed,
                total: total_entries,
                message: String::new(),
            });
        }
        
        if entry.path() == dir_path {
            continue;
        }
        
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        
        if metadata.is_dir() {
            total_dirs += 1;
            continue;
        }
        
        total_files += 1;
        let size = metadata.len();
        total_size += size;
        
        let name = entry.file_name().to_string_lossy().to_string();
        let path_str = entry.path().to_string_lossy().to_string();
        
        // Extension stats
        let extension = entry.path()
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_else(|| "(none)".to_string());
        
        let stats = type_stats.entry(extension).or_insert((0, 0));
        stats.0 += 1;
        stats.1 += size;
        
        // Modified time
        let modified_time = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        
        // Large files
        if size >= large_file_threshold {
            large_files.push(LargeFile {
                path: path_str.clone(),
                name: name.clone(),
                size,
                size_formatted: format_size(size),
                modified_time,
            });
        }
        
        // Old files (not modified for a long time)
        if modified_time > 0 && now > modified_time {
            let age_secs = now - modified_time;
            if age_secs > old_threshold_secs {
                let days = age_secs / (24 * 60 * 60);
                old_files.push(OldFile {
                    path: path_str.clone(),
                    name: name.clone(),
                    size,
                    size_formatted: format_size(size),
                    last_modified_days: days,
                    modified_time,
                });
            }
        }
        
        // Duplicate detection (only for files > 1KB)
        if size > 1024 {
            if let Some(hash) = calculate_file_hash(entry.path(), size) {
                file_hashes
                    .entry(hash)
                    .or_insert_with(Vec::new)
                    .push((path_str, size));
            }
        }
    }

    // Convert type stats
    let mut file_type_stats: Vec<FileTypeStats> = type_stats
        .into_iter()
        .map(|(ext, (count, size))| FileTypeStats {
            extension: ext,
            count,
            total_size: size,
        })
        .collect();
    
    // Sort by size descending
    file_type_stats.sort_by(|a, b| b.total_size.cmp(&a.total_size));
    
    // Sort large files by size descending, take top 20
    large_files.sort_by(|a, b| b.size.cmp(&a.size));
    large_files.truncate(20);
    
    // Sort old files by age descending, take top 50
    old_files.sort_by(|a, b| b.last_modified_days.cmp(&a.last_modified_days));
    old_files.truncate(50);
    
    // Find duplicates (groups with more than 1 file)
    let mut duplicate_groups: Vec<DuplicateGroup> = file_hashes
        .into_iter()
        .filter(|(_, files)| files.len() > 1)
        .map(|(hash, files)| {
            let size = files.first().map(|(_, s)| *s).unwrap_or(0);
            DuplicateGroup {
                hash,
                size,
                size_formatted: format_size(size),
                files: files.into_iter().map(|(p, _)| p).collect(),
            }
        })
        .collect();
    
    // Sort by wasted space (size * (count - 1))
    duplicate_groups.sort_by(|a, b| {
        let waste_a = a.size * (a.files.len() as u64 - 1);
        let waste_b = b.size * (b.files.len() as u64 - 1);
        waste_b.cmp(&waste_a)
    });
    duplicate_groups.truncate(20);

    let _ = app.emit("analysis-progress", AnalysisProgress {
        stage: "complete".to_string(),
        current: total_entries,
        total: total_entries,
        message: String::new(),
    });

    Ok(FolderAnalysisResult {
        path,
        total_files,
        total_dirs,
        total_size,
        total_size_formatted: format_size(total_size),
        file_type_stats,
        large_files,
        duplicate_groups,
        old_files,
        analyzed_at: now,
        truncated,
    })
}

/// Scan system for cleanup suggestions
#[tauri::command]
pub fn scan_cleanup_suggestions() -> Result<CleanupSuggestion, String> {
    let home_dir = dirs::home_dir()
        .ok_or_else(|| crate::err::code("home_dir_missing"))?;
    
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let mut cache_files: Vec<CleanupItem> = Vec::new();
    let mut temp_files: Vec<CleanupItem> = Vec::new();
    let mut download_files: Vec<CleanupItem> = Vec::new();
    let mut log_files: Vec<CleanupItem> = Vec::new();
    let mut total_size: u64 = 0;

    // macOS cache directories
    let cache_paths = vec![
        home_dir.join("Library/Caches"),
        Path::new("/private/var/folders").to_path_buf(),
    ];

    for cache_path in cache_paths {
        if cache_path.exists() && cache_path.is_dir() {
            if let Ok(entries) = fs::read_dir(&cache_path) {
                for entry in entries.filter_map(|e| e.ok()) {
                    let path = entry.path();
                    if let Ok(metadata) = entry.metadata() {
                        let size = if metadata.is_dir() {
                            // Calculate dir size (limited depth)
                            calculate_dir_size(&path, 2)
                        } else {
                            metadata.len()
                        };
                        
                        if size > 10 * 1024 * 1024 { // Only show > 10MB
                            cache_files.push(CleanupItem {
                                category: "cache".to_string(),
                                path: path.to_string_lossy().to_string(),
                                name: entry.file_name().to_string_lossy().to_string(),
                                size,
                                size_formatted: format_size(size),
                                description: "cache".to_string(),
                            });
                            total_size += size;
                        }
                    }
                }
            }
        }
    }

    // Temp files
    let temp_paths = vec![
        Path::new("/tmp").to_path_buf(),
        Path::new("/private/tmp").to_path_buf(),
        home_dir.join(".Trash"),
    ];

    for temp_path in temp_paths {
        if temp_path.exists() && temp_path.is_dir() {
            let size = calculate_dir_size(&temp_path, 3);
            if size > 1024 * 1024 { // > 1MB
                let name = temp_path.file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| temp_path.to_string_lossy().to_string());
                
                let description = if name == ".Trash" {
                    "trash"
                } else {
                    "temp"
                };
                
                temp_files.push(CleanupItem {
                    category: "temp".to_string(),
                    path: temp_path.to_string_lossy().to_string(),
                    name,
                    size,
                    size_formatted: format_size(size),
                    description: description.to_string(),
                });
                total_size += size;
            }
        }
    }

    // Downloads folder - old files
    let downloads_path = home_dir.join("Downloads");
    if downloads_path.exists() && downloads_path.is_dir() {
        let thirty_days_ago = now - (30 * 24 * 60 * 60);
        
        if let Ok(entries) = fs::read_dir(&downloads_path) {
            for entry in entries.filter_map(|e| e.ok()) {
                if let Ok(metadata) = entry.metadata() {
                    let modified = metadata
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(now);
                    
                    if modified < thirty_days_ago {
                        let size = if metadata.is_dir() {
                            calculate_dir_size(&entry.path(), 3)
                        } else {
                            metadata.len()
                        };
                        
                        if size > 5 * 1024 * 1024 { // > 5MB
                            download_files.push(CleanupItem {
                                category: "download".to_string(),
                                path: entry.path().to_string_lossy().to_string(),
                                name: entry.file_name().to_string_lossy().to_string(),
                                size,
                                size_formatted: format_size(size),
                                description: "download_old".to_string(),
                            });
                            total_size += size;
                        }
                    }
                }
            }
        }
    }

    // Log files
    let log_paths = vec![
        home_dir.join("Library/Logs"),
        Path::new("/var/log").to_path_buf(),
    ];

    for log_path in log_paths {
        if log_path.exists() && log_path.is_dir() {
            if let Ok(entries) = fs::read_dir(&log_path) {
                for entry in entries.filter_map(|e| e.ok()) {
                    if let Ok(metadata) = entry.metadata() {
                        let size = if metadata.is_dir() {
                            calculate_dir_size(&entry.path(), 2)
                        } else {
                            metadata.len()
                        };
                        
                        if size > 10 * 1024 * 1024 { // > 10MB
                            log_files.push(CleanupItem {
                                category: "log".to_string(),
                                path: entry.path().to_string_lossy().to_string(),
                                name: entry.file_name().to_string_lossy().to_string(),
                                size,
                                size_formatted: format_size(size),
                                description: "log".to_string(),
                            });
                            total_size += size;
                        }
                    }
                }
            }
        }
    }

    // Sort by size
    cache_files.sort_by(|a, b| b.size.cmp(&a.size));
    temp_files.sort_by(|a, b| b.size.cmp(&a.size));
    download_files.sort_by(|a, b| b.size.cmp(&a.size));
    log_files.sort_by(|a, b| b.size.cmp(&a.size));

    // Truncate
    cache_files.truncate(20);
    temp_files.truncate(10);
    download_files.truncate(20);
    log_files.truncate(10);

    Ok(CleanupSuggestion {
        cache_files,
        temp_files,
        download_files,
        log_files,
        total_cleanable_size: total_size,
        total_cleanable_size_formatted: format_size(total_size),
        analyzed_at: now,
    })
}

/// Calculate directory size with depth limit
fn calculate_dir_size(path: &Path, max_depth: usize) -> u64 {
    let mut size: u64 = 0;
    
    for entry in WalkDir::new(path)
        .max_depth(max_depth)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if let Ok(metadata) = entry.metadata() {
            if metadata.is_file() {
                size += metadata.len();
            }
        }
    }
    
    size
}
