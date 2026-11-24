use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Read;
use std::path::Path;

const HASH_CHUNK: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyDuplicateResult {
    pub confirmed: bool,
    pub hash: String,
}

/// Stream full SHA-256 over all paths; `confirmed` when every file yields the same digest.
#[tauri::command]
pub fn verify_duplicate_files(paths: Vec<String>) -> Result<VerifyDuplicateResult, String> {
    if paths.len() < 2 {
        return Err(crate::err::code("duplicate_need_two"));
    }

    let mut expected: Option<String> = None;
    for p in &paths {
        crate::path_util::validate_user_path(p)?;
        if crate::path_util::is_remote_path(p) {
            return Err(crate::err::code("duplicate_remote_unsupported"));
        }
        let hash = hash_file_sha256(Path::new(p))?;
        match &expected {
            None => expected = Some(hash),
            Some(exp) if exp == &hash => {}
            Some(exp) => {
                return Ok(VerifyDuplicateResult {
                    confirmed: false,
                    hash: exp.clone(),
                });
            }
        }
    }

    Ok(VerifyDuplicateResult {
        confirmed: true,
        hash: expected.unwrap_or_default(),
    })
}

fn hash_file_sha256(path: &Path) -> Result<String, String> {
    if !path.is_file() {
        return Err(crate::err::with_detail("duplicate_not_file", path.display()));
    }
    let mut file = File::open(path).map_err(|e| crate::err::with_detail("duplicate_read_failed", e))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; HASH_CHUNK];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| crate::err::with_detail("duplicate_read_failed", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}