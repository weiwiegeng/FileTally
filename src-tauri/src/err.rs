//! Stable machine-readable error codes for frontend i18n mapping.
//! Format: `FTERR:<code>` or `FTERR:<code>|<detail>`

use std::fmt::Display;

pub fn code(code: &str) -> String {
    format!("FTERR:{code}")
}

pub fn with_detail(code: &str, detail: impl Display) -> String {
    format!("FTERR:{code}|{detail}")
}
