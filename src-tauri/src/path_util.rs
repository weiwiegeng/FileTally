use std::path::{Component, Path};

use crate::err;

/// Virtual path scheme for in-app SMB sessions: `remote://{connectionId}/relative/path`
pub const REMOTE_SCHEME: &str = "remote://";

pub fn is_remote_path(path: &str) -> bool {
    path.starts_with(REMOTE_SCHEME)
}

/// Parse `remote://{id}/rel` into `(connection_id, relative_path)`.
/// Relative path uses `/` separators and has no leading slash.
pub fn parse_remote_path(path: &str) -> Result<(String, String), String> {
    let rest = path
        .strip_prefix(REMOTE_SCHEME)
        .ok_or_else(|| err::code("remote_path_invalid"))?;

    if rest.is_empty() {
        return Err(err::code("remote_path_invalid"));
    }

    let (id, rel) = match rest.split_once('/') {
        Some((id, rel)) => (id, rel.trim_matches('/')),
        None => (rest, ""),
    };

    if id.trim().is_empty() {
        return Err(err::code("remote_path_invalid"));
    }

    // Reject path traversal in the relative portion
    for part in rel.split('/') {
        if part == ".." {
            return Err(err::code("path_relative_parent"));
        }
    }

    Ok((id.to_string(), rel.to_string()))
}

pub fn join_remote_path(connection_id: &str, relative: &str) -> String {
    let rel = relative.trim_matches('/');
    if rel.is_empty() {
        format!("{REMOTE_SCHEME}{connection_id}/")
    } else {
        format!("{REMOTE_SCHEME}{connection_id}/{rel}")
    }
}

/// 校验用户传入路径：拒绝空路径、空字节、以及含 ParentDir 的相对穿越段。
/// 桌面文件管理器需要访问任意用户可选路径，因此不做全局 allowlist，
/// 但拒绝明显危险/无效输入。
/// `remote://` 虚拟路径走专用解析。
pub fn validate_user_path(path: &str) -> Result<&Path, String> {
    if path.trim().is_empty() {
        return Err(err::code("path_empty"));
    }
    if path.contains('\0') {
        return Err(err::code("path_illegal_char"));
    }

    if is_remote_path(path) {
        parse_remote_path(path)?;
        // Return a dummy Path for API compatibility; callers must branch on is_remote_path
        return Ok(Path::new(path));
    }

    let p = Path::new(path);

    // Windows UNC paths like \\host\share are absolute
    // 相对路径中禁止 `..` 组件（绝对路径允许正常使用，如 /Users/../Users）
    if !p.is_absolute() {
        for c in p.components() {
            if matches!(c, Component::ParentDir) {
                return Err(err::code("path_relative_parent"));
            }
        }
    }

    Ok(p)
}

/// 校验文件名（不含路径分隔）
pub fn validate_file_name(name: &str) -> Result<&str, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(err::code("name_empty"));
    }
    if trimmed == "." || trimmed == ".." {
        return Err(err::code("name_dot_forbidden"));
    }
    let invalid = ['/', '\\', ':', '*', '?', '"', '<', '>', '|', '\0'];
    if trimmed.chars().any(|c| invalid.contains(&c)) {
        return Err(err::code("name_illegal_char"));
    }
    Ok(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_remote_root_and_nested() {
        let (id, rel) = parse_remote_path("remote://abc/").unwrap();
        assert_eq!(id, "abc");
        assert_eq!(rel, "");

        let (id, rel) = parse_remote_path("remote://abc/foo/bar").unwrap();
        assert_eq!(id, "abc");
        assert_eq!(rel, "foo/bar");
    }

    #[test]
    fn reject_remote_traversal() {
        assert!(parse_remote_path("remote://abc/../etc").is_err());
    }
}
