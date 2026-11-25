use reqwest::{Client, StatusCode};
use serde::Serialize;
use std::time::Duration;

use crate::err;
use crate::path_util::join_remote_path;

#[derive(Clone)]
pub struct WebDavSession {
    pub client: Client,
    pub base_url: String,
    pub label: String,
}

pub async fn connect_webdav(
    base_url: &str,
    username: &str,
    password: &str,
    label: &str,
    timeout_ms: u64,
) -> Result<WebDavSession, String> {
    let mut url = base_url.trim().to_string();
    if !url.ends_with('/') {
        url.push('/');
    }
    if !url.starts_with("http://") && !url.starts_with("https://") {
        url = format!("https://{url}");
    }

    let client = Client::builder()
        .timeout(Duration::from_millis(timeout_ms.max(5_000)))
        .build()
        .map_err(|e| err::with_detail("webdav_connect_failed", e))?;

    let resp = client
        .request(reqwest::Method::from_bytes(b"PROPFIND").unwrap(), &url)
        .header("Depth", "0")
        .basic_auth(username, Some(password))
        .send()
        .await
        .map_err(|e| err::with_detail("webdav_connect_failed", e))?;

    if resp.status() == StatusCode::UNAUTHORIZED {
        return Err(err::code("webdav_auth_failed"));
    }
    if !resp.status().is_success() && resp.status() != StatusCode::MULTI_STATUS {
        return Err(err::with_detail("webdav_connect_failed", resp.status()));
    }

    Ok(WebDavSession {
        client,
        base_url: url,
        label: label.to_string(),
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct WebDavEntry {
    pub href: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: i64,
}

fn decode_href(raw: &str) -> String {
    urlencoding::decode(raw)
        .map(|s| s.into_owned())
        .unwrap_or_else(|_| raw.to_string())
}

fn child_name(parent: &str, href: &str) -> String {
    let decoded = decode_href(href);
    let parent_norm = parent.trim_end_matches('/');
    if let Some(rest) = decoded.strip_prefix(parent_norm) {
        let rest = rest.trim_start_matches('/');
        return rest.trim_end_matches('/').to_string();
    }
    decoded
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_string()
}

pub async fn webdav_list_dir(session: &WebDavSession, rel: &str, username: &str, password: &str) -> Result<Vec<WebDavEntry>, String> {
    let rel = rel.trim_matches('/');
    let target = if rel.is_empty() {
        session.base_url.clone()
    } else {
        format!("{}{rel}/", session.base_url)
    };
    let body = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop>
</d:propfind>"#;

    let resp = session
        .client
        .request(reqwest::Method::from_bytes(b"PROPFIND").unwrap(), &target)
        .header("Depth", "1")
        .basic_auth(username, Some(password))
        .header("Content-Type", "application/xml")
        .body(body)
        .send()
        .await
        .map_err(|e| err::with_detail("webdav_list_failed", e))?;

    if resp.status() == StatusCode::UNAUTHORIZED {
        return Err(err::code("webdav_auth_failed"));
    }
    if !resp.status().is_success() && resp.status() != StatusCode::MULTI_STATUS {
        return Err(err::with_detail("webdav_list_failed", resp.status()));
    }

    let text = resp
        .text()
        .await
        .map_err(|e| err::with_detail("webdav_list_failed", e))?;

    let parent_path = decode_href(
        &reqwest::Url::parse(&target)
            .map(|u: reqwest::Url| u.path().to_string())
            .unwrap_or_else(|_| "/".into()),
    );

    let mut out = Vec::new();
    for block in text.split("<d:response").skip(1) {
        let href = block
            .split("<d:href>")
            .nth(1)
            .and_then(|s| s.split("</d:href>").next())
            .unwrap_or("")
            .trim();
        if href.is_empty() {
            continue;
        }
        let name = child_name(&parent_path, href);
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }
        let is_dir = block.contains("<d:collection");
        let size = block
            .split("<d:getcontentlength>")
            .nth(1)
            .and_then(|s| s.split("</d:getcontentlength>").next())
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(0);
        let modified = block
            .split("<d:getlastmodified>")
            .nth(1)
            .and_then(|s| s.split("</d:getlastmodified>").next())
            .map(|s| parse_http_date_secs(s.trim()))
            .unwrap_or(0);
        out.push(WebDavEntry {
            href: decode_href(href),
            name,
            is_dir,
            size,
            modified,
        });
    }
    Ok(out)
}

fn parse_http_date_secs(raw: &str) -> i64 {
    // Best-effort RFC 2822 / HTTP-date → unix seconds (0 = unknown → size-only sync).
    chrono::DateTime::parse_from_rfc2822(raw)
        .map(|dt| dt.timestamp())
        .unwrap_or(0)
}

/// PROPFIND Depth 0 → (exists, is_dir). Missing → Ok((false, false)).
pub async fn webdav_stat(
    session: &WebDavSession,
    rel: &str,
    username: &str,
    password: &str,
) -> Result<(bool, bool), String> {
    let rel = rel.trim_matches('/');
    let target = if rel.is_empty() {
        session.base_url.clone()
    } else {
        // Prefer collection URL when probing; many servers accept both.
        format!("{}{rel}", session.base_url)
    };
    let body = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop><d:resourcetype/></d:prop>
</d:propfind>"#;

    let resp = session
        .client
        .request(reqwest::Method::from_bytes(b"PROPFIND").unwrap(), &target)
        .header("Depth", "0")
        .basic_auth(username, Some(password))
        .header("Content-Type", "application/xml")
        .body(body)
        .send()
        .await
        .map_err(|e| err::with_detail("webdav_list_failed", e))?;

    if resp.status() == StatusCode::NOT_FOUND {
        return Ok((false, false));
    }
    if resp.status() == StatusCode::UNAUTHORIZED {
        return Err(err::code("webdav_auth_failed"));
    }
    if !resp.status().is_success() && resp.status() != StatusCode::MULTI_STATUS {
        // Retry with trailing slash (directory form) once.
        if !target.ends_with('/') {
            let alt = format!("{target}/");
            let resp2 = session
                .client
                .request(reqwest::Method::from_bytes(b"PROPFIND").unwrap(), &alt)
                .header("Depth", "0")
                .basic_auth(username, Some(password))
                .header("Content-Type", "application/xml")
                .body(body)
                .send()
                .await
                .map_err(|e| err::with_detail("webdav_list_failed", e))?;
            if resp2.status() == StatusCode::NOT_FOUND {
                return Ok((false, false));
            }
            if resp2.status().is_success() || resp2.status() == StatusCode::MULTI_STATUS {
                let text = resp2
                    .text()
                    .await
                    .map_err(|e| err::with_detail("webdav_list_failed", e))?;
                let is_dir = text.contains("<d:collection");
                return Ok((true, is_dir || rel.is_empty()));
            }
            return Err(err::with_detail("webdav_list_failed", resp2.status()));
        }
        return Err(err::with_detail("webdav_list_failed", resp.status()));
    }

    let text = resp
        .text()
        .await
        .map_err(|e| err::with_detail("webdav_list_failed", e))?;
    let is_dir = text.contains("<d:collection") || rel.is_empty();
    Ok((true, is_dir))
}

pub async fn webdav_mkcol(
    session: &WebDavSession,
    rel: &str,
    username: &str,
    password: &str,
) -> Result<(), String> {
    let rel = rel.trim_matches('/');
    if rel.is_empty() {
        return Ok(());
    }
    let url = format!("{}{rel}/", session.base_url);
    let resp = session
        .client
        .request(reqwest::Method::from_bytes(b"MKCOL").unwrap(), &url)
        .basic_auth(username, Some(password))
        .send()
        .await
        .map_err(|e| err::with_detail("webdav_write_failed", e))?;
    // 201 Created, 405 Method Not Allowed / 409 often means already exists
    if resp.status().is_success()
        || resp.status() == StatusCode::CREATED
        || resp.status() == StatusCode::METHOD_NOT_ALLOWED
        || resp.status() == StatusCode::CONFLICT
    {
        return Ok(());
    }
    Err(err::with_detail("webdav_write_failed", resp.status()))
}

pub async fn webdav_ensure_dirs(
    session: &WebDavSession,
    rel: &str,
    username: &str,
    password: &str,
) -> Result<(), String> {
    let rel = rel.trim_matches('/');
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
        let (exists, is_dir) = webdav_stat(session, &acc, username, password).await?;
        if exists {
            if !is_dir {
                return Err(err::with_detail("smb_path_not_dir", &acc));
            }
            continue;
        }
        webdav_mkcol(session, &acc, username, password).await?;
    }
    Ok(())
}

pub async fn webdav_read_file(
    session: &WebDavSession,
    rel: &str,
    username: &str,
    password: &str,
) -> Result<Vec<u8>, String> {
    let rel = rel.trim_matches('/');
    let url = if rel.is_empty() {
        return Err(err::code("remote_path_is_dir"));
    } else {
        format!("{}{rel}", session.base_url)
    };
    let resp = session
        .client
        .get(&url)
        .basic_auth(username, Some(password))
        .send()
        .await
        .map_err(|e| err::with_detail("webdav_read_failed", e))?;
    if !resp.status().is_success() {
        return Err(err::with_detail("webdav_read_failed", resp.status()));
    }
    resp.bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| err::with_detail("webdav_read_failed", e))
}

/// Stream a remote WebDAV file to a local path (avoids loading the whole file into RAM).
pub async fn webdav_download_to_file(
    session: &WebDavSession,
    rel: &str,
    local_path: &std::path::Path,
    username: &str,
    password: &str,
) -> Result<(), String> {
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    let rel = rel.trim_matches('/');
    if rel.is_empty() {
        return Err(err::code("remote_path_is_dir"));
    }
    let url = format!("{}{rel}", session.base_url);
    let resp = session
        .client
        .get(&url)
        .basic_auth(username, Some(password))
        .send()
        .await
        .map_err(|e| err::with_detail("webdav_read_failed", e))?;
    if !resp.status().is_success() {
        return Err(err::with_detail("webdav_read_failed", resp.status()));
    }
    if let Some(parent) = local_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| err::with_detail("copy_failed", e))?;
    }
    let mut file = tokio::fs::File::create(local_path)
        .await
        .map_err(|e| err::with_detail("copy_failed", e))?;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| err::with_detail("webdav_read_failed", e))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| err::with_detail("copy_failed", e))?;
    }
    file.flush()
        .await
        .map_err(|e| err::with_detail("copy_failed", e))?;
    Ok(())
}

pub async fn webdav_write_file(
    session: &WebDavSession,
    rel: &str,
    data: &[u8],
    username: &str,
    password: &str,
) -> Result<(), String> {
    let rel = rel.trim_matches('/');
    if rel.is_empty() {
        return Err(err::code("remote_path_is_dir"));
    }
    if let Some((parent, _)) = rel.rsplit_once('/') {
        webdav_ensure_dirs(session, parent, username, password).await?;
    }
    let url = format!("{}{rel}", session.base_url);
    let resp = session
        .client
        .put(&url)
        .basic_auth(username, Some(password))
        .body(data.to_vec())
        .send()
        .await
        .map_err(|e| err::with_detail("webdav_write_failed", e))?;
    if !resp.status().is_success() && resp.status() != StatusCode::CREATED {
        return Err(err::with_detail("webdav_write_failed", resp.status()));
    }
    Ok(())
}

/// Upload a local file via PUT (ensures parent MKCOL chain).
pub async fn webdav_upload_from_file(
    session: &WebDavSession,
    rel: &str,
    local_path: &std::path::Path,
    username: &str,
    password: &str,
) -> Result<(), String> {
    let data = tokio::fs::read(local_path)
        .await
        .map_err(|e| err::with_detail("copy_failed", e))?;
    webdav_write_file(session, rel, &data, username, password).await
}

pub async fn webdav_delete(
    session: &WebDavSession,
    rel: &str,
    username: &str,
    password: &str,
) -> Result<(), String> {
    let rel = rel.trim_matches('/');
    if rel.is_empty() {
        return Err(err::code("remote_path_is_dir"));
    }
    let url = format!("{}{rel}", session.base_url);
    let resp = session
        .client
        .delete(&url)
        .basic_auth(username, Some(password))
        .send()
        .await
        .map_err(|e| err::with_detail("webdav_delete_failed", e))?;
    if !resp.status().is_success() && resp.status() != StatusCode::NO_CONTENT {
        return Err(err::with_detail("webdav_delete_failed", resp.status()));
    }
    Ok(())
}

pub async fn walk_webdav_files(
    session: &WebDavSession,
    conn_id: &str,
    rel: &str,
    username: &str,
    password: &str,
    out: &mut Vec<(String, u64, bool, i64)>,
    cap: usize,
) -> Result<(), String> {
    if out.len() >= cap {
        return Ok(());
    }
    let entries = webdav_list_dir(session, rel, username, password).await?;
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
            Box::pin(walk_webdav_files(
                session, conn_id, &child_rel, username, password, out, cap,
            ))
            .await?;
        } else {
            out.push((remote_path, e.size, false, e.modified));
        }
    }
    Ok(())
}