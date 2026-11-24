//! JSON helpers shared by every wave (owned by Wave 0): request-body parsing
//! the way Hono's `c.req.json()` does it, SQLite values as better-sqlite3
//! would hand them to `JSON.stringify`, and JS truthiness / `Number()`.

use rusqlite::types::ValueRef;
use serde_json::{Map, Number, Value};

/// `await c.req.json()`: the body decoded as UTF-8 (invalid bytes replaced, a
/// leading BOM dropped, like `TextDecoder`) and then `JSON.parse`d.
/// `None` where Node would throw. For `.catch(() => ({}))` use
/// [`body_or_empty_object`].
pub fn parse_body(body: &[u8]) -> Option<Value> {
    let text = String::from_utf8_lossy(body);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    serde_json::from_str(text).ok()
}

/// `await c.req.json().catch(() => ({}))`.
pub fn body_or_empty_object(body: &[u8]) -> Value {
    parse_body(body).unwrap_or_else(|| Value::Object(Map::new()))
}

/// `body?.field`: the property when `body` is an object, else `undefined`
/// (`None`). Arrays and primitives have no own JSON properties.
pub fn field<'a>(body: &'a Value, name: &str) -> Option<&'a Value> {
    body.as_object().and_then(|o| o.get(name))
}

/// JS truthiness of a JSON value (`undefined` is `None`).
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// A finite `f64` as a JSON number; NaN and ±Infinity become `null`, as
/// `JSON.stringify` does.
pub fn number(f: f64) -> Value {
    Number::from_f64(f)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

/// A SQLite value as better-sqlite3 returns it, then as `JSON.stringify`
/// renders it: INTEGER/REAL → number, TEXT → string, NULL → null,
/// BLOB → `{"type":"Buffer","data":[…]}`.
pub fn from_sql(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::Number(i.into()),
        ValueRef::Real(f) => number(f),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => serde_json::json!({ "type": "Buffer", "data": b }),
    }
}

/// `Number(v)` for the value kinds SQLite/JSON can produce.
pub fn to_number(v: &Value) -> f64 {
    match v {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => string_to_number(s),
        Value::Array(a) => match a.as_slice() {
            [] => 0.0,
            [one] => to_number(one),
            _ => f64::NAN,
        },
        Value::Object(_) => f64::NAN,
    }
}

/// `Number(string)`: trimmed; empty → 0; decimal, `0x`/`0o`/`0b` and
/// `Infinity` forms; anything else NaN.
pub fn string_to_number(s: &str) -> f64 {
    let t = crate::js::js_trim(s);
    if t.is_empty() {
        return 0.0;
    }
    let radix = |p: &str, r: u32| {
        u64::from_str_radix(p, r)
            .map(|v| v as f64)
            .unwrap_or(f64::NAN)
    };
    if let Some(rest) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        return radix(rest, 16);
    }
    if let Some(rest) = t.strip_prefix("0o").or_else(|| t.strip_prefix("0O")) {
        return radix(rest, 8);
    }
    if let Some(rest) = t.strip_prefix("0b").or_else(|| t.strip_prefix("0B")) {
        return radix(rest, 2);
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    // Rust accepts "inf"/"nan"/"infinity" which JS does not.
    let valid = t
        .bytes()
        .all(|c| c.is_ascii_digit() || matches!(c, b'.' | b'e' | b'E' | b'+' | b'-'));
    if !valid {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn body_parsing() {
        assert_eq!(parse_body(b"{\"a\":1}"), Some(json!({"a": 1})));
        assert_eq!(parse_body("\u{feff}[1]".as_bytes()), Some(json!([1])));
        assert_eq!(parse_body(b""), None);
        assert_eq!(parse_body(b"{bad"), None);
        assert_eq!(body_or_empty_object(b"nope"), json!({}));
        assert_eq!(parse_body(b" null "), Some(Value::Null));
    }

    #[test]
    fn truthiness() {
        assert!(!truthy(None));
        assert!(!truthy(Some(&json!(0))));
        assert!(!truthy(Some(&json!(""))));
        assert!(truthy(Some(&json!("0"))));
        assert!(truthy(Some(&json!([]))));
        assert!(truthy(Some(&json!({}))));
    }

    #[test]
    fn numbers() {
        assert_eq!(string_to_number(" 83.2 "), 83.2);
        assert_eq!(string_to_number(""), 0.0);
        assert_eq!(string_to_number("0x10"), 16.0);
        assert!(string_to_number("inf").is_nan());
        assert!(string_to_number("12abc").is_nan());
        assert_eq!(string_to_number("1e3"), 1000.0);
        assert_eq!(number(f64::NAN), Value::Null);
    }
}
