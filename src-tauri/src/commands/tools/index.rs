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