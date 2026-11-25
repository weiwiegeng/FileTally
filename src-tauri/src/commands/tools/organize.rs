use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use walkdir::WalkDir;

use crate::commands::remote::{
    delete_remote_path, download_remote_file, invalidate_remote_list_cache_many, upload_local_file,
    walk_remote_files, RemoteSessionStore,
};
use crate::path_util::{self, join_remote_path, parse_remote_path};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeChange {
    pub from: String,
    pub to: String,
    pub action: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeOptions {
    pub mode: String,
    pub pattern: Option<String>,
    pub remove_empty: Option<bool>,
}

struct UndoLog {
    changes: Vec<OrganizeChange>,
}

static ORGANIZE_UNDO: Mutex<Option<UndoLog>> = Mutex::new(None);

fn apply_rename_pattern(stem: &str, ext: &str, index: usize, pattern: &str) -> String {
    pattern
        .replace("{name}", stem)
        .replace("{ext}", ext)
        .replace("{index}", &index.to_string())
}

fn collect_rename_preview(root: &Path, pattern: &str) -> Result<Vec<OrganizeChange>, String> {
    let mut out = Vec::new();
    let mut index = 1usize;
    for entry in WalkDir::new(root)
        .follow_links(false)
        .min_depth(1)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let parent = path.parent().unwrap_or(root);
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("file");
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| format!(".{e}"))
            .unwrap_or_default();
        let new_name = apply_rename_pattern(stem, &ext, index, pattern);
        let to = parent.join(&new_name);
        index += 1;
        out.push(OrganizeChange {
            from: path.to_string_lossy().to_string(),
            to: to.to_string_lossy().to_string(),
            action: "rename".into(),
        });
    }
    Ok(out)
}

async fn collect_remote_rename_preview(
    store: &RemoteSessionStore,
    root: &str,
    pattern: &str,
) -> Result<Vec<OrganizeChange>, String> {
    let (conn_id, base_rel) = parse_remote_path(root)?;
    let mut files: Vec<(String, u64, bool, i64)> = Vec::new();
    walk_remote_files(store, &conn_id, &base_rel, &mut files, 200_000).await?;
    let mut out = Vec::new();
    let mut index = 1usize;
    for (remote_path, _, is_dir, _) in files {
        if is_dir {
            continue;
        }
        let (_, rel) = parse_remote_path(&remote_path)?;
        let name = rel.rsplit('/').next().unwrap_or(&rel);
        let parent_rel = rel.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
        let (stem, ext) = match name.rsplit_once('.') {
            Some((s, e)) if !s.is_empty() => (s, format!(".{e}")),
            _ => (name, String::new()),
        };
        let new_name = apply_rename_pattern(stem, &ext, index, pattern);
        let new_rel = if parent_rel.is_empty() {
            new_name
        } else {
            format!("{parent_rel}/{new_name}")
        };
        index += 1;
        out.push(OrganizeChange {
            from: remote_path,
            to: join_remote_path(&conn_id, &new_rel),
            action: "rename".into(),
        });
    }
    Ok(out)
}

fn collect_by_ext_preview(root: &Path) -> Result<Vec<OrganizeChange>, String> {
    let mut out = Vec::new();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .min_depth(1)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("no_ext")
            .to_lowercase();
        let target_dir = root.join(&ext);
        let file_name = path.file_name().unwrap_or_default();
        let to = target_dir.join(file_name);
        out.push(OrganizeChange {
            from: path.to_string_lossy().to_string(),
            to: to.to_string_lossy().to_string(),
            action: "move".into(),
        });
    }
    Ok(out)
}

async fn collect_remote_by_ext_preview(
    store: &RemoteSessionStore,
    root: &str,
) -> Result<Vec<OrganizeChange>, String> {
    let (conn_id, base_rel) = parse_remote_path(root)?;
    let mut files: Vec<(String, u64, bool, i64)> = Vec::new();
    walk_remote_files(store, &conn_id, &base_rel, &mut files, 200_000).await?;
    let mut out = Vec::new();
    for (remote_path, _, is_dir, _) in files {
        if is_dir {
            continue;
        }
        let (_, rel) = parse_remote_path(&remote_path)?;
        let name = rel.rsplit('/').next().unwrap_or(&rel);
        let ext = name
            .rsplit_once('.')
            .map(|(_, e)| e.to_lowercase())
            .unwrap_or_else(|| "no_ext".into());
        let new_rel = if base_rel.is_empty() {
            format!("{ext}/{name}")
        } else {
            format!("{base_rel}/{ext}/{name}")
        };
        out.push(OrganizeChange {
            from: remote_path,
            to: join_remote_path(&conn_id, &new_rel),
            action: "move".into(),
        });
    }
    Ok(out)
}

fn find_empty_dirs(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut dirs: Vec<PathBuf> = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .map(|e| e.path().to_path_buf())
        .collect();
    dirs.sort_by_key(|b| std::cmp::Reverse(b.components().count()));

    let mut empty = Vec::new();
    let mut kept: HashSet<PathBuf> = HashSet::new();
    for dir in dirs {
        if dir == root {
            continue;
        }
        if kept.contains(&dir) {
            continue;
        }
        let mut has_entries = false;
        if let Ok(rd) = fs::read_dir(&dir) {
            for ent in rd.flatten() {
                let p = ent.path();
                if p.is_file() {
                    has_entries = true;
                    break;
                }
                if p.is_dir() && kept.contains(&p) {
                    has_entries = true;
                    break;
                }
            }
        }
        if !has_entries {
            empty.push(dir);
        } else {
            kept.insert(dir);
        }
    }
    Ok(empty)
}

fn collect_empty_dirs_preview(root: &Path, remove: bool) -> Result<Vec<OrganizeChange>, String> {
    let empty = find_empty_dirs(root)?;
    Ok(empty
        .into_iter()
        .map(|p| OrganizeChange {
            from: p.to_string_lossy().to_string(),
            to: String::new(),
            action: if remove {
                "remove_dir".into()
            } else {
                "list_empty_dir".into()
            },
        })
        .collect())
}

async fn build_preview_local(root: &Path, opts: &OrganizeOptions) -> Result<Vec<OrganizeChange>, String> {
    match opts.mode.as_str() {
        "rename" => {
            let pattern = opts
                .pattern
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| crate::err::code("organize_pattern_missing"))?;
            collect_rename_preview(root, pattern)
        }
        "by_ext" => collect_by_ext_preview(root),
        "empty_dirs" => {
            let remove = opts.remove_empty.unwrap_or(false);
            collect_empty_dirs_preview(root, remove)
        }
        _ => Err(crate::err::code("organize_mode_invalid")),
    }
}

async fn build_preview_remote(
    store: &RemoteSessionStore,
    root: &str,
    opts: &OrganizeOptions,
) -> Result<Vec<OrganizeChange>, String> {
    match opts.mode.as_str() {
        "rename" => {
            let pattern = opts
                .pattern
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| crate::err::code("organize_pattern_missing"))?;
            collect_remote_rename_preview(store, root, pattern).await
        }
        "by_ext" => collect_remote_by_ext_preview(store, root).await,
        "empty_dirs" => Ok(Vec::new()),
        _ => Err(crate::err::code("organize_mode_invalid")),
    }
}

async fn validate_root(
    store: &RemoteSessionStore,
    root: &str,
) -> Result<Option<PathBuf>, String> {
    path_util::validate_user_path(root)?;
    if path_util::is_remote_path(root) {
        if !crate::commands::remote::remote_path_exists_inner(store, root)
            .await
            .unwrap_or(false)
        {
            return Err(crate::err::with_detail("organize_root_missing", root));
        }
        Ok(None)
    } else {
        let p = PathBuf::from(root);
        if !p.exists() || !p.is_dir() {
            return Err(crate::err::with_detail("organize_root_missing", root));
        }
        Ok(Some(p))
    }
}

#[tauri::command]
pub async fn preview_organize(
    store: tauri::State<'_, Arc<RemoteSessionStore>>,
    root: String,
    options: OrganizeOptions,
) -> Result<Vec<OrganizeChange>, String> {
    let local = validate_root(store.inner().as_ref(), &root).await?;
    if let Some(root_path) = local {
        build_preview_local(&root_path, &options).await
    } else {
        build_preview_remote(store.inner().as_ref(), &root, &options).await
    }
}

fn execute_change_local(change: &OrganizeChange) -> Result<(), String> {
    match change.action.as_str() {
        "rename" | "move" => {
            let from = Path::new(&change.from);
            let to = Path::new(&change.to);
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent).map_err(|e| crate::err::with_detail("organize_failed", e))?;
            }
            if to.exists() {
                return Err(crate::err::with_detail("organize_target_exists", to.to_string_lossy()));
            }
            fs::rename(from, to).map_err(|e| crate::err::with_detail("organize_failed", e))?;
        }
        "remove_dir" => {
            fs::remove_dir(Path::new(&change.from))
                .map_err(|e| crate::err::with_detail("organize_failed", e))?;
        }
        "list_empty_dir" => {}
        other => return Err(crate::err::with_detail("organize_action_invalid", other)),
    }
    Ok(())
}

async fn execute_change_remote(
    store: &RemoteSessionStore,
    change: &OrganizeChange,
) -> Result<(), String> {
    match change.action.as_str() {
        "rename" | "move" => {
            let staging = std::env::temp_dir().join(format!(
                "filetally_organize_{}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&staging);
            fs::create_dir_all(&staging).map_err(|e| crate::err::with_detail("organize_failed", e))?;
            let file_name = parse_remote_path(&change.from)?
                .1
                .rsplit('/')
                .next()
                .unwrap_or("file")
                .to_string();
            let local_tmp = staging.join(file_name);
            let outcome = async {
                download_remote_file(store, &change.from, &local_tmp).await?;
                upload_local_file(store, &local_tmp, &change.to).await?;
                delete_remote_path(store, &change.from).await
            }
            .await;
            let _ = fs::remove_dir_all(&staging);
            outcome?;
            invalidate_remote_list_cache_many(&[change.from.clone(), change.to.clone()]);
        }
        "remove_dir" => {}
        "list_empty_dir" => {}
        other => return Err(crate::err::with_detail("organize_action_invalid", other)),
    }
    Ok(())
}

#[tauri::command]
pub async fn apply_organize(
    store: tauri::State<'_, Arc<RemoteSessionStore>>,
    root: String,
    options: OrganizeOptions,
) -> Result<Vec<OrganizeChange>, String> {
    let local = validate_root(store.inner().as_ref(), &root).await?;
    let preview = if let Some(ref root_path) = local {
        build_preview_local(root_path, &options).await?
    } else {
        build_preview_remote(store.inner().as_ref(), &root, &options).await?
    };
    if preview.is_empty() {
        return Ok(preview);
    }

    let list_only = options.mode == "empty_dirs" && !options.remove_empty.unwrap_or(false);
    if list_only {
        return Ok(preview);
    }

    let mut applied = Vec::new();
    let is_remote = local.is_none();
    for change in &preview {
        if change.action == "list_empty_dir" {
            continue;
        }
        if is_remote {
            execute_change_remote(store.inner().as_ref(), change).await?;
        } else {
            execute_change_local(change)?;
        }
        applied.push(change.clone());
    }

    if let Ok(mut guard) = ORGANIZE_UNDO.lock() {
        *guard = Some(UndoLog { changes: applied.clone() });
    }

    Ok(applied)
}

#[tauri::command]
pub async fn undo_organize(
    store: tauri::State<'_, Arc<RemoteSessionStore>>,
) -> Result<Vec<OrganizeChange>, String> {
    let log = ORGANIZE_UNDO
        .lock()
        .map_err(|_| crate::err::code("organize_undo_busy"))?
        .take()
        .ok_or_else(|| crate::err::code("organize_nothing_to_undo"))?;

    let mut undone = Vec::new();
    for change in log.changes.iter().rev() {
        if path_util::is_remote_path(&change.from) || path_util::is_remote_path(&change.to) {
            let reverse = OrganizeChange {
                from: change.to.clone(),
                to: change.from.clone(),
                action: change.action.clone(),
            };
            if execute_change_remote(store.inner().as_ref(), &reverse).await.is_ok() {
                undone.push(OrganizeChange {
                    from: change.to.clone(),
                    to: change.from.clone(),
                    action: "undo".into(),
                });
            }
            continue;
        }
        match change.action.as_str() {
            "rename" | "move" => {
                let from = Path::new(&change.to);
                let to = Path::new(&change.from);
                if from.exists() {
                    if let Some(parent) = to.parent() {
                        let _ = fs::create_dir_all(parent);
                    }
                    fs::rename(from, to).map_err(|e| crate::err::with_detail("organize_undo_failed", e))?;
                    undone.push(OrganizeChange {
                        from: change.to.clone(),
                        to: change.from.clone(),
                        action: "undo".into(),
                    });
                }
            }
            "remove_dir" => {
                let _ = fs::create_dir_all(Path::new(&change.from));
                undone.push(OrganizeChange {
                    from: String::new(),
                    to: change.from.clone(),
                    action: "undo_mkdir".into(),
                });
            }
            _ => {}
        }
    }
    Ok(undone)
}