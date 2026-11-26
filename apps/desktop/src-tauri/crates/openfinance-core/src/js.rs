//! Helpers that reproduce JavaScript semantics the Node server relies on.
//! Shared by every wave; owned by Wave 0.

use chrono::{SecondsFormat, Utc};

pub use crate::crypto::{is_js_whitespace, js_trim};

/// `new Date().toISOString()`: UTC, millisecond precision, `Z` suffix.
pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn now_iso_shape() {
        let s = now_iso();
        // 2026-11-24T05:06:07.089Z
        assert_eq!(s.len(), 24, "{s}");
        assert!(s.ends_with('Z') && s.as_bytes()[10] == b'T' && s.as_bytes()[19] == b'.');
    }

    #[test]
    fn trim_matches_js() {
        assert_eq!(js_trim("\u{feff} a \u{a0}\n"), "a");
        assert_eq!(js_trim("\u{85}a"), "\u{85}a");
    }
}
