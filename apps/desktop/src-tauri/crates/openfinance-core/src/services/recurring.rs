//! Port of `apps/server/src/services/recurring.service.ts` (Wave 1, budget).

use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, Connection, OptionalExtension, Row};
use serde_json::{json, Map, Value};

use crate::db::run_transaction;
use crate::error::{ApiError, ApiResult};
use crate::ids::nanoid;
use crate::js::now_iso;
use crate::services::budget::compat::{add_days_iso, add_months_iso, day_of_month, local_iso_date};
use crate::services::budget::{
    assert_envelope_required, col_bool, col_f64, col_json, col_str, col_string, envelope_for_date,
    insert_transaction, sql_value, NewTransaction,
};
use crate::state::AppState;

/// Safety valve for the catch-up loop.
const MAX_CATCHUP_PERIODS: u32 = 500;

const RECURRING_COLS: &str = "\"id\", \"payee\", \"amount\", \"type\", \"account_id\", \"envelope_id\", \"frequency\", \"next_date\", \"anchor_day\", \"end_date\", \"notes\", \"is_active\", \"created_at\"";

/// A `recurring_transactions` row as drizzle returns it (`is_active` boolean).
fn row_json(r: &Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": col_json(r, 0)?,
        "payee": col_json(r, 1)?,
        "amount": col_json(r, 2)?,
        "type": col_json(r, 3)?,
        "account_id": col_json(r, 4)?,
        "envelope_id": col_json(r, 5)?,
        "frequency": col_json(r, 6)?,
        "next_date": col_json(r, 7)?,
        "anchor_day": col_json(r, 8)?,
        "end_date": col_json(r, 9)?,
        "notes": col_json(r, 10)?,
        "is_active": col_bool(r, 11)?,
        "created_at": col_json(r, 12)?,
    }))
}

/// `advanceDate(dateStr, frequency, anchorDay)`: the next occurrence, or the
/// same date for an unknown frequency.
pub fn advance_date(date: &str, frequency: &str, anchor_day: Option<f64>) -> String {
    match frequency {
        "weekly" => add_days_iso(date, 7.0),
        "monthly" => add_months_iso(date, 1.0, anchor_day),
        "quarterly" => add_months_iso(date, 3.0, anchor_day),
        "annual" => add_months_iso(date, 12.0, anchor_day),
        _ => date.to_string(),
    }
}

struct Rule {
    id: String,
    payee: String,
    amount: f64,
    txn_type: String,
    account_id: String,
    envelope_id: Option<String>,
    frequency: String,
    next_date: String,
    anchor_day: Option<f64>,
    end_date: Option<String>,
    notes: Option<String>,
}

fn non_empty(s: &Option<String>) -> Option<&str> {
    s.as_deref().filter(|s| !s.is_empty())
}

/// `applyDueRecurring()`: emits every occurrence due up to today. Startup job
/// (`jobs.rs`) and `POST /api/budget/recurring/apply-due`.
pub async fn apply_due_recurring(state: &AppState) -> ApiResult<u64> {
    let today = local_iso_date();
    state
        .db(move |conn| apply_due_recurring_on(conn, &today))
        .await
}

/// `applyDueRecurring()` with "today" given.
pub fn apply_due_recurring_on(conn: &Connection, today: &str) -> ApiResult<u64> {
    let mut stmt = conn.prepare(&format!(
        "select {RECURRING_COLS} from \"recurring_transactions\" where (\"recurring_transactions\".\"is_active\" = ? and \"recurring_transactions\".\"next_date\" <= ?)"
    ))?;
    let due = stmt
        .query_map(rusqlite::params![1, today], |r| {
            Ok(Rule {
                id: col_string(r, 0)?,
                payee: col_string(r, 1)?,
                amount: col_f64(r, 2)?.unwrap_or(0.0),
                txn_type: col_string(r, 3)?,
                account_id: col_string(r, 4)?,
                envelope_id: col_str(r, 5)?,
                frequency: col_string(r, 6)?,
                next_date: col_string(r, 7)?,
                anchor_day: col_f64(r, 8)?,
                end_date: col_str(r, 9)?,
                notes: col_str(r, 10)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);

    let mut count: u64 = 0;
    for r in due {
        let end = non_empty(&r.end_date).map(str::to_string);
        if end.as_deref().is_some_and(|e| r.next_date.as_str() > e) {
            conn.execute(
                "update \"recurring_transactions\" set \"is_active\" = ? where \"recurring_transactions\".\"id\" = ?",
                rusqlite::params![0, r.id],
            )?;
            continue;
        }
        count += run_transaction(conn, |conn| {
            let mut next = r.next_date.clone();
            let anchor = r.anchor_day.or_else(|| Some(day_of_month(&r.next_date)));
            let mut generated: u64 = 0;
            while next.as_str() <= today && generated < u64::from(MAX_CATCHUP_PERIODS) {
                if end.as_deref().is_some_and(|e| next.as_str() > e) {
                    break;
                }
                let mut envelope_id = None;
                if let Some(env) = non_empty(&r.envelope_id) {
                    envelope_id = envelope_for_date(conn, Some(env), &next)?;
                    if envelope_id.is_none() {
                        tracing::warn!(
                            "[recurring] rule {} (\"{}\"): its category no longer exists — recording the transaction uncategorised",
                            r.id,
                            r.payee
                        );
                    }
                }
                insert_transaction(
                    conn,
                    &NewTransaction {
                        id: Some(nanoid()),
                        account_id: r.account_id.clone(),
                        envelope_id,
                        payee: r.payee.clone(),
                        amount: r.amount,
                        txn_type: r.txn_type.clone(),
                        date: Some(next.clone()),
                        notes: Some(match non_empty(&r.notes) {
                            Some(n) => format!("[Auto] {n}"),
                            None => "[Auto] Recurring".into(),
                        }),
                        ..Default::default()
                    },
                )?;
                generated += 1;
                let advanced = advance_date(&next, &r.frequency, anchor);
                if advanced <= next {
                    tracing::error!(
                        "[recurring] rule {}: unknown frequency \"{}\", deactivating",
                        r.id,
                        r.frequency
                    );
                    conn.execute(
                        "update \"recurring_transactions\" set \"is_active\" = ? where \"recurring_transactions\".\"id\" = ?",
                        rusqlite::params![0, r.id],
                    )?;
                    return Ok(generated);
                }
                next = advanced;
            }
            let expired = end.as_deref().is_some_and(|e| next.as_str() > e);
            conn.execute(
                "update \"recurring_transactions\" set \"next_date\" = ?, \"is_active\" = ? where \"recurring_transactions\".\"id\" = ?",
                rusqlite::params![next, i64::from(!expired), r.id],
            )?;
            Ok::<_, ApiError>(generated)
        })?;
    }
    Ok(count)
}

/// `listRecurring()`.
pub fn list_recurring(conn: &Connection) -> ApiResult<Vec<Value>> {
    let mut stmt = conn.prepare(&format!(
        "select {RECURRING_COLS} from \"recurring_transactions\" order by \"recurring_transactions\".\"next_date\""
    ))?;
    let rows = stmt
        .query_map([], row_json)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// `assertRecurringEnvelope(accountId, type, envelopeId)`.
fn assert_recurring_envelope(
    conn: &Connection,
    account_id: Option<&str>,
    txn_type: Option<&str>,
    envelope_id: Option<&str>,
) -> ApiResult<()> {
    let Some(account_id) = account_id.filter(|a| !a.is_empty()) else {
        return Ok(());
    };
    if txn_type != Some("expense") || envelope_id.is_some_and(|e| !e.is_empty()) {
        return Ok(());
    }
    assert_envelope_required(conn, account_id, txn_type, envelope_id)
}

fn str_of<'a>(data: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    data.get(key).and_then(Value::as_str)
}

/// `createRecurring(data)`; `data` is `CreateRecurringSchema`'s output.
pub fn create_recurring(conn: &Connection, data: &Map<String, Value>) -> ApiResult<Value> {
    assert_recurring_envelope(
        conn,
        str_of(data, "account_id"),
        str_of(data, "type"),
        str_of(data, "envelope_id"),
    )?;
    let next_date = str_of(data, "next_date").unwrap_or_default();
    let get = |k: &str| data.get(k).map_or(SqlValue::Null, sql_value);
    Ok(conn.query_row(
        &format!(
            "insert into \"recurring_transactions\" ({RECURRING_COLS}) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning {RECURRING_COLS}"
        ),
        params_from_iter([
            SqlValue::Text(nanoid()),
            get("payee"),
            get("amount"),
            get("type"),
            get("account_id"),
            get("envelope_id"),
            get("frequency"),
            get("next_date"),
            SqlValue::Real(day_of_month(next_date)),
            get("end_date"),
            get("notes"),
            SqlValue::Integer(1),
            SqlValue::Text(now_iso()),
        ]),
        row_json,
    )?)
}

/// The columns `UpdateRecurringSchema` can set, in drizzle's column order.
const RECURRING_UPDATABLE: [&str; 10] = [
    "payee",
    "amount",
    "type",
    "account_id",
    "envelope_id",
    "frequency",
    "next_date",
    "end_date",
    "notes",
    "is_active",
];

/// `updateRecurring(id, data)`; `data` is `UpdateRecurringSchema`'s output.
pub fn update_recurring(
    conn: &Connection,
    id: &str,
    data: &Map<String, Value>,
) -> ApiResult<Value> {
    let existing = conn
        .query_row(
            "select \"account_id\", \"type\", \"envelope_id\" from \"recurring_transactions\" where \"recurring_transactions\".\"id\" = ? limit ?",
            rusqlite::params![id, 1],
            |r| Ok((col_str(r, 0)?, col_str(r, 1)?, col_str(r, 2)?)),
        )
        .optional()?
        .ok_or_else(|| ApiError::service(404, "Recurring transaction not found"))?;

    let account_id = str_of(data, "account_id")
        .map(str::to_string)
        .or(existing.0);
    let txn_type = str_of(data, "type").map(str::to_string).or(existing.1);
    let envelope_id = match data.get("envelope_id") {
        Some(v) => v.as_str().map(str::to_string),
        None => existing.2,
    };
    assert_recurring_envelope(
        conn,
        account_id.as_deref(),
        txn_type.as_deref(),
        envelope_id.as_deref(),
    )?;

    let mut set: Vec<String> = Vec::new();
    let mut params: Vec<SqlValue> = Vec::new();
    for key in RECURRING_UPDATABLE {
        if let Some(v) = data.get(key) {
            set.push(format!("\"{key}\" = ?"));
            params.push(sql_value(v));
        }
        if key == "next_date" {
            // `...(data.next_date ? { anchor_day: dayOfMonth(data.next_date) } : {})`
            if let Some(nd) = str_of(data, "next_date").filter(|s| !s.is_empty()) {
                set.push("\"anchor_day\" = ?".into());
                params.push(SqlValue::Real(day_of_month(nd)));
            }
        }
    }
    if set.is_empty() {
        return Err(ApiError::plain("No values to set"));
    }
    params.push(SqlValue::Text(id.to_string()));
    conn.query_row(
        &format!(
            "update \"recurring_transactions\" set {} where \"recurring_transactions\".\"id\" = ? returning {RECURRING_COLS}",
            set.join(", ")
        ),
        params_from_iter(params),
        row_json,
    )
    .optional()?
    .ok_or_else(|| ApiError::service(404, "Recurring transaction not found"))
}

/// `deleteRecurring(id)`.
pub fn delete_recurring(conn: &Connection, id: &str) -> ApiResult<()> {
    let n = conn.execute(
        "delete from \"recurring_transactions\" where \"recurring_transactions\".\"id\" = ?",
        [id],
    )?;
    if n == 0 {
        return Err(ApiError::service(404, "Recurring transaction not found"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::budget::test_support::{db, exec};

    #[test]
    fn keeps_a_rule_on_the_first_on_the_first() {
        let mut d = "2026-03-01".to_string();
        let mut seen = vec![d.clone()];
        for _ in 0..3 {
            d = advance_date(&d, "monthly", Some(1.0));
            seen.push(d.clone());
        }
        assert_eq!(
            seen,
            ["2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01"]
        );
    }

    #[test]
    fn does_not_skip_february_for_the_31st() {
        let mut d = "2026-01-31".to_string();
        let mut seen = vec![d.clone()];
        for _ in 0..3 {
            d = advance_date(&d, "monthly", Some(31.0));
            seen.push(d.clone());
        }
        assert_eq!(
            seen,
            ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]
        );
    }

    #[test]
    fn steps_weekly_quarterly_and_annually() {
        assert_eq!(advance_date("2026-09-28", "weekly", None), "2026-10-05");
        assert_eq!(
            advance_date("2026-11-30", "quarterly", Some(30.0)),
            "2027-02-28"
        );
        assert_eq!(
            advance_date("2028-02-29", "annual", Some(29.0)),
            "2029-02-28"
        );
        assert_eq!(advance_date("2028-02-29", "daily", None), "2028-02-29");
    }

    fn rule_dates(conn: &Connection) -> Vec<String> {
        let mut s = conn
            .prepare("select date from transactions order by date")
            .expect("prepare");
        s.query_map([], |r| r.get(0))
            .expect("query")
            .collect::<Result<_, _>>()
            .expect("rows")
    }

    #[test]
    fn catches_up_every_missed_period() {
        let conn = db();
        exec(
            &conn,
            "insert into accounts (id, name, type) values ('acc-1', 'A', 'checking');
             insert into recurring_transactions (id, account_id, envelope_id, payee, amount, type, frequency, next_date, end_date, notes, is_active)
               values ('rec-1', 'acc-1', null, 'Rent', 1000, 'expense', 'monthly', '2026-05-15', null, null, 1);",
        );
        let applied = apply_due_recurring_on(&conn, "2026-08-19").expect("apply");
        assert_eq!(applied, 4);
        assert_eq!(
            rule_dates(&conn),
            ["2026-05-15", "2026-06-15", "2026-07-15", "2026-08-15"]
        );
        let (next, active): (String, bool) = conn
            .query_row(
                "select next_date, is_active from recurring_transactions where id = 'rec-1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("rule");
        assert_eq!((next.as_str(), active), ("2026-09-15", true));
        assert_eq!(
            apply_due_recurring_on(&conn, "2026-08-19").expect("again"),
            0
        );
    }

    #[test]
    fn end_dates_and_unknown_frequencies_deactivate() {
        let conn = db();
        exec(
            &conn,
            "insert into accounts (id, name, type) values ('a', 'A', 'checking');
             insert into recurring_transactions (id, account_id, payee, amount, type, frequency, next_date, end_date, notes, is_active) values
               ('ended', 'a', 'Old', 5, 'income', 'weekly', '2026-05-10', '2026-05-01', null, 1),
               ('bounded', 'a', 'Gym', 5, 'expense', 'weekly', '2026-05-01', '2026-05-10', 'Note', 1),
               ('odd', 'a', 'Odd', 5, 'income', 'daily', '2026-05-01', null, null, 1);",
        );
        let applied = apply_due_recurring_on(&conn, "2026-06-01").expect("apply");
        // bounded: May 1 and May 8; odd: one, then deactivated
        assert_eq!(applied, 3);
        let mut s = conn
            .prepare("select id, next_date, is_active from recurring_transactions order by id")
            .expect("p");
        let rules: Vec<(String, String, i64)> = s
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .expect("q")
            .collect::<Result<_, _>>()
            .expect("r");
        assert_eq!(
            rules,
            [
                ("bounded".to_string(), "2026-05-15".to_string(), 0),
                ("ended".to_string(), "2026-05-10".to_string(), 0),
                ("odd".to_string(), "2026-05-01".to_string(), 0),
            ]
        );
        let notes: String = conn
            .query_row(
                "select notes from transactions where payee = 'Gym' limit 1",
                [],
                |r| r.get(0),
            )
            .expect("notes");
        assert_eq!(notes, "[Auto] Note");
    }
}
