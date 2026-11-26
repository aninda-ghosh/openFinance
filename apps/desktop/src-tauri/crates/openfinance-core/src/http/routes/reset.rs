//! Port of `apps/server/src/routes/reset.ts`, mounted at `/api/reset`.
//! Owner: Wave 1 (data).
//!
//! Two endpoints: `POST /` wipes every user table (including
//! `exchange_rates`, despite the Node comment; see QUIRKS.md) and
//! `POST /transactions` deletes transactions and budget alerts and zeroes the
//! envelopes' `budgeted` and `spent`.

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use rusqlite::Connection;
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

/// Tables in the FK-safe order both `reset.ts` and the backup import delete them.
pub const WIPE_ORDER: [&str; 17] = [
    "ai_tool_calls",
    "ai_messages",
    "ai_conversations",
    "budget_alerts",
    "recurring_transactions",
    "transactions",
    "envelopes",
    "envelope_groups",
    "price_history",
    "investment_value_history",
    "investment_documents",
    "life_insurance",
    "policy_payouts",
    "policies",
    "investments",
    "accounts",
    "exchange_rates",
];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", post(reset_all))
        .route("/transactions", post(reset_transactions))
}

/// `await tx.delete(table)` for every table in [`WIPE_ORDER`].
pub fn wipe_all(conn: &Connection) -> rusqlite::Result<()> {
    for table in WIPE_ORDER {
        conn.execute(&format!("delete from \"{table}\""), [])?;
    }
    Ok(())
}

fn failed(message: &'static str) -> impl FnOnce(ApiError) -> ApiError {
    move |err| {
        tracing::error!("{message}: {err}");
        ApiError::status(StatusCode::INTERNAL_SERVER_ERROR, message)
    }
}

/// POST /api/reset — delete all user data in one transaction.
async fn reset_all(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    state
        .transaction(|conn| Ok(wipe_all(conn)?))
        .await
        .map_err(failed("Reset failed"))?;
    Ok(Json(json!({ "success": true })))
}

/// POST /api/reset/transactions — delete transactions and alerts, zero the envelopes.
async fn reset_transactions(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    state
        .transaction(|conn| {
            conn.execute("delete from \"budget_alerts\"", [])?;
            conn.execute("delete from \"transactions\"", [])?;
            // drizzle binds the JS number 0 as a double.
            conn.execute(
                "update \"envelopes\" set \"budgeted\" = ?, \"spent\" = ?",
                rusqlite::params![0.0f64, 0.0f64],
            )?;
            Ok(())
        })
        .await
        .map_err(failed("Transaction reset failed"))?;
    Ok(Json(json!({ "success": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wipe_order_satisfies_foreign_keys() {
        let c = Connection::open_in_memory().expect("open");
        c.execute_batch("PRAGMA foreign_keys = ON").expect("fk");
        crate::db::bootstrap::bootstrap_schema(&c).expect("bootstrap");
        c.execute_batch(
            "INSERT INTO accounts (id, name, type) VALUES ('a', 'A', 'checking');
             INSERT INTO envelope_groups (id, name) VALUES ('g', 'G');
             INSERT INTO envelopes (id, group_id, name, month) VALUES ('e', 'g', 'E', '2026-01');
             INSERT INTO transactions (id, account_id, envelope_id, payee, amount, type, date)
               VALUES ('t', 'a', 'e', 'P', 1, 'expense', '2026-01-01');
             INSERT INTO investments (id, name, asset_type, purchase_value, purchase_date, current_value, account_id)
               VALUES ('i', 'I', 'stock', 1, '2026-01-01', 1, 'a');
             INSERT INTO investment_documents (id, investment_id, name, file_name, file_size, mime_type)
               VALUES ('d', 'i', 'D', 'f', 1, 'x');",
        )
        .expect("seed");
        wipe_all(&c).expect("wipe");
        let n: i64 = c
            .query_row("SELECT count(*) FROM accounts", [], |r| r.get(0))
            .expect("count");
        assert_eq!(n, 0);
    }
}
