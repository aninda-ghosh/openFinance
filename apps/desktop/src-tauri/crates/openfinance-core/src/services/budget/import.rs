//! CSV import (budget.service.ts `importCSV`).

use std::collections::HashSet;

use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, Connection};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::compat::js_parse_float;
use super::transactions::{insert_transaction, NewTransaction};
use super::{col_str, node_message, placeholders};
use crate::db::run_transaction;
use crate::error::{ApiError, ApiResult};

/// `ImportResult`.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct ImportResult {
    pub imported: u64,
    pub skipped: u64,
    pub uncategorised: u64,
    pub errors: Vec<String>,
}

fn failure(message: String) -> ImportResult {
    ImportResult {
        errors: vec![message],
        ..Default::default()
    }
}

/// `hashRow(s)`: SHA-256 hex.
pub(crate) fn hash_row(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}

/// `` `${value}` `` of a CSV cell that may be missing (`undefined`).
fn show(v: Option<&str>) -> String {
    v.unwrap_or("undefined").to_string()
}

/// `importCSV(buffer, accountId, format)`: all-or-nothing import; CSV rows
/// land uncategorised (exempt from the envelope rule).
pub fn import_csv(conn: &Connection, file: &[u8], account_id: &str) -> ApiResult<ImportResult> {
    let mut result = ImportResult::default();
    let Ok(rows) = super::csv::parse(file) else {
        return Ok(failure("Failed to parse CSV file".into()));
    };

    let mut stmt =
        conn.prepare("select \"id\" from \"accounts\" where \"accounts\".\"id\" = ? limit ?")?;
    if !stmt.exists(rusqlite::params![account_id, 1])? {
        return Ok(failure("Account not found".into()));
    }

    let mut candidates: Vec<NewTransaction> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let mut seen_set: HashSet<String> = HashSet::new();
    for row in &rows {
        let hash = hash_row(&serde_json::to_string(&Value::Object(row.clone()))?);
        if seen_set.contains(&hash) {
            result.skipped += 1;
            continue;
        }
        let get = |k: &str| row.get(k).and_then(Value::as_str);
        let amount_raw = get("amount");
        let amount = amount_raw.map_or(f64::NAN, js_parse_float);
        if amount.is_nan() {
            result.errors.push(format!(
                "Row skipped — invalid amount: \"{}\"",
                show(amount_raw)
            ));
            continue;
        }
        if amount <= 0.0 {
            result.errors.push(format!(
                "Row skipped — amount must be greater than zero (use the type column for direction): \"{}\"",
                show(amount_raw)
            ));
            continue;
        }
        let type_raw = get("type");
        let lowered = type_raw.map(str::to_lowercase);
        let Some(t) = lowered.filter(|t| matches!(t.as_str(), "income" | "expense" | "transfer"))
        else {
            result.errors.push(format!(
                "Row skipped — invalid type: \"{}\"",
                show(type_raw)
            ));
            continue;
        };
        seen_set.insert(hash.clone());
        seen.push(hash.clone());
        candidates.push(NewTransaction {
            account_id: account_id.to_string(),
            payee: get("payee").unwrap_or("Unknown").to_string(),
            amount,
            txn_type: t,
            date: get("date").map(str::to_string),
            notes: get("notes").map(str::to_string),
            import_hash: Some(hash),
            ..Default::default()
        });
    }
    if candidates.is_empty() {
        return Ok(result);
    }

    let outcome = run_transaction(conn, |conn| {
        let mut existing: HashSet<String> = HashSet::new();
        for chunk in seen.chunks(500) {
            let mut stmt = conn.prepare(&format!(
                "select \"import_hash\" from \"transactions\" where \"transactions\".\"import_hash\" in ({})",
                placeholders(chunk.len())
            ))?;
            let found = stmt
                .query_map(
                    params_from_iter(chunk.iter().map(|h| SqlValue::Text(h.clone()))),
                    |r| col_str(r, 0),
                )?
                .collect::<Result<Vec<_>, _>>()?;
            existing.extend(found.into_iter().flatten().filter(|h| !h.is_empty()));
        }
        let mut imported = 0;
        let mut skipped = 0;
        let mut uncategorised = 0;
        for c in &candidates {
            if c.import_hash.as_ref().is_some_and(|h| existing.contains(h)) {
                skipped += 1;
                continue;
            }
            insert_transaction(conn, c)?;
            imported += 1;
            if c.txn_type == "expense" && c.envelope_id.is_none() {
                uncategorised += 1;
            }
        }
        Ok::<_, ApiError>((imported, skipped, uncategorised))
    });
    match outcome {
        Ok((imported, skipped, uncategorised)) => {
            result.imported += imported;
            result.skipped += skipped;
            result.uncategorised += uncategorised;
            Ok(result)
        }
        Err(err) => Ok(failure(format!(
            "Import failed — no rows were imported: {}",
            node_message(&err)
        ))),
    }
}

/// Row objects for tests.
#[cfg(test)]
fn rows_of(csv: &str) -> Vec<serde_json::Map<String, Value>> {
    super::csv::parse(csv.as_bytes()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::budget::test_support::{db, exec};

    #[test]
    fn hashes_rows_like_json_stringify() {
        let rows = rows_of("date,payee\n2026-05-01,\"Caf\u{e9} \u{1}\"\n");
        let text = serde_json::to_string(&Value::Object(rows[0].clone())).expect("json");
        assert_eq!(
            text,
            "{\"date\":\"2026-05-01\",\"payee\":\"Caf\u{e9} \\u0001\"}"
        );
        assert_eq!(
            hash_row("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn import_validates_dedupes_and_rolls_back() {
        let conn = db();
        exec(
            &conn,
            "insert into accounts (id, name, type) values ('a', 'A', 'checking')",
        );
        let csv = "date,payee,amount,type\n2026-05-01,Shop,12.5,Expense\n2026-05-01,Shop,12.5,Expense\n2026-05-02,Pay,-3,income\n2026-05-03,X,abc,income\n2026-05-04,Y,4,refund\n";
        let r = import_csv(&conn, csv.as_bytes(), "a").expect("import");
        assert_eq!(r.imported, 1);
        assert_eq!(r.skipped, 1);
        assert_eq!(r.uncategorised, 1);
        assert_eq!(
            r.errors,
            vec![
                "Row skipped — amount must be greater than zero (use the type column for direction): \"-3\"",
                "Row skipped — invalid amount: \"abc\"",
                "Row skipped — invalid type: \"refund\"",
            ]
        );
        // Importing again skips what is already there.
        let again = import_csv(&conn, csv.as_bytes(), "a").expect("again");
        assert_eq!((again.imported, again.skipped), (0, 2));

        let missing_date = import_csv(&conn, b"payee,amount,type\nA,1,income\n", "a").expect("x");
        assert_eq!(
            missing_date.errors,
            vec!["Import failed — no rows were imported: NOT NULL constraint failed: transactions.date"]
        );
        assert_eq!(
            import_csv(&conn, b"a,b\n1\n", "a").expect("bad").errors,
            vec!["Failed to parse CSV file"]
        );
        assert_eq!(
            import_csv(&conn, b"a\n1\n", "nope").expect("acct").errors,
            vec!["Account not found"]
        );
    }
}
