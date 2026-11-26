//! Smart-check helpers for `remote://` (in-app SMB) folders.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use tauri::AppHandle;

use super::excel_runtime::{emit_progress, PER_FOLDER_ENTRY_SOFT_CAP, SCAN_ENTRY_SOFT_CAP};
use super::remote::{RemoteSession, RemoteSessionStore, SmbSessionStore};
use crate::job_runner;
use crate::path_util::{join_remote_path, parse_remote_path};

/// Recursively walk remote dir; push `(remote_path, size, is_dir)`. Honors cancel + soft cap.
async fn walk_remote_cancellable(
    store: &RemoteSessionStore,
    conn_id: &str,
    rel: &str,
    out: &mut Vec<(String, u64, bool)>,
    cap: usize,
    app: &AppHandle,
    job_id: u64,
    progress_every: usize,
) -> Result<(), String> {
    if out.len() >= cap || job_runner::is_cancelled(job_id) {
        return Ok(());
    }

    let entries = {
        let mut guard = store.inner.lock().await;
        let session = guard
            .get_mut(conn_id)
            .ok_or_else(|| crate::err::code("smb_session_missing"))?;
        match session {
            RemoteSession::Smb(s) => s
                .client
                .list_directory(&mut s.share, rel)
                .await
                .map_err(super::remote::map_smb_err)?,
            RemoteSession::WebDav { .. } | RemoteSession::Sftp(_) => {
                return Err(crate::err::code("remote_protocol_mismatch"));
            }
        }
    };

    for e in entries {
        if job_runner::is_cancelled(job_id) {
            return Ok(());
        }
        if e.name == "." || e.name == ".." {
            continue;
        }
        if out.len() >= cap {
            break;
        }
        let child_rel = if rel.is_empty() {
            e.name.clone()
        } else {
            format!("{rel}/{}", e.name)
        };
        let remote_path = join_remote_path(conn_id, &child_rel);
        if e.is_directory {
            out.push((remote_path, e.size, true));
            if out.len() % progress_every == 0 {
                emit_progress(app, job_id, "scanning", out.len() as u64, 0, "");
            }
            Box::pin(walk_remote_cancellable(
                store,
                conn_id,
                &child_rel,
                out,
                cap,
                app,
                job_id,
                progress_every,
            ))
            .await?;
        } else {
            out.push((remote_path, e.size, false));
            if out.len() % progress_every == 0 {
                emit_progress(app, job_id, "scanning", out.len() as u64, 0, "");
            }
        }
    }
    Ok(())
}

fn push_name_and_stem(names: &mut HashSet<String>, name: &str) {
    names.insert(name.to_string());
    if let Some(stem) = Path::new(name).file_stem().and_then(|s| s.to_str()) {
        if stem != name {
            names.insert(stem.to_string());
        }
    }
}

/// Full-tree name index under a remote folder (files + folders + stems).
pub async fn collect_remote_names(
    store: &SmbSessionStore,
    folder_path: &str,
    app: &AppHandle,
    job_id: u64,
) -> Result<(HashSet<String>, bool), String> {
    let (conn_id, rel) = parse_remote_path(folder_path)?;
    if !super::remote::remote_path_exists_inner(store, folder_path).await? {
        return Err(crate::err::code("target_folder_missing"));
    }

    let mut entries = Vec::new();
    walk_remote_cancellable(
        store,
        &conn_id,
        &rel,
        &mut entries,
        SCAN_ENTRY_SOFT_CAP + 1,
        app,
        job_id,
        200,
    )
    .await?;

    let truncated = entries.len() > SCAN_ENTRY_SOFT_CAP;
    if truncated {
        entries.truncate(SCAN_ENTRY_SOFT_CAP);
    }

    let mut names = HashSet::new();
    for (rpath, _, _) in &entries {
        let name = rpath.rsplit('/').next().unwrap_or(rpath);
        if !name.is_empty() {
            push_name_and_stem(&mut names, name);
        }
    }
    Ok((names, truncated || job_runner::is_cancelled(job_id)))
}

/// First-level remote directories (person/case folders).
pub async fn list_remote_person_folders(
    store: &SmbSessionStore,
    folder_path: &str,
) -> Result<Vec<(String, String)>, String> {
    let entries = super::remote::list_remote_dir_inner(store, folder_path).await?;
    let mut out = Vec::new();
    for e in entries {
        if e.is_dir {
            out.push((e.name, e.path));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

/// Deep contents under one remote person/case folder for template matching.
pub async fn collect_remote_contents(
    store: &SmbSessionStore,
    folder_path: &str,
    app: &AppHandle,
    job_id: u64,
) -> Result<(HashSet<String>, HashMap<String, String>, bool), String> {
    let (conn_id, rel) = parse_remote_path(folder_path)?;
    let mut entries = Vec::new();
    walk_remote_cancellable(
        store,
        &conn_id,
        &rel,
        &mut entries,
        PER_FOLDER_ENTRY_SOFT_CAP + 1,
        app,
        job_id,
        500,
    )
    .await?;

    let truncated = entries.len() > PER_FOLDER_ENTRY_SOFT_CAP;
    if truncated {
        entries.truncate(PER_FOLDER_ENTRY_SOFT_CAP);
    }

    let mut contents = HashSet::new();
    let mut content_paths = HashMap::new();
    for (rpath, _, _) in entries {
        let name = rpath.rsplit('/').next().unwrap_or(rpath.as_str()).to_string();
        if name.is_empty() {
            continue;
        }
        contents.insert(name.clone());
        content_paths.entry(name.clone()).or_insert_with(|| rpath.clone());
        if let Some(stem) = Path::new(&name).file_stem().and_then(|s| s.to_str()) {
            if stem != name {
                contents.insert(stem.to_string());
                content_paths
                    .entry(stem.to_string())
                    .or_insert_with(|| rpath.clone());
            }
        }
    }
    Ok((contents, content_paths, truncated))
}

/// Remote folder tree for UI preview. Returns nested children as
/// `(name, path, is_dir, nested_children)` plus totals and truncated flag.
pub async fn scan_remote_folder_tree(
    store: &SmbSessionStore,
    folder_path: &str,
    max_depth: usize,
    entry_cap: usize,
) -> Result<(Vec<RemoteTreeNode>, usize, usize, bool), String> {
    let depth = max_depth.clamp(1, 8);
    let mut files = 0usize;
    let mut folders = 0usize;
    let mut truncated = false;
    let children = build_remote_tree(
        store,
        folder_path,
        1,
        depth,
        &mut files,
        &mut folders,
        &mut truncated,
        entry_cap,
    )
    .await?;
    Ok((children, files, folders, truncated))
}

#[derive(Debug, Clone)]
pub struct RemoteTreeNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Vec<RemoteTreeNode>,
}

async fn build_remote_tree(
    store: &SmbSessionStore,
    folder_path: &str,
    current_depth: usize,
    max_depth: usize,
    files: &mut usize,
    folders: &mut usize,
    truncated: &mut bool,
    entry_cap: usize,
) -> Result<Vec<RemoteTreeNode>, String> {
    if *truncated || current_depth > max_depth {
        return Ok(Vec::new());
    }
    let entries = super::remote::list_remote_dir_inner(store, folder_path).await?;
    let mut children = Vec::new();
    for e in entries {
        if *files + *folders >= entry_cap {
            *truncated = true;
            break;
        }
        if e.is_dir {
            *folders += 1;
            let nested = if current_depth < max_depth && !*truncated {
                Box::pin(build_remote_tree(
                    store,
                    &e.path,
                    current_depth + 1,
                    max_depth,
                    files,
                    folders,
                    truncated,
                    entry_cap,
                ))
                .await?
            } else {
                Vec::new()
            };
            children.push(RemoteTreeNode {
                name: e.name,
                path: e.path,
                is_dir: true,
                children: nested,
            });
        } else {
            *files += 1;
            children.push(RemoteTreeNode {
                name: e.name,
                path: e.path,
                is_dir: false,
                children: Vec::new(),
            });
        }
    }
    Ok(children)
}

