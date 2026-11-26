//! Shared archive / roster key normalization for material verification.

/// First token of a folder/roster label (`S2026-0008 刘澎` → `S2026-0008`).
pub fn first_token(raw: &str) -> &str {
    raw.trim()
        .split(|c: char| c.is_whitespace() || c == '　')
        .find(|t| !t.is_empty())
        .unwrap_or("")
}

/// Strip leading `S` so `S2026-0008` → `2026-0008`.
pub fn normalize_archive_id(raw: &str) -> String {
    let token = first_token(raw);
    let mut chars = token.chars();
    match (chars.next(), chars.as_str()) {
        (Some('S') | Some('s'), rest) if rest.starts_with(|c: char| c.is_ascii_digit()) => {
            rest.to_string()
        }
        _ => token.to_string(),
    }
}

/// Leading `YYYY-digits` in a label, allowing glued names (`2026-0008刘澎` / `S2026-0135朱鹏飞`).
fn extract_year_num_prefix(raw: &str) -> Option<(String, String)> {
    let mut s = raw.trim();
    if let Some(rest) = s.strip_prefix('S').or_else(|| s.strip_prefix('s')) {
        if rest.starts_with(|c: char| c.is_ascii_digit()) {
            s = rest;
        }
    }
    // Also allow first token only when spaced.
    if let Some(tok) = s.split(|c: char| c.is_whitespace() || c == '　').next() {
        if !tok.is_empty() {
            s = tok;
        }
    }
    let chars: Vec<char> = s.chars().collect();
    if chars.len() < 6 {
        return None;
    }
    if !(chars[..4].iter().all(|c| c.is_ascii_digit()) && chars[4] == '-') {
        return None;
    }
    let mut i = 5;
    while i < chars.len() && chars[i].is_ascii_digit() {
        i += 1;
    }
    if i == 5 {
        return None;
    }
    let year: String = chars[..4].iter().collect();
    let num: String = chars[5..i].iter().collect();
    Some((year, num))
}

/// Canonical key: strip `S` and leading zeros in the numeric suffix.
pub fn archive_id_key(raw: &str) -> String {
    if let Some((year, num)) = extract_year_num_prefix(raw) {
        let trimmed = num.trim_start_matches('0');
        let trimmed = if trimmed.is_empty() { "0" } else { trimmed };
        return format!("{}-{}", year, trimmed);
    }
    let id = normalize_archive_id(raw);
    if let Some((year, num)) = id.split_once('-') {
        if !year.is_empty()
            && year.chars().all(|c| c.is_ascii_digit())
            && !num.is_empty()
            && num.chars().all(|c| c.is_ascii_digit())
        {
            let trimmed = num.trim_start_matches('0');
            let trimmed = if trimmed.is_empty() { "0" } else { trimmed };
            return format!("{}-{}", year, trimmed);
        }
    }
    id
}

/// `YYYY-N` after normalization (e.g. `2026-13`, `2026-135`).
pub fn looks_like_archive_key(key: &str) -> bool {
    if let Some((year, num)) = key.split_once('-') {
        year.len() == 4
            && year.chars().all(|c| c.is_ascii_digit())
            && !num.is_empty()
            && num.chars().all(|c| c.is_ascii_digit())
    } else {
        false
    }
}

pub fn folder_matches_roster_name(folder_name: &str, roster_name: &str, mode: &str) -> bool {
    if roster_name.is_empty() {
        return false;
    }
    if folder_name == roster_name {
        return true;
    }
    let folder_key = archive_id_key(folder_name);
    let roster_key = archive_id_key(roster_name);

    // Archive ids must match as whole keys. Never allow `2026-13` ⊆ `2026-135`.
    if looks_like_archive_key(&roster_key) && looks_like_archive_key(&folder_key) {
        return folder_key == roster_key;
    }

    if !roster_key.is_empty() && !folder_key.is_empty() && looks_like_archive_key(&roster_key) {
        // Roster is an archive id; folder is not id-shaped — still only accept equal keys.
        return folder_key == roster_key;
    }

    match mode {
        "exact" => false,
        "starts_with" => folder_name.starts_with(roster_name),
        _ => folder_name.contains(roster_name),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_normalizes_prefix_and_zeros() {
        assert_eq!(archive_id_key("S2026-0008"), "2026-8");
        assert_eq!(archive_id_key("2026-0008 刘澎"), "2026-8");
        assert_eq!(archive_id_key("S2026-0109"), "2026-109");
        assert_eq!(archive_id_key("2026-109 惠春菊"), "2026-109");
        assert_eq!(archive_id_key("2026-0008刘澎"), "2026-8");
    }

    #[test]
    fn archive_keys_do_not_substring_match() {
        // Regression: S2026-0013 must NOT bind to 2026-135…
        assert!(!folder_matches_roster_name(
            "2026-135朱鹏飞",
            "S2026-0013",
            "contains"
        ));
        assert!(!folder_matches_roster_name(
            "2026-155王占刚",
            "S2026-0015",
            "contains"
        ));
        assert!(folder_matches_roster_name(
            "2026-0135朱鹏飞",
            "S2026-0135",
            "contains"
        ));
        assert!(folder_matches_roster_name(
            "2026-135朱鹏飞",
            "S2026-0135",
            "contains"
        ));
        assert!(folder_matches_roster_name(
            "2026-0008刘澎",
            "S2026-0008",
            "contains"
        ));
    }
}
