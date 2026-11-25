//! Remote NAS connectivity: SMB, WebDAV, and SFTP in-app sessions.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use smb2::{DirectoryEntry, SmbClient};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

use crate::err;
use crate::path_util::{self, join_remote_path, parse_remote_path};

use super::remote_sftp::{connect_sftp as open_sftp, walk_sftp_files, SftpSession};
use super::remote_webdav::{connect_webdav as open_webdav, walk_webdav_files, WebDavSession};

/// In-memory remote sessions keyed by frontend connection id.
pub struct RemoteSessionStore {
    pub(crate) inner: Mutex<HashMap<String, RemoteSession>>,
}

/// Back-compat alias for existing call sites.
pub type SmbSessionStore = RemoteSessionStore;

impl Default for RemoteSessionStore {
    fn default() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }
}

pub enum RemoteSession {
    Smb(SmbSession),
    WebDav {
        inner: WebDavSession,
        username: String,
        password: String,
    },
    Sftp(SftpSession),
}

pub(crate) struct SmbSession {
    pub(crate) client: SmbClient,
    pub(crate) share: smb2::Tree,
    pub(crate) share_name: String,
}

fn session_missing() -> String {
    err::code("remote_session_missing")
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

const REMOTE_LIST_CACHE_TTL: Duration = Duration::from_secs(30);

static REMOTE_LIST_CACHE: OnceLock<std::sync::Mutex<HashMap<String, (Instant, Vec<RemoteDirEntry>)>>> =
    OnceLock::new();

fn remote_list_cache() -> &'static std::sync::Mutex<HashMap<String, (Instant, Vec<RemoteDirEntry>)>> {
    REMOTE_LIST_CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
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

pub(crate) fn map_smb_err(e: impl std::fmt::Display) -> String {
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
    store: State<'_, Arc<RemoteSessionStore>>,
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
        RemoteSession::Smb(SmbSession {
            client,
            share: tree,
            share_name: share,
        }),
    );

    Ok(join_remote_path(&connection_id, ""))
}

/// Connect in-app WebDAV session (direct mode).
#[tauri::command]
pub async fn connect_webdav(
    store: State<'_, Arc<RemoteSessionStore>>,
    connection_id: String,
    base_url: String,
    username: String,
    password: String,
    label: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<String, String> {
    if connection_id.trim().is_empty() || base_url.trim().is_empty() {
        return Err(err::code("webdav_params_missing"));
    }
    let inner = open_webdav(
        &base_url,
        &username,
        &password,
        label.as_deref().unwrap_or("WebDAV"),
        timeout_ms.unwrap_or(30_000),
    )
    .await?;
    let mut guard = store.inner.lock().await;
    guard.insert(
        connection_id.clone(),
        RemoteSession::WebDav {
            inner,
            username,
            password,
        },
    );
    Ok(join_remote_path(&connection_id, ""))
}

/// Connect in-app SFTP session (direct mode).
#[tauri::command]
pub async fn connect_sftp(
    store: State<'_, Arc<RemoteSessionStore>>,
    connection_id: String,
    host: String,
    port: Option<u16>,
    username: String,
    password: String,
    root: Option<String>,
    label: Option<String>,
) -> Result<String, String> {
    if connection_id.trim().is_empty() || host.trim().is_empty() || username.trim().is_empty() {
        return Err(err::code("sftp_params_missing"));
    }
    let session = open_sftp(
        host.trim(),
        port.unwrap_or(22),
        username.trim(),
        &password,
        root.as_deref().unwrap_or("/"),
        label.as_deref().unwrap_or("SFTP"),
    )?;
    let mut guard = store.inner.lock().await;
    guard.insert(connection_id.clone(), RemoteSession::Sftp(session));
    Ok(join_remote_path(&connection_id, ""))
}

#[tauri::command]
pub async fn disconnect_smb(
    store: State<'_, Arc<RemoteSessionStore>>,
    connection_id: String,
) -> Result<(), String> {
    let mut guard = store.inner.lock().await;
    if let Some(session) = guard.remove(&connection_id) {
        if let RemoteSession::Smb(mut s) = session {
            let _ = s.client.disconnect_share(&s.share).await;
        }
    }
    Ok(())
}

/// Disconnect any remote session type.
#[tauri::command]
pub async fn disconnect_remote(
    store: State<'_, Arc<RemoteSessionStore>>,
    connection_id: String,
) -> Result<(), String> {
    disconnect_smb(store, connection_id).await
}

pub async fn list_remote_dir_inner(
    store: &RemoteSessionStore,
    path: &str,
) -> Result<Vec<RemoteDirEntry>, String> {
    path_util::validate_user_path(path)?;

    if let Ok(cache) = remote_list_cache().lock() {
        if let Some((at, entries)) = cache.get(path) {
            if at.elapsed() < REMOTE_LIST_CACHE_TTL {
                return Ok(entries.clone());
            }
        }
    }

    let (conn_id, rel) = parse_remote_path(path)?;

    let mut guard = store.inner.lock().await;
    match guard.get_mut(&conn_id) {
        Some(RemoteSession::Smb(session)) => {
            let entries = session
                .client
                .list_directory(&mut session.share, &rel)
                .await
                .map_err(map_smb_err)?;
            let out = entries_to_remote(&conn_id, &rel, &entries);
            cache_remote_list(path, &out);
            Ok(out)
        }
        Some(RemoteSession::WebDav {
            inner,
            username,
            password,
        }) => {
            let inner = inner.clone();
            let username = username.clone();
            let password = password.clone();
            drop(guard);
            let entries = super::remote_webdav::webdav_list_dir(&inner, &rel, &username, &password).await?;
            let out = simple_entries_to_remote(&conn_id, &rel, &entries);
            cache_remote_list(path, &out);
            Ok(out)
        }
        Some(RemoteSession::Sftp(session)) => {
            let entries = super::remote_sftp::sftp_list_dir(session, &rel)?;
            let out = sftp_entries_to_remote(&conn_id, &rel, &entries);
            cache_remote_list(path, &out);
            Ok(out)
        }
        None => Err(session_missing()),
    }
}

fn cache_remote_list(path: &str, entries: &[RemoteDirEntry]) {
    if let Ok(mut cache) = remote_list_cache().lock() {
        cache.insert(path.to_string(), (Instant::now(), entries.to_vec()));
    }
}

/// Drop cached listings for a remote path and its ancestors / children.
pub(crate) fn invalidate_remote_list_cache(path: &str) {
    if let Ok(mut cache) = remote_list_cache().lock() {
        if path.is_empty() {
            cache.clear();
            return;
        }
        let prefix = if path.ends_with('/') {
            path.to_string()
        } else {
            format!("{path}/")
        };
        cache.retain(|k, _| k != path && !k.starts_with(&prefix));
        // Also drop parent directory listing so refreshed browse sees new children.
        if let Ok((_, rel)) = parse_remote_path(path) {
            if let Some((parent_rel, _)) = rel.rsplit_once('/') {
                let (conn_id, _) = match parse_remote_path(path) {
                    Ok(v) => v,
                    Err(_) => return,
                };
                let parent = join_remote_path(&conn_id, parent_rel);
                cache.remove(&parent);
            } else if let Ok((conn_id, _)) = parse_remote_path(path) {
                cache.remove(&join_remote_path(&conn_id, ""));
            }
        }
    }
}

pub(crate) fn invalidate_remote_list_cache_many(paths: &[String]) {
    for p in paths {
        invalidate_remote_list_cache(p);
    }
}

fn simple_entries_to_remote(
    conn_id: &str,
    parent_rel: &str,
    entries: &[super::remote_webdav::WebDavEntry],
) -> Vec<RemoteDirEntry> {
    let mut out: Vec<RemoteDirEntry> = entries
        .iter()
        .map(|e| {
            let child_rel = if parent_rel.is_empty() {
                e.name.clone()
            } else {
                format!("{parent_rel}/{}", e.name)
            };
            RemoteDirEntry {
                name: e.name.clone(),
                path: join_remote_path(conn_id, &child_rel),
                is_dir: e.is_dir,
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

fn sftp_entries_to_remote(
    conn_id: &str,
    parent_rel: &str,
    entries: &[super::remote_sftp::SftpEntry],
) -> Vec<RemoteDirEntry> {
    let mut out: Vec<RemoteDirEntry> = entries
        .iter()
        .map(|e| {
            let child_rel = if parent_rel.is_empty() {
                e.name.clone()
            } else {
                format!("{parent_rel}/{}", e.name)
            };
            RemoteDirEntry {
                name: e.name.clone(),
                path: join_remote_path(conn_id, &child_rel),
                is_dir: e.is_dir,
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

#[tauri::command]
pub async fn list_remote_dir(
    store: State<'_, Arc<RemoteSessionStore>>,
    path: String,
) -> Result<Vec<RemoteDirEntry>, String> {
    list_remote_dir_inner(store.as_ref(), &path).await
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
    store: &RemoteSessionStore,
    path: &str,
) -> Result<bool, String> {
    if !path_util::is_remote_path(path) {
        return Ok(Path::new(path).exists());
    }
    path_util::validate_user_path(path)?;
    let (conn_id, rel) = parse_remote_path(path)?;

    let mut guard = store.inner.lock().await;
    let exists = match guard.get_mut(&conn_id) {
        None => return Ok(false),
        Some(RemoteSession::Smb(session)) => {
            if rel.is_empty() {
                true
            } else {
                session.client.stat(&mut session.share, &rel).await.is_ok()
            }
        }
        Some(RemoteSession::WebDav { .. }) => !rel.is_empty(),
        Some(RemoteSession::Sftp(session)) => {
            if rel.is_empty() {
                true
            } else {
                super::remote_sftp::sftp_stat_is_dir(session, &rel).is_ok()
                    || super::remote_sftp::sftp_read_file(session, &rel).is_ok()
            }
        }
    };
    Ok(exists)
}

#[tauri::command]
pub async fn remote_path_exists(
    store: State<'_, Arc<RemoteSessionStore>>,
    path: String,
) -> Result<bool, String> {
    remote_path_exists_inner(store.as_ref(), &path).await
}

/// Read remote file bytes with an optional size cap (0 = unlimited).
pub async fn read_remote_file_bytes(
    store: &RemoteSessionStore,
    remote_path: &str,
    max_bytes: u64,
) -> Result<Vec<u8>, String> {
    let (conn_id, rel) = parse_remote_path(remote_path)?;
    if rel.is_empty() {
        return Err(err::code("smb_path_is_dir"));
    }

    let mut guard = store.inner.lock().await;
    match guard.get_mut(&conn_id) {
        Some(RemoteSession::Smb(session)) => {
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
        Some(RemoteSession::WebDav {
            inner,
            username,
            password,
        }) => {
            let inner = inner.clone();
            let username = username.clone();
            let password = password.clone();
            drop(guard);
            let data = super::remote_webdav::webdav_read_file(&inner, &rel, &username, &password).await?;
            if max_bytes > 0 && data.len() as u64 > max_bytes {
                return Err(err::with_detail("smb_file_too_large", data.len()));
            }
            Ok(data)
        }
        Some(RemoteSession::Sftp(session)) => {
            let data = super::remote_sftp::sftp_read_file(session, &rel)?;
            if max_bytes > 0 && data.len() as u64 > max_bytes {
                return Err(err::with_detail("smb_file_too_large", data.len()));
            }
            Ok(data)
        }
        None => Err(session_missing()),
    }
}

#[tauri::command]
pub async fn remote_path_info(
    store: State<'_, Arc<RemoteSessionStore>>,
    path: String,
) -> Result<RemoteDirEntry, String> {
    path_util::validate_user_path(&path)?;
    let (conn_id, rel) = parse_remote_path(&path)?;

    let mut guard = store.inner.lock().await;
    match guard.get_mut(&conn_id) {
        Some(RemoteSession::Smb(session)) => {
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
        Some(RemoteSession::WebDav { inner, .. }) => {
            let name = if rel.is_empty() {
                inner.label.clone()
            } else {
                rel.rsplit('/').next().unwrap_or(&rel).to_string()
            };
            Ok(RemoteDirEntry {
                name,
                path: join_remote_path(&conn_id, &rel),
                is_dir: rel.is_empty(),
                size: 0,
                size_formatted: format_size(0),
            })
        }
        Some(RemoteSession::Sftp(session)) => {
            let name = if rel.is_empty() {
                session.label.clone()
            } else {
                rel.rsplit('/').next().unwrap_or(&rel).to_string()
            };
            let is_dir = if rel.is_empty() {
                true
            } else {
                super::remote_sftp::sftp_stat_is_dir(session, &rel).unwrap_or(false)
            };
            Ok(RemoteDirEntry {
                name,
                path: join_remote_path(&conn_id, &rel),
                is_dir,
                size: 0,
                size_formatted: format_size(0),
            })
        }
        None => Err(session_missing()),
    }
}

/// Recursively list files under a remote directory (for search / transfer counting).
fn smb_mtime_secs(entry: &DirectoryEntry) -> i64 {
    entry
        .modified
        .to_system_time()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Recursively list files: `(remote_path, size, is_dir, mtime_unix_secs)`.
pub async fn walk_remote_files(
    store: &RemoteSessionStore,
    conn_id: &str,
    rel: &str,
    out: &mut Vec<(String, u64, bool, i64)>,
    cap: usize,
) -> Result<(), String> {
    if out.len() >= cap {
        return Ok(());
    }

    let mut guard = store.inner.lock().await;
    match guard.get_mut(conn_id) {
        Some(RemoteSession::Smb(session)) => {
            let entries = session
                .client
                .list_directory(&mut session.share, rel)
                .await
                .map_err(map_smb_err)?;
            drop(guard);
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
                let mtime = smb_mtime_secs(&e);
                if e.is_directory {
                    out.push((remote_path, e.size, true, mtime));
                    Box::pin(walk_remote_files(store, conn_id, &child_rel, out, cap)).await?;
                } else {
                    out.push((remote_path, e.size, false, mtime));
                }
            }
            Ok(())
        }
        Some(RemoteSession::WebDav {
            inner,
            username,
            password,
        }) => {
            let inner = inner.clone();
            let username = username.clone();
            let password = password.clone();
            drop(guard);
            walk_webdav_files(&inner, conn_id, rel, &username, &password, out, cap).await
        }
        Some(RemoteSession::Sftp(session)) => {
            let session = session.clone();
            drop(guard);
            walk_sftp_files(&session, conn_id, rel, out, cap)
        }
        None => Err(session_missing()),
    }
}

/// Copy a single remote file to a local path.
pub async fn download_remote_file(
    store: &RemoteSessionStore,
    remote_path: &str,
    local_path: &Path,
) -> Result<(), String> {
    let data = read_remote_file_bytes(store, remote_path, 0).await?;

    if let Some(parent) = local_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| err::with_detail("copy_failed", e))?;
    }
    std::fs::write(local_path, data).map_err(|e| err::with_detail("copy_failed", e))?;
    Ok(())
}

/// Upload a local file to a remote path (file path on share).
pub async fn upload_local_file(
    store: &RemoteSessionStore,
    local_path: &Path,
    remote_path: &str,
) -> Result<(), String> {
    let (conn_id, rel) = parse_remote_path(remote_path)?;
    if rel.is_empty() {
        return Err(err::code("smb_path_is_dir"));
    }

    let data = std::fs::read(local_path).map_err(|e| err::with_detail("copy_failed", e))?;

    let mut guard = store.inner.lock().await;
    match guard.get_mut(&conn_id) {
        Some(RemoteSession::Smb(session)) => {
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
        Some(RemoteSession::WebDav {
            inner,
            username,
            password,
        }) => {
            let inner = inner.clone();
            let username = username.clone();
            let password = password.clone();
            drop(guard);
            super::remote_webdav::webdav_write_file(&inner, &rel, &data, &username, &password).await
        }
        Some(RemoteSession::Sftp(session)) => {
            super::remote_sftp::sftp_write_file(session, &rel, &data)
        }
        None => Err(session_missing()),
    }
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
pub async fn transfer_remote_to_local_job(
    store: &RemoteSessionStore,
    source_remote: &str,
    target_dir: &Path,
    conflict: &str,
    job_id: u64,
) -> Result<(u64, u64, u64, Vec<String>), String> {
    if job_id > 0 && crate::job_runner::is_cancelled(job_id) {
        return Err(err::code("transfer_cancelled"));
    }
    let (conn_id, rel) = parse_remote_path(source_remote)?;
    let mut transferred = 0u64;
    let mut skipped = 0u64;
    let mut failed = 0u64;
    let mut errors = Vec::new();

    let is_dir = if rel.is_empty() {
        true
    } else {
        let mut guard = store.inner.lock().await;
        match guard.get_mut(&conn_id) {
            Some(RemoteSession::Smb(session)) => session
                .client
                .stat(&mut session.share, &rel)
                .await
                .map(|i| i.is_directory)
                .map_err(map_smb_err)?,
            Some(RemoteSession::Sftp(session)) => {
                super::remote_sftp::sftp_stat_is_dir(session, &rel)?
            }
            Some(RemoteSession::WebDav { .. }) => false,
            None => return Err(session_missing()),
        }
    };
    let base_name = if rel.is_empty() {
        {
            let guard = store.inner.lock().await;
            match guard.get(&conn_id) {
                Some(RemoteSession::Smb(s)) => s.share_name.clone(),
                Some(RemoteSession::WebDav { inner, .. }) => inner.label.clone(),
                Some(RemoteSession::Sftp(s)) => s.label.clone(),
                None => "share".into(),
            }
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
        if job_id > 0 && crate::job_runner::is_cancelled(job_id) {
            return Err(err::code("transfer_cancelled"));
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

    for (rpath, _size, is_directory, _mtime) in files {
        if job_id > 0 && crate::job_runner::is_cancelled(job_id) {
            return Err(err::code("transfer_cancelled"));
        }
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
pub async fn transfer_local_to_remote_job(
    store: &RemoteSessionStore,
    source_local: &Path,
    target_remote_dir: &str,
    conflict: &str,
    job_id: u64,
) -> Result<(u64, u64, u64, Vec<String>), String> {
    if job_id > 0 && crate::job_runner::is_cancelled(job_id) {
        return Err(err::code("transfer_cancelled"));
    }
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

        if remote_path_exists_inner(store, &remote_file).await.unwrap_or(false) {
            match conflict {
                "skip" => return Ok((0, 1, 0, errors)),
                "rename" => {
                    let rel = parse_remote_path(&remote_file)?.1;
                    let renamed = unique_remote_name(&rel);
                    let remote_file = join_remote_path(&conn_id, &renamed);
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
        if let Some(RemoteSession::Smb(session)) = guard.get_mut(&conn_id) {
            ensure_remote_dirs(session, &root_rel).await?;
        }
    }

    let walker = walkdir::WalkDir::new(source_local).follow_links(false);
    for entry in walker.into_iter().flatten() {
        if job_id > 0 && crate::job_runner::is_cancelled(job_id) {
            return Err(err::code("transfer_cancelled"));
        }
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
            if let Some(RemoteSession::Smb(session)) = guard.get_mut(&conn_id) {
                if let Err(e) = ensure_remote_dirs(session, &remote_rel).await {
                    failed += 1;
                    errors.push(e);
                }
            }
            continue;
        }
        if !path.is_file() {
            continue;
        }

        let remote_file = join_remote_path(&conn_id, &remote_rel);
        if conflict == "skip"
            && remote_path_exists_inner(store, &remote_file)
                .await
                .unwrap_or(false)
        {
            skipped += 1;
            continue;
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

fn r2r_staging_dir(job_id: u64, source_remote: &str) -> PathBuf {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    source_remote.hash(&mut hasher);
    let tag = hasher.finish();
    let base = if job_id > 0 {
        job_id.to_string()
    } else {
        "adhoc".into()
    };
    std::env::temp_dir()
        .join("filetally_r2r")
        .join(format!("{base}_{tag:x}"))
}

fn top_level_item(dir: &Path) -> Result<PathBuf, String> {
    let mut entries = std::fs::read_dir(dir).map_err(|e| err::with_detail("r2r_staging_failed", e))?;
    let first = entries
        .next()
        .transpose()
        .map_err(|e| err::with_detail("r2r_staging_failed", e))?
        .ok_or_else(|| err::code("r2r_staging_empty"))?;
    Ok(first.path())
}

/// Stage remote → local temp → remote (same connection or cross-connection).
pub async fn transfer_remote_to_remote_job(
    store: &RemoteSessionStore,
    source_remote: &str,
    target_remote_dir: &str,
    conflict: &str,
    job_id: u64,
) -> Result<(u64, u64, u64, Vec<String>), String> {
    if job_id > 0 && crate::job_runner::is_cancelled(job_id) {
        return Err(err::code("transfer_cancelled"));
    }
    let staging = r2r_staging_dir(job_id, source_remote);
    if staging.exists() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    std::fs::create_dir_all(&staging).map_err(|e| err::with_detail("r2r_staging_failed", e))?;

    let outcome = async {
        let (t1, s1, f1, mut e1) = transfer_remote_to_local_job(
            store,
            source_remote,
            &staging,
            conflict,
            job_id,
        )
        .await?;
        if job_id > 0 && crate::job_runner::is_cancelled(job_id) {
            return Err(err::code("transfer_cancelled"));
        }
        let local_src = top_level_item(&staging)?;
        let (t2, s2, f2, e2) = transfer_local_to_remote_job(
            store,
            &local_src,
            target_remote_dir,
            conflict,
            job_id,
        )
        .await?;
        e1.extend(e2);
        Ok((t1.min(t2), s1 + s2, f1 + f2, e1))
    }
    .await;

    let _ = std::fs::remove_dir_all(&staging);
    invalidate_remote_list_cache_many(&[source_remote.to_string(), target_remote_dir.to_string()]);
    outcome
}

pub async fn delete_remote_path(store: &RemoteSessionStore, remote_path: &str) -> Result<(), String> {
    let (conn_id, rel) = parse_remote_path(remote_path)?;
    let mut guard = store.inner.lock().await;
    match guard.get_mut(&conn_id) {
        Some(RemoteSession::Smb(session)) => session
            .client
            .delete_file(&mut session.share, &rel)
            .await
            .map_err(map_smb_err),
        Some(RemoteSession::Sftp(session)) => {
            let s = session.clone();
            drop(guard);
            super::remote_sftp::sftp_unlink(&s, &rel)
        }
        Some(RemoteSession::WebDav {
            inner,
            username,
            password,
        }) => {
            let inner = inner.clone();
            let user = username.clone();
            let pass = password.clone();
            drop(guard);
            super::remote_webdav::webdav_delete(&inner, &rel, &user, &pass).await
        }
        None => Err(session_missing()),
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteRemoteBatchResult {
    pub deleted: usize,
    pub failed: usize,
    pub errors: Vec<String>,
}

async fn delete_remote_tree(store: &RemoteSessionStore, remote_path: &str) -> Result<(), String> {
    path_util::validate_user_path(remote_path)?;
    let (conn_id, rel) = parse_remote_path(remote_path)?;
    let mut files = Vec::new();
    if walk_remote_files(store, &conn_id, &rel, &mut files, 500_000).await.is_ok() && !files.is_empty()
    {
        let mut targets: Vec<String> = files.iter().map(|(p, _, _, _)| p.clone()).collect();
        targets.sort_by_key(|p| std::cmp::Reverse(p.len()));
        for p in targets {
            delete_remote_path(store, &p).await?;
        }
    }
    delete_remote_path(store, remote_path).await
}

#[tauri::command]
pub async fn delete_remote_paths(
    store: State<'_, Arc<RemoteSessionStore>>,
    paths: Vec<String>,
) -> Result<DeleteRemoteBatchResult, String> {
    let cache_paths = paths.clone();
    let mut deleted = 0usize;
    let mut failed = 0usize;
    let mut errors = Vec::new();
    for path in paths {
        if !path_util::is_remote_path(&path) {
            failed += 1;
            errors.push(err::code("remote_path_invalid"));
            continue;
        }
        match delete_remote_tree(store.as_ref(), &path).await {
            Ok(()) => deleted += 1,
            Err(e) => {
                failed += 1;
                errors.push(e);
            }
        }
    }
    invalidate_remote_list_cache_many(&cache_paths);
    Ok(DeleteRemoteBatchResult {
        deleted,
        failed,
        errors,
    })
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
    app: AppHandle,
    store: State<'_, Arc<RemoteSessionStore>>,
    source_paths: Vec<String>,
    target_path: String,
    conflict_resolution: String,
    job_id: Option<u64>,
    max_concurrency: Option<u64>,
) -> Result<crate::commands::transfer::TransferResult, String> {
    let resolution = match conflict_resolution.as_str() {
        "skip" | "rename" | "overwrite" => conflict_resolution.as_str(),
        _ => return Err(err::code("invalid_conflict_resolution")),
    };

    let job_id = job_id.unwrap_or(0);
    let concurrency = max_concurrency
        .unwrap_or_else(crate::commands::transfer::transfer_concurrency)
        .clamp(1, 8) as usize;

    path_util::validate_user_path(&target_path)?;
    for p in &source_paths {
        path_util::validate_user_path(p)?;
    }

    let total = source_paths.len() as u64;
    let _ = app.emit(
        "transfer-progress",
        crate::commands::transfer::TransferProgress {
            current_file: String::new(),
            current_index: 0,
            total_files: total,
            bytes_transferred: 0,
            total_bytes: 0,
            stage: "transferring".to_string(),
            message: String::new(),
        },
    );

    let target_is_remote = path_util::is_remote_path(&target_path);
    let invalidate_paths: Vec<String> = {
        let mut paths = vec![target_path.clone()];
        paths.extend(source_paths.iter().cloned());
        paths
    };
    let store_arc = store.inner().clone();
    let sem = Arc::new(tokio::sync::Semaphore::new(concurrency));
    let done = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let mut handles = Vec::with_capacity(source_paths.len());

    for source in source_paths {
        if job_id > 0 && crate::job_runner::is_cancelled(job_id) {
            break;
        }
        let permit = sem
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| err::with_detail("transfer_concurrency_failed", e))?;
        let store_arc = store_arc.clone();
        let target_path = target_path.clone();
        let resolution = resolution.to_string();
        let app = app.clone();
        let done = done.clone();
        let total_files = total;

        handles.push(tokio::spawn(async move {
            let _permit = permit;
            if job_id > 0 && crate::job_runner::is_cancelled(job_id) {
                return Err(err::code("transfer_cancelled"));
            }

            let source_is_remote = path_util::is_remote_path(&source);
            let current_name = if source_is_remote {
                parse_remote_path(&source)
                    .map(|(_, r)| r.rsplit('/').next().unwrap_or(&r).to_string())
                    .unwrap_or_else(|_| "remote".into())
            } else {
                Path::new(&source)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("file")
                    .to_string()
            };

            let idx = done.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            let _ = app.emit(
                "transfer-progress",
                crate::commands::transfer::TransferProgress {
                    current_file: current_name,
                    current_index: idx,
                    total_files,
                    bytes_transferred: 0,
                    total_bytes: 0,
                    stage: "transferring".to_string(),
                    message: String::new(),
                },
            );

            let result = match (source_is_remote, target_is_remote) {
                (true, false) => {
                    transfer_remote_to_local_job(
                        store_arc.as_ref(),
                        &source,
                        Path::new(&target_path),
                        &resolution,
                        job_id,
                    )
                    .await
                }
                (false, true) => {
                    transfer_local_to_remote_job(
                        store_arc.as_ref(),
                        Path::new(&source),
                        &target_path,
                        &resolution,
                        job_id,
                    )
                    .await
                }
                (true, true) => {
                    transfer_remote_to_remote_job(
                        store_arc.as_ref(),
                        &source,
                        &target_path,
                        &resolution,
                        job_id,
                    )
                    .await
                }
                (false, false) => Err(err::code("smb_not_remote_transfer")),
            };

            result
        }));
    }

    let mut transferred = 0u64;
    let mut skipped = 0u64;
    let mut failed = 0u64;
    let mut errors = Vec::new();
    let mut cancelled = job_id > 0 && crate::job_runner::is_cancelled(job_id);

    for handle in handles {
        match handle.await {
            Ok(Ok((t, s, f, e))) => {
                transferred += t;
                skipped += s;
                failed += f;
                errors.extend(e);
            }
            Ok(Err(e)) => {
                if e.contains("transfer_cancelled") || e.contains("cancelled") {
                    cancelled = true;
                } else {
                    failed += 1;
                    errors.push(e);
                }
            }
            Err(e) => {
                failed += 1;
                errors.push(err::with_detail("task_join_failed", e));
            }
        }
    }

    if cancelled {
        let _ = app.emit(
            "transfer-progress",
            crate::commands::transfer::TransferProgress {
                current_file: String::new(),
                current_index: total,
                total_files: total,
                bytes_transferred: 0,
                total_bytes: 0,
                stage: "cancelled".to_string(),
                message: String::new(),
            },
        );
    }

    // Always invalidate after remote writes so browse doesn't show stale listings.
    invalidate_remote_list_cache_many(&invalidate_paths);

    if job_id > 0 {
        crate::job_runner::end_job(job_id);
    }

    Ok(crate::commands::transfer::TransferResult {
        success: failed == 0 && !cancelled,
        transferred: transferred as usize,
        skipped: skipped as usize,
        failed: failed as usize,
        cancelled,
        truncated: false,
        errors,
    })
}
