//! `TransactionFiltersSchema.parse({...})` as `get_transactions` calls it
//! (zod 4.3): the five fields the tool passes, zod's issue objects, and the
//! thrown error's text (`String(zodError)` is `JSON.stringify(issues, null, 2)`).

use serde_json::{json, Map, Value};

use crate::services::budget::TransactionFilters;

/// The tool's input object (`limit` already `params.limit ?? 20` minus the default).
pub struct Input {
    pub account_id: Option<Value>,
    pub envelope_id: Option<Value>,
    pub date_from: Option<Value>,
    pub date_to: Option<Value>,
    pub limit: Option<Value>,
}

const DATE_PATTERN: &str = r"/^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))$/";
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

/// zod's name for a value's type in "received X".
fn received(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn issue(fields: Value, key: &str, message: String) -> Value {
    let mut out: Map<String, Value> = fields.as_object().cloned().unwrap_or_default();
    out.insert("path".into(), json!([key]));
    out.insert("message".into(), Value::String(message));
    Value::Object(out)
}

/// `z.string().date()`'s regex: `YYYY-MM-DD` with a real day.
pub fn is_iso_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let digits = |r: std::ops::Range<usize>| b[r].iter().all(u8::is_ascii_digit);
    if !(digits(0..4) && digits(5..7) && digits(8..10)) {
        return false;
    }
    let n = |r: std::ops::Range<usize>| {
        b[r].iter()
            .fold(0u32, |acc, d| acc * 10 + u32::from(d - b'0'))
    };
    let (cc, yy, month, day) = (n(0..2), n(2..4), n(5..7), n(8..10));
    let leap = if yy == 0 { cc % 4 == 0 } else { yy % 4 == 0 };
    let max = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=max).contains(&day)
}

/// An optional `z.string()` (with `.date()` when `date`).
fn opt_string(v: &Option<Value>, key: &str, date: bool, issues: &mut Vec<Value>) -> Option<String> {
    match v {
        None => None,
        Some(Value::String(s)) => {
            if date && !is_iso_date(s) {
                issues.push(issue(
                    json!({
                        "origin": "string",
                        "code": "invalid_format",
                        "format": "date",
                        "pattern": DATE_PATTERN,
                    }),
                    key,
                    "Invalid ISO date".into(),
                ));
            }
            Some(s.clone())
        }
        Some(other) => {
            issues.push(issue(
                json!({ "expected": "string", "code": "invalid_type" }),
                key,
                format!(
                    "Invalid input: expected string, received {}",
                    received(other)
                ),
            ));
            None
        }
    }
}

/// `z.coerce.number().int().min(1).max(200)` on `params.limit ?? 20`.
fn limit(v: &Option<Value>, issues: &mut Vec<Value>) -> f64 {
    let n = match v {
        None => 20.0,
        Some(v) => crate::json::to_number(v),
    };
    if !n.is_finite() {
        let what = if n.is_nan() { "NaN" } else { "Infinity" };
        let shown = if n.is_nan() { "NaN" } else { "number" };
        issues.push(issue(
            json!({ "expected": "number", "code": "invalid_type", "received": what }),
            "limit",
            format!("Invalid input: expected number, received {shown}"),
        ));
        return n;
    }
    if n.fract() != 0.0 {
        issues.push(issue(
            json!({ "expected": "int", "format": "safeint", "code": "invalid_type" }),
            "limit",
            "Invalid input: expected int, received number".into(),
        ));
        return n;
    }
    if n > MAX_SAFE {
        issues.push(issue(
            json!({
                "code": "too_big",
                "maximum": 9_007_199_254_740_991_i64,
                "note": "Integers must be within the safe integer range.",
                "origin": "int",
                "inclusive": true,
            }),
            "limit",
            "Too big: expected int to be <=9007199254740991".into(),
        ));
    } else if n < -MAX_SAFE {
        issues.push(issue(
            json!({
                "code": "too_small",
                "minimum": -9_007_199_254_740_991_i64,
                "note": "Integers must be within the safe integer range.",
                "origin": "int",
                "inclusive": true,
            }),
            "limit",
            "Too small: expected int to be >=-9007199254740991".into(),
        ));
    }
    if n < 1.0 {
        issues.push(issue(
            json!({ "origin": "number", "code": "too_small", "minimum": 1, "inclusive": true }),
            "limit",
            "Too small: expected number to be >=1".into(),
        ));
    }
    if n > 200.0 {
        issues.push(issue(
            json!({ "origin": "number", "code": "too_big", "maximum": 200, "inclusive": true }),
            "limit",
            "Too big: expected number to be <=200".into(),
        ));
    }
    n
}

/// The parsed filters, or the thrown ZodError's text.
pub fn parse(input: &Input) -> Result<TransactionFilters, String> {
    let mut issues = Vec::new();
    let account_id = opt_string(&input.account_id, "account_id", false, &mut issues);
    let envelope_id = opt_string(&input.envelope_id, "envelope_id", false, &mut issues);
    let date_from = opt_string(&input.date_from, "date_from", true, &mut issues);
    let date_to = opt_string(&input.date_to, "date_to", true, &mut issues);
    let limit = limit(&input.limit, &mut issues);
    if !issues.is_empty() {
        return Err(serde_json::to_string_pretty(&Value::Array(issues)).unwrap_or_default());
    }
    Ok(TransactionFilters {
        account_id,
        envelope_id,
        date_from,
        date_to,
        page: Some(1.0),
        limit: Some(limit),
        ..TransactionFilters::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(v: Value) -> Input {
        let g = |k: &str| v.get(k).cloned();
        Input {
            account_id: g("account_id"),
            envelope_id: g("envelope_id"),
            date_from: g("date_from"),
            date_to: g("date_to"),
            limit: g("limit").filter(|v| !v.is_null()),
        }
    }

    /// `String(err)` from zod 4.3 for the same inputs (Node).
    #[test]
    fn matches_zod() {
        let err = parse(&input(json!({ "limit": 500 }))).expect_err("500");
        assert_eq!(err, "[\n  {\n    \"origin\": \"number\",\n    \"code\": \"too_big\",\n    \"maximum\": 200,\n    \"inclusive\": true,\n    \"path\": [\n      \"limit\"\n    ],\n    \"message\": \"Too big: expected number to be <=200\"\n  }\n]");
        let err =
            parse(&input(json!({ "limit": "abc", "date_from": "2026-13-01" }))).expect_err("abc");
        assert_eq!(err, "[\n  {\n    \"origin\": \"string\",\n    \"code\": \"invalid_format\",\n    \"format\": \"date\",\n    \"pattern\": \"/^(?:(?:\\\\d\\\\d[2468][048]|\\\\d\\\\d[13579][26]|\\\\d\\\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\\\d|30)|(?:02)-(?:0[1-9]|1\\\\d|2[0-8])))$/\",\n    \"path\": [\n      \"date_from\"\n    ],\n    \"message\": \"Invalid ISO date\"\n  },\n  {\n    \"expected\": \"number\",\n    \"code\": \"invalid_type\",\n    \"received\": \"NaN\",\n    \"path\": [\n      \"limit\"\n    ],\n    \"message\": \"Invalid input: expected number, received NaN\"\n  }\n]");
        let err = parse(&input(json!({ "account_id": 5, "limit": 0.5 }))).expect_err("int");
        assert_eq!(err, "[\n  {\n    \"expected\": \"string\",\n    \"code\": \"invalid_type\",\n    \"path\": [\n      \"account_id\"\n    ],\n    \"message\": \"Invalid input: expected string, received number\"\n  },\n  {\n    \"expected\": \"int\",\n    \"format\": \"safeint\",\n    \"code\": \"invalid_type\",\n    \"path\": [\n      \"limit\"\n    ],\n    \"message\": \"Invalid input: expected int, received number\"\n  }\n]");
        let err = parse(&input(json!({ "limit": 1e20 }))).expect_err("unsafe");
        assert_eq!(err, "[\n  {\n    \"code\": \"too_big\",\n    \"maximum\": 9007199254740991,\n    \"note\": \"Integers must be within the safe integer range.\",\n    \"origin\": \"int\",\n    \"inclusive\": true,\n    \"path\": [\n      \"limit\"\n    ],\n    \"message\": \"Too big: expected int to be <=9007199254740991\"\n  },\n  {\n    \"origin\": \"number\",\n    \"code\": \"too_big\",\n    \"maximum\": 200,\n    \"inclusive\": true,\n    \"path\": [\n      \"limit\"\n    ],\n    \"message\": \"Too big: expected number to be <=200\"\n  }\n]");
        let err = parse(&input(json!({ "limit": "-Infinity" }))).expect_err("inf");
        assert!(err.contains("\"received\": \"Infinity\"") && err.contains("received number\""));
        let err = parse(&input(json!({ "limit": "", "envelope_id": {} }))).expect_err("obj");
        assert!(err.contains("received object") && err.contains(">=1"));
        let ok = parse(&input(json!({ "limit": "7", "date_from": "2024-02-29" }))).expect("ok");
        assert_eq!(ok.limit, Some(7.0));
        assert_eq!(ok.page, Some(1.0));
        assert_eq!(parse(&input(json!({}))).expect("default").limit, Some(20.0));
        assert_eq!(
            parse(&input(json!({ "limit": true }))).expect("bool").limit,
            Some(1.0)
        );
    }

    #[test]
    fn iso_dates() {
        for ok in [
            "2024-02-29",
            "2000-02-29",
            "2026-12-31",
            "0000-02-29",
            "1904-02-29",
        ] {
            assert!(is_iso_date(ok), "{ok}");
        }
        for bad in [
            "1900-02-29",
            "2026-02-29",
            "2026-04-31",
            "2026-13-01",
            "2026-1-01",
            "２０２６-01-01",
            "",
        ] {
            assert!(!is_iso_date(bad), "{bad}");
        }
    }
}
