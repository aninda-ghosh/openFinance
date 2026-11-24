//! `await c.req.parseBody()` as the Node server runs it: Hono's
//! `parseBody` (utils/body.ts) on top of undici's `Request.formData()`
//! (lib/web/fetch/body.js + formdata-parser.js, as bundled with Node 24).
//! Ported line by line so that malformed bodies fail exactly where undici
//! throws (`TypeError` → the route's 500) and well-formed ones yield the
//! same fields, file names and MIME types.

use std::collections::HashMap;

use axum::http::HeaderMap;

use super::hono::{decode_uri_component, header_string, latin1};
use crate::services::document::FormText;

/// A `File` from the form: `file.name`, `file.type`, the bytes (`file.size`
/// is their length).
#[derive(Debug, Clone, PartialEq)]
pub struct FormFile {
    pub name: String,
    pub mime_type: String,
    pub data: Vec<u8>,
}

/// One form value: a string or a `File`.
#[derive(Debug, Clone, PartialEq)]
pub enum FormValue {
    Text(String),
    File(FormFile),
}

impl FormValue {
    /// The value as `createDocument` binds it.
    pub fn as_form_text(&self) -> FormText {
        match self {
            FormValue::Text(s) => FormText::Text(s.clone()),
            FormValue::File(_) => FormText::File,
        }
    }
}

/// Hono's parsed body (`Object.create(null)`): the last value per key.
/// Keys ending in `[]` become arrays in Hono; no route reads them, so they
/// are left out.
pub type FormBody = HashMap<String, FormValue>;

/// Why `request.formData()` rejected (always a 500 in the routes).
#[derive(Debug, Clone, PartialEq)]
pub struct FormError(pub String);

/// `c.req.parseBody()`.
pub fn parse_body(headers: &HeaderMap, body: &[u8]) -> Result<FormBody, FormError> {
    let content_type = header_string(headers, "content-type");
    let ct = content_type.as_deref().unwrap_or("");
    let multipart = ct.starts_with("multipart/form-data");
    let urlencoded = ct.starts_with("application/x-www-form-urlencoded");
    if content_type.is_none() || !(multipart || urlencoded) {
        return Ok(FormBody::new());
    }
    let mime = extract_mime_type(ct).ok_or_else(not_form_error)?;
    match mime.essence.as_str() {
        "multipart/form-data" => {
            let entries = multipart_parser(body, &mime)?;
            let mut form = FormBody::new();
            for (name, value) in entries {
                if !name.ends_with("[]") {
                    form.insert(name, value);
                }
            }
            Ok(form)
        }
        // URLSearchParams never fails and only yields strings; no route
        // reads string fields unless a `File` was uploaded, so the values
        // themselves are not needed.
        "application/x-www-form-urlencoded" => Ok(FormBody::new()),
        _ => Err(not_form_error()),
    }
}

fn not_form_error() -> FormError {
    FormError(
        "TypeError: Content-Type was not one of \"multipart/form-data\" or \"application/x-www-form-urlencoded\"."
            .into(),
    )
}

fn parsing_error(cause: &str) -> FormError {
    FormError(format!("TypeError: Failed to parse body as FormData. ({cause})"))
}

// ── MIME type (fetch/data-url.js, fetch/util.js) ─────────────────────────────

#[derive(Debug, Clone)]
struct MimeType {
    essence: String,
    parameters: Vec<(String, String)>,
}

impl MimeType {
    fn param(&self, name: &str) -> Option<&str> {
        self.parameters
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

fn is_http_ws(c: char) -> bool {
    matches!(c, '\r' | '\n' | '\t' | ' ')
}

/// `removeHTTPWhitespace(s, false, true)`: like `trimEnd`, except that the
/// first character is never removed (undici's `trail > 0` loop bound).
fn trim_end_js(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        None => String::new(),
        Some(first) => {
            let mut out = String::from(first);
            out.push_str(chars.as_str().trim_end_matches(is_http_ws));
            out
        }
    }
}

fn is_token_cp(c: char) -> bool {
    c.is_ascii_alphanumeric() || "-!#$%&'*+.^_|~".contains(c)
}

fn token_string(s: &str) -> bool {
    !s.is_empty() && s.chars().all(is_token_cp)
}

fn quoted_string_tokens(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c == '\t' || ('\u{20}'..='\u{7e}').contains(&c) || ('\u{80}'..='\u{ff}').contains(&c))
}

/// `collectAnHTTPQuotedString(input, position, extractValue)` on chars.
fn collect_quoted(input: &[char], pos: &mut usize, extract: bool) -> String {
    let start = *pos;
    let mut value = String::new();
    *pos += 1; // the opening quote
    loop {
        while *pos < input.len() && input[*pos] != '"' && input[*pos] != '\\' {
            value.push(input[*pos]);
            *pos += 1;
        }
        if *pos >= input.len() {
            break;
        }
        let q = input[*pos];
        *pos += 1;
        if q == '\\' {
            if *pos >= input.len() {
                value.push('\\');
                break;
            }
            value.push(input[*pos]);
            *pos += 1;
        } else {
            break;
        }
    }
    if extract {
        value
    } else {
        input[start..*pos].iter().collect()
    }
}

fn find_char(input: &[char], c: char, from: usize) -> usize {
    input[from.min(input.len())..]
        .iter()
        .position(|&x| x == c)
        .map_or(input.len(), |p| p + from)
}

/// `parseMIMEType(input)`.
fn parse_mime_type(input: &str) -> Option<MimeType> {
    let input: Vec<char> = input.trim_matches(is_http_ws).chars().collect();
    let mut pos = 0;
    let end = find_char(&input, '/', 0);
    let type_: String = input[..end].iter().collect();
    pos = pos.max(end);
    if type_.is_empty() || !token_string(&type_) || pos >= input.len() {
        return None;
    }
    pos += 1;
    let end = find_char(&input, ';', pos);
    let subtype: String = input[pos..end].iter().collect();
    pos = end;
    let subtype = trim_end_js(&subtype);
    if subtype.is_empty() || !token_string(&subtype) {
        return None;
    }
    let essence = format!("{}/{}", type_.to_lowercase(), subtype.to_lowercase());
    let mut mime = MimeType {
        essence,
        parameters: Vec::new(),
    };
    while pos < input.len() {
        pos += 1;
        while pos < input.len() && is_http_ws(input[pos]) {
            pos += 1;
        }
        let mut name = String::new();
        while pos < input.len() && input[pos] != ';' && input[pos] != '=' {
            name.push(input[pos]);
            pos += 1;
        }
        let name = name.to_lowercase();
        if pos < input.len() {
            if input[pos] == ';' {
                continue;
            }
            pos += 1;
        }
        if pos >= input.len() {
            break;
        }
        let value;
        if input[pos] == '"' {
            value = collect_quoted(&input, &mut pos, true);
            pos = find_char(&input, ';', pos);
        } else {
            let end = find_char(&input, ';', pos);
            let raw: String = input[pos..end].iter().collect();
            pos = end;
            value = trim_end_js(&raw);
            if value.is_empty() {
                continue;
            }
        }
        if !name.is_empty()
            && token_string(&name)
            && (value.is_empty() || quoted_string_tokens(&value))
            && mime.param(&name).is_none()
        {
            mime.parameters.push((name, value));
        }
    }
    Some(mime)
}

/// `gettingDecodingSplitting(value)`: split on commas outside quotes.
fn split_header_values(input: &str) -> Vec<String> {
    let chars: Vec<char> = input.chars().collect();
    let mut pos = 0;
    let mut values = Vec::new();
    let mut temp = String::new();
    while pos < chars.len() {
        while pos < chars.len() && chars[pos] != '"' && chars[pos] != ',' {
            temp.push(chars[pos]);
            pos += 1;
        }
        if pos < chars.len() {
            if chars[pos] == '"' {
                temp.push_str(&collect_quoted(&chars, &mut pos, false));
                if pos < chars.len() {
                    continue;
                }
            } else {
                pos += 1;
            }
        }
        values.push(temp.trim_matches(|c| c == '\t' || c == ' ').to_string());
        temp.clear();
    }
    values
}

/// `extractMimeType(headers)` for the Content-Type value.
fn extract_mime_type(value: &str) -> Option<MimeType> {
    let mut essence: Option<String> = None;
    let mut charset: Option<String> = None;
    let mut mime: Option<MimeType> = None;
    for v in split_header_values(value) {
        let Some(mut m) = parse_mime_type(&v) else {
            continue;
        };
        if m.essence == "*/*" {
            continue;
        }
        if Some(&m.essence) != essence.as_ref() {
            charset = m.param("charset").map(str::to_string);
            essence = Some(m.essence.clone());
        } else if m.param("charset").is_none() {
            if let Some(c) = &charset {
                m.parameters.push(("charset".into(), c.clone()));
            }
        }
        mime = Some(m);
    }
    mime
}

// ── multipart/form-data (fetch/formdata-parser.js) ──────────────────────────

fn is_ctl(c: u8) -> bool {
    c <= 31 || c == 127
}

fn is_tspecial(c: u8) -> bool {
    matches!(
        c,
        b'(' | b')' | b'<' | b'>' | b'@' | b',' | b';' | b':' | b'\\' | b'"' | b'/' | b'[' | b']' | b'?' | b'='
    )
}

fn is_token(c: u8) -> bool {
    c <= 127 && c != b' ' && c != b'\t' && !is_ctl(c) && !is_tspecial(c)
}

fn collect<'a>(input: &'a [u8], pos: &mut usize, cond: impl Fn(u8) -> bool) -> &'a [u8] {
    let start = *pos;
    let mut end = start.min(input.len());
    while end < input.len() && cond(input[end]) {
        end += 1;
    }
    *pos = end;
    &input[start.min(input.len())..end]
}

/// `removeChars(buf, leading, trailing, predicate)`, including its
/// `trail > 0` quirk.
fn remove_chars(buf: &[u8], leading: bool, trailing: bool, pred: impl Fn(u8) -> bool) -> &[u8] {
    let len = buf.len() as isize;
    let mut lead: isize = 0;
    let mut trail: isize = len - 1;
    if leading {
        while lead < len && pred(buf[lead as usize]) {
            lead += 1;
        }
    }
    if trailing {
        while trail > 0 && pred(buf[trail as usize]) {
            trail -= 1;
        }
    }
    if lead == 0 && trail == len - 1 {
        return buf;
    }
    let end = (trail + 1).max(lead);
    &buf[lead as usize..end as usize]
}

fn starts_with_at(input: &[u8], pat: &[u8], pos: usize) -> bool {
    input.len() >= pat.len() && input.get(pos..pos + pat.len()) == Some(pat)
}

fn index_of(input: &[u8], pat: &[u8], from: usize) -> Option<usize> {
    if pat.is_empty() {
        return Some(from.min(input.len()));
    }
    if from >= input.len() {
        return None;
    }
    input[from..]
        .windows(pat.len())
        .position(|w| w == pat)
        .map(|p| p + from)
}

/// `new TextDecoder().decode(bytes)`: a leading BOM is dropped, invalid bytes
/// become U+FFFD.
fn text_decode(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

/// Node's `new File([...], name, { type })`: a type with any character
/// outside U+0020–U+007E becomes "", otherwise it is lower-cased.
fn blob_type(t: &str) -> String {
    if t.chars().all(|c| ('\u{20}'..='\u{7e}').contains(&c)) {
        t.to_lowercase()
    } else {
        String::new()
    }
}

struct PartHeaders {
    name: String,
    filename: Option<String>,
    content_type: Option<String>,
    encoding: Option<String>,
}

struct Attribute {
    name: String,
    value: String,
    extended: bool,
}

fn parse_disposition_attribute(input: &[u8], pos: &mut usize) -> Result<Option<Attribute>, FormError> {
    if input.get(*pos) == Some(&b';') {
        *pos += 1;
    }
    collect(input, pos, |c| c == b' ' || c == b'\t');
    let name = collect(input, pos, |c| is_token(c) && c != b'=' && c != b'*');
    if name.is_empty() {
        return Ok(None);
    }
    let name = String::from_utf8_lossy(name).to_ascii_lowercase();
    let extended = input.get(*pos) == Some(&b'*');
    if extended {
        *pos += 1;
    }
    if input.get(*pos) != Some(&b'=') {
        return Ok(None);
    }
    *pos += 1;
    collect(input, pos, |c| c == b' ' || c == b'\t');
    let value = if extended {
        let v = collect(input, pos, |c| c != b' ' && c != b'\r' && c != b'\n' && c != b';');
        let ok = v.len() >= 5
            && (v[0] == b'u' || v[0] == b'U')
            && (v[1] == b't' || v[1] == b'T')
            && (v[2] == b'f' || v[2] == b'F')
            && v[3] == b'-'
            && v[4] == b'8';
        if !ok {
            return Err(parsing_error("unknown encoding, expected utf-8''"));
        }
        let rest = v.get(7..).unwrap_or(&[]);
        decode_uri_component(&text_decode(rest))
            .ok_or_else(|| FormError("URIError: URI malformed".into()))?
    } else if input.get(*pos) == Some(&b'"') {
        *pos += 1;
        let q = collect(input, pos, |c| c != b'\n' && c != b'\r' && c != b'"');
        if input.get(*pos) != Some(&b'"') {
            return Err(parsing_error("Closing quote not found"));
        }
        *pos += 1;
        unescape_quoted(&text_decode(q))
    } else {
        let t = collect(input, pos, |c| is_token(c) && c != b';');
        text_decode(t)
    };
    Ok(Some(Attribute {
        name,
        value,
        extended,
    }))
}

/// `.replace(/%0A/ig, "\n").replace(/%0D/ig, "\r").replace(/%22/g, '"')`.
fn unescape_quoted(s: &str) -> String {
    let replace_ci = |s: &str, pat: &str, with: &str| {
        let mut out = String::with_capacity(s.len());
        let mut rest = s;
        while let Some(i) = rest.to_ascii_lowercase().find(pat) {
            out.push_str(&rest[..i]);
            out.push_str(with);
            rest = &rest[i + pat.len()..];
        }
        out.push_str(rest);
        out
    };
    let s = replace_ci(s, "%0a", "\n");
    let s = replace_ci(&s, "%0d", "\r");
    s.replace("%22", "\"")
}

fn parse_part_headers(input: &[u8], pos: &mut usize) -> Result<PartHeaders, FormError> {
    let mut name: Option<String> = None;
    let mut filename: Option<String> = None;
    let mut content_type: Option<String> = None;
    let mut encoding: Option<String> = None;
    loop {
        if input.get(*pos) == Some(&b'\r') && input.get(*pos + 1) == Some(&b'\n') {
            return match name {
                Some(name) => Ok(PartHeaders {
                    name,
                    filename,
                    content_type,
                    encoding,
                }),
                None => Err(parsing_error("header name is null")),
            };
        }
        let header_name = collect(input, pos, |c| c != b'\n' && c != b'\r' && c != b':');
        let header_name = remove_chars(header_name, true, true, |c| c == b'\t' || c == b' ');
        let hn = String::from_utf8_lossy(header_name);
        if !token_string(&hn) {
            return Err(parsing_error(
                "header name does not match the field-name token production",
            ));
        }
        if input.get(*pos) != Some(&b':') {
            return Err(parsing_error("expected :"));
        }
        *pos += 1;
        collect(input, pos, |c| c == b' ' || c == b'\t');
        match latin1(header_name).to_lowercase().as_str() {
            "content-disposition" => {
                name = None;
                filename = None;
                let mut filename_extended = false;
                let disposition = collect(input, pos, is_token);
                if !String::from_utf8_lossy(disposition).eq_ignore_ascii_case("form-data") {
                    return Err(parsing_error("expected form-data for content-disposition header"));
                }
                while *pos < input.len()
                    && (input.get(*pos) != Some(&b'\r') || input.get(*pos + 1) != Some(&b'\n'))
                {
                    let Some(attr) = parse_disposition_attribute(input, pos)? else {
                        break;
                    };
                    if attr.name == "name" {
                        name = Some(attr.value);
                    } else if attr.name == "filename" {
                        if attr.extended {
                            filename = Some(attr.value);
                            filename_extended = true;
                        } else if !filename_extended {
                            filename = Some(attr.value);
                        }
                    }
                }
                if name.is_none() {
                    return Err(parsing_error(
                        "name attribute is required in content-disposition header",
                    ));
                }
            }
            "content-type" => {
                let v = collect(input, pos, |c| c != b'\n' && c != b'\r');
                let v = remove_chars(v, false, true, |c| c == b'\t' || c == b' ');
                content_type = Some(latin1(v));
            }
            "content-transfer-encoding" => {
                let v = collect(input, pos, |c| c != b'\n' && c != b'\r');
                let v = remove_chars(v, false, true, |c| c == b'\t' || c == b' ');
                encoding = Some(latin1(v));
            }
            _ => {
                collect(input, pos, |c| c != b'\n' && c != b'\r');
            }
        }
        if input.get(*pos) != Some(&b'\r') || input.get(*pos + 1) != Some(&b'\n') {
            return Err(parsing_error("expected CRLF"));
        }
        *pos += 2;
    }
}

/// `multipartFormDataParser(input, mimeType)`: the entries in body order.
fn multipart_parser(input: &[u8], mime: &MimeType) -> Result<Vec<(String, FormValue)>, FormError> {
    let Some(boundary_string) = mime.param("boundary") else {
        return Err(parsing_error("missing boundary in content-type header"));
    };
    let boundary = format!("--{boundary_string}").into_bytes();
    let mut entries = Vec::new();
    let Some(first) = index_of(input, &boundary, 0) else {
        return Err(parsing_error("no boundary found in multipart body"));
    };
    let mut pos = first;
    loop {
        if input.get(pos..pos + boundary.len()) == Some(boundary.as_slice()) {
            pos += boundary.len();
        } else {
            return Err(parsing_error("expected a value starting with -- and the boundary"));
        }
        if starts_with_at(input, b"--", pos) {
            return Ok(entries);
        }
        if input.get(pos) != Some(&b'\r') || input.get(pos + 1) != Some(&b'\n') {
            return Err(parsing_error("expected CRLF"));
        }
        pos += 2;
        let headers = parse_part_headers(input, &mut pos)?;
        pos += 2;
        let mut body: Vec<u8> = {
            let Some(bi) = index_of(input, &boundary[2..], pos) else {
                return Err(parsing_error("expected boundary after body"));
            };
            // `input.subarray(pos, bi - 4)`: empty when the end is before the start.
            let end = bi.saturating_sub(4);
            let b = if end > pos { &input[pos..end] } else { &[][..] };
            pos += b.len();
            b.to_vec()
        };
        if headers.encoding.as_deref() == Some("base64") {
            body = crate::crypto::node_base64_decode(&String::from_utf8_lossy(&body));
        }
        if input.get(pos) != Some(&b'\r') || input.get(pos + 1) != Some(&b'\n') {
            return Err(parsing_error("expected CRLF"));
        }
        pos += 2;
        let value = match headers.filename {
            Some(filename) => {
                let mut ct = headers.content_type.unwrap_or_else(|| "text/plain".into());
                if !ct.is_ascii() {
                    ct = String::new();
                }
                FormValue::File(FormFile {
                    name: filename,
                    mime_type: blob_type(&ct),
                    data: body,
                })
            }
            None => FormValue::Text(String::from_utf8_lossy(&body).into_owned()),
        };
        entries.push((headers.name, value));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(ct: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("content-type", HeaderValue::from_bytes(ct.as_bytes()).expect("hv"));
        h
    }

    const B: &str = "----formdata-undici-0123456789012";

    fn body(parts: &[&str]) -> Vec<u8> {
        let mut s = String::new();
        for p in parts {
            s.push_str(&format!("--{B}\r\n{p}\r\n"));
        }
        s.push_str(&format!("--{B}--\r\n"));
        s.into_bytes()
    }

    #[test]
    fn parses_fields_and_files() {
        let b = body(&[
            "Content-Disposition: form-data; name=\"name\"\r\n\r\nMy Doc",
            "Content-Disposition: form-data; name=\"file\"; filename=\"a b.PDF\"\r\nContent-Type: Application/PDF\r\n\r\n%PDF-1\r\nbody",
        ]);
        let form = parse_body(&headers(&format!("multipart/form-data; boundary={B}")), &b).expect("parse");
        assert_eq!(form.get("name"), Some(&FormValue::Text("My Doc".into())));
        match form.get("file") {
            Some(FormValue::File(f)) => {
                assert_eq!(f.name, "a b.PDF");
                assert_eq!(f.mime_type, "application/pdf");
                assert_eq!(f.data, b"%PDF-1\r\nbody");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn defaults_and_extended_filename() {
        let b = body(&[
            "Content-Disposition: form-data; name=\"file\"; filename=\"x.txt\"; filename*=UTF-8''%E2%9C%93.txt\r\n\r\nhi",
        ]);
        let form = parse_body(&headers(&format!("multipart/form-data; boundary=\"{B}\"")), &b).expect("parse");
        match form.get("file") {
            Some(FormValue::File(f)) => {
                assert_eq!(f.name, "✓.txt");
                assert_eq!(f.mime_type, "text/plain");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn failures() {
        let ok_ct = format!("multipart/form-data; boundary={B}");
        assert!(parse_body(&headers("multipart/form-data"), b"x").is_err());
        assert!(parse_body(&headers(&ok_ct), b"no boundary here").is_err());
        assert!(parse_body(&headers("multipart/form-data-x; boundary=abc"), b"--abc--").is_err());
        let bad = body(&["Content-Disposition: form-data\r\n\r\nx"]);
        assert!(parse_body(&headers(&ok_ct), &bad).is_err());
        let bad_uri = body(&["Content-Disposition: form-data; name=\"f\"; filename*=utf-8''%E2\r\n\r\nx"]);
        assert!(parse_body(&headers(&ok_ct), &bad_uri).is_err());
        // Not a form content type: Hono returns {} without touching the body.
        assert_eq!(parse_body(&headers("application/json"), b"{").expect("ok"), FormBody::new());
        assert_eq!(parse_body(&HeaderMap::new(), b"").expect("ok"), FormBody::new());
        assert_eq!(
            parse_body(&headers("application/x-www-form-urlencoded"), b"file=x").expect("ok"),
            FormBody::new()
        );
    }

    #[test]
    fn mime_parsing() {
        let m = parse_mime_type(" Multipart/Form-Data ; boundary=\"a\\\"b\" ; x=1").expect("mime");
        assert_eq!(m.essence, "multipart/form-data");
        assert_eq!(m.param("boundary"), Some("a\"b"));
        assert!(parse_mime_type("text").is_none());
        assert!(parse_mime_type("/x").is_none());
        assert_eq!(trim_end_js("  "), " ");
        assert_eq!(trim_end_js("a  "), "a");
        assert_eq!(trim_end_js(""), "");
    }
}
