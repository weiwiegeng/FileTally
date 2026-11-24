use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use walkdir::WalkDir;

use crate::path_util;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedFile {
    pub path: String,
    pub name: String,
    pub ext: String,
    pub size: u64,
    pub mtime: i64,
    pub root: String,
}

fn index_db_path() -> Result<std::path::PathBuf, String> {
    let base = dirs::data_dir().ok_or_else(|| crate::err::code("index_data_dir_missing"))?;
    let dir = base.join("FileTally");
    fs::create_dir_all(&dir).map_err(|e| crate::err::with_detail("index_db_open_failed", e))?;
    Ok(dir.join("search_index.db"))
}

fn open_index_db() -> Result<Connection, String> {
    let path = index_db_path()?;
    let conn =
        Connection::open(&path).map_err(|e| crate::err::with_detail("index_db_open_failed", e))?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS files (
            path TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            ext TEXT NOT NULL,
            size INTEGER NOT NULL,
            mtime INTEGER NOT NULL,
            root TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_files_name ON files(name);
        CREATE INDEX IF NOT EXISTS idx_files_root ON files(root);
        ",
    )
    .map_err(|e| crate::err::with_detail("index_db_open_failed", e))?;
    Ok(conn)
}

#[tauri::command]
pub fn index_root(root: String) -> Result<u64, String> {
    path_util::validate_user_path(&root)?;
    if path_util::is_remote_path(&root) {
        return Err(crate::err::code("index_remote_unsupported"));
    }
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err(crate::err::with_detail("index_root_missing", &root));
    }

    let mut conn = open_index_db()?;
    conn.execute("DELETE FROM files WHERE root = ?1", params![root])
        .map_err(|e| crate::err::with_detail("index_write_failed", e))?;

    let mut count = 0u64;
    let tx = conn
        .transaction()
        .map_err(|e| crate::err::with_detail("index_write_failed", e))?;
    {
        let mut stmt = tx
            .prepare(
                "INSERT OR REPLACE INTO files(path, name, ext, size, mtime, root) VALUES(?1,?2,?3,?4,?5,?6)",
            )
            .map_err(|e| crate::err::with_detail("index_write_failed", e))?;

        for entry in WalkDir::new(root_path)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let p = entry.path();
            if !p.is_file() {
                continue;
            }
            let meta = match fs::metadata(p) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let name = p
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            let ext = p
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            let path_str = p.to_string_lossy().to_string();
            stmt.execute(params![path_str, name, ext, meta.len() as i64, mtime, root])
                .map_err(|e| crate::err::with_detail("index_write_failed", e))?;
            count += 1;
        }
    }
    tx.commit()
        .map_err(|e| crate::err::with_detail("index_write_failed", e))?;
    Ok(count)
}

#[tauri::command]
pub fn search_index(query: String, root: Option<String>, limit: Option<u64>) -> Result<Vec<IndexedFile>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Err(crate::err::code("index_query_empty"));
    }
    let cap = limit.unwrap_or(500).min(10_000);

    let conn = open_index_db()?;
    let pattern = format!("%{}%", q.replace('%', "").replace('_', ""));

    let mut out = Vec::new();
    if let Some(r) = root.as_ref().filter(|s| !s.trim().is_empty()) {
        let mut stmt = conn
            .prepare(
                "SELECT path, name, ext, size, mtime, root FROM files WHERE root = ?1 AND name LIKE ?2 ESCAPE '\\' LIMIT ?3",
            )
            .map_err(|e| crate::err::with_detail("index_query_failed", e))?;
        let rows = stmt
            .query_map(params![r, pattern, cap as i64], |row| {
                Ok(IndexedFile {
                    path: row.get(0)?,
                    name: row.get(1)?,
                    ext: row.get(2)?,
                    size: row.get::<_, i64>(3)? as u64,
                    mtime: row.get(4)?,
                    root: row.get(5)?,
                })
            })
            .map_err(|e| crate::err::with_detail("index_query_failed", e))?;
        for row in rows {
            out.push(row.map_err(|e| crate::err::with_detail("index_query_failed", e))?);
        }
    } else {
        let mut stmt = conn
            .prepare(
                "SELECT path, name, ext, size, mtime, root FROM files WHERE name LIKE ?1 ESCAPE '\\' LIMIT ?2",
            )
            .map_err(|e| crate::err::with_detail("index_query_failed", e))?;
        let rows = stmt
            .query_map(params![pattern, cap as i64], |row| {
                Ok(IndexedFile {
                    path: row.get(0)?,
                    name: row.get(1)?,
                    ext: row.get(2)?,
                    size: row.get::<_, i64>(3)? as u64,
                    mtime: row.get(4)?,
                    root: row.get(5)?,
                })
            })
            .map_err(|e| crate::err::with_detail("index_query_failed", e))?;
        for row in rows {
            out.push(row.map_err(|e| crate::err::with_detail("index_query_failed", e))?);
        }
    }

    Ok(out)
}

/// Filename-only search against the SQLite index, shaped like `SearchResponse`.
#[tauri::command]
pub fn search_index_filename(
    query: String,
    roots: Vec<String>,
    limit: Option<u64>,
) -> Result<crate::commands::search::SearchResponse, String> {
    let q = query.trim();
    if q.is_empty() {
        return Err(crate::err::code("index_query_empty"));
    }

    let cap = limit.unwrap_or(500).min(10_000);
    let conn = open_index_db()?;
    let pattern = format!("%{}%", q.replace('%', "").replace('_', ""));

    let mut matched = Vec::new();
    let fetch_roots: Vec<String> = if roots.iter().any(|r| !r.trim().is_empty()) {
        roots
            .into_iter()
            .filter(|r| !r.trim().is_empty())
            .collect()
    } else {
        vec![]
    };

    let mut rows = Vec::new();
    if fetch_roots.is_empty() {
        let mut stmt = conn
            .prepare(
                "SELECT path, name, ext, size, mtime, root FROM files WHERE name LIKE ?1 ESCAPE '\\' LIMIT ?2",
            )
            .map_err(|e| crate::err::with_detail("index_query_failed", e))?;
        let mapped = stmt
            .query_map(params![pattern, cap as i64], row_to_indexed)
            .map_err(|e| crate::err::with_detail("index_query_failed", e))?;
        for row in mapped {
            rows.push(row.map_err(|e| crate::err::with_detail("index_query_failed", e))?);
        }
    } else {
        for r in fetch_roots {
            path_util::validate_user_path(&r)?;
            let mut stmt = conn
                .prepare(
                    "SELECT path, name, ext, size, mtime, root FROM files WHERE root = ?1 AND name LIKE ?2 ESCAPE '\\' LIMIT ?3",
                )
                .map_err(|e| crate::err::with_detail("index_query_failed", e))?;
            let mapped = stmt
                .query_map(params![r, pattern, cap as i64], row_to_indexed)
                .map_err(|e| crate::err::with_detail("index_query_failed", e))?;
            for row in mapped {
                rows.push(row.map_err(|e| crate::err::with_detail("index_query_failed", e))?);
            }
        }
        if rows.len() as u64 > cap {
            rows.truncate(cap as usize);
        }
    }

    let total_scanned = rows.len();
    for hit in rows {
        let file_type = file_type_for_ext(&hit.ext);
        matched.push(crate::commands::search::SearchResult {
            file_path: hit.path.clone(),
            file_name: hit.name.clone(),
            file_type,
            matches: vec![crate::commands::search::SearchMatch {
                line_number: 0,
                content: format!("[filename] {}", hit.name),
                match_start: 0,
                match_end: 0,
            }],
            match_count: 1,
        });
    }

    Ok(crate::commands::search::SearchResponse {
        matched,
        unmatched: vec![],
        total_scanned,
        cancelled: false,
        truncated: false,
    })
}

fn row_to_indexed(row: &rusqlite::Row<'_>) -> rusqlite::Result<IndexedFile> {
    Ok(IndexedFile {
        path: row.get(0)?,
        name: row.get(1)?,
        ext: row.get(2)?,
        size: row.get::<_, i64>(3)? as u64,
        mtime: row.get(4)?,
        root: row.get(5)?,
    })
}

fn file_type_for_ext(ext: &str) -> String {
    match ext.to_lowercase().as_str() {
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

/// Re-index only files whose on-disk mtime is newer than the stored row (or missing).
#[tauri::command]
pub fn index_root_incremental(root: String) -> Result<u64, String> {
    path_util::validate_user_path(&root)?;
    if path_util::is_remote_path(&root) {
        return Err(crate::err::code("index_remote_unsupported"));
    }
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err(crate::err::with_detail("index_root_missing", &root));
    }

    let mut conn = open_index_db()?;
    let tx = conn
        .transaction()
        .map_err(|e| crate::err::with_detail("index_write_failed", e))?;

    let mut count = 0u64;
    {
        let mut stmt = tx
            .prepare(
                "INSERT OR REPLACE INTO files(path, name, ext, size, mtime, root) VALUES(?1,?2,?3,?4,?5,?6)",
            )
            .map_err(|e| crate::err::with_detail("index_write_failed", e))?;

        let mut existing_mtime = tx
            .prepare("SELECT mtime FROM files WHERE path = ?1")
            .map_err(|e| crate::err::with_detail("index_write_failed", e))?;

        for entry in WalkDir::new(root_path)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let p = entry.path();
            if !p.is_file() {
                continue;
            }
            let meta = match fs::metadata(p) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            let path_str = p.to_string_lossy().to_string();
            let stored: Option<i64> = existing_mtime
                .query_row(params![path_str], |row| row.get(0))
                .ok();
            if stored == Some(mtime) {
                continue;
            }

            let name = p
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            let ext = p
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            stmt.execute(params![path_str, name, ext, meta.len() as i64, mtime, root])
                .map_err(|e| crate::err::with_detail("index_write_failed", e))?;
            count += 1;
        }
    }
    tx.commit()
        .map_err(|e| crate::err::with_detail("index_write_failed", e))?;
    Ok(count)
}