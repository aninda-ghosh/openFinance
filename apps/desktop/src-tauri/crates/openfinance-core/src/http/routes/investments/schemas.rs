//! Port of `packages/shared/src/schemas/investment.schema.ts` (zod 4.3):
//! `CreateInvestmentSchema`, `UpdateInvestmentSchema`,
//! `SetContributionSchema`, `BulkContributionSchema` (and `CurrencyEnum`,
//! `AssetTypeEnum`). Owner: Wave 2 (investments).
//!
//! `parse` returns zod's output: shape keys in declaration order, absent
//! optional keys omitted, defaults filled, unknown keys stripped. Failures
//! carry zod-shaped issues as `details` (the harness compares only the status
//! and `error`).

use serde_json::{json, Map, Value};

use crate::error::ApiError;

const CURRENCIES: &[&str] = &["INR", "USD", "SGD", "GBP", "EUR", "JPY", "NTD"];
const ASSET_TYPES: &[&str] = &[
    "mutual_fund",
    "stock",
    "etf",
    "fd",
    "savings",
    "bond",
    "real_estate",
    "cash",
    "structured",
    "other",
    "vehicle",
];
const MODES: &[&str] = &["match_delta", "clear"];

#[derive(Clone, Copy)]
pub enum Kind {
    /// `z.string()`; `min1`: `.min(1)`.
    Str {
        min1: bool,
    },
    /// `z.string().date(msg?)`.
    Date,
    Enum(&'static [&'static str]),
    /// `z.number()` with optional `.positive()` / `.min(lo)` / `.max(hi)`.
    Number {
        positive: bool,
        min: Option<f64>,
        max: Option<f64>,
    },
}

#[derive(Clone, Copy)]
pub enum Presence {
    Required,
    Optional,
    /// `.nullable().optional()`
    NullableOptional,
    /// `.default(value)`
    Default(&'static str),
}

pub type Field = (&'static str, Kind, Presence);

use Kind::*;
use Presence::*;

const NUMBER: Kind = Number {
    positive: false,
    min: None,
    max: None,
};
const POSITIVE: Kind = Number {
    positive: true,
    min: None,
    max: None,
};
const NON_NEGATIVE: Kind = Number {
    positive: false,
    min: Some(0.0),
    max: None,
};
/// `DepreciationRate`: `z.number().min(0).max(100).nullable().optional()`.
const RATE: Kind = Number {
    positive: false,
    min: Some(0.0),
    max: Some(100.0),
};
const S: Kind = Str { min1: false };
const S1: Kind = Str { min1: true };

/// `CreateInvestmentSchema`.
pub const CREATE_INVESTMENT: &[Field] = &[
    ("name", S1, Required),
    ("asset_type", Enum(ASSET_TYPES), Required),
    ("currency", Enum(CURRENCIES), Default("INR")),
    ("purchase_value", POSITIVE, Required),
    ("units", POSITIVE, Optional),
    ("purchase_date", Date, Required),
    ("current_value", NON_NEGATIVE, Required),
    ("current_value_source", S, Optional),
    ("current_value_at", Date, Optional),
    ("notes", S, Optional),
    ("account_id", S, NullableOptional),
    ("maturity_date", Date, NullableOptional),
    ("depreciation_rate", RATE, NullableOptional),
];

/// `UpdateInvestmentSchema`.
pub const UPDATE_INVESTMENT: &[Field] = &[
    ("contribution", NUMBER, Optional),
    ("name", S1, Optional),
    ("asset_type", Enum(ASSET_TYPES), Optional),
    ("currency", Enum(CURRENCIES), Optional),
    ("purchase_value", POSITIVE, Optional),
    ("purchase_date", Date, Optional),
    ("current_value", NON_NEGATIVE, Optional),
    ("current_value_source", S, Optional),
    ("current_value_at", Date, Optional),
    ("units", POSITIVE, Optional),
    ("notes", S, Optional),
    ("account_id", S, NullableOptional),
    ("maturity_date", Date, NullableOptional),
    ("depreciation_rate", RATE, NullableOptional),
];

/// `SetContributionSchema`.
pub const SET_CONTRIBUTION: &[Field] = &[("contribution", NUMBER, Required)];

/// `BulkContributionSchema`.
pub const BULK_CONTRIBUTION: &[Field] = &[("mode", Enum(MODES), Required)];

/// zod's `z.string().date()` regex: `YYYY-MM-DD` naming a real day.
fn is_iso_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let all_digits = b
        .iter()
        .enumerate()
        .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit());
    if !all_digits {
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

fn issue(path: &str, code: &str, message: String) -> Value {
    let path: Vec<Value> = if path.is_empty() {
        Vec::new()
    } else {
        vec![json!(path)]
    };
    json!({ "code": code, "path": path, "message": message })
}

/// Checks one present value; pushes issues.
fn check(key: &str, kind: Kind, v: &Value, issues: &mut Vec<Value>) {
    match kind {
        Str { min1 } => match v {
            Value::String(s) => {
                if min1 && s.is_empty() {
                    issues.push(issue(
                        key,
                        "too_small",
                        "Too small: expected string to have >=1 characters".into(),
                    ));
                }
            }
            other => issues.push(issue(
                key,
                "invalid_type",
                format!(
                    "Invalid input: expected string, received {}",
                    received(other)
                ),
            )),
        },
        Date => match v {
            Value::String(s) => {
                if !is_iso_date(s) {
                    let msg = match key {
                        "current_value_at" => "Invalid ISO date",
                        _ => "Date must be ISO format YYYY-MM-DD",
                    };
                    issues.push(issue(key, "invalid_format", msg.into()));
                }
            }
            other => issues.push(issue(
                key,
                "invalid_type",
                format!(
                    "Invalid input: expected string, received {}",
                    received(other)
                ),
            )),
        },
        Enum(values) => {
            if !v.as_str().is_some_and(|s| values.contains(&s)) {
                let joined: Vec<String> = values.iter().map(|v| format!("\"{v}\"")).collect();
                issues.push(issue(
                    key,
                    "invalid_value",
                    format!("Invalid option: expected one of {}", joined.join("|")),
                ));
            }
        }
        Number { positive, min, max } => match v.as_f64().filter(|f| f.is_finite()) {
            Some(f) => {
                if positive && f <= 0.0 {
                    issues.push(issue(
                        key,
                        "too_small",
                        "Too small: expected number to be >0".into(),
                    ));
                }
                if let Some(lo) = min.filter(|lo| f < *lo) {
                    issues.push(issue(
                        key,
                        "too_small",
                        format!("Too small: expected number to be >={lo}"),
                    ));
                }
                if let Some(hi) = max.filter(|hi| f > *hi) {
                    issues.push(issue(
                        key,
                        "too_big",
                        format!("Too big: expected number to be <={hi}"),
                    ));
                }
            }
            None => issues.push(issue(
                key,
                "invalid_type",
                format!("Invalid input: expected number, received {}", received(v)),
            )),
        },
    }
}

/// `schema.safeParse(body)`: the parsed object, or `400 Validation failed`.
/// `body` is `None` when the request body was not JSON (`.catch(() => null)`).
pub fn parse(fields: &[Field], body: Option<&Value>) -> Result<Map<String, Value>, ApiError> {
    let body = body.unwrap_or(&Value::Null);
    let Value::Object(obj) = body else {
        return Err(ApiError::validation(json!([issue(
            "",
            "invalid_type",
            format!(
                "Invalid input: expected object, received {}",
                received(body)
            ),
        )])));
    };
    let mut out = Map::new();
    let mut issues = Vec::new();
    for &(key, kind, presence) in fields {
        match (obj.get(key), presence) {
            (None, Required) => issues.push(issue(
                key,
                "invalid_type",
                format!(
                    "Invalid input: expected {}, received undefined",
                    match kind {
                        Number { .. } => "number",
                        Enum(_) => "enum",
                        _ => "string",
                    }
                ),
            )),
            (None, Optional | NullableOptional) => {}
            (None, Default(d)) => {
                out.insert(key.into(), Value::String(d.into()));
            }
            (Some(Value::Null), NullableOptional) => {
                out.insert(key.into(), Value::Null);
            }
            (Some(v), _) => {
                let before = issues.len();
                check(key, kind, v, &mut issues);
                if issues.len() == before {
                    out.insert(key.into(), v.clone());
                }
            }
        }
    }
    if issues.is_empty() {
        Ok(out)
    } else {
        Err(ApiError::validation(Value::Array(issues)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(fields: &[Field], v: Value) -> Value {
        match parse(fields, Some(&v)) {
            Ok(m) => Value::Object(m),
            Err(e) => panic!("unexpected failure for {v}: {e}"),
        }
    }

    fn fails(fields: &[Field], v: Value) -> bool {
        parse(fields, Some(&v)).is_err()
    }

    #[test]
    fn create_schema() {
        let base = json!({
            "name": "X", "asset_type": "stock", "purchase_value": 10,
            "purchase_date": "2024-02-29", "current_value": 0, "extra": 1
        });
        assert_eq!(
            ok(CREATE_INVESTMENT, base.clone()),
            json!({"name":"X","asset_type":"stock","currency":"INR","purchase_value":10,
                   "purchase_date":"2024-02-29","current_value":0})
        );
        let with = |k: &str, v: Value| {
            let mut b = base.clone();
            b[k] = v;
            b
        };
        assert!(fails(CREATE_INVESTMENT, with("name", json!(""))));
        assert!(fails(
            CREATE_INVESTMENT,
            with("asset_type", json!("crypto"))
        ));
        assert!(fails(CREATE_INVESTMENT, with("currency", json!("CHF"))));
        assert!(fails(CREATE_INVESTMENT, with("purchase_value", json!(0))));
        assert!(fails(
            CREATE_INVESTMENT,
            with("purchase_value", json!("10"))
        ));
        assert!(fails(CREATE_INVESTMENT, with("current_value", json!(-1))));
        assert!(fails(
            CREATE_INVESTMENT,
            with("purchase_date", json!("2023-02-29"))
        ));
        assert!(fails(CREATE_INVESTMENT, with("units", json!(null))));
        assert!(fails(
            CREATE_INVESTMENT,
            with("depreciation_rate", json!(100.5))
        ));
        assert!(!fails(
            CREATE_INVESTMENT,
            with("depreciation_rate", json!(null))
        ));
        assert!(!fails(CREATE_INVESTMENT, with("account_id", json!(null))));
        assert!(fails(CREATE_INVESTMENT, with("notes", json!(null))));
        assert!(fails(CREATE_INVESTMENT, json!([])));
        assert!(parse(CREATE_INVESTMENT, None).is_err());
    }

    #[test]
    fn update_and_contribution_schemas() {
        assert_eq!(ok(UPDATE_INVESTMENT, json!({})), json!({}));
        assert_eq!(
            ok(
                UPDATE_INVESTMENT,
                json!({"notes":"n","contribution":-5,"x":1})
            ),
            json!({"contribution":-5,"notes":"n"})
        );
        assert!(fails(UPDATE_INVESTMENT, json!({"contribution": null})));
        assert!(fails(SET_CONTRIBUTION, json!({})));
        assert!(!fails(SET_CONTRIBUTION, json!({"contribution": 0})));
        assert!(fails(BULK_CONTRIBUTION, json!({"mode": "all"})));
        assert!(!fails(BULK_CONTRIBUTION, json!({"mode": "clear"})));
    }
}
