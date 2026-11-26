//! Port of `apps/server/src/services/bulk.service.ts` (Wave 1, budget): many
//! rows for one account, previewed read-only and saved all-or-nothing through
//! the same `create_transaction` / `create_transfer` the single-add form uses.

use std::collections::{HashMap, HashSet};

use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, Connection};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::db::run_transaction;
use crate::error::{ApiError, ApiResult};
use crate::services::budget::compat::shift_iso_date;
use crate::services::budget::{
    col_f64, col_str, col_string, create_transaction, create_transfer, node_message, placeholders,
    resolve_envelope_for_month, CreateTransaction, CreateTransfer,
};

/// Days either side of a row's date that count as "possibly the same".
const DUPLICATE_WINDOW_DAYS: f64 = 3.0;

/// `BulkValidationError`: `{ error: "Some rows need attention", rows }`.
#[derive(Debug, Clone, PartialEq)]
pub struct BulkRowError {
    pub index: usize,
    pub message: String,
}

#[derive(Debug)]
pub enum BulkError {
    Rows(Vec<BulkRowError>),
    Api(ApiError),
}

impl From<ApiError> for BulkError {
    fn from(e: ApiError) -> Self {
        BulkError::Api(e)
    }
}

impl From<rusqlite::Error> for BulkError {
    fn from(e: rusqlite::Error) -> Self {
        BulkError::Api(e.into())
    }
}

/// `bulkImportHash(accountId, sourceKey)`.
pub fn bulk_import_hash(account_id: &str, source_key: &str) -> String {
    crate::services::budget::hash_row(&format!("bulk|{account_id}|{source_key}"))
}

const PAYEE_NOISE: [&str; 19] = [
    "ach",
    "aplpay",
    "autopay",
    "card",
    "co",
    "com",
    "debit",
    "inc",
    "llc",
    "ltd",
    "online",
    "paypal",
    "pos",
    "purchase",
    "recurring",
    "sq",
    "the",
    "tst",
    "www",
];

/// `payeeKeys(payee)`: lookup keys, most specific first.
pub fn payee_keys(payee: &str) -> Vec<String> {
    let lowered: String = payee
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_lowercase() || crate::js::is_js_whitespace(c) {
                c
            } else {
                ' '
            }
        })
        .collect();
    let tokens: Vec<&str> = lowered
        .split(crate::js::is_js_whitespace)
        .filter(|t| t.len() > 1 && !PAYEE_NOISE.contains(t))
        .collect();
    let mut keys = Vec::new();
    if tokens.is_empty() {
        return keys;
    }
    if tokens.len() >= 2 {
        keys.push(format!("{} {}", tokens[0], tokens[1]));
    }
    if tokens[0].len() >= 4 {
        keys.push(tokens[0].to_string());
    }
    keys
}

/// `BulkPreviewSchema`'s output.
#[derive(Debug, Clone, Deserialize)]
pub struct BulkPreviewRequest {
    pub account_id: String,
    pub category_month: String,
    pub rows: Vec<BulkPreviewRow>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BulkPreviewRow {
    pub date: String,
    pub payee: String,
    pub amount: f64,
    pub source_key: Option<String>,
}

fn shift(iso: &str, days: f64) -> ApiResult<String> {
    // `toISOString()` throws a RangeError for an Invalid Date.
    shift_iso_date(iso, days).ok_or_else(|| ApiError::plain("Invalid time value"))
}

/// `previewBulk(req)`: already-imported flags, possible duplicates and the
/// suggested category per row.
pub fn preview_bulk(conn: &Connection, req: &BulkPreviewRequest) -> ApiResult<Value> {
    if req.rows.is_empty() {
        return Ok(json!({ "rows": [] }));
    }
    let mut stmt =
        conn.prepare("select \"id\" from \"accounts\" where \"accounts\".\"id\" = ? limit ?")?;
    if !stmt.exists(rusqlite::params![req.account_id, 1])? {
        return Err(ApiError::service(404, "Account not found"));
    }

    let hashes: Vec<Option<String>> = req
        .rows
        .iter()
        .map(|r| {
            r.source_key
                .as_deref()
                .filter(|k| !k.is_empty())
                .map(|k| bulk_import_hash(&req.account_id, k))
        })
        .collect();
    let wanted: Vec<&String> = hashes.iter().flatten().collect();
    let mut imported: HashSet<String> = HashSet::new();
    for chunk in wanted.chunks(500) {
        let mut stmt = conn.prepare(&format!(
            "select \"import_hash\" from \"transactions\" where \"transactions\".\"import_hash\" in ({})",
            placeholders(chunk.len())
        ))?;
        let found = stmt
            .query_map(
                params_from_iter(chunk.iter().map(|h| SqlValue::Text((*h).clone()))),
                |r| col_str(r, 0),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        imported.extend(found.into_iter().flatten().filter(|h| !h.is_empty()));
    }

    // JS default sort: UTF-16 code unit order.
    let mut dates: Vec<&str> = req.rows.iter().map(|r| r.date.as_str()).collect();
    dates.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let lo_all = shift(dates[0], -DUPLICATE_WINDOW_DAYS)?;
    let hi_all = shift(dates[dates.len() - 1], DUPLICATE_WINDOW_DAYS)?;
    struct Near {
        id: String,
        date: String,
        payee: String,
        amount: f64,
        txn_type: String,
        notes: Option<String>,
    }
    let mut stmt = conn.prepare(
        "select \"id\", \"date\", \"payee\", \"amount\", \"type\", \"notes\" from \"transactions\" where (\"transactions\".\"account_id\" = ? and \"transactions\".\"date\" >= ? and \"transactions\".\"date\" <= ?)",
    )?;
    let nearby = stmt
        .query_map(rusqlite::params![req.account_id, lo_all, hi_all], |r| {
            Ok(Near {
                id: col_string(r, 0)?,
                date: col_string(r, 1)?,
                payee: col_string(r, 2)?,
                amount: col_f64(r, 3)?.unwrap_or(0.0),
                txn_type: col_string(r, 4)?,
                notes: col_str(r, 5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut stmt = conn.prepare(
        "select \"payee\", \"envelope_id\" from \"transactions\" where (\"transactions\".\"type\" = ? and \"transactions\".\"envelope_id\" is not null) order by \"transactions\".\"date\" asc, \"transactions\".\"created_at\" asc",
    )?;
    let history = stmt
        .query_map(["expense"], |r| Ok((col_string(r, 0)?, col_str(r, 1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut last_envelope: HashMap<String, String> = HashMap::new();
    for (payee, envelope_id) in history {
        let Some(envelope_id) = envelope_id.filter(|e| !e.is_empty()) else {
            continue;
        };
        for key in payee_keys(&payee) {
            last_envelope.insert(key, envelope_id.clone());
        }
    }

    let mut in_month: HashMap<String, Option<String>> = HashMap::new();
    let mut rows = Vec::with_capacity(req.rows.len());
    for (i, r) in req.rows.iter().enumerate() {
        let lo = shift(&r.date, -DUPLICATE_WINDOW_DAYS)?;
        let hi = shift(&r.date, DUPLICATE_WINDOW_DAYS)?;
        let amount = r.amount.abs();
        let possible: Vec<Value> = nearby
            .iter()
            .filter(|t| t.date >= lo && t.date <= hi && (t.amount - amount).abs() < 0.005)
            .map(|t| {
                let payee = match t.notes.as_deref().filter(|n| !n.is_empty()) {
                    Some(n) if t.txn_type == "transfer" => format!("{} · {n}", t.payee),
                    _ => t.payee.clone(),
                };
                json!({
                    "id": t.id,
                    "date": t.date,
                    "payee": payee,
                    "amount": crate::json::number(t.amount),
                    "type": t.txn_type,
                })
            })
            .collect();

        let mut suggested: Option<String> = None;
        for key in payee_keys(&r.payee) {
            if let Some(hit) = last_envelope.get(&key) {
                if !in_month.contains_key(hit) {
                    let resolved = resolve_envelope_for_month(conn, hit, &req.category_month)?;
                    in_month.insert(hit.clone(), resolved);
                }
                suggested = in_month.get(hit).cloned().flatten();
                if suggested.is_some() {
                    break;
                }
            }
        }

        let already = hashes[i].as_ref().is_some_and(|h| imported.contains(h));
        rows.push(json!({
            "already_imported": already,
            "possible_duplicates": possible,
            "suggested_envelope_id": suggested,
        }));
    }
    Ok(json!({ "rows": rows }))
}

/// One `BulkRowSchema` row (after zod: payee trimmed).
#[derive(Debug, Clone, Deserialize)]
pub struct BulkRow {
    pub date: String,
    pub payee: String,
    pub amount: f64,
    #[serde(rename = "type")]
    pub txn_type: String,
    pub envelope_id: Option<String>,
    pub income_category: Option<String>,
    pub notes: Option<String>,
    pub counterpart_account_id: Option<String>,
    pub direction: Option<String>,
    pub source_key: Option<String>,
}

/// `BulkCreateSchema`'s output.
#[derive(Debug, Clone, Deserialize)]
pub struct BulkCreateRequest {
    pub account_id: String,
    pub rows: Vec<BulkRow>,
}

struct Acct {
    id: String,
    name: String,
    currency: Option<String>,
    off_budget: Option<bool>,
}

fn validate_row(
    r: &BulkRow,
    account: &Acct,
    accounts_by_id: &HashMap<String, Acct>,
    envelope_ids: &HashSet<String>,
) -> Option<String> {
    fn truthy(s: &Option<String>) -> Option<&str> {
        s.as_deref().filter(|s| !s.is_empty())
    }
    if let Some(e) = truthy(&r.envelope_id) {
        if !envelope_ids.contains(e) {
            return Some("That category no longer exists — pick another.".into());
        }
    }
    if r.txn_type == "expense" {
        if account.off_budget != Some(true) && truthy(&r.envelope_id).is_none() {
            return Some("Pick a category — spending on an on-budget account needs one.".into());
        }
        return None;
    }
    if r.txn_type == "transfer" {
        let Some(direction) = truthy(&r.direction) else {
            return Some("Choose whether money moved in or out.".into());
        };
        let Some(counterpart) = truthy(&r.counterpart_account_id) else {
            return Some("Choose the other account for this transfer.".into());
        };
        if counterpart == account.id {
            return Some("A transfer needs two different accounts.".into());
        }
        let Some(other) = accounts_by_id.get(counterpart) else {
            return Some("The other account no longer exists.".into());
        };
        let cur = |a: &Acct| a.currency.clone().unwrap_or_else(|| "INR".into());
        if cur(other) != cur(account) {
            return Some(
                "Transfers between currencies need both amounts — add this one with Quick Add."
                    .into(),
            );
        }
        let (from, to) = if direction == "out" {
            (account, other)
        } else {
            (other, account)
        };
        if from.off_budget != Some(true)
            && to.off_budget == Some(true)
            && truthy(&r.envelope_id).is_none()
        {
            return Some(format!(
                "Pick a category — money leaving the budget for {} needs one.",
                to.name
            ));
        }
    }
    None
}

fn load_accounts(conn: &Connection, ids: &[String]) -> ApiResult<Vec<Acct>> {
    let mut stmt = conn.prepare(&format!(
        "select \"id\", \"name\", \"currency\", \"off_budget\" from \"accounts\" where \"accounts\".\"id\" in ({})",
        placeholders(ids.len())
    ))?;
    let rows = stmt
        .query_map(
            params_from_iter(ids.iter().map(|i| SqlValue::Text(i.clone()))),
            |r| {
                Ok(Acct {
                    id: col_string(r, 0)?,
                    name: col_string(r, 1)?,
                    currency: col_str(r, 2)?,
                    off_budget: crate::services::budget::col_bool(r, 3)?,
                })
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn unique(values: impl Iterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for v in values {
        if !out.contains(&v) {
            out.push(v);
        }
    }
    out
}

/// `createBulk(req)`: `{ created, skipped }`, or every row problem at once.
pub fn create_bulk(conn: &Connection, req: &BulkCreateRequest) -> Result<Value, BulkError> {
    let account = load_accounts(conn, std::slice::from_ref(&req.account_id))?
        .into_iter()
        .next()
        .ok_or_else(|| ApiError::service(404, "Account not found"))?;

    let counterpart_ids = unique(
        req.rows
            .iter()
            .filter_map(|r| r.counterpart_account_id.clone())
            .filter(|s| !s.is_empty()),
    );
    let accounts_by_id: HashMap<String, Acct> = if counterpart_ids.is_empty() {
        HashMap::new()
    } else {
        load_accounts(conn, &counterpart_ids)?
            .into_iter()
            .map(|a| (a.id.clone(), a))
            .collect()
    };
    let envelope_wanted = unique(
        req.rows
            .iter()
            .filter_map(|r| r.envelope_id.clone())
            .filter(|s| !s.is_empty()),
    );
    let envelope_ids: HashSet<String> = if envelope_wanted.is_empty() {
        HashSet::new()
    } else {
        let mut stmt = conn.prepare(&format!(
            "select \"id\" from \"envelopes\" where \"envelopes\".\"id\" in ({})",
            placeholders(envelope_wanted.len())
        ))?;
        let found = stmt
            .query_map(
                params_from_iter(envelope_wanted.iter().map(|i| SqlValue::Text(i.clone()))),
                |r| col_string(r, 0),
            )?
            .collect::<Result<HashSet<_>, _>>()?;
        found
    };

    let errors: Vec<BulkRowError> = req
        .rows
        .iter()
        .enumerate()
        .filter_map(|(index, r)| {
            validate_row(r, &account, &accounts_by_id, &envelope_ids)
                .map(|message| BulkRowError { index, message })
        })
        .collect();
    if !errors.is_empty() {
        return Err(BulkError::Rows(errors));
    }

    let mut created: u64 = 0;
    let mut skipped: u64 = 0;
    run_transaction(conn, |conn| {
        for (index, r) in req.rows.iter().enumerate() {
            let import_hash = r
                .source_key
                .as_deref()
                .filter(|k| !k.is_empty())
                .map(|k| bulk_import_hash(&account.id, k));
            let notes_trimmed = r
                .notes
                .as_deref()
                .map(crate::js::js_trim)
                .filter(|n| !n.is_empty());
            let result = if r.txn_type == "transfer" {
                let out = r.direction.as_deref() == Some("out");
                let other = r.counterpart_account_id.clone().unwrap_or_default();
                create_transfer(
                    conn,
                    &CreateTransfer {
                        from_account_id: if out {
                            account.id.clone()
                        } else {
                            other.clone()
                        },
                        to_account_id: if out { other } else { account.id.clone() },
                        amount: r.amount,
                        to_amount: r.amount,
                        date: r.date.clone(),
                        notes: Some(
                            notes_trimmed
                                .map(str::to_string)
                                .unwrap_or_else(|| r.payee.clone()),
                        ),
                        import_hash,
                        envelope_id: r.envelope_id.clone(),
                        to_envelope_id: None,
                        from_savings: None,
                    },
                )
                .map(|t| t.is_some())
            } else {
                create_transaction(
                    conn,
                    &CreateTransaction {
                        account_id: account.id.clone(),
                        payee: r.payee.clone(),
                        amount: r.amount,
                        txn_type: r.txn_type.clone(),
                        date: r.date.clone(),
                        notes: notes_trimmed.map(str::to_string),
                        import_hash,
                        envelope_id: if r.txn_type == "expense" {
                            r.envelope_id.clone()
                        } else {
                            None
                        },
                        income_category: if r.txn_type == "income" {
                            Some(r.income_category.clone().unwrap_or_else(|| "income".into()))
                        } else {
                            None
                        },
                    },
                )
                .map(|t| t.is_some())
            };
            match result {
                Ok(true) => created += 1,
                Ok(false) => skipped += 1,
                Err(err) => {
                    let message = node_message(&err);
                    return Err(BulkError::Rows(vec![BulkRowError {
                        index,
                        message: if message.is_empty() {
                            "This row could not be saved.".into()
                        } else {
                            message
                        },
                    }]));
                }
            }
        }
        Ok(())
    })?;
    Ok(json!({ "created": created, "skipped": skipped }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::budget::test_support::{db, exec};

    #[test]
    fn payee_keys_strip_noise() {
        assert_eq!(
            payee_keys("SQ *BLUE BOTTLE #123 OAKLAND"),
            ["blue bottle", "blue"]
        );
        assert_eq!(payee_keys("Blue Bottle"), ["blue bottle", "blue"]);
        assert_eq!(
            payee_keys("STARBUCKS STORE 1234"),
            ["starbucks store", "starbucks"]
        );
        assert_eq!(payee_keys("Starbucks"), ["starbucks"]);
        assert_eq!(payee_keys("The Co"), Vec::<String>::new());
        assert_eq!(payee_keys("Bar"), Vec::<String>::new());
    }

    fn row(t: &str) -> BulkRow {
        BulkRow {
            date: "2026-05-10".into(),
            payee: "Shop".into(),
            amount: 10.0,
            txn_type: t.into(),
            envelope_id: None,
            income_category: None,
            notes: None,
            counterpart_account_id: None,
            direction: None,
            source_key: None,
        }
    }

    fn setup() -> Connection {
        let conn = db();
        exec(
            &conn,
            "insert into accounts (id, name, type, currency, off_budget) values
               ('a', 'Chase', 'checking', 'USD', 0), ('b', 'HYSA', 'savings', 'USD', 1), ('c', 'HDFC', 'savings', 'INR', 0);
             insert into envelope_groups (id, name, sort_order) values ('g', 'G', 0);
             insert into envelopes (id, group_id, name, month) values ('e', 'g', 'Food', '2026-05');",
        );
        conn
    }

    fn rows_err(r: Result<Value, BulkError>) -> Vec<(usize, String)> {
        match r {
            Err(BulkError::Rows(rows)) => rows.into_iter().map(|e| (e.index, e.message)).collect(),
            other => panic!("expected row errors, got {other:?}"),
        }
    }

    #[test]
    fn validates_every_row_first() {
        let conn = setup();
        let req = BulkCreateRequest {
            account_id: "a".into(),
            rows: vec![
                row("expense"),
                BulkRow {
                    envelope_id: Some("gone".into()),
                    ..row("expense")
                },
                row("transfer"),
                BulkRow {
                    direction: Some("out".into()),
                    ..row("transfer")
                },
                BulkRow {
                    direction: Some("out".into()),
                    counterpart_account_id: Some("a".into()),
                    ..row("transfer")
                },
                BulkRow {
                    direction: Some("out".into()),
                    counterpart_account_id: Some("c".into()),
                    ..row("transfer")
                },
                BulkRow {
                    direction: Some("out".into()),
                    counterpart_account_id: Some("b".into()),
                    ..row("transfer")
                },
                BulkRow {
                    direction: Some("in".into()),
                    counterpart_account_id: Some("b".into()),
                    ..row("transfer")
                },
            ],
        };
        assert_eq!(
            rows_err(create_bulk(&conn, &req)),
            vec![
                (
                    0,
                    "Pick a category — spending on an on-budget account needs one.".into()
                ),
                (1, "That category no longer exists — pick another.".into()),
                (2, "Choose whether money moved in or out.".into()),
                (3, "Choose the other account for this transfer.".into()),
                (4, "A transfer needs two different accounts.".into()),
                (
                    5,
                    "Transfers between currencies need both amounts — add this one with Quick Add."
                        .into()
                ),
                (
                    6,
                    "Pick a category — money leaving the budget for HYSA needs one.".into()
                ),
            ]
        );
    }

    #[test]
    fn saves_all_or_nothing_and_skips_repeats() {
        let conn = setup();
        let req = BulkCreateRequest {
            account_id: "a".into(),
            rows: vec![
                BulkRow {
                    envelope_id: Some("e".into()),
                    source_key: Some("line1".into()),
                    ..row("expense")
                },
                BulkRow {
                    source_key: Some("line2".into()),
                    ..row("income")
                },
                BulkRow {
                    direction: Some("in".into()),
                    counterpart_account_id: Some("b".into()),
                    source_key: Some("line3".into()),
                    ..row("transfer")
                },
            ],
        };
        assert_eq!(
            create_bulk(&conn, &req).ok(),
            Some(json!({"created": 3, "skipped": 0}))
        );
        assert_eq!(
            create_bulk(&conn, &req).ok(),
            Some(json!({"created": 0, "skipped": 3}))
        );

        // A row that fails while saving rolls the whole batch back: the
        // off-budget counterpart makes an expense-less transfer out invalid
        // only at save time when its envelope is missing (forced here).
        let before: i64 = conn
            .query_row("select count(*) from transactions", [], |r| r.get(0))
            .expect("n");
        let bad = BulkCreateRequest {
            account_id: "c".into(),
            rows: vec![
                BulkRow {
                    source_key: Some("new".into()),
                    ..row("income")
                },
                BulkRow {
                    source_key: Some("new2".into()),
                    ..row("expense")
                },
            ],
        };
        exec(&conn, "update accounts set off_budget = 1 where id = 'c'");
        exec(&conn, "create temp trigger fail_second before insert on transactions when new.import_hash is not null and new.type = 'expense' begin select raise(abort, 'boom'); end;");
        assert_eq!(
            rows_err(create_bulk(&conn, &bad)),
            vec![(1, "boom".to_string())]
        );
        let after: i64 = conn
            .query_row("select count(*) from transactions", [], |r| r.get(0))
            .expect("n");
        assert_eq!(before, after);
        exec(&conn, "drop trigger fail_second");

        let preview = preview_bulk(
            &conn,
            &BulkPreviewRequest {
                account_id: "a".into(),
                category_month: "2026-05".into(),
                rows: vec![
                    BulkPreviewRow {
                        date: "2026-05-12".into(),
                        payee: "SHOP 123".into(),
                        amount: -10.0,
                        source_key: Some("line1".into()),
                    },
                    BulkPreviewRow {
                        date: "2026-05-30".into(),
                        payee: "Other".into(),
                        amount: 10.0,
                        source_key: None,
                    },
                ],
            },
        )
        .expect("preview");
        assert_eq!(preview["rows"][0]["already_imported"], json!(true));
        assert_eq!(
            preview["rows"][0]["possible_duplicates"]
                .as_array()
                .map(Vec::len),
            Some(3)
        );
        assert_eq!(preview["rows"][0]["suggested_envelope_id"], json!("e"));
        assert_eq!(preview["rows"][1]["already_imported"], json!(false));
        assert_eq!(preview["rows"][1]["possible_duplicates"], json!([]));
    }
}
