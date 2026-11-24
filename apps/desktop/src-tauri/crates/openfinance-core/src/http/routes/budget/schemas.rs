//! `@openfinance/shared/schemas` (account, envelope, recurring, transaction)
//! as [`super::zod`] schemas, field for field.

use serde_json::json;

use super::zod::{array, coerce_number, enumeration, number, object, string, Check, Schema};

const CURRENCIES: &[&str] = &["INR", "USD", "SGD", "GBP", "EUR", "JPY", "NTD"];
const ACCOUNT_TYPES: &[&str] = &[
    "checking",
    "savings",
    "cash",
    "investment",
    "policy",
    "credit",
    "loan",
    "debt",
];
const ROLLOVER_TYPES: &[&str] = &["none", "amount", "leftover"];
const FREQUENCIES: &[&str] = &["weekly", "monthly", "quarterly", "annual"];
const TRANSACTION_TYPES: &[&str] = &["income", "expense", "transfer"];
const INCOME_EXPENSE: &[&str] = &["income", "expense"];
const INCOME_CATEGORIES: &[&str] = &["income", "cashback", "starting_balance"];
const DATE_MSG: Option<&str> = Some("Date must be ISO format YYYY-MM-DD");

fn min1() -> Schema {
    string(vec![Check::MinLen(1, None)])
}
fn plain() -> Schema {
    string(vec![])
}
fn iso_date(msg: Option<&'static str>) -> Schema {
    string(vec![Check::IsoDate(msg)])
}
fn year_month(msg: Option<&'static str>) -> Schema {
    string(vec![Check::YearMonth(msg)])
}

pub(super) fn create_account() -> Schema {
    object(vec![
        ("name", min1()),
        ("type", enumeration(ACCOUNT_TYPES)),
        ("currency", enumeration(CURRENCIES).default(json!("INR"))),
        ("institution", plain().optional()),
        ("balance", number(vec![]).default(json!(0))),
        ("off_budget", Schema::Bool.default(json!(false))),
    ])
}

pub(super) fn update_account() -> Schema {
    object(vec![
        ("name", min1().optional()),
        ("type", enumeration(ACCOUNT_TYPES).optional()),
        ("currency", enumeration(CURRENCIES).optional()),
        ("institution", plain().optional()),
        ("balance", number(vec![]).optional()),
        ("is_active", Schema::Bool.optional()),
        ("off_budget", Schema::Bool.optional()),
    ])
}

pub(super) fn create_envelope() -> Schema {
    object(vec![
        ("group_id", min1()),
        ("name", min1()),
        ("budgeted", number(vec![Check::Gte(0.0)]).default(json!(0))),
        (
            "budget_currency",
            enumeration(CURRENCIES).default(json!("INR")),
        ),
        ("month", year_month(Some("Month must be in YYYY-MM format"))),
        (
            "rollover_type",
            enumeration(ROLLOVER_TYPES).default(json!("none")),
        ),
        (
            "rollover_amount",
            number(vec![Check::Gte(0.0)]).default(json!(0)),
        ),
    ])
}

pub(super) fn update_envelope() -> Schema {
    object(vec![
        ("name", min1().optional()),
        ("budgeted", number(vec![Check::Gte(0.0)]).optional()),
        ("budget_currency", enumeration(CURRENCIES).optional()),
        ("group_id", min1().optional()),
        ("rollover_type", enumeration(ROLLOVER_TYPES).optional()),
        ("rollover_amount", number(vec![Check::Gte(0.0)]).optional()),
    ])
}

fn recurring_fields() -> Vec<(&'static str, Schema)> {
    vec![
        ("payee", min1()),
        ("amount", number(vec![Check::Positive(None)])),
        ("type", enumeration(INCOME_EXPENSE)),
        ("account_id", min1()),
        ("envelope_id", min1().nullable().optional()),
        ("frequency", enumeration(FREQUENCIES)),
        ("next_date", iso_date(DATE_MSG)),
        ("end_date", iso_date(None).nullable().optional()),
        ("notes", plain().nullable().optional()),
    ]
}

pub(super) fn create_recurring() -> Schema {
    object(recurring_fields())
}

/// `CreateRecurringSchema.partial().extend({ is_active })`.
pub(super) fn update_recurring() -> Schema {
    let mut fields: Vec<(&'static str, Schema)> = recurring_fields()
        .into_iter()
        .map(|(k, s)| {
            let s = match s {
                already @ Schema::Optional(_) => already,
                other => other.optional(),
            };
            (k, s)
        })
        .collect();
    fields.push(("is_active", Schema::Bool.optional()));
    object(fields)
}

pub(super) fn create_transaction() -> Schema {
    object(vec![
        ("account_id", min1()),
        ("envelope_id", min1().optional()),
        ("payee", min1()),
        ("amount", number(vec![Check::Positive(None)])),
        ("type", enumeration(INCOME_EXPENSE)),
        ("date", iso_date(DATE_MSG)),
        ("notes", plain().optional()),
        ("import_hash", plain().optional()),
        ("income_category", enumeration(INCOME_CATEGORIES).optional()),
    ])
}

pub(super) fn update_transaction() -> Schema {
    object(vec![
        ("envelope_id", min1().nullable().optional()),
        ("notes", plain().optional()),
        ("payee", min1().optional()),
        ("amount", number(vec![Check::Positive(None)]).optional()),
        ("date", iso_date(None).optional()),
        ("type", enumeration(INCOME_EXPENSE).optional()),
        (
            "income_category",
            enumeration(INCOME_CATEGORIES).nullable().optional(),
        ),
    ])
}

pub(super) fn create_transfer() -> Schema {
    object(vec![
        ("from_account_id", min1()),
        ("to_account_id", min1()),
        ("amount", coerce_number(vec![Check::Positive(None)])),
        (
            "to_amount",
            coerce_number(vec![Check::Positive(None)]).optional(),
        ),
        ("date", iso_date(DATE_MSG)),
        ("notes", plain().optional()),
        ("import_hash", plain().optional()),
        ("envelope_id", min1().optional()),
        ("to_envelope_id", min1().optional()),
        ("from_savings", Schema::Bool.optional()),
    ])
}

pub(super) fn transaction_filters() -> Schema {
    object(vec![
        ("account_id", plain().optional()),
        ("envelope_id", plain().optional()),
        ("type", enumeration(TRANSACTION_TYPES).optional()),
        ("date_from", iso_date(None).optional()),
        ("date_to", iso_date(None).optional()),
        ("search", plain().optional()),
        (
            "page",
            coerce_number(vec![Check::Int, Check::Gte(1.0)]).default(json!(1)),
        ),
        (
            "limit",
            coerce_number(vec![Check::Int, Check::Gte(1.0), Check::Lte(200.0)]).default(json!(50)),
        ),
        ("off_budget", Schema::BoolOrStr.optional()),
    ])
}

fn bulk_row() -> Schema {
    object(vec![
        ("date", iso_date(DATE_MSG)),
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
        ("type", enumeration(TRANSACTION_TYPES)),
        ("envelope_id", min1().optional()),
        ("income_category", enumeration(INCOME_CATEGORIES).optional()),
        ("notes", plain().optional()),
        ("counterpart_account_id", min1().optional()),
        ("direction", enumeration(&["in", "out"]).optional()),
        (
            "source_key",
            string(vec![Check::MaxLen(1000, None)]).optional(),
        ),
    ])
}

pub(super) fn bulk_create() -> Schema {
    object(vec![
        ("account_id", min1()),
        (
            "rows",
            array(
                bulk_row(),
                vec![Check::MinLen(1, None), Check::MaxLen(1000, None)],
            ),
        ),
    ])
}

pub(super) fn bulk_preview() -> Schema {
    object(vec![
        ("account_id", min1()),
        ("category_month", year_month(None)),
        (
            "rows",
            array(
                object(vec![
                    ("date", iso_date(None)),
                    ("payee", plain()),
                    ("amount", number(vec![])),
                    (
                        "source_key",
                        string(vec![Check::MaxLen(1000, None)]).optional(),
                    ),
                ]),
                vec![Check::MaxLen(1000, None)],
            ),
        ),
    ])
}
