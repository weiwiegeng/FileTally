use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;
use regex::RegexBuilder;
use rayon::prelude::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub line_number: usize,
    pub content: String,
    pub match_start: usize,
    pub match_end: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub file_path: String,
    pub file_name: String,
    pub file_type: String,
    pub matches: Vec<SearchMatch>,
    pub match_count: usize,
}

/// 未匹配文件信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnmatchedFile {
    pub file_path: String,
    pub file_name: String,
    pub file_type: String,
}

/// 搜索结果汇总
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub matched: Vec<SearchResult>,
    pub unmatched: Vec<UnmatchedFile>,
    pub total_scanned: usize,
}

/// 多关键词检查结果 - 单个文件
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeywordCheckResult {
    pub file_path: String,
    pub file_name: String,
    pub file_type: String,
    pub missing_keywords: Vec<String>,
}

/// 多关键词检查响应
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeywordCheckResponse {
    pub results: Vec<KeywordCheckResult>,
    pub total_scanned: usize,
    pub total_with_missing: usize,
    pub keywords: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchOptions {
    pub search_content: bool,
    pub search_filename: bool,      // 是否搜索文件名
    pub case_sensitive: bool,
    pub include_hidden: bool,
    pub file_extensions: Option<Vec<String>>,
    pub max_pdf_size_mb: Option<u64>,  // PDF 最大处理大小 (MB)
}

impl Default for SearchOptions {
    fn default() -> Self {
        Self {
            search_content: true,
            search_filename: true,
            case_sensitive: false,
            include_hidden: false,
            file_extensions: None,
            max_pdf_size_mb: Some(30),
        }
    }
}

/// 判断文件是否为文本文件
fn is_text_file(extension: &str) -> bool {
    let text_extensions = [
        "txt", "md", "json", "xml", "html", "htm", "css", "js", "ts", "tsx", "jsx",
        "py", "rs", "go", "java", "c", "cpp", "h", "hpp", "cs", "rb", "php",
        "yaml", "yml", "toml", "ini", "conf", "cfg", "sh", "bash", "zsh",
        "sql", "log", "csv", "vue", "svelte", "astro",
    ];
    text_extensions.contains(&extension.to_lowercase().as_str())
}

/// 判断文件是否为 PDF
fn is_pdf_file(extension: &str) -> bool {
    extension.to_lowercase() == "pdf"
}

/// 获取文件类型
fn get_file_type(extension: &str) -> String {
    let ext = extension.to_lowercase();
    match ext.as_str() {
        "pdf" => "pdf".to_string(),
        "doc" | "docx" => "word".to_string(),
        "xls" | "xlsx" => "excel".to_string(),
        "txt" | "md" | "json" | "xml" | "html" | "css" | "js" | "ts" => "text".to_string(),
        "jpg" | "jpeg" | "png" | "gif" | "bmp" | "webp" => "image".to_string(),
        "mp4" | "avi" | "mov" | "mkv" => "video".to_string(),
        "mp3" | "wav" | "flac" | "aac" => "audio".to_string(),
        _ => "other".to_string(),
    }
}

/// 搜索文本内容
fn search_text_content(content: &str, query: &str, case_sensitive: bool) -> Vec<SearchMatch> {
    let mut matches = Vec::new();
    
    let regex = RegexBuilder::new(&regex::escape(query))
        .case_insensitive(!case_sensitive)
        .build();
    
    if let Ok(re) = regex {
        for (line_num, line) in content.lines().enumerate() {
            for mat in re.find_iter(line) {
                matches.push(SearchMatch {
                    line_number: line_num + 1,
                    content: line.to_string(),
                    match_start: mat.start(),
                    match_end: mat.end(),
                });
            }
        }
    }
    
    matches
}

/// 读取文本文件内容
fn read_text_file(path: &Path) -> Option<String> {
    // 先尝试 UTF-8
    if let Ok(content) = fs::read_to_string(path) {
        return Some(content);
    }
    
    // 尝试其他编码
    if let Ok(bytes) = fs::read(path) {
        // 尝试 GBK
        let (decoded, _, _) = encoding_rs::GBK.decode(&bytes);
        return Some(decoded.into_owned());
    }
    
    None
}

/// 提取 PDF 文本内容（带 panic 保护和大小限制）
fn extract_pdf_text(path: &Path, max_size_mb: u64) -> Option<String> {
    // 限制 PDF 文件大小
    if let Ok(metadata) = fs::metadata(path) {
        if metadata.len() > max_size_mb * 1024 * 1024 {
            return None;
        }
    }
    
    // 使用 catch_unwind 来捕获 pdf-extract 的 panic
    std::panic::catch_unwind(|| {
        pdf_extract::extract_text(path).ok()
    }).ok().flatten()
}

/// 检查文件名是否匹配
fn match_filename(filename: &str, query: &str, case_sensitive: bool) -> bool {
    if case_sensitive {
        filename.contains(query)
    } else {
        filename.to_lowercase().contains(&query.to_lowercase())
    }
}

/// 判断是否为隐藏文件
fn is_hidden(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.starts_with('.'))
        .unwrap_or(false)
}

/// 单个文件搜索结果
enum FileSearchResult {
    Matched(SearchResult),
    Unmatched(UnmatchedFile),
    Skipped,
}

/// 搜索单个文件
fn search_single_file(
    file_path: &Path,
    query: &str,
    case_sensitive: bool,
    search_content: bool,
    search_filename: bool,
    max_pdf_size_mb: u64,
) -> FileSearchResult {
    let file_name = file_path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    
    let extension = file_path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_string();
    
    let file_type = get_file_type(&extension);
    let mut matches = Vec::new();
    let mut was_searched = false;
    
    // 文件名匹配（根据选项决定是否启用）
    if search_filename {
        let filename_matched = match_filename(&file_name, query, case_sensitive);
        
        if filename_matched {
            matches.push(SearchMatch {
                line_number: 0,
                content: format!("文件名匹配: {}", file_name),
                match_start: 0,
                match_end: 0,
            });
        }
    }
    
    // 内容搜索
    if search_content {
        // 文本文件
        if is_text_file(&extension) {
            was_searched = true;
            if let Some(content) = read_text_file(file_path) {
                let content_matches = search_text_content(&content, query, case_sensitive);
                matches.extend(content_matches);
            }
        }
        // PDF 文件
        else if is_pdf_file(&extension) {
            was_searched = true;
            if let Some(content) = extract_pdf_text(file_path, max_pdf_size_mb) {
                let content_matches = search_text_content(&content, query, case_sensitive);
                matches.extend(content_matches);
            }
        }
    }
    
    // 根据是否匹配分类
    if !matches.is_empty() {
        FileSearchResult::Matched(SearchResult {
            file_path: file_path.to_string_lossy().to_string(),
            file_name,
            file_type,
            match_count: matches.len(),
            matches,
        })
    } else if was_searched {
        FileSearchResult::Unmatched(UnmatchedFile {
            file_path: file_path.to_string_lossy().to_string(),
            file_name,
            file_type,
        })
    } else {
        FileSearchResult::Skipped
    }
}

#[tauri::command]
pub async fn search_files(
    path: String,
    query: String,
    options: SearchOptions,
) -> Result<SearchResponse, String> {
    let search_path = Path::new(&path);
    
    if !search_path.exists() {
        return Err("搜索路径不存在".to_string());
    }
    
    // 第一步：收集所有需要搜索的文件路径
    let files_to_search: Vec<PathBuf> = WalkDir::new(search_path)
        .follow_links(true)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|entry| {
            let entry_path = entry.path();
            
            // 跳过目录
            if entry_path.is_dir() {
                return false;
            }
            
            // 隐藏文件过滤
            if !options.include_hidden && is_hidden(entry_path) {
                return false;
            }
            
            // 扩展名过滤
            if let Some(ref exts) = options.file_extensions {
                let extension = entry_path.extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("");
                if !exts.is_empty() && !exts.iter().any(|e| e.eq_ignore_ascii_case(extension)) {
                    return false;
                }
            }
            
            true
        })
        .map(|e| e.path().to_path_buf())
        .collect();
    
    // 第二步：并行搜索所有文件
    let max_pdf_size = options.max_pdf_size_mb.unwrap_or(30);
    let results: Vec<FileSearchResult> = files_to_search
        .par_iter()
        .map(|file_path| {
            search_single_file(
                file_path,
                &query,
                options.case_sensitive,
                options.search_content,
                options.search_filename,
                max_pdf_size,
            )
        })
        .collect();
    
    // 第三步：汇总结果
    let mut matched = Vec::new();
    let mut unmatched = Vec::new();
    let mut total_scanned = 0;
    
    for result in results {
        match result {
            FileSearchResult::Matched(r) => {
                total_scanned += 1;
                matched.push(r);
            }
            FileSearchResult::Unmatched(u) => {
                total_scanned += 1;
                unmatched.push(u);
            }
            FileSearchResult::Skipped => {}
        }
    }
    
    // 按匹配数量排序
    matched.sort_by(|a, b| b.match_count.cmp(&a.match_count));
    
    Ok(SearchResponse {
        matched,
        unmatched,
        total_scanned,
    })
}

/// 检查单个文件是否包含某个关键词
fn check_keyword_in_content(
    content: &str,
    keyword: &str,
    case_sensitive: bool,
) -> bool {
    if case_sensitive {
        content.contains(keyword)
    } else {
        content.to_lowercase().contains(&keyword.to_lowercase())
    }
}

/// 检查单个文件的多关键词匹配情况
fn check_file_keywords(
    file_path: &Path,
    keywords: &[String],
    case_sensitive: bool,
    search_content: bool,
    search_filename: bool,
    max_pdf_size_mb: u64,
) -> Option<KeywordCheckResult> {
    let file_name = file_path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    
    let extension = file_path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_string();
    
    let file_type = get_file_type(&extension);
    
    // 获取文件内容
    let content = if search_content {
        if is_text_file(&extension) {
            read_text_file(file_path)
        } else if is_pdf_file(&extension) {
            extract_pdf_text(file_path, max_pdf_size_mb)
        } else {
            None
        }
    } else {
        None
    };
    
    // 如果不搜索内容且不搜索文件名，或者搜索内容但无法读取内容，跳过
    if !search_filename && content.is_none() {
        return None;
    }
    
    // 检查每个关键词
    let mut missing_keywords = Vec::new();
    
    for keyword in keywords {
        let mut found = false;
        
        // 检查文件名
        if search_filename {
            if match_filename(&file_name, keyword, case_sensitive) {
                found = true;
            }
        }
        
        // 检查内容
        if !found && search_content {
            if let Some(ref content) = content {
                if check_keyword_in_content(content, keyword, case_sensitive) {
                    found = true;
                }
            }
        }
        
        if !found {
            missing_keywords.push(keyword.clone());
        }
    }
    
    // 只返回有缺失关键词的文件
    if !missing_keywords.is_empty() {
        Some(KeywordCheckResult {
            file_path: file_path.to_string_lossy().to_string(),
            file_name,
            file_type,
            missing_keywords,
        })
    } else {
        None
    }
}

/// 多关键词检查命令
#[tauri::command]
pub async fn check_keywords(
    path: String,
    keywords: Vec<String>,
    options: SearchOptions,
) -> Result<KeywordCheckResponse, String> {
    let search_path = Path::new(&path);
    
    if !search_path.exists() {
        return Err("搜索路径不存在".to_string());
    }
    
    if keywords.is_empty() {
        return Err("请提供至少一个关键词".to_string());
    }
    
    // 第一步：收集所有需要搜索的文件路径
    let files_to_check: Vec<PathBuf> = WalkDir::new(search_path)
        .follow_links(true)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|entry| {
            let entry_path = entry.path();
            
            // 跳过目录
            if entry_path.is_dir() {
                return false;
            }
            
            // 隐藏文件过滤
            if !options.include_hidden && is_hidden(entry_path) {
                return false;
            }
            
            // 扩展名过滤
            if let Some(ref exts) = options.file_extensions {
                let extension = entry_path.extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("");
                if !exts.is_empty() && !exts.iter().any(|e| e.eq_ignore_ascii_case(extension)) {
                    return false;
                }
            }
            
            true
        })
        .map(|e| e.path().to_path_buf())
        .collect();
    
    // 第二步：并行检查所有文件
    let max_pdf_size = options.max_pdf_size_mb.unwrap_or(30);
    let results: Vec<Option<KeywordCheckResult>> = files_to_check
        .par_iter()
        .map(|file_path| {
            check_file_keywords(
                file_path,
                &keywords,
                options.case_sensitive,
                options.search_content,
                options.search_filename,
                max_pdf_size,
            )
        })
        .collect();
    
    // 第三步：汇总结果
    let mut check_results = Vec::new();
    let mut total_scanned = 0;
    
    for result in results {
        total_scanned += 1;
        if let Some(r) = result {
            check_results.push(r);
        }
    }
    
    // 按缺失关键词数量排序（缺失越多排越前）
    check_results.sort_by(|a, b| b.missing_keywords.len().cmp(&a.missing_keywords.len()));
    
    let total_with_missing = check_results.len();
    
    Ok(KeywordCheckResponse {
        results: check_results,
        total_scanned,
        total_with_missing,
        keywords,
    })
}
