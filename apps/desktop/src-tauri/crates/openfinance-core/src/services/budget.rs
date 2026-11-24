//! Port of `apps/server/src/services/budget.service.ts`.
//! Owner: Wave 1 (budget). TODO(wave 1): port the rest of this service.
//!
//! Wave 0 ported only `scaleBudgetEnvelopes`, because the exchange-rates route
//! (Wave 0) calls it. Wave 1 owns this file and may reorganise it freely as
//! long as the signature below keeps working (or the caller is updated).

use rusqlite::types::Value as SqlValue;
use rusqlite::Connection;
use serde_json::Value;

use crate::error::ApiResult;

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
