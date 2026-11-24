//! Transactions: listing, the single insert path, create / update / delete,
//! and transfers (budget.service.ts "Transactions").

use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::accounts::find_account;
use super::envelopes::envelope_for_date;
use super::{
    col_bool, col_f64, col_str, col_string, is_unique_violation, FROM_SAVINGS, TRANSFER_IN,
    TRANSFER_OUT,
};
use crate::db::run_transaction;
use crate::error::{ApiError, ApiResult};
use crate::ids::nanoid;
use crate::js::now_iso;

/// A row of `transactions`.
#[derive(Debug, Clone, PartialEq)]
pub struct TransactionRow {
    pub id: String,
    pub account_id: String,
    pub envelope_id: Option<String>,
    pub payee: String,
    pub amount: f64,
    pub txn_type: String,
    pub date: String,
    pub notes: Option<String>,
    pub import_hash: Option<String>,
    pub income_category: Option<String>,
    pub transfer_pair_id: Option<String>,
    pub created_at: Option<String>,
}

pub(crate) const TXN_COLS: &str = "\"id\", \"account_id\", \"envelope_id\", \"payee\", \"amount\", \"type\", \"date\", \"notes\", \"import_hash\", \"income_category\", \"transfer_pair_id\", \"created_at\"";

pub(crate) fn read_txn(r: &Row) -> rusqlite::Result<TransactionRow> {
    Ok(TransactionRow {
        id: col_string(r, 0)?,
        account_id: col_string(r, 1)?,
        envelope_id: col_str(r, 2)?,
        payee: col_string(r, 3)?,
        amount: col_f64(r, 4)?.unwrap_or(0.0),
        txn_type: col_string(r, 5)?,
        date: col_string(r, 6)?,
        notes: col_str(r, 7)?,
        import_hash: col_str(r, 8)?,
        income_category: col_str(r, 9)?,
        transfer_pair_id: col_str(r, 10)?,
        created_at: col_str(r, 11)?,
    })
}

fn find_txn(conn: &Connection, id: &str) -> ApiResult<Option<TransactionRow>> {
    Ok(conn
        .query_row(
            &format!("select {TXN_COLS} from \"transactions\" where \"transactions\".\"id\" = ?"),
            [id],
            read_txn,
        )
        .optional()?)
}

/// `TransactionResponse`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TransactionResponse {
    pub id: String,
    pub account_id: String,
    pub envelope_id: Option<String>,
    pub payee: String,
    pub amount: f64,
    pub currency: String,
    #[serde(rename = "type")]
    pub txn_type: String,
    pub date: String,
    pub notes: Option<String>,
    pub income_category: Option<String>,
    pub created_at: String,
}

/// `toTransactionResponse(row)`: a bare transactions row has no currency, so
/// it is always "INR" here.
pub(crate) fn to_transaction_response(row: &TransactionRow) -> TransactionResponse {
    TransactionResponse {
        id: row.id.clone(),
        account_id: row.account_id.clone(),
        envelope_id: row.envelope_id.clone(),
        payee: row.payee.clone(),
        amount: row.amount,
        currency: "INR".into(),
        txn_type: row.txn_type.clone(),
        date: row.date.clone(),
        notes: row.notes.clone(),
        income_category: row.income_category.clone(),
        created_at: row.created_at.clone().unwrap_or_default(),
    }
}

/// One row of `listTransactions`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ListedTransaction {
    #[serde(flatten)]
    pub base: TransactionResponse,
    pub envelope_name: Option<String>,
}

/// `PaginatedTransactionsResponse`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PaginatedTransactionsResponse {
    pub transactions: Vec<ListedTransaction>,
    pub total: f64,
    pub page: f64,
    pub limit: f64,
}

/// `TransactionFiltersSchema`'s output (query strings).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct TransactionFilters {
    pub account_id: Option<String>,
    pub envelope_id: Option<String>,
    #[serde(rename = "type")]
    pub txn_type: Option<String>,
    pub date_from: Option<String>,
    pub date_to: Option<String>,
    pub search: Option<String>,
    pub page: Option<f64>,
    pub limit: Option<f64>,
    /// `z.union([z.boolean(), z.string()])`.
    pub off_budget: Option<Value>,
}

fn non_empty(s: &Option<String>) -> Option<&str> {
    s.as_deref().filter(|s| !s.is_empty())
}

/// `listTransactions(filters)`.
pub fn list_transactions(
    conn: &Connection,
    filters: &TransactionFilters,
) -> ApiResult<PaginatedTransactionsResponse> {
    let mut conds: Vec<String> = Vec::new();
    let mut params: Vec<SqlValue> = Vec::new();
    if let Some(a) = non_empty(&filters.account_id) {
        conds.push("\"transactions\".\"account_id\" = ?".into());
        params.push(SqlValue::Text(a.into()));
    }
    if let Some(e) = non_empty(&filters.envelope_id) {
        if e == "_uncategorised_" {
            conds.push("\"transactions\".\"envelope_id\" is null".into());
            conds.push("\"transactions\".\"type\" = ?".into());
            params.push(SqlValue::Text("expense".into()));
        } else {
            conds.push("\"transactions\".\"envelope_id\" = ?".into());
            params.push(SqlValue::Text(e.into()));
        }
    }
    if let Some(t) = non_empty(&filters.txn_type) {
        conds.push("\"transactions\".\"type\" = ?".into());
        params.push(SqlValue::Text(t.into()));
    }
    if let Some(d) = non_empty(&filters.date_from) {
        conds.push("\"transactions\".\"date\" >= ?".into());
        params.push(SqlValue::Text(d.into()));
    }
    if let Some(d) = non_empty(&filters.date_to) {
        conds.push("\"transactions\".\"date\" <= ?".into());
        params.push(SqlValue::Text(d.into()));
    }
    if let Some(s) = non_empty(&filters.search) {
        conds.push("\"transactions\".\"payee\" like ?".into());
        params.push(SqlValue::Text(format!("%{s}%")));
    }
    if let Some(ob) = &filters.off_budget {
        let off = matches!(ob, Value::Bool(true)) || ob.as_str() == Some("true");
        if off {
            conds.push("\"accounts\".\"off_budget\" = ?".into());
            params.push(SqlValue::Integer(1));
        } else {
            conds.push(
                "(\"accounts\".\"off_budget\" = ? or \"accounts\".\"off_budget\" is null)".into(),
            );
            params.push(SqlValue::Integer(0));
        }
    }
    let where_sql = if conds.is_empty() {
        String::new()
    } else {
        format!(" where {}", conds.join(" and "))
    };
    let page = filters.page.unwrap_or(1.0);
    let limit = filters.limit.unwrap_or(50.0);
    let offset = (page - 1.0) * limit;

    let mut page_params = params.clone();
    page_params.push(SqlValue::Real(limit));
    let offset_sql = if offset != 0.0 && !offset.is_nan() {
        page_params.push(SqlValue::Real(offset));
        " offset ?"
    } else {
        ""
    };
    let sql = format!(
        "select \"transactions\".\"id\", \"transactions\".\"account_id\", \"transactions\".\"envelope_id\", \"envelopes\".\"name\", \"transactions\".\"payee\", \"transactions\".\"amount\", \"accounts\".\"currency\", \"transactions\".\"type\", \"transactions\".\"date\", \"transactions\".\"notes\", \"transactions\".\"income_category\", \"transactions\".\"transfer_pair_id\", \"transactions\".\"created_at\" from \"transactions\" left join \"envelopes\" on \"transactions\".\"envelope_id\" = \"envelopes\".\"id\" left join \"accounts\" on \"transactions\".\"account_id\" = \"accounts\".\"id\"{where_sql} order by \"transactions\".\"date\" desc, \"transactions\".\"created_at\" desc limit ?{offset_sql}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params_from_iter(page_params), |r| {
            Ok(ListedTransaction {
                base: TransactionResponse {
                    id: col_string(r, 0)?,
                    account_id: col_string(r, 1)?,
                    envelope_id: col_str(r, 2)?,
                    payee: col_string(r, 4)?,
                    amount: col_f64(r, 5)?.unwrap_or(0.0),
                    currency: col_str(r, 6)?.unwrap_or_else(|| "INR".into()),
                    txn_type: col_string(r, 7)?,
                    date: col_string(r, 8)?,
                    notes: col_str(r, 9)?,
                    income_category: col_str(r, 10)?,
                    created_at: col_str(r, 12)?.unwrap_or_default(),
                },
                envelope_name: col_str(r, 3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let total: f64 = conn.query_row(
        &format!(
            "select count(*) from \"transactions\" left join \"accounts\" on \"transactions\".\"account_id\" = \"accounts\".\"id\"{where_sql}"
        ),
        params_from_iter(params),
        |r| Ok(col_f64(r, 0)?.unwrap_or(0.0)),
    )?;

    Ok(PaginatedTransactionsResponse {
        transactions: rows,
        total,
        page,
        limit,
    })
}

/// The values `insertTransactionTx` receives; unset columns get drizzle's
/// defaults (`id` → nanoid, `created_at` → now, the rest NULL).
#[derive(Debug, Clone, Default)]
pub struct NewTransaction {
    pub id: Option<String>,
    pub account_id: String,
    pub envelope_id: Option<String>,
    pub payee: String,
    pub amount: f64,
    pub txn_type: String,
    /// `None` only from CSV import (a file with no `date` column), where it
    /// trips the NOT NULL constraint exactly like Node.
    pub date: Option<String>,
    pub notes: Option<String>,
    pub import_hash: Option<String>,
    pub income_category: Option<String>,
    pub transfer_pair_id: Option<String>,
}

/// `insertTransactionTx(tx, data)`: the single write path for a row.
pub fn insert_transaction(conn: &Connection, t: &NewTransaction) -> ApiResult<TransactionRow> {
    Ok(conn.query_row(
        &format!(
            "insert into \"transactions\" ({TXN_COLS}) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning {TXN_COLS}"
        ),
        rusqlite::params![
            t.id.clone().unwrap_or_else(nanoid),
            t.account_id,
            t.envelope_id,
            t.payee,
            t.amount,
            t.txn_type,
            t.date,
            t.notes,
            t.import_hash,
            t.income_category,
            t.transfer_pair_id,
            now_iso(),
        ],
        read_txn,
    )?)
}

/// `assertEnvelopeRequired(q, accountId, type, envelopeId)`.
pub fn assert_envelope_required(
    conn: &Connection,
    account_id: &str,
    txn_type: Option<&str>,
    envelope_id: Option<&str>,
) -> ApiResult<()> {
    if txn_type != Some("expense") || envelope_id.is_some_and(|e| !e.is_empty()) {
        return Ok(());
    }
    let account: Option<Option<bool>> = conn
        .query_row(
            "select \"off_budget\" from \"accounts\" where \"accounts\".\"id\" = ? limit ?",
            rusqlite::params![account_id, 1],
            |r| col_bool(r, 0),
        )
        .optional()?;
    match account {
        None => Err(ApiError::service(404, "Account not found")),
        Some(Some(true)) => Ok(()),
        Some(_) => Err(ApiError::service(
            400,
            "An envelope category is required for expenses on On-Budget accounts.",
        )),
    }
}

/// `CreateTransactionSchema`'s output.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct CreateTransaction {
    pub account_id: String,
    pub envelope_id: Option<String>,
    pub payee: String,
    pub amount: f64,
    #[serde(rename = "type")]
    pub txn_type: String,
    pub date: String,
    pub notes: Option<String>,
    pub import_hash: Option<String>,
    pub income_category: Option<String>,
}

fn import_hash_exists(conn: &Connection, hash: &str) -> ApiResult<bool> {
    let mut stmt = conn.prepare(
        "select \"id\" from \"transactions\" where \"transactions\".\"import_hash\" = ?",
    )?;
    Ok(stmt.exists([hash])?)
}

/// `createTransaction(data)`: `None` when the import hash already exists.
pub fn create_transaction(
    conn: &Connection,
    data: &CreateTransaction,
) -> ApiResult<Option<TransactionResponse>> {
    let result = run_transaction(conn, |conn| {
        let envelope_id = envelope_for_date(conn, data.envelope_id.as_deref(), &data.date)?;
        assert_envelope_required(
            conn,
            &data.account_id,
            Some(&data.txn_type),
            envelope_id.as_deref(),
        )?;
        if let Some(hash) = data.import_hash.as_deref().filter(|h| !h.is_empty()) {
            if import_hash_exists(conn, hash)? {
                return Ok(None);
            }
        }
        insert_transaction(
            conn,
            &NewTransaction {
                account_id: data.account_id.clone(),
                envelope_id,
                payee: data.payee.clone(),
                amount: data.amount,
                txn_type: data.txn_type.clone(),
                date: Some(data.date.clone()),
                notes: data.notes.clone(),
                import_hash: data.import_hash.clone(),
                income_category: data.income_category.clone(),
                ..Default::default()
            },
        )
        .map(Some)
    });
    match result {
        Ok(row) => Ok(row.as_ref().map(to_transaction_response)),
        Err(e) if is_unique_violation(&e) => Ok(None),
        Err(e) => Err(e),
    }
}

/// A key of an update body: absent, `null`, or a value.
fn field<'a>(data: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    data.get(key)
}

fn opt_string(v: &Value) -> Option<String> {
    v.as_str().map(str::to_string)
}

/// `updateTransaction(id, data)`; `data` is `UpdateTransactionSchema`'s output.
pub fn update_transaction(
    conn: &Connection,
    id: &str,
    data: &Map<String, Value>,
) -> ApiResult<TransactionResponse> {
    let row = run_transaction(conn, |conn| {
        let existing =
            find_txn(conn, id)?.ok_or_else(|| ApiError::service(404, "Transaction not found"))?;

        if let Some(pair_id) = existing.transfer_pair_id.clone().filter(|p| !p.is_empty()) {
            let disallowed = ["amount", "type", "payee", "envelope_id", "income_category"]
                .iter()
                .any(|k| data.contains_key(*k));
            if disallowed {
                return Err(ApiError::service(
                    400,
                    "Only date and notes can be edited on a transfer — delete and recreate the transfer to change amounts, accounts, or envelopes.",
                ));
            }
            let date = field(data, "date").and_then(opt_string);
            let notes = field(data, "notes").and_then(opt_string);
            if date.is_none() && notes.is_none() {
                return Ok(existing);
            }
            let mut set = Vec::new();
            let mut params: Vec<SqlValue> = Vec::new();
            if let Some(d) = &date {
                set.push("\"date\" = ?");
                params.push(SqlValue::Text(d.clone()));
            }
            if let Some(n) = &notes {
                set.push("\"notes\" = ?");
                params.push(SqlValue::Text(n.clone()));
            }
            params.push(SqlValue::Text(pair_id.clone()));
            conn.execute(
                &format!(
                    "update \"transactions\" set {} where \"transactions\".\"transfer_pair_id\" = ?",
                    set.join(", ")
                ),
                params_from_iter(params),
            )?;

            if let Some(d) = &date {
                let legs = {
                    let mut stmt = conn.prepare(
                        "select \"id\", \"envelope_id\" from \"transactions\" where \"transactions\".\"transfer_pair_id\" = ?",
                    )?;
                    let legs = stmt
                        .query_map([&pair_id], |r| Ok((col_string(r, 0)?, col_str(r, 1)?)))?
                        .collect::<Result<Vec<_>, _>>()?;
                    legs
                };
                for (leg_id, leg_env) in legs {
                    let Some(leg_env) = leg_env.filter(|e| !e.is_empty()) else {
                        continue;
                    };
                    let target = envelope_for_date(conn, Some(&leg_env), d)?;
                    if let Some(target) = target.filter(|t| *t != leg_env) {
                        conn.execute(
                            "update \"transactions\" set \"envelope_id\" = ? where \"transactions\".\"id\" = ?",
                            rusqlite::params![target, leg_id],
                        )?;
                    }
                }
            }
            return find_txn(conn, id)?
                .ok_or_else(|| ApiError::plain("Cannot read properties of undefined"));
        }

        let new_type = field(data, "type")
            .and_then(opt_string)
            .unwrap_or_else(|| existing.txn_type.clone());
        let new_envelope_id = match field(data, "envelope_id") {
            Some(v) => opt_string(v),
            None => existing.envelope_id.clone(),
        };
        let new_date = field(data, "date")
            .and_then(opt_string)
            .unwrap_or_else(|| existing.date.clone());
        let resolved = if new_type == "income" {
            None
        } else {
            envelope_for_date(conn, new_envelope_id.as_deref(), &new_date)?
        };

        assert_envelope_required(
            conn,
            &existing.account_id,
            Some(&new_type),
            resolved.as_deref(),
        )?;

        let mut set: Vec<&str> = Vec::new();
        let mut params: Vec<SqlValue> = Vec::new();
        // drizzle writes the SET list in column order.
        if resolved != existing.envelope_id {
            set.push("\"envelope_id\" = ?");
            params.push(resolved.clone().map_or(SqlValue::Null, SqlValue::Text));
        }
        if let Some(v) = field(data, "payee") {
            set.push("\"payee\" = ?");
            params.push(super::sql_value(v));
        }
        if let Some(v) = field(data, "amount") {
            set.push("\"amount\" = ?");
            params.push(super::sql_value(v));
        }
        if new_type != existing.txn_type {
            set.push("\"type\" = ?");
            params.push(SqlValue::Text(new_type.clone()));
        }
        if let Some(v) = field(data, "date") {
            set.push("\"date\" = ?");
            params.push(super::sql_value(v));
        }
        if let Some(v) = field(data, "notes") {
            set.push("\"notes\" = ?");
            params.push(super::sql_value(v));
        }
        if let Some(v) = field(data, "income_category") {
            set.push("\"income_category\" = ?");
            params.push(super::sql_value(v));
        }
        if set.is_empty() {
            return Ok(existing);
        }
        params.push(SqlValue::Text(id.to_string()));
        conn.query_row(
            &format!(
                "update \"transactions\" set {} where \"transactions\".\"id\" = ? returning {TXN_COLS}",
                set.join(", ")
            ),
            params_from_iter(params),
            read_txn,
        )
        .optional()?
        .ok_or_else(|| ApiError::plain("Cannot read properties of undefined"))
    })?;
    Ok(to_transaction_response(&row))
}

/// `deleteTransaction(id)`: a transfer leg takes its pair with it.
pub fn delete_transaction(conn: &Connection, id: &str) -> ApiResult<()> {
    run_transaction(conn, |conn| {
        let existing =
            find_txn(conn, id)?.ok_or_else(|| ApiError::service(404, "Transaction not found"))?;
        match existing.transfer_pair_id.filter(|p| !p.is_empty()) {
            Some(pair) => conn.execute(
                "delete from \"transactions\" where \"transactions\".\"transfer_pair_id\" = ?",
                [pair],
            )?,
            None => conn.execute(
                "delete from \"transactions\" where \"transactions\".\"id\" = ?",
                [id],
            )?,
        };
        Ok(())
    })
}

/// `createTransfer(data)`'s argument (`to_amount` already defaulted).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct CreateTransfer {
    pub from_account_id: String,
    pub to_account_id: String,
    pub amount: f64,
    pub to_amount: f64,
    pub date: String,
    pub notes: Option<String>,
    pub import_hash: Option<String>,
    pub envelope_id: Option<String>,
    pub to_envelope_id: Option<String>,
    pub from_savings: Option<bool>,
}

/// `{ from, to }`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TransferResponse {
    pub from: TransactionResponse,
    pub to: TransactionResponse,
}

/// `createTransfer(data)`: `None` when the import hash already exists.
pub fn create_transfer(
    conn: &Connection,
    data: &CreateTransfer,
) -> ApiResult<Option<TransferResponse>> {
    let from_account = find_account(conn, &data.from_account_id)?;
    let to_account = find_account(conn, &data.to_account_id)?;
    let from_account =
        from_account.ok_or_else(|| ApiError::service(404, "Source account not found"))?;
    let to_account =
        to_account.ok_or_else(|| ApiError::service(404, "Destination account not found"))?;

    let from_on_budget = from_account.off_budget != Some(true);
    let to_off_budget = to_account.off_budget == Some(true);
    let from_savings = data.from_savings == Some(true);
    let has = |s: &Option<String>| s.as_deref().is_some_and(|s| !s.is_empty());

    if from_savings {
        if from_on_budget || to_off_budget {
            return Err(ApiError::service(
                400,
                "Only transfers from an Off-Budget account into an On-Budget account can be added to Ready to assign.",
            ));
        }
        if has(&data.to_envelope_id) {
            return Err(ApiError::service(
                400,
                "Choose either Ready to assign or a destination envelope for this transfer, not both.",
            ));
        }
    }
    if from_on_budget && to_off_budget && !has(&data.envelope_id) {
        return Err(ApiError::service(
            400,
            "On-to-Off Budget transfers require a budget envelope category.",
        ));
    }

    let result = run_transaction(conn, |conn| {
        if let Some(hash) = data.import_hash.as_deref().filter(|h| !h.is_empty()) {
            if import_hash_exists(conn, hash)? {
                return Ok(None);
            }
        }
        let pair_id = nanoid();
        let from_env = envelope_for_date(conn, data.envelope_id.as_deref(), &data.date)?;
        let to_env = envelope_for_date(conn, data.to_envelope_id.as_deref(), &data.date)?;
        let from = insert_transaction(
            conn,
            &NewTransaction {
                account_id: data.from_account_id.clone(),
                payee: TRANSFER_OUT.into(),
                amount: data.amount,
                txn_type: "transfer".into(),
                date: Some(data.date.clone()),
                notes: data.notes.clone(),
                import_hash: data.import_hash.clone(),
                envelope_id: from_env,
                transfer_pair_id: Some(pair_id.clone()),
                ..Default::default()
            },
        )?;
        let to = insert_transaction(
            conn,
            &NewTransaction {
                account_id: data.to_account_id.clone(),
                payee: TRANSFER_IN.into(),
                amount: data.to_amount,
                txn_type: "transfer".into(),
                date: Some(data.date.clone()),
                notes: data.notes.clone(),
                transfer_pair_id: Some(pair_id),
                envelope_id: to_env,
                income_category: from_savings.then(|| FROM_SAVINGS.to_string()),
                ..Default::default()
            },
        )?;
        Ok(Some((from, to)))
    });
    match result {
        Ok(Some((from, to))) => Ok(Some(TransferResponse {
            from: to_transaction_response(&from),
            to: to_transaction_response(&to),
        })),
        Ok(None) => Ok(None),
        Err(e) if is_unique_violation(&e) => Ok(None),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::budget::test_support::{db, exec};

    fn setup() -> Connection {
        let conn = db();
        exec(
            &conn,
            "insert into accounts (id, name, type, currency, off_budget) values
               ('acc-1', 'Chase', 'checking', 'USD', 0),
               ('acc-2', 'Car Loan', 'loan', 'USD', 1),
               ('hysa', 'HYSA', 'savings', 'USD', 1),
               ('chase', 'Chase 2', 'checking', 'USD', 0),
               ('off', 'Cash box', 'cash', 'USD', 1);
             insert into envelope_groups (id, name, sort_order) values ('g-1', 'Needs', 0);
             insert into envelopes (id, group_id, name, month, budgeted) values
               ('env-123', 'g-1', 'Car Loan', '2026-05', 0),
               ('env-1', 'g-1', 'Groceries', '2026-05', 100);",
        );
        conn
    }

    fn transfer(from: &str, to: &str) -> CreateTransfer {
        CreateTransfer {
            from_account_id: from.into(),
            to_account_id: to.into(),
            amount: 100.0,
            to_amount: 100.0,
            date: "2026-05-21".into(),
            ..Default::default()
        }
    }

    fn message(e: ApiError) -> String {
        crate::services::budget::node_message(&e)
    }

    fn count(conn: &Connection) -> i64 {
        conn.query_row("select count(*) from transactions", [], |r| r.get(0))
            .expect("count")
    }

    #[test]
    fn on_to_off_budget_transfer_needs_an_envelope() {
        let conn = setup();
        let err = create_transfer(&conn, &transfer("acc-1", "acc-2")).expect_err("400");
        assert_eq!(
            message(err),
            "On-to-Off Budget transfers require a budget envelope category."
        );
        let ok = create_transfer(
            &conn,
            &CreateTransfer {
                envelope_id: Some("env-123".into()),
                ..transfer("acc-1", "acc-2")
            },
        )
        .expect("transfer")
        .expect("created");
        assert_eq!(ok.from.envelope_id.as_deref(), Some("env-123"));
        assert_eq!(count(&conn), 2);
    }

    #[test]
    fn from_savings_tags_only_the_incoming_leg() {
        let conn = setup();
        let res = create_transfer(
            &conn,
            &CreateTransfer {
                amount: 741.95,
                to_amount: 741.95,
                date: "2026-10-01".into(),
                from_savings: Some(true),
                ..transfer("hysa", "chase")
            },
        )
        .expect("ok")
        .expect("created");
        assert_eq!(res.from.payee, "Transfer out");
        assert_eq!(res.from.income_category, None);
        assert_eq!(res.from.envelope_id, None);
        assert_eq!(res.to.payee, "Transfer in");
        assert_eq!(res.to.income_category.as_deref(), Some("from_savings"));
        assert_eq!(res.to.envelope_id, None);
        assert_eq!(res.to.txn_type, "transfer");

        let untagged = create_transfer(&conn, &transfer("hysa", "chase"))
            .expect("ok")
            .expect("created");
        assert_eq!(untagged.to.income_category, None);
    }

    #[test]
    fn from_savings_rules() {
        let conn = setup();
        let err = create_transfer(
            &conn,
            &CreateTransfer {
                from_savings: Some(true),
                ..transfer("acc-1", "chase")
            },
        )
        .expect_err("400");
        assert!(message(err).contains("Off-Budget account into an On-Budget account"));
        let err = create_transfer(
            &conn,
            &CreateTransfer {
                from_savings: Some(true),
                to_envelope_id: Some("env-1".into()),
                ..transfer("hysa", "chase")
            },
        )
        .expect_err("400");
        assert!(message(err).contains("not both"));
    }

    fn expense(envelope: Option<&str>, account: &str, t: &str) -> CreateTransaction {
        CreateTransaction {
            account_id: account.into(),
            envelope_id: envelope.map(str::to_string),
            payee: "Groceries".into(),
            amount: 500.0,
            txn_type: t.into(),
            date: "2026-05-21".into(),
            ..Default::default()
        }
    }

    #[test]
    fn on_budget_expenses_need_an_envelope() {
        let conn = setup();
        let err = create_transaction(&conn, &expense(None, "acc-1", "expense")).expect_err("400");
        assert_eq!(
            message(err),
            "An envelope category is required for expenses on On-Budget accounts."
        );
        assert_eq!(count(&conn), 0);
        create_transaction(&conn, &expense(None, "off", "expense")).expect("off-budget");
        let row = create_transaction(&conn, &expense(Some("env-1"), "acc-1", "expense"))
            .expect("with envelope")
            .expect("row");
        assert_eq!(row.envelope_id.as_deref(), Some("env-1"));
        create_transaction(&conn, &expense(None, "acc-1", "income")).expect("income");
        assert_eq!(count(&conn), 3);

        // clearing the envelope on an on-budget expense is refused
        let mut patch = Map::new();
        patch.insert("envelope_id".into(), Value::Null);
        let err = update_transaction(&conn, &row.id, &patch).expect_err("400");
        assert_eq!(
            message(err),
            "An envelope category is required for expenses on On-Budget accounts."
        );
    }

    #[test]
    fn deleting_a_transfer_leg_deletes_the_pair_and_never_touches_spent() {
        let conn = setup();
        let res = create_transfer(
            &conn,
            &CreateTransfer {
                envelope_id: Some("env-123".into()),
                ..transfer("acc-1", "acc-2")
            },
        )
        .expect("ok")
        .expect("created");
        let single = create_transaction(&conn, &expense(Some("env-1"), "acc-1", "expense"))
            .expect("ok")
            .expect("row");
        let spent_before: Vec<f64> = {
            let mut s = conn
                .prepare("select spent from envelopes order by id")
                .expect("p");
            s.query_map([], |r| r.get(0))
                .expect("q")
                .collect::<Result<_, _>>()
                .expect("r")
        };
        delete_transaction(&conn, &single.id).expect("delete");
        delete_transaction(&conn, &res.from.id).expect("delete pair");
        assert_eq!(count(&conn), 0);
        let spent_after: Vec<f64> = {
            let mut s = conn
                .prepare("select spent from envelopes order by id")
                .expect("p");
            s.query_map([], |r| r.get(0))
                .expect("q")
                .collect::<Result<_, _>>()
                .expect("r")
        };
        assert_eq!(spent_before, spent_after);
        let err = delete_transaction(&conn, "missing").expect_err("404");
        assert_eq!(message(err), "Transaction not found");
    }

    #[test]
    fn duplicate_import_hash_is_skipped() {
        let conn = setup();
        let data = CreateTransaction {
            import_hash: Some("h1".into()),
            ..expense(None, "acc-1", "income")
        };
        assert!(create_transaction(&conn, &data).expect("first").is_some());
        assert!(create_transaction(&conn, &data).expect("second").is_none());
    }
}
