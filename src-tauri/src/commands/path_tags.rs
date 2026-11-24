use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathTag {
    pub path: String,
    pub color: String,
    pub label: String,
}

fn tags_db_path() -> Result<PathBuf, String> {
    let base = dirs::data_dir().ok_or_else(|| crate::err::code("tags_data_dir_missing"))?;
    let dir = base.join("FileTally");
    fs::create_dir_all(&dir).map_err(|e| crate::err::with_detail("tags_db_open_failed", e))?;
    Ok(dir.join("path_tags.db"))
}

fn open_tags_db() -> Result<Connection, String> {
    let path = tags_db_path()?;
    let conn =
        Connection::open(&path).map_err(|e| crate::err::with_detail("tags_db_open_failed", e))?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS path_tags (
            path TEXT PRIMARY KEY,
            color TEXT NOT NULL,
            label TEXT NOT NULL
        );",
    )
    .map_err(|e| crate::err::with_detail("tags_db_open_failed", e))?;
    Ok(conn)
}

#[tauri::command]
pub fn set_path_tag(path: String, color: String, label: String) -> Result<(), String> {
    crate::path_util::validate_user_path(&path)?;
    let conn = open_tags_db()?;
    conn.execute(
        "INSERT INTO path_tags(path, color, label) VALUES(?1,?2,?3)
         ON CONFLICT(path) DO UPDATE SET color=excluded.color, label=excluded.label",
        params![path, color, label],
    )
    .map_err(|e| crate::err::with_detail("tags_write_failed", e))?;
    Ok(())
}

#[tauri::command]
pub fn list_path_tags() -> Result<Vec<PathTag>, String> {
    let conn = open_tags_db()?;
    let mut stmt = conn
        .prepare("SELECT path, color, label FROM path_tags ORDER BY path")
        .map_err(|e| crate::err::with_detail("tags_query_failed", e))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(PathTag {
                path: row.get(0)?,
                color: row.get(1)?,
                label: row.get(2)?,
            })
        })
        .map_err(|e| crate::err::with_detail("tags_query_failed", e))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| crate::err::with_detail("tags_query_failed", e))?);
    }
    Ok(out)
}

#[tauri::command]
pub fn remove_path_tag(path: String) -> Result<(), String> {
    crate::path_util::validate_user_path(&path)?;
    let conn = open_tags_db()?;
    conn.execute("DELETE FROM path_tags WHERE path = ?1", params![path])
        .map_err(|e| crate::err::with_detail("tags_write_failed", e))?;
    Ok(())
}