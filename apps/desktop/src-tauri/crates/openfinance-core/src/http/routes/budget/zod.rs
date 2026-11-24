//! The subset of zod 4.3 the budget schemas use, with zod's parsing rules:
//! unknown keys stripped, defaults filled, issues collected in shape order,
//! type errors aborting later checks except length checks (which zod runs
//! whenever the value has a `length`), and zod's English messages. Only the
//! bulk-create route shows messages to the client (`rows[].message`); for
//! every other route the harness ignores `details`.

use serde_json::{json, Map, Value};

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Seg {
    Key(&'static str),
    Index(usize),
}

#[derive(Debug, Clone)]
pub(crate) struct Issue {
    pub path: Vec<Seg>,
    pub message: String,
    pub code: &'static str,
    /// zod's `continue` flag: false issues abort later non-length checks.
    cont: bool,
}

impl Issue {
    fn new(code: &'static str, message: String, cont: bool) -> Self {
        Self {
            path: Vec::new(),
            message,
            code,
            cont,
        }
    }

    pub fn to_json(&self) -> Value {
        let path: Vec<Value> = self
            .path
            .iter()
            .map(|s| match s {
                Seg::Key(k) => json!(k),
                Seg::Index(i) => json!(i),
            })
            .collect();
        json!({ "code": self.code, "path": path, "message": self.message })
    }
}

/// `{ issues: [...] }`, the shape of `parsed.error` as it serialises.
pub(crate) fn details(issues: &[Issue]) -> Value {
    Value::Array(issues.iter().map(Issue::to_json).collect())
}

#[derive(Debug, Clone)]
pub(crate) enum Check {
    /// `.min(n, msg?)` on a string / array.
    MinLen(usize, Option<&'static str>),
    /// `.max(n, msg?)` on a string / array.
    MaxLen(usize, Option<&'static str>),
    /// `.trim()`.
    Trim,
    /// `.date(msg?)`: `YYYY-MM-DD` with a real day.
    IsoDate(Option<&'static str>),
    /// `.regex(/^\d{4}-(0[1-9]|1[0-2])$/, msg?)`.
    YearMonth(Option<&'static str>),
    /// `.int()`.
    Int,
    /// `.positive(msg?)`.
    Positive(Option<&'static str>),
    /// `.min(n)` on a number.
    Gte(f64),
    /// `.max(n)` on a number.
    Lte(f64),
}

#[derive(Debug, Clone)]
pub(crate) enum Schema {
    Str(Vec<Check>),
    Num {
        coerce: bool,
        checks: Vec<Check>,
    },
    Bool,
    Enum(&'static [&'static str]),
    /// `z.union([z.boolean(), z.string()])`.
    BoolOrStr,
    Optional(Box<Schema>),
    Nullable(Box<Schema>),
    Default(Box<Schema>, Value),
    Object(Vec<(&'static str, Schema)>),
    Array(Box<Schema>, Vec<Check>),
}

// Builders, named after zod.
pub(crate) fn string(checks: Vec<Check>) -> Schema {
    Schema::Str(checks)
}
pub(crate) fn number(checks: Vec<Check>) -> Schema {
    Schema::Num {
        coerce: false,
        checks,
    }
}
pub(crate) fn coerce_number(checks: Vec<Check>) -> Schema {
    Schema::Num {
        coerce: true,
        checks,
    }
}
pub(crate) fn enumeration(values: &'static [&'static str]) -> Schema {
    Schema::Enum(values)
}
pub(crate) fn object(fields: Vec<(&'static str, Schema)>) -> Schema {
    Schema::Object(fields)
}
pub(crate) fn array(el: Schema, checks: Vec<Check>) -> Schema {
    Schema::Array(Box::new(el), checks)
}

impl Schema {
    pub fn optional(self) -> Schema {
        Schema::Optional(Box::new(self))
    }
    pub fn nullable(self) -> Schema {
        Schema::Nullable(Box::new(self))
    }
    pub fn default(self, v: Value) -> Schema {
        Schema::Default(Box::new(self), v)
    }

    fn optional_out(&self) -> bool {
        match self {
            Schema::Optional(_) => true,
            Schema::Nullable(inner) => inner.optional_out(),
            _ => false,
        }
    }

    /// `schema.safeParse(input)`: the parsed value or the issues.
    pub fn safe_parse(&self, input: &Value) -> Result<Value, Vec<Issue>> {
        let (value, issues) = self.run(Some(input));
        if issues.is_empty() {
            Ok(value.unwrap_or(Value::Null))
        } else {
            Err(issues)
        }
    }

    /// `None` is `undefined`.
    fn run(&self, input: Option<&Value>) -> (Option<Value>, Vec<Issue>) {
        match self {
            Schema::Optional(inner) => match input {
                None => (None, Vec::new()),
                Some(_) => inner.run(input),
            },
            Schema::Nullable(inner) => match input {
                Some(Value::Null) => (Some(Value::Null), Vec::new()),
                _ => inner.run(input),
            },
            Schema::Default(inner, d) => match input {
                None => (Some(d.clone()), Vec::new()),
                Some(_) => {
                    let (v, issues) = inner.run(input);
                    (Some(v.unwrap_or_else(|| d.clone())), issues)
                }
            },
            Schema::Str(checks) => {
                let mut issues = Vec::new();
                if !matches!(input, Some(Value::String(_))) {
                    issues.push(invalid_type("string", input));
                }
                let mut value = input.cloned();
                run_checks(&mut value, &mut issues, checks);
                (value, issues)
            }
            Schema::Num { coerce, checks } => {
                let n = match input {
                    Some(v) if *coerce => Some(js_number(v)),
                    Some(Value::Number(n)) => n.as_f64(),
                    _ => None,
                };
                let mut issues = Vec::new();
                match n {
                    Some(f) if f.is_finite() => {
                        let mut value = Some(crate::json::number(f));
                        run_num_checks(f, &mut issues, checks);
                        (value.take(), issues)
                    }
                    Some(f) => {
                        let received = if f.is_nan() { "NaN" } else { "number" };
                        issues.push(Issue::new(
                            "invalid_type",
                            format!("Invalid input: expected number, received {received}"),
                            false,
                        ));
                        (input.cloned(), issues)
                    }
                    None => {
                        issues.push(invalid_type("number", input));
                        (input.cloned(), issues)
                    }
                }
            }
            Schema::Bool => match input {
                Some(Value::Bool(_)) => (input.cloned(), Vec::new()),
                _ => (input.cloned(), vec![invalid_type("boolean", input)]),
            },
            Schema::Enum(values) => match input {
                Some(Value::String(s)) if values.contains(&s.as_str()) => {
                    (input.cloned(), Vec::new())
                }
                _ => {
                    let msg = if values.len() == 1 {
                        format!("Invalid input: expected \"{}\"", values[0])
                    } else {
                        let joined: Vec<String> =
                            values.iter().map(|v| format!("\"{v}\"")).collect();
                        format!("Invalid option: expected one of {}", joined.join("|"))
                    };
                    (
                        input.cloned(),
                        vec![Issue::new("invalid_value", msg, false)],
                    )
                }
            },
            Schema::BoolOrStr => match input {
                Some(Value::Bool(_)) | Some(Value::String(_)) => (input.cloned(), Vec::new()),
                _ => (
                    input.cloned(),
                    vec![Issue::new("invalid_union", "Invalid input".into(), false)],
                ),
            },
            Schema::Object(fields) => {
                let Some(Value::Object(obj)) = input else {
                    return (input.cloned(), vec![invalid_type("object", input)]);
                };
                let mut out = Map::new();
                let mut issues = Vec::new();
                for (key, schema) in fields {
                    let (v, field_issues) = schema.run(obj.get(*key));
                    if !field_issues.is_empty()
                        && !(schema.optional_out() && !obj.contains_key(*key))
                    {
                        issues.extend(field_issues.into_iter().map(|mut i| {
                            i.path.insert(0, Seg::Key(key));
                            i
                        }));
                    }
                    if let Some(v) = v {
                        out.insert((*key).to_string(), v);
                    }
                }
                (Some(Value::Object(out)), issues)
            }
            Schema::Array(el, checks) => {
                let mut issues = Vec::new();
                let mut value = input.cloned();
                if let Some(Value::Array(items)) = input {
                    let mut out = Vec::with_capacity(items.len());
                    for (i, item) in items.iter().enumerate() {
                        let (v, item_issues) = el.run(Some(item));
                        issues.extend(item_issues.into_iter().map(|mut iss| {
                            iss.path.insert(0, Seg::Index(i));
                            iss
                        }));
                        out.push(v.unwrap_or(Value::Null));
                    }
                    value = Some(Value::Array(out));
                } else {
                    issues.push(invalid_type("array", input));
                }
                run_checks(&mut value, &mut issues, checks);
                (value, issues)
            }
        }
    }
}

/// `Number(v)` for a JSON value (arrays go through `String(array)`).
fn js_number(v: &Value) -> f64 {
    match v {
        Value::Array(_) => crate::json::string_to_number(&js_string(v)),
        other => crate::json::to_number(other),
    }
}

/// `String(v)` for a JSON value.
fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n
            .as_f64()
            .map_or_else(|| n.to_string(), crate::services::budget::js_num),
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|i| match i {
                Value::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// zod's `parsedType(input)`.
fn parsed_type(input: Option<&Value>) -> &'static str {
    match input {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

fn invalid_type(expected: &str, input: Option<&Value>) -> Issue {
    Issue::new(
        "invalid_type",
        format!(
            "Invalid input: expected {expected}, received {}",
            parsed_type(input)
        ),
        false,
    )
}

fn aborted(issues: &[Issue], from: usize) -> bool {
    issues.iter().skip(from).any(|i| !i.cont)
}

/// A value's `.length` (UTF-16 units for strings) and zod's origin name.
fn length_of(v: Option<&Value>) -> Option<(usize, &'static str, &'static str)> {
    match v {
        Some(Value::String(s)) => Some((s.encode_utf16().count(), "string", "characters")),
        Some(Value::Array(a)) => Some((a.len(), "array", "items")),
        _ => None,
    }
}

fn is_iso_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let digits = |r: std::ops::Range<usize>| b[r].iter().all(u8::is_ascii_digit);
    if !(digits(0..4) && digits(5..7) && digits(8..10)) {
        return false;
    }
    let num = |r: std::ops::Range<usize>| s[r].parse::<u32>().unwrap_or(0);
    let (y, m, d) = (num(0..4), num(5..7), num(8..10));
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let max = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=max).contains(&d)
}

/// `/^\d{4}-(0[1-9]|1[0-2])$/`.
pub(crate) fn is_year_month(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 7
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[4] == b'-'
        && matches!((b[5], b[6]), (b'0', b'1'..=b'9') | (b'1', b'0'..=b'2'))
}

fn run_checks(value: &mut Option<Value>, issues: &mut Vec<Issue>, checks: &[Check]) {
    let mut is_aborted = aborted(issues, 0);
    for check in checks {
        let has_when = matches!(check, Check::MinLen(..) | Check::MaxLen(..));
        if has_when {
            if length_of(value.as_ref()).is_none() {
                continue;
            }
        } else if is_aborted {
            continue;
        }
        let before = issues.len();
        match check {
            Check::MinLen(n, msg) => {
                if let Some((len, origin, unit)) = length_of(value.as_ref()) {
                    if len < *n {
                        issues.push(Issue::new(
                            "too_small",
                            msg.map(str::to_string).unwrap_or_else(|| {
                                format!("Too small: expected {origin} to have >={n} {unit}")
                            }),
                            true,
                        ));
                    }
                }
            }
            Check::MaxLen(n, msg) => {
                if let Some((len, origin, unit)) = length_of(value.as_ref()) {
                    if len > *n {
                        issues.push(Issue::new(
                            "too_big",
                            msg.map(str::to_string).unwrap_or_else(|| {
                                format!("Too big: expected {origin} to have <={n} {unit}")
                            }),
                            true,
                        ));
                    }
                }
            }
            Check::Trim => {
                if let Some(Value::String(s)) = value {
                    *s = crate::js::js_trim(s).to_string();
                }
            }
            Check::IsoDate(msg) => {
                if let Some(Value::String(s)) = value.as_ref() {
                    if !is_iso_date(s) {
                        issues.push(Issue::new(
                            "invalid_format",
                            msg.unwrap_or("Invalid ISO date").to_string(),
                            true,
                        ));
                    }
                }
            }
            Check::YearMonth(msg) => {
                if let Some(Value::String(s)) = value.as_ref() {
                    if !is_year_month(s) {
                        issues.push(Issue::new(
                            "invalid_format",
                            msg.map(str::to_string).unwrap_or_else(|| {
                                "Invalid string: must match pattern /^\\d{4}-(0[1-9]|1[0-2])$/"
                                    .to_string()
                            }),
                            true,
                        ));
                    }
                }
            }
            Check::Int | Check::Positive(_) | Check::Gte(_) | Check::Lte(_) => {}
        }
        if issues.len() != before && !is_aborted {
            is_aborted = aborted(issues, before);
        }
    }
}

fn run_num_checks(f: f64, issues: &mut Vec<Issue>, checks: &[Check]) {
    let mut is_aborted = false;
    for check in checks {
        if is_aborted {
            continue;
        }
        let before = issues.len();
        match check {
            Check::Int => {
                if f.fract() != 0.0 {
                    issues.push(Issue::new(
                        "invalid_type",
                        "Invalid input: expected int, received number".into(),
                        false,
                    ));
                } else if f.abs() > 9_007_199_254_740_991.0 {
                    let msg = if f > 0.0 {
                        "Too big: expected int to be <=9007199254740991"
                    } else {
                        "Too small: expected int to be >=-9007199254740991"
                    };
                    let code = if f > 0.0 { "too_big" } else { "too_small" };
                    issues.push(Issue::new(code, msg.into(), true));
                }
            }
            Check::Positive(msg) => {
                if f <= 0.0 {
                    issues.push(Issue::new(
                        "too_small",
                        msg.unwrap_or("Too small: expected number to be >0")
                            .to_string(),
                        true,
                    ));
                }
            }
            Check::Gte(n) => {
                if f < *n {
                    issues.push(Issue::new(
                        "too_small",
                        format!(
                            "Too small: expected number to be >={}",
                            crate::services::budget::js_num(*n)
                        ),
                        true,
                    ));
                }
            }
            Check::Lte(n) if f > *n => {
                issues.push(Issue::new(
                    "too_big",
                    format!(
                        "Too big: expected number to be <={}",
                        crate::services::budget::js_num(*n)
                    ),
                    true,
                ));
            }
            _ => {}
        }
        if issues.len() != before {
            is_aborted = aborted(issues, before);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row_schema() -> Schema {
        object(vec![
            (
                "date",
                string(vec![Check::IsoDate(Some(
                    "Date must be ISO format YYYY-MM-DD",
                ))]),
            ),
            (
                "payee",
                string(vec![
                    Check::Trim,
                    Check::MinLen(1, Some("Payee is required")),
                ]),
            ),
            (
                "amount",
                number(vec![Check::Positive(Some(
                    "Amount must be greater than zero",
                ))]),
            ),
            ("type", enumeration(&["income", "expense", "transfer"])),
            (
                "source_key",
                string(vec![Check::MaxLen(1000, None)]).optional(),
            ),
        ])
    }

    fn messages(r: Result<Value, Vec<Issue>>) -> Vec<String> {
        r.err()
            .unwrap_or_default()
            .into_iter()
            .map(|i| i.message)
            .collect()
    }

    #[test]
    fn object_rules() {
        let s = row_schema();
        let ok = s.safe_parse(
            &json!({"date":"2024-02-29","payee":"  Cafe ","amount":5,"type":"expense","x":1}),
        );
        assert_eq!(
            ok.ok(),
            Some(json!({"date":"2024-02-29","payee":"Cafe","amount":5.0,"type":"expense"}))
        );
        assert_eq!(
            messages(
                s.safe_parse(&json!({"date":"2026-02-30","payee":"  ","amount":0,"type":"x"}))
            ),
            vec![
                "Date must be ISO format YYYY-MM-DD",
                "Payee is required",
                "Amount must be greater than zero",
                "Invalid option: expected one of \"income\"|\"expense\"|\"transfer\""
            ]
        );
        assert_eq!(
            messages(
                s.safe_parse(&json!({"payee":[],"amount":"5","type":"income","source_key":5}))
            ),
            vec![
                "Invalid input: expected string, received undefined",
                "Invalid input: expected string, received array",
                "Payee is required",
                "Invalid input: expected number, received string",
                "Invalid input: expected string, received number",
            ]
        );
        assert_eq!(
            messages(s.safe_parse(&Value::Null)),
            vec!["Invalid input: expected object, received null"]
        );
    }

    #[test]
    fn coercion_and_ints() {
        let page = coerce_number(vec![Check::Int, Check::Gte(1.0)]).default(json!(1));
        assert_eq!(page.safe_parse(&json!("3")).ok(), Some(json!(3.0)));
        assert!(page.safe_parse(&json!("")).is_err());
        assert!(page.safe_parse(&json!("1.5")).is_err());
        assert!(page.safe_parse(&json!("abc")).is_err());
        let amount = coerce_number(vec![Check::Positive(None)]);
        assert_eq!(amount.safe_parse(&json!(["7"])).ok(), Some(json!(7.0)));
        assert!(amount.safe_parse(&json!([true])).is_err());
        assert!(amount.safe_parse(&json!(null)).is_err());
        assert!(is_year_month("2026-12") && !is_year_month("2026-13") && !is_year_month("2026-1"));
    }
}
