//! Smart-check helpers for `remote://` (in-app SMB) folders.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use tauri::AppHandle;

use super::excel_runtime::{
    emit_progress, is_cancelled, PER_FOLDER_ENTRY_SOFT_CAP, SCAN_ENTRY_SOFT_CAP,
};
use super::remote::{RemoteSession, RemoteSessionStore, SmbSessionStore};
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
    if out.len() >= cap || is_cancelled(job_id) {
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
        if is_cancelled(job_id) {
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
    Ok((names, truncated || is_cancelled(job_id)))
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

/// Shallow tree preview (depth 1) for remote folders.
pub async fn scan_remote_folder_tree_shallow(
    store: &SmbSessionStore,
    folder_path: &str,
) -> Result<(Vec<(String, String, bool)>, usize, usize), String> {
    let entries = super::remote::list_remote_dir_inner(store, folder_path).await?;
    let mut children = Vec::new();
    let mut files = 0usize;
    let mut folders = 0usize;
    for e in entries {
        if e.is_dir {
            folders += 1;
        } else {
            files += 1;
        }
        children.push((e.name, e.path, e.is_dir));
    }
    // root itself counts as 1 folder in local scanner; keep consistent-ish: only children
    Ok((children, files, folders))
}
