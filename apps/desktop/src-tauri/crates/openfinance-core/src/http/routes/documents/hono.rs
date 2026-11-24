//! Request/response details of Hono and the WHATWG APIs that the document
//! routes rely on: query parameters (`c.req.query`), path parameters
//! (`c.req.param`), header strings, `encodeURIComponent` /
//! `decodeURIComponent`, and the `Headers.set` validation that `c.body()` runs.

use axum::http::HeaderMap;

/// A header as `c.req.header(name)` returns it: every value joined with
/// ", ", each byte read as Latin-1 (how Node decodes header bytes).
pub fn header_string(headers: &HeaderMap, name: &str) -> Option<String> {
    let mut values = headers.get_all(name).iter().peekable();
    values.peek()?;
    Some(
        values
            .map(|v| latin1(v.as_bytes()))
            .collect::<Vec<_>>()
            .join(", "),
    )
}

/// Bytes as Latin-1 characters (`isomorphicDecode`).
pub fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| char::from(b)).collect()
}

/// `decodeURIComponent(s)`; `None` where JS throws `URIError`.
pub fn decode_uri_component(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'%' {
            // Copy one whole character.
            let ch_len = utf8_len(bytes[i]);
            out.push_str(s.get(i..i + ch_len)?);
            i += ch_len;
            continue;
        }
        let first = hex_byte(bytes, i)?;
        i += 3;
        if first < 0x80 {
            out.push(char::from(first));
            continue;
        }
        let n = match first {
            0xC0..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF7 => 4,
            _ => return None,
        };
        let mut buf = vec![first];
        for _ in 1..n {
            if bytes.get(i) != Some(&b'%') {
                return None;
            }
            let b = hex_byte(bytes, i)?;
            if b & 0xC0 != 0x80 {
                return None;
            }
            buf.push(b);
            i += 3;
        }
        // Rejects overlong forms, surrogates and > U+10FFFF, like JS.
        out.push_str(std::str::from_utf8(&buf).ok()?);
    }
    Some(out)
}

fn utf8_len(b: u8) -> usize {
    match b {
        0x00..=0x7F => 1,
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        _ => 4,
    }
}

fn hex_byte(bytes: &[u8], i: usize) -> Option<u8> {
    let h = |c: u8| (c as char).to_digit(16);
    let hi = h(*bytes.get(i + 1)?)?;
    let lo = h(*bytes.get(i + 2)?)?;
    Some((hi * 16 + lo) as u8)
}

/// Hono's `tryDecode(str, decodeURIComponent)`: the whole string, or else
/// each run of `%XX` escapes that decodes on its own.
pub fn try_decode_component(s: &str) -> String {
    if let Some(d) = decode_uri_component(s) {
        return d;
    }
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    let mut last = 0;
    while i < bytes.len() {
        if is_escape(bytes, i) {
            let start = i;
            while is_escape(bytes, i) {
                i += 3;
            }
            out.push_str(&s[last..start]);
            let run = &s[start..i];
            match decode_uri_component(run) {
                Some(d) => out.push_str(&d),
                None => out.push_str(run),
            }
            last = i;
        } else {
            i += 1;
        }
    }
    out.push_str(&s[last..]);
    out
}

fn is_escape(bytes: &[u8], i: usize) -> bool {
    bytes.get(i) == Some(&b'%')
        && bytes.get(i + 1).is_some_and(u8::is_ascii_hexdigit)
        && bytes.get(i + 2).is_some_and(u8::is_ascii_hexdigit)
}

/// `c.req.param(name)` from the raw path segment: decoded only when it holds
/// a `%` (the router already ran `decodeURI` over the path; for well-formed
/// escapes the combination is one `decodeURIComponent`).
pub fn path_param(raw: &str) -> String {
    if raw.contains('%') {
        try_decode_component(raw)
    } else {
        raw.to_string()
    }
}

/// Hono `_decodeURI` for query names/values: `+` → space, then `tryDecode`.
fn decode_query_part(value: &str) -> String {
    if !value.contains(['%', '+']) {
        return value.to_string();
    }
    let value = value.replace('+', " ");
    if value.contains('%') {
        try_decode_component(&value)
    } else {
        value
    }
}

/// `c.req.query(key)` (Hono `_getQueryParam(url, key)`), given the raw query
/// string without its `?` (`None` when the URL has no `?`).
pub fn query_param(query: Option<&str>, key: &str) -> Option<String> {
    let query = query?;
    // Work on "?<query>" so the indices mirror `url.indexOf("?")` in Hono.
    let url = format!("?{query}");
    let at = |i: usize| url.as_bytes().get(i).copied();
    let find = |pat: &str, from: usize| url.get(from..).and_then(|s| s.find(pat)).map(|p| p + from);

    let mut encoded = None;
    if !key.contains(['%', '+']) {
        let mut key_index = Some(0usize);
        if !url[1..].starts_with(key) {
            key_index = find(&format!("&{key}"), 1);
        }
        while let Some(ki) = key_index {
            let trailing = at(ki + key.len() + 1);
            match trailing {
                Some(b'=') => {
                    let value_index = ki + key.len() + 2;
                    let end = find("&", value_index).unwrap_or(url.len());
                    return Some(decode_query_part(&url[value_index..end]));
                }
                Some(b'&') | None => return Some(String::new()),
                _ => {}
            }
            key_index = find(&format!("&{key}"), ki + 1);
        }
        let e = url.contains(['%', '+']);
        if !e {
            return None;
        }
        encoded = Some(e);
    }

    let encoded = encoded.unwrap_or_else(|| url.contains(['%', '+']));
    let mut key_index = Some(0usize);
    let mut result: Option<String> = None;
    while let Some(ki) = key_index {
        let next_key_index = find("&", ki + 1);
        let mut value_index = find("=", ki);
        if let (Some(v), Some(n)) = (value_index, next_key_index) {
            if v > n {
                value_index = None;
            }
        }
        let name_end = value_index.or(next_key_index).unwrap_or(url.len());
        let mut name = url[ki + 1..name_end].to_string();
        if encoded {
            name = decode_query_part(&name);
        }
        key_index = next_key_index;
        if name.is_empty() {
            continue;
        }
        let value = match value_index {
            None => String::new(),
            Some(v) => {
                let raw = &url[v + 1..next_key_index.unwrap_or(url.len())];
                if encoded {
                    decode_query_part(raw)
                } else {
                    raw.to_string()
                }
            }
        };
        if name == key && result.is_none() {
            result = Some(value);
        }
    }
    result
}

/// `encodeURIComponent(s)`.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        let unreserved = b.is_ascii_alphanumeric()
            || matches!(
                b,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            );
        if unreserved {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `new Headers().set(name, value)` for a response header: the value with
/// leading/trailing HTTP whitespace removed, or `None` where undici throws
/// (a NUL, CR or LF inside, or a character above U+00FF, which is not a
/// ByteString). The result is the header's Latin-1 bytes.
pub fn response_header_bytes(value: &str) -> Option<Vec<u8>> {
    let ws = |c: char| matches!(c, '\t' | '\n' | '\r' | ' ');
    let trimmed = value.trim_matches(ws);
    let mut out = Vec::with_capacity(trimmed.len());
    for c in trimmed.chars() {
        let cp = u32::from(c);
        if cp > 0xFF || matches!(c, '\0' | '\r' | '\n') {
            return None;
        }
        out.push(cp as u8);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_component_like_js() {
        assert_eq!(decode_uri_component("a%20b").as_deref(), Some("a b"));
        assert_eq!(decode_uri_component("%E2%9C%93").as_deref(), Some("✓"));
        assert_eq!(decode_uri_component("%2F%3f").as_deref(), Some("/?"));
        assert_eq!(decode_uri_component("ü%41").as_deref(), Some("üA"));
        assert_eq!(decode_uri_component("%"), None);
        assert_eq!(decode_uri_component("%zz"), None);
        assert_eq!(decode_uri_component("%C0%80"), None);
        assert_eq!(decode_uri_component("%ED%A0%80"), None);
        assert_eq!(decode_uri_component("%E2%9C"), None);
        assert_eq!(try_decode_component("%41%zz%42"), "A%zzB");
        assert_eq!(try_decode_component("%E2%9C%93%E2"), "%E2%9C%93%E2");
        assert_eq!(try_decode_component("%E2%9C%93x%E2"), "✓x%E2");
    }

    #[test]
    fn encode_component_like_js() {
        assert_eq!(
            encode_uri_component("Report (final) ü ✓/x?.pdf"),
            "Report%20(final)%20%C3%BC%20%E2%9C%93%2Fx%3F.pdf"
        );
        assert_eq!(encode_uri_component("a-_.!~*'()"), "a-_.!~*'()");
    }

    #[test]
    fn query_like_hono() {
        let q = |s: &str, k: &str| query_param(Some(s), k);
        assert_eq!(
            q("investment_id=abc", "investment_id").as_deref(),
            Some("abc")
        );
        assert_eq!(
            q("a=1&investment_id=x%20y", "investment_id").as_deref(),
            Some("x y")
        );
        assert_eq!(q("investment_id", "investment_id").as_deref(), Some(""));
        assert_eq!(q("investment_id&b=1", "investment_id").as_deref(), Some(""));
        assert_eq!(q("investment_idx=1", "investment_id"), None);
        assert_eq!(q("investment_idx=1&c=%41", "investment_id"), None);
        assert_eq!(
            q("investment_i%64=7", "investment_id").as_deref(),
            Some("7")
        );
        assert_eq!(
            q("x=1&investment_id=a&investment_id=b", "investment_id").as_deref(),
            Some("a")
        );
        assert_eq!(
            q("investment_id=a+b", "investment_id").as_deref(),
            Some("a b")
        );
        assert_eq!(query_param(None, "investment_id"), None);
    }

    #[test]
    fn header_values() {
        assert_eq!(
            response_header_bytes(" application/pdf "),
            Some(b"application/pdf".to_vec())
        );
        assert_eq!(response_header_bytes("a\nb"), None);
        assert_eq!(response_header_bytes("ü"), Some(vec![0xFC]));
        assert_eq!(response_header_bytes("✓"), None);
        assert_eq!(response_header_bytes(""), Some(vec![]));
    }
}
