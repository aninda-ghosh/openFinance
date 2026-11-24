//! Port of `apps/server/src/services/budget.service.ts` (Wave 1, budget).
//!
//! Split by topic into private submodules; everything later waves import from
//! `budget.service.ts` is re-exported here and takes `&Connection`:
//! `list_accounts`, `get_account_balances`, `list_envelopes`,
//! `compute_spent_by_envelope`, `resolve_envelope_for_month`,
//! `compute_carryover_for_month`, `compute_from_savings`,
//! `get_monthly_summary`, `list_transactions`, plus the budget-local
//! `get_latest_rates` / `to_inr` they are called with.
//!
//! Column values are read leniently (REAL/INTEGER/TEXT → number, any → text)
//! and drizzle's boolean columns map `Number(v) === 1`, as drizzle does.

mod accounts;
pub(crate) mod compat;
mod csv;
mod envelopes;
mod import;
mod reports;
mod transactions;

use std::collections::HashMap;

use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{Connection, Row};
use serde_json::Value;

use crate::error::{ApiError, ApiResult};

pub use accounts::{
    create_account, delete_account, get_account_balances, list_accounts, update_account,
    AccountBalanceParts, AccountBalances, AccountResponse, CreateAccount,
};
pub(crate) use compat::js_num;
pub use envelopes::{
    clear_month_budget, compute_spent_by_envelope, copy_previous_month_budget, create_envelope,
    create_envelope_group, delete_envelope, delete_envelope_group, envelope_for_date,
    find_misfiled_transactions, list_envelope_groups, list_envelopes, reclaim_envelope_to_pool,
    repair_misfiled_transactions, resolve_envelope_for_month, update_envelope,
    update_envelope_group, CreateEnvelope, EnvelopeResponse, EnvelopeWithGroupResponse,
    MisfiledTransaction,
};
pub(crate) use import::hash_row;
pub use import::{import_csv, ImportResult};
pub use reports::{
    compute_carryover_for_month, compute_from_savings, get_envelope_trends, get_monthly_summary,
    EnvelopeSummary, MonthlySummaryResponse, SavingsRange, TrendResponse,
};
pub use transactions::{
    assert_envelope_required, create_transaction, create_transfer, delete_transaction,
    insert_transaction, list_transactions, update_transaction, CreateTransaction, CreateTransfer,
    ListedTransaction, NewTransaction, PaginatedTransactionsResponse, TransactionFilters,
    TransactionResponse, TransactionRow, TransferResponse,
};

// ─── Shared constants (`@openfinance/shared/constants`) ─────────────────────

pub const TRANSFER_OUT: &str = "Transfer out";
pub const TRANSFER_IN: &str = "Transfer in";
pub const FROM_SAVINGS: &str = "from_savings";
pub const STARTING_BALANCE_PAYEE: &str = "Starting Balance";
pub const BALANCE_ADJUSTMENT_PAYEE: &str = "Balance Adjustment";
pub const PHYSICAL_ASSET_TYPES: [&str; 1] = ["vehicle"];

/// `isLiabilityType(type)`.
pub fn is_liability_type(t: &str) -> bool {
    matches!(t, "credit" | "loan" | "debt")
}

/// `bearsHoldings(type)`.
pub fn bears_holdings(t: &str) -> bool {
    matches!(t, "investment" | "checking" | "savings" | "cash")
}

/// `isTransferIn(txn)`.
pub fn is_transfer_in(t: &str, payee: &str) -> bool {
    t == "transfer" && payee == TRANSFER_IN
}

/// `balanceDelta(txn)`: `None` for a transfer leg with no direction (or an
/// unknown type).
pub fn balance_delta(t: &str, payee: &str, amount: f64) -> Option<f64> {
    match t {
        "income" => Some(amount),
        "expense" => Some(-amount),
        "transfer" if payee == TRANSFER_IN => Some(amount),
        "transfer" if payee == TRANSFER_OUT => Some(-amount),
        _ => None,
    }
}

// ─── Rates ───────────────────────────────────────────────────────────────────

/// `{ [currency]: rate }` as budget.service.ts's own `getLatestRates()` builds
/// it (no base-currency entry, unlike exchange-rate.service.ts).
pub type Rates = HashMap<String, f64>;

/// budget.service.ts `getLatestRates()`: newest row per currency; a falsy
/// (0 / NaN) rate is overwritten by an older row.
pub fn get_latest_rates(conn: &Connection) -> ApiResult<Rates> {
    let mut stmt = conn.prepare(
        "select \"id\", \"from_currency\", \"rate_to_base\", \"source\", \"fetched_at\" from \"exchange_rates\" order by \"exchange_rates\".\"fetched_at\" desc",
    )?;
    let rows = stmt
        .query_map([], |r| Ok((col_str(r, 1)?, col_f64(r, 2)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut latest = Rates::new();
    for (cur, rate) in rows {
        let Some(cur) = cur.filter(|c| !c.is_empty()) else {
            continue;
        };
        let falsy = latest.get(&cur).is_none_or(|v| *v == 0.0 || v.is_nan());
        if falsy {
            latest.insert(cur, rate.unwrap_or(1.0));
        }
    }
    Ok(latest)
}

/// `toInr(amount, currency, rates)`: `amount * (rates[currency] ?? 1.0)`.
pub fn to_inr(amount: f64, currency: &str, rates: &Rates) -> f64 {
    amount * rates.get(currency).copied().unwrap_or(1.0)
}

/// `Math.round(n * 100) / 100`.
pub(crate) fn round2(n: f64) -> f64 {
    compat::js_round(n * 100.0) / 100.0
}

// ─── Column readers ──────────────────────────────────────────────────────────

/// A column as text, the way JS would print it (`null` stays `None`).
pub(crate) fn col_str(r: &Row, i: usize) -> rusqlite::Result<Option<String>> {
    Ok(match r.get_ref(i)? {
        ValueRef::Null => None,
        ValueRef::Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Integer(n) => Some(n.to_string()),
        ValueRef::Real(f) => Some(js_num(f)),
        ValueRef::Blob(b) => Some(String::from_utf8_lossy(b).into_owned()),
    })
}

/// A NOT NULL text column.
pub(crate) fn col_string(r: &Row, i: usize) -> rusqlite::Result<String> {
    Ok(col_str(r, i)?.unwrap_or_default())
}

/// A column as a JS number (`null` stays `None`).
pub(crate) fn col_f64(r: &Row, i: usize) -> rusqlite::Result<Option<f64>> {
    Ok(match r.get_ref(i)? {
        ValueRef::Null => None,
        ValueRef::Integer(n) => Some(n as f64),
        ValueRef::Real(f) => Some(f),
        ValueRef::Text(t) => Some(crate::json::string_to_number(&String::from_utf8_lossy(t))),
        ValueRef::Blob(_) => Some(f64::NAN),
    })
}

/// A drizzle `mode: "boolean"` column: `Number(value) === 1`.
pub(crate) fn col_bool(r: &Row, i: usize) -> rusqlite::Result<Option<bool>> {
    Ok(col_f64(r, i)?.map(|f| f == 1.0))
}

/// A column as better-sqlite3 hands it to `JSON.stringify`.
pub(crate) fn col_json(r: &Row, i: usize) -> rusqlite::Result<Value> {
    Ok(crate::json::from_sql(r.get_ref(i)?))
}

/// `?, ?, ?` for an `in (...)` list of `n` values.
pub(crate) fn placeholders(n: usize) -> String {
    vec!["?"; n].join(", ")
}

/// A JSON value bound the way drizzle + better-sqlite3 bind it (booleans as
/// 1/0, numbers as doubles).
pub(crate) fn sql_value(v: &Value) -> SqlValue {
    match v {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(i64::from(*b)),
        Value::Number(n) => n.as_f64().map_or(SqlValue::Null, SqlValue::Real),
        Value::String(s) => SqlValue::Text(s.clone()),
        other => SqlValue::Text(other.to_string()),
    }
}

/// `err.message` as Node would see it for an error thrown inside a service
/// (SQLite errors carry SQLite's own message).
pub(crate) fn node_message(err: &ApiError) -> String {
    match err {
        ApiError::Service { message, .. } | ApiError::Status { message, .. } => message.clone(),
        ApiError::Internal(m) => m
            .strip_prefix("database error: ")
            .unwrap_or(m.as_str())
            .to_string(),
        other => other.to_string(),
    }
}

/// `isUniqueViolation(err)`.
pub(crate) fn is_unique_violation(err: &ApiError) -> bool {
    node_message(err)
        .to_lowercase()
        .contains("unique constraint failed")
}

// ─── Exchange-rate route helper (kept from Wave 0) ──────────────────────────

/// `scaleBudgetEnvelopes(conversionRate, newBase)`: multiplies every
/// envelope's `budgeted` and `rollover_amount` and sets `budget_currency`.
/// `conversion_rate` is the raw JS value Node binds (normally a number).
pub fn scale_budget_envelopes(
    conn: &Connection,
    conversion_rate: &Value,
    new_base: &str,
) -> ApiResult<()> {
    let rate = match conversion_rate {
        Value::Number(n) => n.as_f64().map_or(SqlValue::Null, SqlValue::Real),
        Value::String(s) => SqlValue::Text(s.clone()),
        Value::Bool(b) => SqlValue::Integer(i64::from(*b)),
        _ => SqlValue::Null,
    };
    conn.execute(
        "UPDATE envelopes SET budgeted = envelopes.budgeted * ?1, rollover_amount = envelopes.rollover_amount * ?1, budget_currency = ?2",
        rusqlite::params![rate, new_base],
    )?;
    Ok(())
}

#[cfg(test)]
pub(crate) mod test_support {
    use rusqlite::Connection;

    /// A fresh in-memory database with Node's schema.
    pub fn db() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        conn.pragma_update(None, "foreign_keys", "ON").expect("fk");
        crate::db::bootstrap::bootstrap_schema(&conn).expect("schema");
        conn
    }

    pub fn exec(conn: &Connection, sql: &str) {
        conn.execute_batch(sql).expect("sql");
    }
}
