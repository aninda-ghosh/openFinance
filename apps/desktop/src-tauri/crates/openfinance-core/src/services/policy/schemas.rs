//! Port of `packages/shared/src/schemas/{policy,life-insurance,currency}.schema.ts`
//! (zod 4.3.6). Owner: Wave 1 (policies).
//!
//! `parse` returns the zod output: the shape's keys in declaration order,
//! absent optional keys omitted, defaults filled in, unknown keys stripped.
//! Failures carry a small `details` value (the harness ignores `details`).

use serde_json::{json, Map, Value};

use crate::error::ApiError;

const CURRENCIES: &[&str] = &["INR", "USD", "SGD", "GBP", "EUR", "JPY", "NTD"];
const FREQUENCIES: &[&str] = &["monthly", "quarterly", "annual"];
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

#[derive(Clone, Copy)]
pub(crate) enum Num {
    /// `z.number().positive()`
    Positive,
    /// `z.number().min(0)`
    NonNegative,
    /// `z.number().int().positive()`
    PositiveInt,
}

#[derive(Clone, Copy)]
pub(crate) enum Kind {
    /// `z.string()` (`min1`: `.min(1)`)
    Str {
        min1: bool,
    },
    /// `z.string().date()`
    Date,
    /// `z.enum([...])`
    Enum(&'static [&'static str]),
    Number(Num),
    /// `z.boolean()`
    Bool,
}

#[derive(Clone, Copy)]
pub(crate) enum Presence {
    Required,
    Optional,
    /// `.nullable().optional()`
    NullableOptional,
    /// `.default(value)`
    Default(&'static str),
    /// `z.boolean().default(false)`
    DefaultFalse,
}

pub(crate) type Field = (&'static str, Kind, Presence);

use Kind::*;
use Presence::*;

const S1: Kind = Str { min1: true };

/// `CreatePolicySchema`.
pub const CREATE_POLICY: &[Field] = &[
    ("name", S1, Required),
    ("provider", S1, Required),
    ("policy_number", Str { min1: false }, Optional),
    ("currency", Enum(CURRENCIES), Default("INR")),
    ("start_date", Date, Required),
    ("premium_amount", Number(Num::Positive), Required),
    ("premium_frequency", Enum(FREQUENCIES), Required),
    ("premium_term_years", Number(Num::PositiveInt), Required),
    ("policy_term_years", Number(Num::PositiveInt), Required),
    ("maturity_date", Date, Required),
    ("sum_assured", Number(Num::Positive), Required),
    ("maturity_value", Number(Num::Positive), Required),
    (
        "surrender_value",
        Number(Num::NonNegative),
        NullableOptional,
    ),
    ("notes", Str { min1: false }, Optional),
    ("account_id", Str { min1: false }, Optional),
];

/// `UpdatePolicySchema`.
pub const UPDATE_POLICY: &[Field] = &[
    ("name", S1, Optional),
    ("provider", S1, Optional),
    ("policy_number", Str { min1: false }, Optional),
    ("currency", Enum(CURRENCIES), Optional),
    ("start_date", Date, Optional),
    ("premium_amount", Number(Num::Positive), Optional),
    ("premium_frequency", Enum(FREQUENCIES), Optional),
    ("premium_term_years", Number(Num::PositiveInt), Optional),
    ("policy_term_years", Number(Num::PositiveInt), Optional),
    ("maturity_date", Date, Optional),
    ("sum_assured", Number(Num::Positive), Optional),
    ("maturity_value", Number(Num::Positive), Optional),
    (
        "surrender_value",
        Number(Num::NonNegative),
        NullableOptional,
    ),
    ("notes", Str { min1: false }, Optional),
    ("account_id", Str { min1: false }, Optional),
];

/// `CreatePayoutSchema`.
pub const CREATE_PAYOUT: &[Field] = &[
    ("payout_date", Date, Required),
    ("amount", Number(Num::Positive), Required),
    ("label", S1, Required),
    ("is_received", Bool, DefaultFalse),
];

/// `UpdatePayoutSchema`.
pub const UPDATE_PAYOUT: &[Field] = &[
    ("is_received", Bool, Optional),
    ("amount", Number(Num::Positive), Optional),
    ("label", S1, Optional),
];

/// `CreateLifeInsuranceSchema`.
pub const CREATE_LIFE_INSURANCE: &[Field] = &[
    ("name", S1, Required),
    ("insured_person", S1, Required),
    ("provider", S1, Required),
    ("policy_number", Str { min1: false }, Optional),
    ("currency", Enum(CURRENCIES), Default("INR")),
    ("coverage_amount", Number(Num::Positive), Required),
    ("renewal_date", Date, Required),
    ("premium_amount", Number(Num::Positive), NullableOptional),
    ("premium_frequency", Enum(FREQUENCIES), NullableOptional),
];

/// `UpdateLifeInsuranceSchema`.
pub const UPDATE_LIFE_INSURANCE: &[Field] = &[
    ("name", S1, Optional),
    ("insured_person", S1, Optional),
    ("provider", S1, Optional),
    ("policy_number", Str { min1: false }, Optional),
    ("currency", Enum(CURRENCIES), Optional),
    ("coverage_amount", Number(Num::Positive), Optional),
    ("renewal_date", Date, Optional),
    ("premium_amount", Number(Num::Positive), NullableOptional),
    ("premium_frequency", Enum(FREQUENCIES), NullableOptional),
];

/// zod's ISO date regex (`z.string().date()`): a real calendar date
/// `YYYY-MM-DD`, Gregorian leap years, ASCII digits only.
pub fn is_zod_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let digits = |r: std::ops::Range<usize>| b[r].iter().all(u8::is_ascii_digit);
    if !digits(0..4) || !digits(5..7) || !digits(8..10) {
        return false;
    }
    let n = |r: std::ops::Range<usize>| {
        b[r].iter()
            .fold(0u32, |acc, c| acc * 10 + u32::from(c - b'0'))
    };
    let (y, m, d) = (n(0..4), n(5..7), n(8..10));
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

fn check(kind: Kind, v: &Value) -> Result<(), &'static str> {
    match kind {
        Str { min1 } => match v {
            Value::String(s) if min1 && s.is_empty() => {
                Err("Too small: expected string to have >=1 characters")
            }
            Value::String(_) => Ok(()),
            _ => Err("Invalid input: expected string"),
        },
        Date => match v {
            Value::String(s) if is_zod_date(s) => Ok(()),
            Value::String(_) => Err("Invalid ISO date"),
            _ => Err("Invalid input: expected string"),
        },
        Enum(options) => match v.as_str() {
            Some(s) if options.contains(&s) => Ok(()),
            _ => Err("Invalid option"),
        },
        Number(rule) => {
            // serde_json never yields NaN/Infinity (zod rejects them too).
            let Some(f) = v.as_f64().filter(|_| v.is_number()) else {
                return Err("Invalid input: expected number");
            };
            match rule {
                Num::Positive if f > 0.0 => Ok(()),
                Num::NonNegative if f >= 0.0 => Ok(()),
                Num::PositiveInt => {
                    if f.fract() != 0.0 {
                        Err("Invalid input: expected int")
                    } else if f.abs() > MAX_SAFE_INTEGER {
                        Err("Integers must be within the safe integer range.")
                    } else if f > 0.0 {
                        Ok(())
                    } else {
                        Err("Too small: expected number to be >0")
                    }
                }
                _ => Err("Too small"),
            }
        }
        Bool => match v {
            Value::Bool(_) => Ok(()),
            _ => Err("Invalid input: expected boolean"),
        },
    }
}

/// `Schema.safeParse(body)`: the parsed object, or `400 Validation failed`.
pub fn parse(schema: &[Field], body: Option<&Value>) -> Result<Map<String, Value>, ApiError> {
    let Some(Value::Object(input)) = body else {
        return Err(ApiError::validation(json!({
            "issues": [{ "path": [], "message": "Invalid input: expected object" }]
        })));
    };
    let mut out = Map::new();
    let mut issues = Vec::new();
    for (key, kind, presence) in schema {
        match (input.get(*key), presence) {
            (None, Required) => issues.push(json!({
                "path": [key], "message": "Invalid input: expected value, received undefined"
            })),
            (None, Optional | NullableOptional) => {}
            (None, Default(d)) => {
                out.insert((*key).to_string(), Value::String((*d).to_string()));
            }
            (None, DefaultFalse) => {
                out.insert((*key).to_string(), Value::Bool(false));
            }
            (Some(Value::Null), NullableOptional) => {
                out.insert((*key).to_string(), Value::Null);
            }
            (Some(v), _) => match check(*kind, v) {
                Ok(()) => {
                    out.insert((*key).to_string(), v.clone());
                }
                Err(message) => issues.push(json!({ "path": [key], "message": message })),
            },
        }
    }
    if issues.is_empty() {
        Ok(out)
    } else {
        Err(ApiError::validation(json!({ "issues": issues })))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zod_date_regex() {
        assert!(is_zod_date("2026-09-28"));
        assert!(is_zod_date("2024-02-29"));
        assert!(is_zod_date("2000-02-29"));
        assert!(is_zod_date("0000-02-29"));
        assert!(!is_zod_date("1900-02-29"));
        assert!(!is_zod_date("2026-02-29"));
        assert!(!is_zod_date("2026-04-31"));
        assert!(!is_zod_date("2026-13-01"));
        assert!(!is_zod_date("2026-00-01"));
        assert!(!is_zod_date("2026-01-00"));
        assert!(!is_zod_date("2026-1-01"));
        assert!(!is_zod_date("09/28/2026"));
        assert!(!is_zod_date("2026-01-01T00:00:00Z"));
        assert!(!is_zod_date("２０２６-01-01"));
    }

    #[test]
    fn parse_fills_defaults_and_strips_unknown_keys() {
        let body = json!({
            "payout_date": "2026-01-01", "amount": 5, "label": "x", "extra": 1
        });
        let out = parse(CREATE_PAYOUT, Some(&body)).expect("valid");
        assert_eq!(
            Value::Object(out),
            json!({ "payout_date": "2026-01-01", "amount": 5, "label": "x", "is_received": false })
        );
        assert!(parse(CREATE_PAYOUT, None).is_err());
        assert!(parse(CREATE_PAYOUT, Some(&json!([]))).is_err());
        assert!(parse(UPDATE_PAYOUT, Some(&json!({ "label": "" }))).is_err());
        assert!(parse(UPDATE_PAYOUT, Some(&json!({ "amount": null }))).is_err());
        assert!(parse(UPDATE_PAYOUT, Some(&json!({}))).is_ok());
    }

    #[test]
    fn numbers() {
        let ok = |v: Value| check(Number(Num::PositiveInt), &v).is_ok();
        assert!(ok(json!(10)));
        assert!(ok(json!(10.0)));
        assert!(!ok(json!(1.5)));
        assert!(!ok(json!(0)));
        assert!(!ok(json!(9007199254740992.0)));
        assert!(!ok(json!("10")));
        assert!(check(Number(Num::NonNegative), &json!(0)).is_ok());
        assert!(check(Number(Num::Positive), &json!(0)).is_err());
        assert!(check(Number(Num::Positive), &json!(-1)).is_err());
    }
}
