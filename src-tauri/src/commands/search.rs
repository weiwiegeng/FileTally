use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use walkdir::WalkDir;
use regex::RegexBuilder;
use rayon::prelude::*;
use rayon::ThreadPoolBuilder;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchProgress {
    pub job_id: u64,
    pub stage: String,
    pub current: u64,
    pub total: u64,
    pub message: String,
}

fn emit_search_progress(app: &AppHandle, job_id: u64, stage: &str, current: u64, total: u64, message: &str) {
    let _ = app.emit(
        "search-progress",
        SearchProgress {
            job_id,
            stage: stage.to_string(),
            current,
            total,
            message: message.to_string(),
        },
    );
}

/// Per-job cancel: cancel only affects the job id that was current when cancel was called.
static SEARCH_JOB_ID: AtomicU64 = AtomicU64::new(0);
static SEARCH_CANCEL_ID: AtomicU64 = AtomicU64::new(0);

const SEARCH_FILE_CAP: usize = 500_000;
/// After walk cancel/timeout, still scan a bounded set for partial hits (then honor cancel again).
const POST_WALK_CANCEL_CAP: usize = 2_000;

fn begin_search_job() -> u64 {
    SEARCH_JOB_ID.fetch_add(1, Ordering::SeqCst) + 1
}

fn is_search_cancelled(job_id: u64) -> bool {
    SEARCH_CANCEL_ID.load(Ordering::SeqCst) == job_id
}

fn clear_search_cancel(job_id: u64) {
    let _ = SEARCH_CANCEL_ID.compare_exchange(job_id, 0, Ordering::SeqCst, Ordering::SeqCst);
}

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
    pub cancelled: bool,
    pub truncated: bool,
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
    pub cancelled: bool,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    pub search_content: bool,
    pub search_filename: bool,      // 是否搜索文件名
    pub case_sensitive: bool,
    pub include_hidden: bool,
    pub file_extensions: Option<Vec<String>>,
    pub max_pdf_size_mb: Option<u64>,  // PDF 最大处理大小 (MB)
    pub max_text_size_mb: Option<u64>, // 文本最大读取大小 (MB)
    pub max_concurrency: Option<usize>, // 并行线程数
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
            max_text_size_mb: Some(10),
            max_concurrency: Some(4),
        }
    }
}

/// 预分配搜索 job id（供前端超时/取消精确指向，避免误杀后续任务）
#[tauri::command]
pub fn prepare_search() -> Result<u64, String> {
    Ok(begin_search_job())
}

/// 取消指定搜索 job；未传 job_id 时取消当前 job
#[tauri::command]
pub fn cancel_search(job_id: Option<u64>) -> Result<(), String> {
    let id = job_id
        .filter(|v| *v > 0)
        .unwrap_or_else(|| SEARCH_JOB_ID.load(Ordering::SeqCst));
    if id > 0 {
        SEARCH_CANCEL_ID.store(id, Ordering::SeqCst);
    }
    Ok(())
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

/// 读取文本文件内容（带大小上限）
fn read_text_file(path: &Path, max_bytes: u64) -> Option<String> {
    if let Ok(metadata) = fs::metadata(path) {
        if metadata.len() > max_bytes {
            return None;
        }
    }

    // 先尝试 UTF-8
    if let Ok(content) = fs::read_to_string(path) {
        return Some(content);
    }

    // 尝试其他编码
    if let Ok(bytes) = fs::read(path) {
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
    max_text_bytes: u64,
    job_id: u64,
    respect_cancel: bool,
) -> FileSearchResult {
    // Walk-phase cancel keeps respect_cancel=false so already-listed files still yield partial hits.
    if respect_cancel && is_search_cancelled(job_id) {
        return FileSearchResult::Skipped;
    }

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
                content: format!("[filename] {}", file_name),
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
            if let Some(content) = read_text_file(file_path, max_text_bytes) {
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
    app: AppHandle,
    store: tauri::State<'_, std::sync::Arc<crate::commands::remote::SmbSessionStore>>,
    paths: Vec<String>,
    query: String,
    options: SearchOptions,
    job_id: Option<u64>,
) -> Result<SearchResponse, String> {
    let resolved_job = match job_id {
        Some(id) if id > 0 => id,
        _ => begin_search_job(),
    };
    emit_search_progress(&app, resolved_job, "scanning", 0, 0, &query);

    let mut remote_paths = Vec::new();
    let mut local_paths = Vec::new();
    for p in paths {
        if crate::path_util::is_remote_path(&p) {
            remote_paths.push(p);
        } else {
            local_paths.push(p);
        }
    }

    let mut matched = Vec::new();
    let mut unmatched = Vec::new();
    let mut total_scanned = 0usize;
    let mut cancelled = false;
    let mut truncated = false;

    if !local_paths.is_empty() {
        let app2 = app.clone();
        let local = tokio::task::spawn_blocking({
            let query = query.clone();
            let options = options.clone();
            move || search_files_sync(app2, local_paths, query, options, Some(resolved_job))
        })
        .await
        .map_err(|e| crate::err::with_detail("analysis_task_failed", e))??;
        matched.extend(local.matched);
        unmatched.extend(local.unmatched);
        total_scanned += local.total_scanned;
        cancelled |= local.cancelled;
        truncated |= local.truncated;
    }

    if !remote_paths.is_empty() {
        let remote = search_remote_paths(store.as_ref(), remote_paths, &query, &options).await?;
        matched.extend(remote.matched);
        unmatched.extend(remote.unmatched);
        total_scanned += remote.total_scanned;
        cancelled |= remote.cancelled;
        truncated |= remote.truncated;
    }

    if total_scanned == 0 && matched.is_empty() && unmatched.is_empty() {
        return Err(crate::err::code("search_need_paths"));
    }

    emit_search_progress(
        &app,
        resolved_job,
        if cancelled { "cancelled" } else { "done" },
        total_scanned as u64,
        total_scanned as u64,
        &query,
    );

    Ok(SearchResponse {
        matched,
        unmatched,
        total_scanned,
        cancelled,
        truncated,
    })
}

async fn search_remote_paths(
    store: &crate::commands::remote::SmbSessionStore,
    paths: Vec<String>,
    query: &str,
    options: &SearchOptions,
) -> Result<SearchResponse, String> {
    if query.trim().is_empty() {
        return Err(crate::err::code("search_need_query"));
    }
    if !options.search_content && !options.search_filename {
        return Err(crate::err::code("search_need_mode"));
    }

    let mut matched = Vec::new();
    let mut unmatched = Vec::new();
    let mut total_scanned = 0usize;
    let mut truncated = false;
    const CAP: usize = 50_000;

    for path in &paths {
        crate::path_util::validate_user_path(path)?;
        let (conn_id, rel) = crate::path_util::parse_remote_path(path)?;

        // Verify session / root
        if !crate::commands::remote::remote_path_exists_inner(store, path).await? {
            return Err(crate::err::with_detail("search_path_missing", path));
        }

        let mut files = Vec::new();
        crate::commands::remote::walk_remote_files(store, &conn_id, &rel, &mut files, CAP + 1)
            .await?;
        if files.len() > CAP {
            truncated = true;
            files.truncate(CAP);
        }

        for (rpath, _size, is_dir) in files {
            if is_dir {
                continue;
            }
            total_scanned += 1;
            let file_name = rpath.rsplit('/').next().unwrap_or(&rpath).to_string();
            let extension = Path::new(&file_name)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_string();

            if let Some(ref exts) = options.file_extensions {
                if !exts.is_empty() {
                    let ok = exts.iter().any(|e| {
                        e.trim_start_matches('.')
                            .eq_ignore_ascii_case(extension.trim_start_matches('.'))
                    });
                    if !ok {
                        continue;
                    }
                }
            }

            let mut matches = Vec::new();
            let mut was_searched = false;

            if options.search_filename {
                was_searched = true;
                if match_filename(&file_name, query, options.case_sensitive) {
                    matches.push(SearchMatch {
                        line_number: 0,
                        content: format!("[filename] {}", file_name),
                        match_start: 0,
                        match_end: 0,
                    });
                }
            }

            // Content search for small text-like files only
            if options.search_content {
                let text_like = matches!(
                    extension.to_lowercase().as_str(),
                    "txt" | "md" | "csv" | "json" | "xml" | "log" | "yml" | "yaml" | "rs" | "ts"
                        | "tsx" | "js" | "jsx" | "py" | "java" | "go" | "c" | "cpp" | "h" | "hpp"
                        | "html" | "css" | "sql" | "toml" | "ini" | "conf"
                );
                if text_like {
                    was_searched = true;
                    if let Ok(bytes) =
                        crate::commands::remote::read_remote_file_bytes(store, &rpath, 2 * 1024 * 1024)
                            .await
                    {
                        let (decoded, _, _) = encoding_rs::UTF_8.decode(&bytes);
                        let content = if decoded.contains('\u{FFFD}') {
                            let (gbk, _, _) = encoding_rs::GBK.decode(&bytes);
                            gbk.into_owned()
                        } else {
                            decoded.into_owned()
                        };
                        matches.extend(search_text_content(
                            &content,
                            query,
                            options.case_sensitive,
                        ));
                    }
                }
            }

            if !was_searched {
                continue;
            }

            let file_type = get_file_type(&extension);
            if matches.is_empty() {
                unmatched.push(UnmatchedFile {
                    file_path: rpath,
                    file_name,
                    file_type,
                });
            } else {
                let match_count = matches.len();
                matched.push(SearchResult {
                    file_path: rpath,
                    file_name,
                    file_type,
                    matches,
                    match_count,
                });
            }
        }
    }

    Ok(SearchResponse {
        matched,
        unmatched,
        total_scanned,
        cancelled: false,
        truncated,
    })
}

fn search_files_sync(
    app: AppHandle,
    paths: Vec<String>,
    query: String,
    options: SearchOptions,
    job_id: Option<u64>,
) -> Result<SearchResponse, String> {
    let job_id = match job_id {
        Some(id) if id > 0 => id,
        _ => begin_search_job(),
    };

    if paths.is_empty() {
        return Err(crate::err::code("search_need_paths"));
    }

    if query.trim().is_empty() {
        return Err(crate::err::code("search_need_query"));
    }

    if !options.search_content && !options.search_filename {
        return Err(crate::err::code("search_need_mode"));
    }
    
    for path in &paths {
        crate::path_util::validate_user_path(path)?;
        let search_path = Path::new(path);
        if !search_path.exists() {
            return Err(crate::err::with_detail("search_path_missing", path));
        }
    }
    
    let mut files_to_search: Vec<PathBuf> = Vec::new();
    let mut cancelled_during_walk = false;
    let mut truncated = false;

    'outer: for path in &paths {
        let search_path = Path::new(path);
        for entry in WalkDir::new(search_path).follow_links(false).into_iter().filter_map(|e| e.ok()) {
            if is_search_cancelled(job_id) {
                cancelled_during_walk = true;
                break 'outer;
            }
            let ft = entry.file_type();
            // Skip symlinks entirely (consistent with transfer; avoid following link targets).
            if ft.is_symlink() || ft.is_dir() {
                continue;
            }
            let entry_path = entry.path();
            if !options.include_hidden && is_hidden(entry_path) {
                continue;
            }
            if let Some(ref exts) = options.file_extensions {
                let extension = entry_path.extension().and_then(|e| e.to_str()).unwrap_or("");
                if !exts.is_empty() && !exts.iter().any(|e| e.eq_ignore_ascii_case(extension)) {
                    continue;
                }
            }
            files_to_search.push(entry_path.to_path_buf());
            if files_to_search.len() % 200 == 0 {
                emit_search_progress(
                    &app,
                    job_id,
                    "scanning",
                    files_to_search.len() as u64,
                    0,
                    &query,
                );
            }
            // CAP+1 sentinel: exact-CAP trees are not falsely marked truncated.
            if files_to_search.len() > SEARCH_FILE_CAP {
                files_to_search.truncate(SEARCH_FILE_CAP);
                truncated = true;
                break 'outer;
            }
        }
    }

    // Walk-phase cancel: clear cancel so listed files can still yield partial hits,
    // but cap the set and keep respect_cancel=true so a new cancel/timeout still stops work.
    let walk_cancelled = cancelled_during_walk;
    if walk_cancelled {
        clear_search_cancel(job_id);
        if files_to_search.len() > POST_WALK_CANCEL_CAP {
            files_to_search.truncate(POST_WALK_CANCEL_CAP);
        }
    }

    let max_pdf_size = options.max_pdf_size_mb.unwrap_or(30);
    let max_text_bytes = options
        .max_text_size_mb
        .unwrap_or(10)
        .saturating_mul(1024 * 1024)
        .max(1);
    let concurrency = options.max_concurrency.unwrap_or(4).clamp(1, 16);
    let pool = ThreadPoolBuilder::new()
        .num_threads(concurrency)
        .build()
        .map_err(|e| crate::err::with_detail("thread_pool_failed", e))?;

    let results: Vec<FileSearchResult> = pool.install(|| {
        files_to_search
            .par_iter()
            .map(|file_path| {
                search_single_file(
                    file_path,
                    &query,
                    options.case_sensitive,
                    options.search_content,
                    options.search_filename,
                    max_pdf_size,
                    max_text_bytes,
                    job_id,
                    true,
                )
            })
            .collect()
    });

    let cancelled = walk_cancelled || is_search_cancelled(job_id);
    
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
    
    matched.sort_by(|a, b| b.match_count.cmp(&a.match_count));
    
    Ok(SearchResponse {
        matched,
        unmatched,
        total_scanned,
        cancelled,
        truncated,
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
    max_text_bytes: u64,
    job_id: u64,
    respect_cancel: bool,
    scanned: &AtomicUsize,
) -> Option<KeywordCheckResult> {
    if respect_cancel && is_search_cancelled(job_id) {
        return None;
    }
    scanned.fetch_add(1, Ordering::Relaxed);

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
            read_text_file(file_path, max_text_bytes)
        } else if is_pdf_file(&extension) {
            extract_pdf_text(file_path, max_pdf_size_mb)
        } else {
            None
        }
    } else {
        None
    };
    
    // 仅内容搜索且读不到：
    // - 文本/PDF（尝试过但失败）→ 记为全部缺失
    // - 其它二进制/不支持类型 → 跳过，避免误报刷屏
    if !search_filename && content.is_none() {
        if search_content && (is_text_file(&extension) || is_pdf_file(&extension)) {
            return Some(KeywordCheckResult {
                file_path: file_path.to_string_lossy().to_string(),
                file_name,
                file_type,
                missing_keywords: keywords.to_vec(),
            });
        }
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
    paths: Vec<String>,
    keywords: Vec<String>,
    options: SearchOptions,
    job_id: Option<u64>,
) -> Result<KeywordCheckResponse, String> {
    tokio::task::spawn_blocking(move || check_keywords_sync(paths, keywords, options, job_id))
        .await
        .map_err(|e| crate::err::with_detail("analysis_task_failed", e))?
}

fn check_keywords_sync(
    paths: Vec<String>,
    keywords: Vec<String>,
    options: SearchOptions,
    job_id: Option<u64>,
) -> Result<KeywordCheckResponse, String> {
    let job_id = match job_id {
        Some(id) if id > 0 => id,
        _ => begin_search_job(),
    };

    if paths.is_empty() {
        return Err(crate::err::code("search_need_paths"));
    }
    
    for path in &paths {
        crate::path_util::validate_user_path(path)?;
        let search_path = Path::new(path);
        if !search_path.exists() {
            return Err(crate::err::with_detail("search_path_missing", path));
        }
    }
    
    if keywords.is_empty() {
        return Err(crate::err::code("search_need_keywords"));
    }

    if !options.search_content && !options.search_filename {
        return Err(crate::err::code("search_need_mode"));
    }
    
    let mut files_to_check: Vec<PathBuf> = Vec::new();
    let mut cancelled_during_walk = false;
    let mut truncated = false;

    'outer: for path in &paths {
        let search_path = Path::new(path);
        for entry in WalkDir::new(search_path).follow_links(false).into_iter().filter_map(|e| e.ok()) {
            if is_search_cancelled(job_id) {
                cancelled_during_walk = true;
                break 'outer;
            }
            let ft = entry.file_type();
            if ft.is_symlink() || ft.is_dir() {
                continue;
            }
            let entry_path = entry.path();
            if !options.include_hidden && is_hidden(entry_path) {
                continue;
            }
            if let Some(ref exts) = options.file_extensions {
                let extension = entry_path.extension().and_then(|e| e.to_str()).unwrap_or("");
                if !exts.is_empty() && !exts.iter().any(|e| e.eq_ignore_ascii_case(extension)) {
                    continue;
                }
            }
            files_to_check.push(entry_path.to_path_buf());
            if files_to_check.len() > SEARCH_FILE_CAP {
                files_to_check.truncate(SEARCH_FILE_CAP);
                truncated = true;
                break 'outer;
            }
        }
    }

    let walk_cancelled = cancelled_during_walk;
    if walk_cancelled {
        clear_search_cancel(job_id);
        if files_to_check.len() > POST_WALK_CANCEL_CAP {
            files_to_check.truncate(POST_WALK_CANCEL_CAP);
        }
    }

    let max_pdf_size = options.max_pdf_size_mb.unwrap_or(30);
    let max_text_bytes = options
        .max_text_size_mb
        .unwrap_or(10)
        .saturating_mul(1024 * 1024)
        .max(1);
    let concurrency = options.max_concurrency.unwrap_or(4).clamp(1, 16);
    let pool = ThreadPoolBuilder::new()
        .num_threads(concurrency)
        .build()
        .map_err(|e| crate::err::with_detail("thread_pool_failed", e))?;

    let scanned = Arc::new(AtomicUsize::new(0));
    let results: Vec<Option<KeywordCheckResult>> = pool.install(|| {
        files_to_check
            .par_iter()
            .map(|file_path| {
                check_file_keywords(
                    file_path,
                    &keywords,
                    options.case_sensitive,
                    options.search_content,
                    options.search_filename,
                    max_pdf_size,
                    max_text_bytes,
                    job_id,
                    true,
                    &scanned,
                )
            })
            .collect()
    });

    let cancelled = walk_cancelled || is_search_cancelled(job_id);
    
    let mut check_results = Vec::new();
    let total_scanned = if cancelled {
        scanned.load(Ordering::Relaxed)
    } else {
        files_to_check.len()
    };
    
    for result in results {
        if let Some(r) = result {
            check_results.push(r);
        }
    }
    
    check_results.sort_by(|a, b| b.missing_keywords.len().cmp(&a.missing_keywords.len()));
    
    let total_with_missing = check_results.len();
    
    Ok(KeywordCheckResponse {
        results: check_results,
        total_scanned,
        total_with_missing,
        keywords,
        cancelled,
        truncated,
    })
}
