//! Remote NAS connectivity: system SMB mount + in-app SMB2 sessions.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use smb2::{DirectoryEntry, SmbClient};
use tauri::State;
use tokio::sync::Mutex;

use crate::err;
use crate::path_util::{self, join_remote_path, parse_remote_path};

/// In-memory SMB sessions keyed by frontend connection id.
pub struct SmbSessionStore {
    inner: Mutex<HashMap<String, SmbSession>>,
}

impl Default for SmbSessionStore {
    fn default() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }
}

struct SmbSession {
    client: SmbClient,
    share: smb2::Tree,
    share_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub size_formatted: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemMountResult {
    pub mount_point: String,
}

fn format_size(size: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = KB * 1024;
    const GB: u64 = MB * 1024;

    if size >= GB {
        format!("{:.2} GB", size as f64 / GB as f64)
    } else if size >= MB {
        format!("{:.2} MB", size as f64 / MB as f64)
    } else if size >= KB {
        format!("{:.2} KB", size as f64 / KB as f64)
    } else {
        format!("{} B", size)
    }
}

fn map_smb_err(e: impl std::fmt::Display) -> String {
    let msg = e.to_string();
    let lower = msg.to_lowercase();
    if lower.contains("auth")
        || lower.contains("logon")
        || lower.contains("password")
        || lower.contains("access denied")
        || lower.contains("status_logon_failure")
        || lower.contains("status_access_denied")
    {
        err::with_detail("smb_auth_failed", msg)
    } else if lower.contains("timed out")
        || lower.contains("timeout")
        || lower.contains("connection refused")
        || lower.contains("network")
        || lower.contains("unreachable")
        || lower.contains("failed to connect")
        || lower.contains("os error 61")
        || lower.contains("os error 111")
    {
        err::with_detail("smb_host_unreachable", msg)
    } else if lower.contains("not found")
        || lower.contains("bad network name")
        || lower.contains("status_bad_network_name")
        || lower.contains("no such share")
    {
        err::with_detail("smb_share_missing", msg)
    } else {
        err::with_detail("smb_connect_failed", msg)
    }
}

fn smb_addr(host: &str, port: Option<u16>) -> String {
    let host = host.trim().trim_end_matches('/');
    // Strip accidental scheme
    let host = host
        .strip_prefix("smb://")
        .or_else(|| host.strip_prefix("SMB://"))
        .unwrap_or(host);
    let port = port.unwrap_or(445);
    if host.contains(':') && !host.starts_with('[') {
        // Already has port or IPv6 without brackets — keep as-is if looks like host:port
        if host.matches(':').count() == 1 {
            return host.to_string();
        }
    }
    format!("{host}:{port}")
}

fn build_smb_url(host: &str, share: &str, username: Option<&str>) -> String {
    let host = host.trim();
    let share = share.trim().trim_matches('/');
    match username.map(str::trim).filter(|u| !u.is_empty()) {
        Some(user) => {
            let encoded: String = user
                .chars()
                .map(|c| match c {
                    ' ' => "%20".to_string(),
                    '@' => "%40".to_string(),
                    _ => c.to_string(),
                })
                .collect();
            format!("smb://{encoded}@{host}/{share}")
        }
        None => format!("smb://{host}/{share}"),
    }
}

fn path_accessible(path: &Path) -> bool {
    path.exists()
}

/// Open system SMB mount dialog / map drive and return the mount root.
#[tauri::command]
pub async fn connect_system_smb(
    host: String,
    share: String,
    username: Option<String>,
    password: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<SystemMountResult, String> {
    let host = host.trim().to_string();
    let share = share.trim().trim_matches('/').to_string();
    if host.is_empty() || share.is_empty() {
        return Err(err::code("smb_params_missing"));
    }

    let timeout = Duration::from_millis(timeout_ms.unwrap_or(30_000));
    let user = username.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let pass = password.as_deref().filter(|s| !s.is_empty());

    #[cfg(target_os = "macos")]
    {
        let _ = pass; // macOS prompts via Finder dialog
        let url = build_smb_url(&host, &share, user);
        let status = Command::new("open")
            .arg(&url)
            .status()
            .map_err(|e| err::with_detail("smb_open_failed", e))?;
        if !status.success() {
            return Err(err::code("smb_open_failed"));
        }

        let candidates = vec![
            PathBuf::from(format!("/Volumes/{share}")),
        ];

        let start = std::time::Instant::now();
        while start.elapsed() < timeout {
            for c in &candidates {
                if path_accessible(c) {
                    return Ok(SystemMountResult {
                        mount_point: c.to_string_lossy().to_string(),
                    });
                }
            }
            // Also accept /Volumes/{share}-N if Finder renamed
            if let Ok(entries) = std::fs::read_dir("/Volumes") {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if name == share || name.starts_with(&format!("{share}-")) {
                        let p = entry.path();
                        if path_accessible(&p) {
                            return Ok(SystemMountResult {
                                mount_point: p.to_string_lossy().to_string(),
                            });
                        }
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }

        return Err(err::with_detail(
            "smb_mount_not_detected",
            format!("/Volumes/{share}"),
        ));
    }

    #[cfg(target_os = "windows")]
    {
        let unc = format!(r"\\{}\{}", host, share);
        let unc_path = PathBuf::from(&unc);

        if path_accessible(&unc_path) {
            return Ok(SystemMountResult {
                mount_point: unc,
            });
        }

        // Try net use to authenticate
        let mut cmd = Command::new("net");
        cmd.arg("use").arg(&unc);
        if let Some(p) = pass {
            cmd.arg(p);
        }
        if let Some(u) = user {
            cmd.arg(format!("/user:{u}"));
        }
        let output = cmd.output().map_err(|e| err::with_detail("smb_open_failed", e))?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr);
            let detail = if detail.trim().is_empty() {
                String::from_utf8_lossy(&output.stdout).to_string()
            } else {
                detail.to_string()
            };
            return Err(map_smb_err(detail));
        }

        let start = std::time::Instant::now();
        while start.elapsed() < timeout {
            if path_accessible(&unc_path) {
                return Ok(SystemMountResult {
                    mount_point: unc,
                });
            }
            tokio::time::sleep(Duration::from_millis(400)).await;
        }

        return Err(err::with_detail("smb_mount_not_detected", unc));
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (user, pass, timeout);
        let unc_style = format!("//{host}/{share}");
        Err(err::with_detail(
            "smb_system_unsupported",
            format!("try direct mode or mount {unc_style} manually"),
        ))
    }
}

/// Connect in-app SMB session (direct mode).
#[tauri::command]
pub async fn connect_smb(
    store: State<'_, Arc<SmbSessionStore>>,
    connection_id: String,
    host: String,
    share: String,
    username: String,
    password: String,
    port: Option<u16>,
) -> Result<String, String> {
    let host = host.trim().to_string();
    let share = share.trim().trim_matches('/').to_string();
    let username = username.trim().to_string();
    if connection_id.trim().is_empty() || host.is_empty() || share.is_empty() {
        return Err(err::code("smb_params_missing"));
    }
    if username.is_empty() {
        return Err(err::code("smb_username_required"));
    }

    let addr = smb_addr(&host, port);
    let mut client = smb2::connect(&addr, &username, &password)
        .await
        .map_err(map_smb_err)?;
    let tree = client
        .connect_share(&share)
        .await
        .map_err(map_smb_err)?;

    let mut guard = store.inner.lock().await;
    guard.insert(
        connection_id.clone(),
        SmbSession {
            client,
            share: tree,
            share_name: share,
        },
    );

    Ok(join_remote_path(&connection_id, ""))
}

#[tauri::command]
pub async fn disconnect_smb(
    store: State<'_, Arc<SmbSessionStore>>,
    connection_id: String,
) -> Result<(), String> {
    let mut guard = store.inner.lock().await;
    if let Some(mut session) = guard.remove(&connection_id) {
        let _ = session.client.disconnect_share(&session.share).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn list_remote_dir(
    store: State<'_, Arc<SmbSessionStore>>,
    path: String,
) -> Result<Vec<RemoteDirEntry>, String> {
    path_util::validate_user_path(&path)?;
    let (conn_id, rel) = parse_remote_path(&path)?;

    let mut guard = store.inner.lock().await;
    let session = guard
        .get_mut(&conn_id)
        .ok_or_else(|| err::code("smb_session_missing"))?;

    let entries = session
        .client
        .list_directory(&mut session.share, &rel)
        .await
        .map_err(map_smb_err)?;

    Ok(entries_to_remote(&conn_id, &rel, &entries))
}

fn entries_to_remote(conn_id: &str, parent_rel: &str, entries: &[DirectoryEntry]) -> Vec<RemoteDirEntry> {
    let mut out: Vec<RemoteDirEntry> = entries
        .iter()
        .filter(|e| e.name != "." && e.name != "..")
        .map(|e| {
            let child_rel = if parent_rel.is_empty() {
                e.name.clone()
            } else {
                format!("{parent_rel}/{}", e.name)
            };
            RemoteDirEntry {
                name: e.name.clone(),
                path: join_remote_path(conn_id, &child_rel),
                is_dir: e.is_directory,
                size: e.size,
                size_formatted: format_size(e.size),
            }
        })
        .collect();

    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    out
}

pub async fn remote_path_exists_inner(
    store: &SmbSessionStore,
    path: &str,
) -> Result<bool, String> {
    if !path_util::is_remote_path(path) {
        return Ok(Path::new(path).exists());
    }
    path_util::validate_user_path(path)?;
    let (conn_id, rel) = parse_remote_path(path)?;

    let mut guard = store.inner.lock().await;
    let session = match guard.get_mut(&conn_id) {
        Some(s) => s,
        None => return Ok(false),
    };

    if rel.is_empty() {
        return Ok(true);
    }

    match session.client.stat(&mut session.share, &rel).await {
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
pub async fn remote_path_exists(
    store: State<'_, Arc<SmbSessionStore>>,
    path: String,
) -> Result<bool, String> {
    remote_path_exists_inner(store.as_ref(), &path).await
}

/// Read remote file bytes with an optional size cap (0 = unlimited).
pub async fn read_remote_file_bytes(
    store: &SmbSessionStore,
    remote_path: &str,
    max_bytes: u64,
) -> Result<Vec<u8>, String> {
    let (conn_id, rel) = parse_remote_path(remote_path)?;
    if rel.is_empty() {
        return Err(err::code("smb_path_is_dir"));
    }

    let mut guard = store.inner.lock().await;
    let session = guard
        .get_mut(&conn_id)
        .ok_or_else(|| err::code("smb_session_missing"))?;

    if max_bytes > 0 {
        let info = session
            .client
            .stat(&mut session.share, &rel)
            .await
            .map_err(map_smb_err)?;
        if info.size > max_bytes {
            return Err(err::with_detail("smb_file_too_large", info.size));
        }
    }

    session
        .client
        .read_file_pipelined(&mut session.share, &rel)
        .await
        .map_err(map_smb_err)
}

#[tauri::command]
pub async fn remote_path_info(
    store: State<'_, Arc<SmbSessionStore>>,
    path: String,
) -> Result<RemoteDirEntry, String> {
    path_util::validate_user_path(&path)?;
    let (conn_id, rel) = parse_remote_path(&path)?;

    let mut guard = store.inner.lock().await;
    let session = guard
        .get_mut(&conn_id)
        .ok_or_else(|| err::code("smb_session_missing"))?;

    let name = if rel.is_empty() {
        session.share_name.clone()
    } else {
        rel.rsplit('/').next().unwrap_or(&rel).to_string()
    };

    if rel.is_empty() {
        return Ok(RemoteDirEntry {
            name,
            path: join_remote_path(&conn_id, ""),
            is_dir: true,
            size: 0,
            size_formatted: format_size(0),
        });
    }

    let info = session
        .client
        .stat(&mut session.share, &rel)
        .await
        .map_err(map_smb_err)?;

    Ok(RemoteDirEntry {
        name,
        path: join_remote_path(&conn_id, &rel),
        is_dir: info.is_directory,
        size: info.size,
        size_formatted: format_size(info.size),
    })
}

/// Recursively list files under a remote directory (for search / transfer counting).
pub async fn walk_remote_files(
    store: &SmbSessionStore,
    conn_id: &str,
    rel: &str,
    out: &mut Vec<(String, u64, bool)>,
    cap: usize,
) -> Result<(), String> {
    if out.len() >= cap {
        return Ok(());
    }

    let entries = {
        let mut guard = store.inner.lock().await;
        let session = guard
            .get_mut(conn_id)
            .ok_or_else(|| err::code("smb_session_missing"))?;
        session
            .client
            .list_directory(&mut session.share, rel)
            .await
            .map_err(map_smb_err)?
    };

    for e in entries {
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
            Box::pin(walk_remote_files(store, conn_id, &child_rel, out, cap)).await?;
        } else {
            out.push((remote_path, e.size, false));
        }
    }
    Ok(())
}

/// Copy a single remote file to a local path.
pub async fn download_remote_file(
    store: &SmbSessionStore,
    remote_path: &str,
    local_path: &Path,
) -> Result<(), String> {
    let (conn_id, rel) = parse_remote_path(remote_path)?;
    if rel.is_empty() {
        return Err(err::code("smb_path_is_dir"));
    }

    let data = {
        let mut guard = store.inner.lock().await;
        let session = guard
            .get_mut(&conn_id)
            .ok_or_else(|| err::code("smb_session_missing"))?;
        session
            .client
            .read_file_pipelined(&mut session.share, &rel)
            .await
            .map_err(map_smb_err)?
    };

    if let Some(parent) = local_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| err::with_detail("copy_failed", e))?;
    }
    std::fs::write(local_path, data).map_err(|e| err::with_detail("copy_failed", e))?;
    Ok(())
}

/// Upload a local file to a remote path (file path on share).
pub async fn upload_local_file(
    store: &SmbSessionStore,
    local_path: &Path,
    remote_path: &str,
) -> Result<(), String> {
    let (conn_id, rel) = parse_remote_path(remote_path)?;
    if rel.is_empty() {
        return Err(err::code("smb_path_is_dir"));
    }

    let data = std::fs::read(local_path).map_err(|e| err::with_detail("copy_failed", e))?;

    let mut guard = store.inner.lock().await;
    let session = guard
        .get_mut(&conn_id)
        .ok_or_else(|| err::code("smb_session_missing"))?;

    // Ensure parent directories exist
    if let Some((parent, _)) = rel.rsplit_once('/') {
        ensure_remote_dirs(session, parent).await?;
    }

    session
        .client
        .write_file_pipelined(&session.share, &rel, &data)
        .await
        .map_err(map_smb_err)?;
    Ok(())
}

async fn ensure_remote_dirs(session: &mut SmbSession, rel: &str) -> Result<(), String> {
    if rel.is_empty() {
        return Ok(());
    }
    let mut acc = String::new();
    for part in rel.split('/') {
        if part.is_empty() {
            continue;
        }
        if !acc.is_empty() {
            acc.push('/');
        }
        acc.push_str(part);
        match session.client.stat(&mut session.share, &acc).await {
            Ok(info) if info.is_directory => continue,
            Ok(_) => return Err(err::with_detail("smb_path_not_dir", &acc)),
            Err(_) => {
                session
                    .client
                    .create_directory(&session.share, &acc)
                    .await
                    .map_err(map_smb_err)?;
            }
        }
    }
    Ok(())
}

/// Recursively download remote dir/file into local directory (places item under target_dir).
pub async fn transfer_remote_to_local(
    store: &SmbSessionStore,
    source_remote: &str,
    target_dir: &Path,
    conflict: &str,
) -> Result<(u64, u64, u64, Vec<String>), String> {
    let (conn_id, rel) = parse_remote_path(source_remote)?;
    let mut transferred = 0u64;
    let mut skipped = 0u64;
    let mut failed = 0u64;
    let mut errors = Vec::new();

    let info = {
        let mut guard = store.inner.lock().await;
        let session = guard
            .get_mut(&conn_id)
            .ok_or_else(|| err::code("smb_session_missing"))?;
        if rel.is_empty() {
            None
        } else {
            Some(
                session
                    .client
                    .stat(&mut session.share, &rel)
                    .await
                    .map_err(map_smb_err)?,
            )
        }
    };

    let is_dir = info.as_ref().map(|i| i.is_directory).unwrap_or(true);
    let base_name = if rel.is_empty() {
        {
            let guard = store.inner.lock().await;
            guard
                .get(&conn_id)
                .map(|s| s.share_name.clone())
                .unwrap_or_else(|| "share".into())
        }
    } else {
        rel.rsplit('/').next().unwrap_or(&rel).to_string()
    };

    if !is_dir {
        let mut dest = target_dir.join(&base_name);
        if dest.exists() {
            match conflict {
                "skip" => return Ok((0, 1, 0, errors)),
                "rename" => dest = unique_local_name(&dest),
                "overwrite" => {}
                _ => return Err(err::code("invalid_conflict_resolution")),
            }
        }
        match download_remote_file(store, source_remote, &dest).await {
            Ok(()) => transferred += 1,
            Err(e) => {
                failed += 1;
                errors.push(e);
            }
        }
        return Ok((transferred, skipped, failed, errors));
    }

    // Directory: create root and walk
    let dest_root = {
        let mut dest = target_dir.join(&base_name);
        if dest.exists() {
            match conflict {
                "skip" => return Ok((0, 1, 0, errors)),
                "rename" => dest = unique_local_name(&dest),
                "overwrite" => {}
                _ => return Err(err::code("invalid_conflict_resolution")),
            }
        }
        std::fs::create_dir_all(&dest).map_err(|e| err::with_detail("copy_failed", e))?;
        dest
    };

    let mut files = Vec::new();
    walk_remote_files(store, &conn_id, &rel, &mut files, 50_000).await?;

    for (rpath, _size, is_directory) in files {
        let (_cid, child_rel) = parse_remote_path(&rpath)?;
        let suffix = if rel.is_empty() {
            child_rel.clone()
        } else {
            child_rel
                .strip_prefix(&format!("{rel}/"))
                .unwrap_or(&child_rel)
                .to_string()
        };
        let local = dest_root.join(Path::new(&suffix.replace('/', std::path::MAIN_SEPARATOR_STR)));
        if is_directory {
            let _ = std::fs::create_dir_all(&local);
            continue;
        }
        if local.exists() && conflict == "skip" {
            skipped += 1;
            continue;
        }
        match download_remote_file(store, &rpath, &local).await {
            Ok(()) => transferred += 1,
            Err(e) => {
                failed += 1;
                errors.push(e);
            }
        }
    }

    Ok((transferred, skipped, failed, errors))
}

/// Recursively upload local path into remote directory.
pub async fn transfer_local_to_remote(
    store: &SmbSessionStore,
    source_local: &Path,
    target_remote_dir: &str,
    conflict: &str,
) -> Result<(u64, u64, u64, Vec<String>), String> {
    let (conn_id, target_rel) = parse_remote_path(target_remote_dir)?;
    let mut transferred = 0u64;
    let mut skipped = 0u64;
    let mut failed = 0u64;
    let mut errors = Vec::new();

    if !source_local.exists() {
        return Err(err::with_detail(
            "source_missing",
            source_local.to_string_lossy(),
        ));
    }

    let base_name = source_local
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    if source_local.is_file() {
        let remote_file = if target_rel.is_empty() {
            join_remote_path(&conn_id, &base_name)
        } else {
            join_remote_path(&conn_id, &format!("{target_rel}/{base_name}"))
        };

        // conflict check
        {
            let mut guard = store.inner.lock().await;
            let session = guard
                .get_mut(&conn_id)
                .ok_or_else(|| err::code("smb_session_missing"))?;
            let rel = parse_remote_path(&remote_file)?.1;
            if session.client.stat(&mut session.share, &rel).await.is_ok() {
                match conflict {
                    "skip" => return Ok((0, 1, 0, errors)),
                    "rename" => {
                        // simple rename suffix
                        let renamed = unique_remote_name(&rel);
                        let remote_file = join_remote_path(&conn_id, &renamed);
                        drop(guard);
                        match upload_local_file(store, source_local, &remote_file).await {
                            Ok(()) => transferred += 1,
                            Err(e) => {
                                failed += 1;
                                errors.push(e);
                            }
                        }
                        return Ok((transferred, skipped, failed, errors));
                    }
                    "overwrite" => {}
                    _ => return Err(err::code("invalid_conflict_resolution")),
                }
            }
        }

        match upload_local_file(store, source_local, &remote_file).await {
            Ok(()) => transferred += 1,
            Err(e) => {
                failed += 1;
                errors.push(e);
            }
        }
        return Ok((transferred, skipped, failed, errors));
    }

    // Directory upload
    let root_rel = if target_rel.is_empty() {
        base_name.clone()
    } else {
        format!("{target_rel}/{base_name}")
    };

    {
        let mut guard = store.inner.lock().await;
        let session = guard
            .get_mut(&conn_id)
            .ok_or_else(|| err::code("smb_session_missing"))?;
        ensure_remote_dirs(session, &root_rel).await?;
    }

    let walker = walkdir::WalkDir::new(source_local).follow_links(false);
    for entry in walker.into_iter().flatten() {
        let path = entry.path();
        let rel_local = match path.strip_prefix(source_local) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let rel_str = rel_local.to_string_lossy().replace('\\', "/");
        let remote_rel = if rel_str.is_empty() {
            root_rel.clone()
        } else {
            format!("{root_rel}/{rel_str}")
        };

        if path.is_dir() {
            let mut guard = store.inner.lock().await;
            let session = guard
                .get_mut(&conn_id)
                .ok_or_else(|| err::code("smb_session_missing"))?;
            if let Err(e) = ensure_remote_dirs(session, &remote_rel).await {
                failed += 1;
                errors.push(e);
            }
            continue;
        }
        if !path.is_file() {
            continue;
        }

        let remote_file = join_remote_path(&conn_id, &remote_rel);
        {
            let mut guard = store.inner.lock().await;
            let session = guard
                .get_mut(&conn_id)
                .ok_or_else(|| err::code("smb_session_missing"))?;
            if session
                .client
                .stat(&mut session.share, &remote_rel)
                .await
                .is_ok()
                && conflict == "skip"
            {
                skipped += 1;
                continue;
            }
        }

        match upload_local_file(store, path, &remote_file).await {
            Ok(()) => transferred += 1,
            Err(e) => {
                failed += 1;
                errors.push(e);
            }
        }
    }

    Ok((transferred, skipped, failed, errors))
}

fn unique_local_name(path: &Path) -> PathBuf {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("file");
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    for i in 1..10_000 {
        let candidate = parent.join(format!("{stem} ({i}){ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    parent.join(format!("{stem}-copy{ext}"))
}

fn unique_remote_name(rel: &str) -> String {
    let (parent, name) = match rel.rsplit_once('/') {
        Some((p, n)) => (p, n),
        None => ("", rel),
    };
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s, format!(".{e}")),
        _ => (name, String::new()),
    };
    let renamed = format!("{stem} (1){ext}");
    if parent.is_empty() {
        renamed
    } else {
        format!("{parent}/{renamed}")
    }
}

/// High-level transfer command that supports remote:// on either side.
#[tauri::command]
pub async fn transfer_files_remote(
    store: State<'_, Arc<SmbSessionStore>>,
    source_paths: Vec<String>,
    target_path: String,
    conflict_resolution: String,
) -> Result<crate::commands::transfer::TransferResult, String> {
    let resolution = match conflict_resolution.as_str() {
        "skip" | "rename" | "overwrite" => conflict_resolution.as_str(),
        _ => return Err(err::code("invalid_conflict_resolution")),
    };

    path_util::validate_user_path(&target_path)?;
    for p in &source_paths {
        path_util::validate_user_path(p)?;
    }

    let target_is_remote = path_util::is_remote_path(&target_path);
    let mut transferred = 0u64;
    let mut skipped = 0u64;
    let mut failed = 0u64;
    let mut errors = Vec::new();

    for source in &source_paths {
        let source_is_remote = path_util::is_remote_path(source);

        let result = match (source_is_remote, target_is_remote) {
            (true, false) => {
                transfer_remote_to_local(
                    store.as_ref(),
                    source,
                    Path::new(&target_path),
                    resolution,
                )
                .await
            }
            (false, true) => {
                transfer_local_to_remote(
                    store.as_ref(),
                    Path::new(source),
                    &target_path,
                    resolution,
                )
                .await
            }
            (true, true) => Err(err::code("smb_remote_to_remote_unsupported")),
            (false, false) => Err(err::code("smb_not_remote_transfer")),
        };

        match result {
            Ok((t, s, f, e)) => {
                transferred += t;
                skipped += s;
                failed += f;
                errors.extend(e);
            }
            Err(e) => {
                failed += 1;
                errors.push(e);
            }
        }
    }

    Ok(crate::commands::transfer::TransferResult {
        success: failed == 0,
        transferred: transferred as usize,
        skipped: skipped as usize,
        failed: failed as usize,
        cancelled: false,
        truncated: false,
        errors,
    })
}
