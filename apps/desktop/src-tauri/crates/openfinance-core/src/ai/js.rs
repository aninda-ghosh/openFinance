//! JavaScript semantics the AI code relies on: `String(value)`, property
//! access on JSON values (with V8's TypeError messages), `JSON.stringify`
//! (JS number formatting), thrown errors and `String(err)`.

use serde_json::Value;

use crate::error::ApiError;
use crate::services::policy::dates::js_number_to_string;

/// Properties every plain JS object inherits from `Object.prototype`.
pub const OBJECT_PROTO_KEYS: &[&str] = &[
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

/// `${obj[key]}` for a key that is not an own property of a plain object
/// literal but is inherited from `Object.prototype` (a native function, or
/// `Object.prototype` itself for `__proto__`). `None` for ordinary keys.
pub fn inherited_member_string(key: &str) -> Option<String> {
    if !OBJECT_PROTO_KEYS.contains(&key) {
        return None;
    }
    Some(match key {
        "__proto__" => "[object Object]".to_string(),
        "constructor" => "function Object() { [native code] }".to_string(),
        other => format!("function {other}() {{ [native code] }}"),
    })
}

/// A thrown JS error: `name` and `message`.
#[derive(Debug, Clone, PartialEq)]
pub struct JsError {
    pub name: String,
    pub message: String,
}

impl JsError {
    pub fn new(name: &str, message: impl Into<String>) -> Self {
        Self {
            name: name.to_string(),
            message: message.into(),
        }
    }

    /// `new Error(message)`.
    pub fn error(message: impl Into<String>) -> Self {
        Self::new("Error", message)
    }

    pub fn type_error(message: impl Into<String>) -> Self {
        Self::new("TypeError", message)
    }

    /// `String(err)` / `err.toString()`: `"Name: message"`, or the name alone
    /// when the message is empty.
    pub fn to_js_string(&self) -> String {
        if self.message.is_empty() {
            self.name.clone()
        } else if self.name.is_empty() {
            self.message.clone()
        } else {
            format!("{}: {}", self.name, self.message)
        }
    }
}

impl std::fmt::Display for JsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.to_js_string())
    }
}

impl From<ApiError> for JsError {
    /// What a service failure looks like once thrown in Node: a service error
    /// is a plain `Error` with its message; an internal failure keeps a
    /// `"TypeError: …"`-style prefix when it carries one.
    fn from(err: ApiError) -> Self {
        match err {
            ApiError::Service { message, .. } | ApiError::Status { message, .. } => {
                JsError::error(message)
            }
            ApiError::Validation { .. } => JsError::error("Validation failed"),
            ApiError::Body { body, .. } => JsError::error(body.to_string()),
            ApiError::Internal(message) => {
                let message = message
                    .strip_prefix("database error: ")
                    .unwrap_or(&message)
                    .to_string();
                for name in ["TypeError", "RangeError", "SyntaxError", "Error"] {
                    if let Some(rest) = message.strip_prefix(&format!("{name}: ")) {
                        return JsError::new(name, rest);
                    }
                }
                JsError::error(message)
            }
        }
    }
}

/// `typeof`-ish name V8 uses in "Cannot read properties of X".
fn nullish_name(v: Option<&Value>) -> Option<&'static str> {
    match v {
        None => Some("undefined"),
        Some(Value::Null) => Some("null"),
        Some(_) => None,
    }
}

/// `base.key` on a JSON value. `undefined` / `null` bases throw V8's
/// TypeError; primitives and arrays have none of the keys the AI code reads
/// (`function`, `name`, `month`, ...), so they give `undefined`.
pub fn get_prop<'a>(base: Option<&'a Value>, key: &str) -> Result<Option<&'a Value>, JsError> {
    if let Some(n) = nullish_name(base) {
        return Err(JsError::type_error(format!(
            "Cannot read properties of {n} (reading '{key}')"
        )));
    }
    Ok(base.and_then(|v| v.as_object()).and_then(|o| o.get(key)))
}

/// `base?.key`: `undefined` for a nullish base.
pub fn opt_prop<'a>(base: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    base.and_then(|v| v.as_object()).and_then(|o| o.get(key))
}

/// `v ?? fallback` for an optional JSON value (`undefined` or `null`).
pub fn nullish(v: Option<&Value>) -> Option<&Value> {
    v.filter(|v| !v.is_null())
}

/// `String(v)`; `None` is `undefined`.
pub fn js_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(v) => value_to_string(v),
    }
}

/// `String(v)` for a JSON value (arrays join their elements with `,`,
/// rendering `null` as an empty string).
pub fn value_to_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|i| match i {
                Value::Null => String::new(),
                other => value_to_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `JSON.stringify(v)`: compact, keys in insertion order, numbers formatted
/// like JS (`1`, not `1.0`; non-finite → `null`).
pub fn stringify(v: &Value) -> String {
    let mut out = String::new();
    write_json(v, &mut out);
    out
}

fn write_json(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            let f = n.as_f64().unwrap_or(f64::NAN);
            if f.is_finite() {
                out.push_str(&js_number_to_string(f));
            } else {
                out.push_str("null");
            }
        }
        Value::String(s) => write_json_string(s, out),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (i, (k, val)) in map.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json_string(k, out);
                out.push(':');
                write_json(val, out);
            }
            out.push('}');
        }
    }
}

/// `JSON.stringify(string)` (well-formed: only `"`, `\` and C0 controls escaped).
pub fn write_json_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// `JSON.stringify(s)` for a string.
pub fn stringify_str(s: &str) -> String {
    let mut out = String::new();
    write_json_string(s, &mut out);
    out
}

/// `Number(v)`; `None` is `undefined` (NaN).
pub fn js_number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(v) => crate::json::to_number(v),
    }
}

/// JS truthiness of an optional JSON value.
pub fn truthy(v: Option<&Value>) -> bool {
    crate::json::truthy(v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn string_conversion() {
        assert_eq!(js_string(None), "undefined");
        assert_eq!(js_string(Some(&json!(null))), "null");
        assert_eq!(js_string(Some(&json!(5.0))), "5");
        assert_eq!(js_string(Some(&json!([1, null, "a", [2, 3]]))), "1,,a,2,3");
        assert_eq!(js_string(Some(&json!({"a": 1}))), "[object Object]");
    }

    #[test]
    fn stringify_like_js() {
        let v: Value = serde_json::from_str(r#"{"a":1.0,"b":[1.5,"x\n\u0001"],"c":null,"d":1e21}"#)
            .expect("json");
        assert_eq!(
            stringify(&v),
            r#"{"a":1,"b":[1.5,"x\n\u0001"],"c":null,"d":1e+21}"#
        );
    }

    #[test]
    fn property_access_errors() {
        let e = get_prop(None, "function").expect_err("undefined");
        assert_eq!(
            e.to_js_string(),
            "TypeError: Cannot read properties of undefined (reading 'function')"
        );
        let null = json!(null);
        let e = get_prop(Some(&null), "month").expect_err("null");
        assert_eq!(
            e.message,
            "Cannot read properties of null (reading 'month')"
        );
        let s = json!("abc");
        assert_eq!(get_prop(Some(&s), "month").expect("string"), None);
    }

    #[test]
    fn inherited_members() {
        assert_eq!(
            inherited_member_string("constructor").as_deref(),
            Some("function Object() { [native code] }")
        );
        assert_eq!(
            inherited_member_string("toString").as_deref(),
            Some("function toString() { [native code] }")
        );
        assert_eq!(
            inherited_member_string("__proto__").as_deref(),
            Some("[object Object]")
        );
        assert_eq!(inherited_member_string("USD"), None);
    }
}
