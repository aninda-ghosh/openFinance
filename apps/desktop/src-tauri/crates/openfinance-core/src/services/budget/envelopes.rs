//! Envelopes and envelope groups: month seeding, derived spend, per-month
//! identity, filing, CRUD, reclaim, copy / clear (budget.service.ts).

use std::collections::HashMap;

use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::compat::{js_round, month_end, previous_month};
use super::{
    col_f64, col_json, col_str, col_string, get_latest_rates, is_transfer_in, placeholders,
    sql_value, to_inr, Rates,
};
use crate::db::run_transaction;
use crate::error::{ApiError, ApiResult};
use crate::ids::nanoid;
use crate::js::now_iso;

const ENVELOPE_COLS: &str = "\"id\", \"group_id\", \"name\", \"budgeted\", \"budget_currency\", \"spent\", \"month\", \"rollover_type\", \"rollover_amount\", \"created_at\"";

/// A row of `envelopes`.
#[derive(Debug, Clone)]
pub(crate) struct EnvelopeRow {
    pub id: String,
    pub group_id: String,
    pub name: String,
    pub budgeted: Option<f64>,
    pub budget_currency: Option<String>,
    pub month: String,
    pub rollover_type: Option<String>,
    pub rollover_amount: Option<f64>,
    pub created_at: Option<String>,
}

fn read_envelope(r: &Row) -> rusqlite::Result<EnvelopeRow> {
    Ok(EnvelopeRow {
        id: col_string(r, 0)?,
        group_id: col_string(r, 1)?,
        name: col_string(r, 2)?,
        budgeted: col_f64(r, 3)?,
        budget_currency: col_str(r, 4)?,
        month: col_string(r, 6)?,
        rollover_type: col_str(r, 7)?,
        rollover_amount: col_f64(r, 8)?,
        created_at: col_str(r, 9)?,
    })
}

fn envelopes_where(conn: &Connection, where_sql: &str, param: &str) -> ApiResult<Vec<EnvelopeRow>> {
    let mut stmt = conn.prepare(&format!(
        "select {ENVELOPE_COLS} from \"envelopes\" where {where_sql}"
    ))?;
    let rows = stmt
        .query_map([param], read_envelope)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// `seedMonthFromTemplate(db, month)`: copies the most recent month's
/// envelopes into an empty `month`.
pub(crate) fn seed_month_from_template(conn: &Connection, month: &str) -> ApiResult<()> {
    run_transaction(conn, |conn| {
        let mut stmt = conn.prepare(
            "select \"id\" from \"envelopes\" where \"envelopes\".\"month\" = ? limit ?",
        )?;
        if stmt.exists(rusqlite::params![month, 1])? {
            return Ok(());
        }
        let template: Option<String> = conn
            .query_row(
                "select \"month\" from \"envelopes\" order by \"envelopes\".\"month\" desc limit ?",
                [1],
                |r| col_string(r, 0),
            )
            .optional()?;
        let Some(src) = template else {
            return Ok(());
        };
        let mut stmt = conn.prepare(
            "select \"group_id\", \"name\", \"budgeted\", \"budget_currency\" from \"envelopes\" where \"envelopes\".\"month\" = ?",
        )?;
        let src_rows = stmt
            .query_map([&src], |r| {
                Ok((
                    col_string(r, 0)?,
                    col_string(r, 1)?,
                    col_f64(r, 2)?,
                    col_str(r, 3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        if src_rows.is_empty() {
            return Ok(());
        }
        // One multi-row insert, like drizzle's `values([...])`.
        let tuple = format!("({})", placeholders(10));
        let sql = format!(
            "insert into \"envelopes\" ({ENVELOPE_COLS}) values {}",
            vec![tuple; src_rows.len()].join(", ")
        );
        let mut params: Vec<SqlValue> = Vec::with_capacity(src_rows.len() * 10);
        for (group_id, name, budgeted, currency) in src_rows {
            params.extend([
                SqlValue::Text(nanoid()),
                SqlValue::Text(group_id),
                SqlValue::Text(name),
                SqlValue::Real(budgeted.unwrap_or(0.0)),
                SqlValue::Text(currency.unwrap_or_else(|| "INR".into())),
                SqlValue::Real(0.0),
                SqlValue::Text(month.to_string()),
                SqlValue::Text("none".into()),
                SqlValue::Real(0.0),
                SqlValue::Text(now_iso()),
            ]);
        }
        conn.execute(&sql, params_from_iter(params))?;
        Ok(())
    })
}

/// `computeSpentByEnvelope(month, rates, envelopeIds?)`: net spend per
/// envelope of `month`, in base currency. Every id passed (or found) is a key.
pub fn compute_spent_by_envelope(
    conn: &Connection,
    month: &str,
    rates: &Rates,
    envelope_ids: Option<&[String]>,
) -> ApiResult<HashMap<String, f64>> {
    let ids: Vec<String> = match envelope_ids {
        Some(ids) => ids.to_vec(),
        None => {
            let mut stmt =
                conn.prepare("select \"id\" from \"envelopes\" where \"envelopes\".\"month\" = ?")?;
            let ids = stmt
                .query_map([month], |r| col_string(r, 0))?
                .collect::<Result<Vec<_>, _>>()?;
            ids
        }
    };
    let mut spent: HashMap<String, f64> = ids.iter().map(|id| (id.clone(), 0.0)).collect();
    if ids.is_empty() {
        return Ok(spent);
    }
    let date_from = format!("{month}-01");
    let date_to = month_end(month);
    let sql = format!(
        "select \"transactions\".\"envelope_id\", \"transactions\".\"amount\", \"accounts\".\"currency\", \"transactions\".\"type\", \"transactions\".\"payee\" from \"transactions\" left join \"accounts\" on \"transactions\".\"account_id\" = \"accounts\".\"id\" where ((\"transactions\".\"type\" = ? or \"transactions\".\"type\" = ?) and \"transactions\".\"date\" >= ? and \"transactions\".\"date\" <= ? and \"transactions\".\"envelope_id\" in ({}))",
        placeholders(ids.len())
    );
    let mut params: Vec<SqlValue> = vec![
        SqlValue::Text("expense".into()),
        SqlValue::Text("transfer".into()),
        SqlValue::Text(date_from),
        SqlValue::Text(date_to),
    ];
    params.extend(ids.iter().map(|i| SqlValue::Text(i.clone())));
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params_from_iter(params), |r| {
            Ok((
                col_str(r, 0)?,
                col_f64(r, 1)?.unwrap_or(0.0),
                col_str(r, 2)?,
                col_string(r, 3)?,
                col_string(r, 4)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (envelope_id, amount, currency, t, payee) in rows {
        let Some(envelope_id) = envelope_id.filter(|e| !e.is_empty()) else {
            continue;
        };
        let base = to_inr(amount, currency.as_deref().unwrap_or("INR"), rates);
        let delta = if is_transfer_in(&t, &payee) {
            -base
        } else {
            base
        };
        let entry = spent.entry(envelope_id).or_insert(0.0);
        *entry += delta;
    }
    Ok(spent)
}

/// `resolveEnvelopeForMonth(q, envelopeId, month)`: the same `group_id|name`
/// envelope in `month`, or `None`.
pub fn resolve_envelope_for_month(
    conn: &Connection,
    envelope_id: &str,
    month: &str,
) -> ApiResult<Option<String>> {
    let src = conn
        .query_row(
            "select \"id\", \"group_id\", \"name\", \"month\" from \"envelopes\" where \"envelopes\".\"id\" = ? limit ?",
            rusqlite::params![envelope_id, 1],
            |r| {
                Ok((
                    col_string(r, 0)?,
                    col_string(r, 1)?,
                    col_string(r, 2)?,
                    col_string(r, 3)?,
                ))
            },
        )
        .optional()?;
    let Some((id, group_id, name, src_month)) = src else {
        return Ok(None);
    };
    if src_month == month {
        return Ok(Some(id));
    }
    Ok(conn
        .query_row(
            "select \"id\" from \"envelopes\" where (\"envelopes\".\"group_id\" = ? and \"envelopes\".\"name\" = ? and \"envelopes\".\"month\" = ?) limit ?",
            rusqlite::params![group_id, name, month, 1],
            |r| col_string(r, 0),
        )
        .optional()?)
}

/// `envelopeForDate(q, envelopeId, date)`: the envelope of the picked
/// category in the transaction's own month, rolling the budget forward or
/// creating the category there when needed. `None` for no / a missing id.
pub fn envelope_for_date(
    conn: &Connection,
    envelope_id: Option<&str>,
    date: &str,
) -> ApiResult<Option<String>> {
    let Some(envelope_id) = envelope_id.filter(|e| !e.is_empty()) else {
        return Ok(None);
    };
    let month: String = {
        let units: Vec<u16> = date.encode_utf16().take(7).collect();
        String::from_utf16_lossy(&units)
    };
    if let Some(direct) = resolve_envelope_for_month(conn, envelope_id, &month)? {
        return Ok(Some(direct));
    }
    let src = conn
        .query_row(
            &format!(
                "select {ENVELOPE_COLS} from \"envelopes\" where \"envelopes\".\"id\" = ? limit ?"
            ),
            rusqlite::params![envelope_id, 1],
            read_envelope,
        )
        .optional()?;
    let Some(src) = src else {
        return Ok(None);
    };
    let mut stmt =
        conn.prepare("select \"id\" from \"envelopes\" where \"envelopes\".\"month\" = ? limit ?")?;
    let any_in_month = stmt.exists(rusqlite::params![month, 1])?;
    if !any_in_month {
        let latest: Option<String> = conn
            .query_row(
                "select \"month\" from \"envelopes\" order by \"envelopes\".\"month\" desc limit ?",
                [1],
                |r| col_string(r, 0),
            )
            .optional()?;
        if latest.is_some_and(|l| month > l) {
            seed_month_from_template(conn, &month)?;
            if let Some(seeded) = resolve_envelope_for_month(conn, envelope_id, &month)? {
                return Ok(Some(seeded));
            }
        }
    }
    let created = conn.query_row(
        &format!(
            "insert into \"envelopes\" ({ENVELOPE_COLS}) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning \"id\""
        ),
        rusqlite::params![
            nanoid(),
            src.group_id,
            src.name,
            0.0,
            src.budget_currency.unwrap_or_else(|| "INR".into()),
            0.0,
            month,
            "none",
            0.0,
            now_iso(),
        ],
        |r| col_string(r, 0),
    )?;
    Ok(Some(created))
}

/// One row of `findMisfiledTransactions()`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MisfiledTransaction {
    pub id: Value,
    pub date: Value,
    pub payee: Value,
    pub amount: Value,
    #[serde(rename = "type")]
    pub txn_type: Value,
    pub envelope_name: Value,
    pub envelope_month: Value,
}

/// `findMisfiledTransactions()`: rows whose envelope is another month's.
pub fn find_misfiled_transactions(conn: &Connection) -> ApiResult<Vec<MisfiledTransaction>> {
    let mut stmt = conn.prepare(
        "select \"transactions\".\"id\", \"transactions\".\"date\", \"transactions\".\"payee\", \"transactions\".\"amount\", \"transactions\".\"type\", \"envelopes\".\"name\", \"envelopes\".\"month\" from \"transactions\" inner join \"envelopes\" on \"transactions\".\"envelope_id\" = \"envelopes\".\"id\" where substr(\"transactions\".\"date\", 1, 7) <> \"envelopes\".\"month\" order by \"transactions\".\"date\" desc",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(MisfiledTransaction {
                id: col_json(r, 0)?,
                date: col_json(r, 1)?,
                payee: col_json(r, 2)?,
                amount: col_json(r, 3)?,
                txn_type: col_json(r, 4)?,
                envelope_name: col_json(r, 5)?,
                envelope_month: col_json(r, 6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// `repairMisfiledTransactions()`.
pub fn repair_misfiled_transactions(conn: &Connection) -> ApiResult<Value> {
    let misfiled = find_misfiled_transactions(conn)?;
    if misfiled.is_empty() {
        return Ok(json!({ "moved": 0 }));
    }
    let mut moved: u64 = 0;
    run_transaction(conn, |conn| {
        for t in &misfiled {
            let id = t.id.as_str().unwrap_or_default();
            let current: Option<Option<String>> = conn
                .query_row(
                    "select \"envelope_id\" from \"transactions\" where \"transactions\".\"id\" = ?",
                    [id],
                    |r| col_str(r, 0),
                )
                .optional()?;
            let current = current.flatten();
            let date = t.date.as_str().unwrap_or_default();
            let target = envelope_for_date(conn, current.as_deref(), date)?;
            if let Some(target) = target.filter(|tg| Some(tg) != current.as_ref()) {
                conn.execute(
                    "update \"transactions\" set \"envelope_id\" = ? where \"transactions\".\"id\" = ?",
                    rusqlite::params![target, id],
                )?;
                moved += 1;
            }
        }
        Ok::<_, ApiError>(())
    })?;
    Ok(json!({ "moved": moved }))
}

/// `EnvelopeWithGroupResponse`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct EnvelopeWithGroupResponse {
    pub id: String,
    pub group_id: String,
    pub group_name: String,
    pub name: String,
    pub budgeted: f64,
    pub budget_currency: String,
    pub budgeted_inr: f64,
    pub spent: f64,
    pub available: f64,
    pub month: String,
    pub rollover_type: String,
    pub rollover_amount: f64,
    pub created_at: String,
}

fn list_month_rows(conn: &Connection, month: &str) -> ApiResult<Vec<(EnvelopeRow, String)>> {
    let mut stmt = conn.prepare(
        "select \"envelopes\".\"id\", \"envelopes\".\"group_id\", \"envelope_groups\".\"name\", \"envelopes\".\"name\", \"envelopes\".\"budgeted\", \"envelopes\".\"budget_currency\", \"envelopes\".\"month\", \"envelopes\".\"rollover_type\", \"envelopes\".\"rollover_amount\", \"envelopes\".\"created_at\" from \"envelopes\" inner join \"envelope_groups\" on \"envelopes\".\"group_id\" = \"envelope_groups\".\"id\" where \"envelopes\".\"month\" = ? order by \"envelope_groups\".\"sort_order\", \"envelopes\".\"name\"",
    )?;
    let rows = stmt
        .query_map([month], |r| {
            Ok((
                EnvelopeRow {
                    id: col_string(r, 0)?,
                    group_id: col_string(r, 1)?,
                    name: col_string(r, 3)?,
                    budgeted: col_f64(r, 4)?,
                    budget_currency: col_str(r, 5)?,
                    month: col_string(r, 6)?,
                    rollover_type: col_str(r, 7)?,
                    rollover_amount: col_f64(r, 8)?,
                    created_at: col_str(r, 9)?,
                },
                col_string(r, 2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// `listEnvelopes(month)`: seeds an empty month, then adds base-currency
/// budget (with rollover), spend and availability.
pub fn list_envelopes(conn: &Connection, month: &str) -> ApiResult<Vec<EnvelopeWithGroupResponse>> {
    let rates = get_latest_rates(conn)?;
    let mut rows = list_month_rows(conn, month)?;
    if rows.is_empty() {
        seed_month_from_template(conn, month)?;
        rows = list_month_rows(conn, month)?;
    }
    let ids: Vec<String> = rows.iter().map(|(r, _)| r.id.clone()).collect();
    let spent_map = compute_spent_by_envelope(conn, month, &rates, Some(&ids))?;

    let has_rollover = rows.iter().any(|(r, _)| {
        r.rollover_type
            .as_deref()
            .is_some_and(|t| !t.is_empty() && t != "none")
    });
    let mut prev_spent: HashMap<String, f64> = HashMap::new();
    let mut prev_budgeted: HashMap<String, f64> = HashMap::new();
    if has_rollover {
        let prev_month = previous_month(month);
        let mut stmt = conn.prepare(
            "select \"id\", \"group_id\", \"name\", \"budgeted\", \"budget_currency\" from \"envelopes\" where \"envelopes\".\"month\" = ?",
        )?;
        let prev_rows = stmt
            .query_map([&prev_month], |r| {
                Ok((
                    col_string(r, 0)?,
                    col_string(r, 1)?,
                    col_string(r, 2)?,
                    col_f64(r, 3)?,
                    col_str(r, 4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let prev_ids: Vec<String> = prev_rows.iter().map(|p| p.0.clone()).collect();
        let prev_spent_by_id =
            compute_spent_by_envelope(conn, &prev_month, &rates, Some(&prev_ids))?;
        for (id, group_id, name, budgeted, currency) in prev_rows {
            let key = format!("{group_id}|{name}");
            prev_budgeted.insert(
                key.clone(),
                to_inr(
                    budgeted.unwrap_or(0.0),
                    currency.as_deref().unwrap_or("INR"),
                    &rates,
                ),
            );
            prev_spent.insert(key, prev_spent_by_id.get(&id).copied().unwrap_or(0.0));
        }
    }

    Ok(rows
        .into_iter()
        .map(|(r, group_name)| {
            let budget_currency = r.budget_currency.clone().unwrap_or_else(|| "INR".into());
            let mut budgeted_inr = to_inr(r.budgeted.unwrap_or(0.0), &budget_currency, &rates);
            let spent = spent_map.get(&r.id).copied().unwrap_or(0.0);
            let rollover_type = r.rollover_type.clone().unwrap_or_else(|| "none".into());
            if rollover_type != "none" {
                let key = format!("{}|{}", r.group_id, r.name);
                let pb = prev_budgeted.get(&key).copied().unwrap_or(0.0);
                let ps = prev_spent.get(&key).copied().unwrap_or(0.0);
                if rollover_type == "leftover" {
                    let leftover = pb - ps;
                    if leftover > 0.0 {
                        budgeted_inr += leftover;
                    }
                } else if rollover_type == "amount" {
                    budgeted_inr +=
                        to_inr(r.rollover_amount.unwrap_or(0.0), &budget_currency, &rates);
                }
            }
            EnvelopeWithGroupResponse {
                id: r.id,
                group_id: r.group_id,
                group_name,
                name: r.name,
                budgeted: r.budgeted.unwrap_or(0.0),
                budget_currency,
                budgeted_inr,
                spent,
                available: budgeted_inr - spent,
                month: r.month,
                rollover_type,
                rollover_amount: r.rollover_amount.unwrap_or(0.0),
                created_at: r.created_at.unwrap_or_default(),
            }
        })
        .collect())
}

/// The envelope shape `createEnvelope` / `updateEnvelope` return (no group name).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct EnvelopeResponse {
    pub id: String,
    pub group_id: String,
    pub name: String,
    pub budgeted: f64,
    pub budget_currency: String,
    pub budgeted_inr: f64,
    pub spent: f64,
    pub available: f64,
    pub month: String,
    pub rollover_type: String,
    pub rollover_amount: f64,
    pub created_at: String,
}

fn envelope_response(row: EnvelopeRow, rates: &Rates, spent: f64) -> EnvelopeResponse {
    let budget_currency = row.budget_currency.unwrap_or_else(|| "INR".into());
    let budgeted_inr = to_inr(row.budgeted.unwrap_or(0.0), &budget_currency, rates);
    EnvelopeResponse {
        id: row.id,
        group_id: row.group_id,
        name: row.name,
        budgeted: row.budgeted.unwrap_or(0.0),
        budget_currency,
        budgeted_inr,
        spent,
        available: budgeted_inr - spent,
        month: row.month,
        rollover_type: row.rollover_type.unwrap_or_else(|| "none".into()),
        rollover_amount: row.rollover_amount.unwrap_or(0.0),
        created_at: row.created_at.unwrap_or_default(),
    }
}

/// `CreateEnvelopeSchema`'s output.
#[derive(Debug, Clone, Deserialize)]
pub struct CreateEnvelope {
    pub group_id: String,
    pub name: String,
    pub budgeted: f64,
    pub budget_currency: String,
    pub month: String,
    pub rollover_type: String,
    pub rollover_amount: f64,
}

/// `createEnvelope(data)`.
pub fn create_envelope(conn: &Connection, data: &CreateEnvelope) -> ApiResult<EnvelopeResponse> {
    let rates = get_latest_rates(conn)?;
    let row = conn.query_row(
        &format!(
            "insert into \"envelopes\" ({ENVELOPE_COLS}) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning {ENVELOPE_COLS}"
        ),
        rusqlite::params![
            nanoid(),
            data.group_id,
            data.name,
            data.budgeted,
            data.budget_currency,
            0.0,
            data.month,
            data.rollover_type,
            data.rollover_amount,
            now_iso(),
        ],
        read_envelope,
    )?;
    // `spent: 0, available: budgetedInr`
    let mut res = envelope_response(row, &rates, 0.0);
    res.available = res.budgeted_inr;
    Ok(res)
}

/// The columns `UpdateEnvelopeSchema` can set, in drizzle's column order.
const ENVELOPE_UPDATABLE: [&str; 6] = [
    "group_id",
    "name",
    "budgeted",
    "budget_currency",
    "rollover_type",
    "rollover_amount",
];

/// `updateEnvelope(id, data)`.
pub fn update_envelope(
    conn: &Connection,
    id: &str,
    data: &Map<String, Value>,
) -> ApiResult<EnvelopeResponse> {
    let rates = get_latest_rates(conn)?;
    let fields: Vec<(&str, &Value)> = ENVELOPE_UPDATABLE
        .iter()
        .filter_map(|k| data.get(*k).map(|v| (*k, v)))
        .collect();
    if fields.is_empty() {
        // drizzle: `.set({})` throws before running anything.
        return Err(ApiError::plain("No values to set"));
    }
    let set: Vec<String> = fields.iter().map(|(k, _)| format!("\"{k}\" = ?")).collect();
    let mut params: Vec<SqlValue> = fields.iter().map(|(_, v)| sql_value(v)).collect();
    params.push(SqlValue::Text(id.to_string()));
    let row = conn
        .query_row(
            &format!(
                "update \"envelopes\" set {} where \"envelopes\".\"id\" = ? returning {ENVELOPE_COLS}",
                set.join(", ")
            ),
            params_from_iter(params),
            read_envelope,
        )
        .optional()?
        .ok_or_else(|| ApiError::service(404, "Envelope not found"))?;
    let spent = compute_spent_by_envelope(
        conn,
        &row.month,
        &rates,
        Some(std::slice::from_ref(&row.id)),
    )?
    .get(&row.id)
    .copied()
    .unwrap_or(0.0);
    Ok(envelope_response(row, &rates, spent))
}

/// `listEnvelopeGroups()`.
pub fn list_envelope_groups(conn: &Connection) -> ApiResult<Vec<Value>> {
    let mut stmt = conn.prepare(
        "select \"id\", \"name\", \"sort_order\", \"created_at\" from \"envelope_groups\" order by \"envelope_groups\".\"sort_order\"",
    )?;
    let rows = stmt
        .query_map([], group_json)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn group_json(r: &Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": col_json(r, 0)?,
        "name": col_json(r, 1)?,
        "sort_order": col_json(r, 2)?,
        "created_at": col_json(r, 3)?,
    }))
}

/// `createEnvelopeGroup(name)`: appended with `sort_order = count(*)`.
pub fn create_envelope_group(conn: &Connection, name: &str) -> ApiResult<Value> {
    let n: f64 = conn.query_row("select count(*) from \"envelope_groups\"", [], |r| {
        Ok(col_f64(r, 0)?.unwrap_or(0.0))
    })?;
    Ok(conn.query_row(
        "insert into \"envelope_groups\" (\"id\", \"name\", \"sort_order\", \"created_at\") values (?, ?, ?, ?) returning \"id\", \"name\", \"sort_order\", \"created_at\"",
        rusqlite::params![nanoid(), name, n, now_iso()],
        group_json,
    )?)
}

/// `updateEnvelopeGroup(id, name)`.
pub fn update_envelope_group(conn: &Connection, id: &str, name: &str) -> ApiResult<Value> {
    conn.query_row(
        "update \"envelope_groups\" set \"name\" = ? where \"envelope_groups\".\"id\" = ? returning \"id\", \"name\", \"sort_order\", \"created_at\"",
        rusqlite::params![name, id],
        group_json,
    )
    .optional()?
    .ok_or_else(|| ApiError::service(404, "Group not found"))
}

/// `deleteEnvelopeGroup(id)`: uncategorises the group's transactions and
/// deletes its envelopes (not in a transaction, like Node).
pub fn delete_envelope_group(conn: &Connection, id: &str) -> ApiResult<()> {
    let mut stmt =
        conn.prepare("select \"id\" from \"envelopes\" where \"envelopes\".\"group_id\" = ?")?;
    let env_ids = stmt
        .query_map([id], |r| col_string(r, 0))?
        .collect::<Result<Vec<_>, _>>()?;
    if !env_ids.is_empty() {
        for env_id in &env_ids {
            conn.execute(
                "update \"transactions\" set \"envelope_id\" = null where \"transactions\".\"envelope_id\" = ?",
                [env_id],
            )?;
        }
        conn.execute(
            "delete from \"envelopes\" where \"envelopes\".\"group_id\" = ?",
            [id],
        )?;
    }
    let n = conn.execute(
        "delete from \"envelope_groups\" where \"envelope_groups\".\"id\" = ?",
        [id],
    )?;
    if n == 0 {
        return Err(ApiError::service(404, "Group not found"));
    }
    Ok(())
}

/// `deleteEnvelope(id)`.
pub fn delete_envelope(conn: &Connection, id: &str) -> ApiResult<()> {
    conn.execute(
        "update \"transactions\" set \"envelope_id\" = null where \"transactions\".\"envelope_id\" = ?",
        [id],
    )?;
    let n = conn.execute(
        "delete from \"envelopes\" where \"envelopes\".\"id\" = ?",
        [id],
    )?;
    if n == 0 {
        return Err(ApiError::service(404, "Envelope not found"));
    }
    Ok(())
}

/// `reclaimEnvelopeToPool(id)`: lowers the budget so the envelope's
/// effective availability becomes zero; returns what was freed (base currency).
pub fn reclaim_envelope_to_pool(conn: &Connection, id: &str) -> ApiResult<Value> {
    let rates = get_latest_rates(conn)?;
    let envelope = conn
        .query_row(
            &format!("select {ENVELOPE_COLS} from \"envelopes\" where \"envelopes\".\"id\" = ?"),
            [id],
            read_envelope,
        )
        .optional()?
        .ok_or_else(|| ApiError::service(404, "Envelope not found"))?;
    let list = list_envelopes(conn, &envelope.month)?;
    let full = list
        .into_iter()
        .find(|e| e.id == id)
        .ok_or_else(|| ApiError::service(404, "Envelope not found"))?;
    let available = full.available;
    if available <= 0.0 {
        return Err(ApiError::service(
            400,
            "No surplus to return — this envelope is fully spent or overspent.",
        ));
    }
    let currency = envelope
        .budget_currency
        .clone()
        .unwrap_or_else(|| "INR".into());
    let rate = rates.get(&currency).copied().unwrap_or(1.0);
    let raw_budgeted_inr = to_inr(envelope.budgeted.unwrap_or(0.0), &currency, &rates);
    let rollover_inr = full.budgeted_inr - raw_budgeted_inr;
    let target_raw_inr = full.spent - rollover_inr;
    let new_budgeted = js_round((target_raw_inr / rate) * 100.0) / 100.0;
    conn.execute(
        "update \"envelopes\" set \"budgeted\" = ? where \"envelopes\".\"id\" = ?",
        rusqlite::params![new_budgeted, id],
    )?;
    Ok(json!({ "reclaimed_inr": crate::json::number(available) }))
}

/// `copyPreviousMonthBudget(month)`.
pub fn copy_previous_month_budget(conn: &Connection, month: &str) -> ApiResult<Value> {
    let current = envelopes_where(conn, "\"envelopes\".\"month\" = ?", month)?;
    if current.is_empty() {
        seed_month_from_template(conn, month)?;
    }
    let template: Option<String> = conn
        .query_row(
            "select \"month\" from \"envelopes\" where \"envelopes\".\"month\" < ? order by \"envelopes\".\"month\" desc limit ?",
            rusqlite::params![month, 1],
            |r| col_string(r, 0),
        )
        .optional()?;
    let Some(prev_month) = template else {
        return Ok(json!({ "count": 0 }));
    };
    // Raw values: `budgeted` / `budget_currency` are copied as stored.
    let mut stmt = conn.prepare(
        "select \"group_id\", \"name\", \"budgeted\", \"budget_currency\" from \"envelopes\" where \"envelopes\".\"month\" = ?",
    )?;
    let prev = stmt
        .query_map([&prev_month], |r| {
            Ok((
                col_string(r, 0)?,
                col_string(r, 1)?,
                r.get::<_, SqlValue>(2)?,
                r.get::<_, SqlValue>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let updated_current = envelopes_where(conn, "\"envelopes\".\"month\" = ?", month)?;

    let mut count: u64 = 0;
    run_transaction(conn, |conn| {
        for (group_id, name, budgeted, currency) in &prev {
            let matching = updated_current
                .iter()
                .find(|c| c.group_id == *group_id && c.name == *name);
            match matching {
                Some(m) => {
                    conn.execute(
                        "update \"envelopes\" set \"budgeted\" = ?, \"budget_currency\" = ? where \"envelopes\".\"id\" = ?",
                        rusqlite::params![budgeted, currency, m.id],
                    )?;
                }
                None => {
                    conn.execute(
                        &format!(
                            "insert into \"envelopes\" ({ENVELOPE_COLS}) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
                        ),
                        rusqlite::params![
                            nanoid(),
                            group_id,
                            name,
                            budgeted,
                            currency,
                            0.0,
                            month,
                            "none",
                            0.0,
                            now_iso(),
                        ],
                    )?;
                }
            }
            count += 1;
        }
        Ok::<_, ApiError>(())
    })?;
    Ok(json!({ "count": count }))
}

/// `clearMonthBudget(month)`.
pub fn clear_month_budget(conn: &Connection, month: &str) -> ApiResult<Value> {
    let n = conn.execute(
        "update \"envelopes\" set \"budgeted\" = ? where \"envelopes\".\"month\" = ?",
        rusqlite::params![0.0, month],
    )?;
    Ok(json!({ "count": n }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::budget::test_support::{db, exec};

    fn setup() -> Connection {
        let conn = db();
        exec(
            &conn,
            "insert into accounts (id, name, type, currency) values ('usd', 'US', 'checking', 'USD'), ('inr', 'IN', 'checking', 'INR');
             insert into envelope_groups (id, name, sort_order) values ('g1', 'Needs', 0);
             insert into envelopes (id, group_id, name, month, budgeted, budget_currency) values
               ('e1', 'g1', 'Food', '2026-05', 100, 'USD'),
               ('e2', 'g1', 'Fun', '2026-05', 50, 'USD'),
               ('e3', 'g1', 'Rent', '2026-05', 10, 'USD'),
               ('env-may', 'g1', 'Travel', '2026-05', 0, 'USD'),
               ('env-aug', 'g1', 'Travel', '2026-08', 0, 'USD');",
        );
        conn
    }

    #[test]
    fn spent_nets_transfers_in_base_currency() {
        let conn = setup();
        exec(
            &conn,
            "insert into transactions (id, account_id, envelope_id, payee, amount, type, date) values
               ('t1', 'usd', 'e1', 'Coffee', 100, 'expense', '2026-05-03'),
               ('t2', 'inr', 'e1', 'Tea', 50, 'expense', '2026-05-31'),
               ('t3', 'inr', 'e2', 'Transfer in', 200, 'transfer', '2026-05-10'),
               ('t4', 'inr', 'e2', 'Transfer out', 20, 'transfer', '2026-05-10'),
               ('t5', 'inr', 'e1', 'Outside', 999, 'expense', '2026-06-01'),
               ('t6', 'inr', 'e1', 'Income', 999, 'income', '2026-05-05');",
        );
        let rates: Rates = [("USD".to_string(), 80.0)].into_iter().collect();
        let ids: Vec<String> = ["e1", "e2", "e3"].iter().map(|s| s.to_string()).collect();
        let spent = compute_spent_by_envelope(&conn, "2026-05", &rates, Some(&ids)).expect("spent");
        assert_eq!(spent["e1"], 100.0 * 80.0 + 50.0);
        assert_eq!(spent["e2"], -180.0);
        assert_eq!(spent["e3"], 0.0);
        assert_eq!(spent.len(), 3);

        let none =
            compute_spent_by_envelope(&conn, "2026-05", &Rates::new(), Some(&[])).expect("empty");
        assert!(none.is_empty());
    }

    #[test]
    fn resolves_per_month_identity() {
        let conn = setup();
        assert_eq!(
            resolve_envelope_for_month(&conn, "env-may", "2026-08")
                .expect("ok")
                .as_deref(),
            Some("env-aug")
        );
        assert_eq!(
            resolve_envelope_for_month(&conn, "env-may", "2026-07").expect("ok"),
            None
        );
        assert_eq!(
            resolve_envelope_for_month(&conn, "env-may", "2026-05")
                .expect("ok")
                .as_deref(),
            Some("env-may")
        );
    }

    #[test]
    fn filing_seeds_future_months_and_creates_past_ones() {
        let conn = setup();
        // A month after every budgeted month is rolled forward from the latest (Aug).
        let sep = envelope_for_date(&conn, Some("e1"), "2026-09-02").expect("ok");
        let n: i64 = conn
            .query_row(
                "select count(*) from envelopes where month = '2026-09'",
                [],
                |r| r.get(0),
            )
            .expect("count");
        // Aug only has Travel, so Food is created in Sep with nothing budgeted.
        assert_eq!(n, 2);
        assert!(sep.is_some());
        // A month before is created with nothing budgeted.
        let jan = envelope_for_date(&conn, Some("e1"), "2026-01-15")
            .expect("ok")
            .expect("id");
        let budgeted: f64 = conn
            .query_row("select budgeted from envelopes where id = ?", [&jan], |r| {
                r.get(0)
            })
            .expect("row");
        assert_eq!(budgeted, 0.0);
        assert_eq!(
            envelope_for_date(&conn, Some("missing"), "2026-01-15").expect("ok"),
            None
        );
        assert_eq!(
            envelope_for_date(&conn, None, "2026-01-15").expect("ok"),
            None
        );
    }

    #[test]
    fn listing_an_empty_month_seeds_it_with_rollover() {
        let conn = setup();
        exec(&conn, "update envelopes set rollover_type = 'leftover' where id = 'e1';
                     insert into envelopes (id, group_id, name, month, budgeted, budget_currency, rollover_type) values ('e1-jun', 'g1', 'Food', '2026-06', 10, 'USD', 'leftover');");
        let june = list_envelopes(&conn, "2026-06").expect("june");
        assert_eq!(june.len(), 1);
        // 10 budgeted + 100 left over from May
        assert_eq!(june[0].budgeted_inr, 110.0);
        let dec = list_envelopes(&conn, "2026-12").expect("seeded");
        assert_eq!(dec.len(), 1); // seeded from the latest month (Aug: Travel)
        assert_eq!(dec[0].name, "Travel");
    }
}
