use ssh2::{Session, Sftp};
use std::io::Read;
use std::net::TcpStream;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::err;
use crate::path_util::join_remote_path;

pub struct SftpSession {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub root: String,
    pub label: String,
    /// Shared live SSH session — reconnects on demand.
    live: Arc<Mutex<Option<Session>>>,
}

impl Clone for SftpSession {
    fn clone(&self) -> Self {
        Self {
            host: self.host.clone(),
            port: self.port,
            username: self.username.clone(),
            password: self.password.clone(),
            root: self.root.clone(),
            label: self.label.clone(),
            live: Arc::clone(&self.live),
        }
    }
}

fn connect_session(host: &str, port: u16, username: &str, password: &str) -> Result<Session, String> {
    let addr = format!("{host}:{port}");
    let tcp = TcpStream::connect(&addr).map_err(|e| err::with_detail("sftp_connect_failed", e))?;
    tcp.set_read_timeout(Some(Duration::from_secs(60)))
        .map_err(|e| err::with_detail("sftp_connect_failed", e))?;
    tcp.set_write_timeout(Some(Duration::from_secs(60)))
        .map_err(|e| err::with_detail("sftp_connect_failed", e))?;

    let mut sess = Session::new().map_err(|e| err::with_detail("sftp_connect_failed", e))?;
    sess.set_tcp_stream(tcp);
    sess.handshake()
        .map_err(|e| err::with_detail("sftp_connect_failed", e))?;
    sess.userauth_password(username, password)
        .map_err(|e| err::with_detail("sftp_auth_failed", e))?;
    if !sess.authenticated() {
        return Err(err::code("sftp_auth_failed"));
    }
    Ok(sess)
}

fn ensure_live(session: &SftpSession) -> Result<(), String> {
    let mut guard = session
        .live
        .lock()
        .map_err(|_| err::code("sftp_connect_failed"))?;
    if guard.is_none() {
        *guard = Some(connect_session(
            &session.host,
            session.port,
            &session.username,
            &session.password,
        )?);
    }
    Ok(())
}

fn with_sftp<R>(
    session: &SftpSession,
    f: impl FnOnce(&Sftp) -> Result<R, String>,
) -> Result<R, String> {
    ensure_live(session)?;
    let guard = session
        .live
        .lock()
        .map_err(|_| err::code("sftp_connect_failed"))?;
    let sess = guard.as_ref().ok_or_else(|| err::code("sftp_connect_failed"))?;
    let sftp = sess.sftp().map_err(|e| err::with_detail("sftp_connect_failed", e))?;
    f(&sftp)
}

pub fn connect_sftp(
    host: &str,
    port: u16,
    username: &str,
    password: &str,
    root: &str,
    label: &str,
) -> Result<SftpSession, String> {
    let sess = connect_session(host, port, username, password)?;
    let root = if root.trim().is_empty() {
        "/".to_string()
    } else {
        let mut r = root.trim().to_string();
        if !r.starts_with('/') {
            r.insert(0, '/');
        }
        r
    };
    Ok(SftpSession {
        host: host.to_string(),
        port,
        username: username.to_string(),
        password: password.to_string(),
        root,
        label: label.to_string(),
        live: Arc::new(Mutex::new(Some(sess))),
    })
}

fn remote_path(session: &SftpSession, rel: &str) -> String {
    let rel = rel.trim_matches('/');
    if rel.is_empty() {
        session.root.clone()
    } else {
        format!("{}/{rel}", session.root.trim_end_matches('/'))
    }
}

fn mtime_secs(mtime: Option<u64>) -> i64 {
    mtime.unwrap_or(0) as i64
}

pub struct SftpEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: i64,
}

pub fn sftp_list_dir(session: &SftpSession, rel: &str) -> Result<Vec<SftpEntry>, String> {
    let path = remote_path(session, rel);
    with_sftp(session, |sftp| list_dir_at(sftp, Path::new(&path)))
}

fn list_dir_at(sftp: &Sftp, path: &Path) -> Result<Vec<SftpEntry>, String> {
    let dir = sftp
        .readdir(path)
        .map_err(|e| err::with_detail("sftp_list_failed", e))?;
    let mut out = Vec::new();
    for (p, stat) in dir {
        let name = p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        if name == "." || name == ".." {
            continue;
        }
        let file_type = stat.file_type();
        let is_dir = file_type.is_dir();
        out.push(SftpEntry {
            name,
            is_dir,
            size: stat.size.unwrap_or(0),
            modified: mtime_secs(stat.mtime),
        });
    }
    Ok(out)
}

pub fn sftp_read_file(session: &SftpSession, rel: &str) -> Result<Vec<u8>, String> {
    if rel.trim().is_empty() {
        return Err(err::code("remote_path_is_dir"));
    }
    let path = remote_path(session, rel);
    with_sftp(session, |sftp| {
        let mut file = sftp
            .open(Path::new(&path))
            .map_err(|e| err::with_detail("sftp_read_failed", e))?;
        let mut data = Vec::new();
        file.read_to_end(&mut data)
            .map_err(|e| err::with_detail("sftp_read_failed", e))?;
        Ok(data)
    })
}

pub fn sftp_write_file(session: &SftpSession, rel: &str, data: &[u8]) -> Result<(), String> {
    if rel.trim().is_empty() {
        return Err(err::code("remote_path_is_dir"));
    }
    let path = remote_path(session, rel);
    with_sftp(session, |sftp| {
        if let Some(parent) = Path::new(&path).parent() {
            let _ = sftp.mkdir(parent, 0o755);
        }
        let mut file = sftp
            .create(Path::new(&path))
            .map_err(|e| err::with_detail("sftp_write_failed", e))?;
        use std::io::Write;
        file.write_all(data)
            .map_err(|e| err::with_detail("sftp_write_failed", e))?;
        Ok(())
    })
}

pub fn sftp_unlink(session: &SftpSession, rel: &str) -> Result<(), String> {
    if rel.trim().is_empty() {
        return Err(err::code("remote_path_is_dir"));
    }
    let path = remote_path(session, rel);
    with_sftp(session, |sftp| {
        sftp.unlink(Path::new(&path))
            .map_err(|e| err::with_detail("sftp_delete_failed", e))?;
        Ok(())
    })
}

pub fn sftp_stat_is_dir(session: &SftpSession, rel: &str) -> Result<bool, String> {
    let path = remote_path(session, rel);
    with_sftp(session, |sftp| {
        let stat = sftp
            .stat(Path::new(&path))
            .map_err(|e| err::with_detail("sftp_stat_failed", e))?;
        Ok(stat.file_type().is_dir())
    })
}

pub fn walk_sftp_files(
    session: &SftpSession,
    conn_id: &str,
    rel: &str,
    out: &mut Vec<(String, u64, bool, i64)>,
    cap: usize,
) -> Result<(), String> {
    if out.len() >= cap {
        return Ok(());
    }
    let entries = sftp_list_dir(session, rel)?;
    for e in entries {
        if out.len() >= cap {
            break;
        }
        let child_rel = if rel.is_empty() {
            e.name.clone()
        } else {
            format!("{rel}/{}", e.name)
        };
        let remote_path = join_remote_path(conn_id, &child_rel);
        if e.is_dir {
            out.push((remote_path, e.size, true, e.modified));
            walk_sftp_files(session, conn_id, &child_rel, out, cap)?;
        } else {
            out.push((remote_path, e.size, false, e.modified));
        }
    }
    Ok(())
}
