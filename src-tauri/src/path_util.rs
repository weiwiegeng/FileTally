use std::path::{Component, Path};

use crate::err;

/// 校验用户传入路径：拒绝空路径、空字节、以及含 ParentDir 的相对穿越段。
/// 桌面文件管理器需要访问任意用户可选路径，因此不做全局 allowlist，
/// 但拒绝明显危险/无效输入。
pub fn validate_user_path(path: &str) -> Result<&Path, String> {
    if path.trim().is_empty() {
        return Err(err::code("path_empty"));
    }
    if path.contains('\0') {
        return Err(err::code("path_illegal_char"));
    }

    let p = Path::new(path);

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
