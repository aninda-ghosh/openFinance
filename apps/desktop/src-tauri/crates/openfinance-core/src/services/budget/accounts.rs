//! Accounts: the derived balance and CRUD (budget.service.ts "Accounts").

use std::collections::HashMap;

use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::compat::{js_to_fixed, local_iso_date};
use super::transactions::{insert_transaction, NewTransaction};
use super::{
    balance_delta, bears_holdings, col_bool, col_f64, col_str, col_string, get_latest_rates,
    is_liability_type, round2, sql_value, to_inr, Rates, BALANCE_ADJUSTMENT_PAYEE,
    STARTING_BALANCE_PAYEE, TRANSFER_IN, TRANSFER_OUT,
};
use crate::db::run_transaction;
use crate::error::{ApiError, ApiResult};
use crate::ids::nanoid;
use crate::js::now_iso;

/// `AccountResponse`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AccountResponse {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub account_type: String,
    pub currency: String,
    pub balance: f64,
    pub balance_inr: f64,
    pub institution: Option<String>,
    pub is_active: bool,
    pub off_budget: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// A row of `accounts` as drizzle maps it.
#[derive(Debug, Clone)]
pub(crate) struct AccountRow {
    pub id: String,
    pub name: String,
    pub account_type: String,
    pub currency: Option<String>,
    pub balance: Option<f64>,
    pub institution: Option<String>,
    pub is_active: Option<bool>,
    pub off_budget: Option<bool>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

pub(crate) const ACCOUNT_COLS: &str = "\"id\", \"name\", \"type\", \"currency\", \"balance\", \"institution\", \"is_active\", \"off_budget\", \"created_at\", \"updated_at\"";

pub(crate) fn read_account(r: &Row) -> rusqlite::Result<AccountRow> {
    Ok(AccountRow {
        id: col_string(r, 0)?,
        name: col_string(r, 1)?,
        account_type: col_string(r, 2)?,
        currency: col_str(r, 3)?,
        balance: col_f64(r, 4)?,
        institution: col_str(r, 5)?,
        is_active: col_bool(r, 6)?,
        off_budget: col_bool(r, 7)?,
        created_at: col_str(r, 8)?,
        updated_at: col_str(r, 9)?,
    })
}

/// `select * from accounts where id = ? limit 1`.
pub(crate) fn find_account(conn: &Connection, id: &str) -> ApiResult<Option<AccountRow>> {
    Ok(conn
        .query_row(
            &format!(
                "select {ACCOUNT_COLS} from \"accounts\" where \"accounts\".\"id\" = ? limit ?"
            ),
            rusqlite::params![id, 1],
            read_account,
        )
        .optional()?)
}

/// `toAccountResponse(row, rates)`: the stored (opening) balance.
fn to_account_response(row: &AccountRow, rates: &Rates) -> AccountResponse {
    let currency = row.currency.clone().unwrap_or_else(|| "INR".into());
    let balance = row.balance.unwrap_or(0.0);
    AccountResponse {
        id: row.id.clone(),
        name: row.name.clone(),
        account_type: row.account_type.clone(),
        balance_inr: to_inr(balance, &currency, rates),
        currency,
        balance,
        institution: row.institution.clone(),
        is_active: row.is_active.unwrap_or(true),
        off_budget: row.off_budget.unwrap_or(false),
        created_at: row.created_at.clone().unwrap_or_default(),
        updated_at: row.updated_at.clone().unwrap_or_default(),
    }
}

/// `AccountBalanceParts`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AccountBalanceParts {
    pub native: f64,
    pub base: f64,
    pub holdings_base: f64,
    pub holdings_native: f64,
}

/// The `Map<string, AccountBalanceParts>` `getAccountBalances()` returns, in
/// its insertion (row) order.
#[derive(Debug, Clone, Default)]
pub struct AccountBalances(Vec<(String, AccountBalanceParts)>);

impl AccountBalances {
    pub fn get(&self, id: &str) -> Option<&AccountBalanceParts> {
        self.0.iter().find(|(k, _)| k == id).map(|(_, v)| v)
    }
    pub fn iter(&self) -> impl Iterator<Item = &(String, AccountBalanceParts)> {
        self.0.iter()
    }
    pub fn len(&self) -> usize {
        self.0.len()
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// `getAccountBalances()`: THE derived balance of every account.
pub fn get_account_balances(conn: &Connection) -> ApiResult<AccountBalances> {
    let rates = get_latest_rates(conn)?;
    let mut stmt = conn.prepare(&format!("select {ACCOUNT_COLS} from \"accounts\""))?;
    let rows = stmt
        .query_map([], read_account)?
        .collect::<Result<Vec<_>, _>>()?;
    derive_account_balances(conn, &rows, &rates)
}

fn add_to(map: &mut Vec<(String, f64)>, key: &str, v: f64) {
    match map.iter_mut().find(|(k, _)| k == key) {
        Some((_, total)) => *total += v,
        None => map.push((key.to_string(), 0.0 + v)),
    }
}

fn lookup(map: &[(String, f64)], key: &str) -> Option<f64> {
    map.iter().find(|(k, _)| k == key).map(|(_, v)| *v)
}

/// `deriveAccountBalances(rows, rates)`.
pub(crate) fn derive_account_balances(
    conn: &Connection,
    rows: &[AccountRow],
    rates: &Rates,
) -> ApiResult<AccountBalances> {
    let mut account_currency: HashMap<String, String> = HashMap::new();
    for r in rows {
        account_currency.insert(
            r.id.clone(),
            r.currency.clone().unwrap_or_else(|| "INR".into()),
        );
    }

    let mut stmt = conn.prepare(
        "select \"account_id\", \"type\", \"payee\", sum(\"transactions\".\"amount\") from \"transactions\" group by \"transactions\".\"account_id\", \"transactions\".\"type\", \"transactions\".\"payee\"",
    )?;
    let totals = stmt
        .query_map([], |r| {
            Ok((
                col_str(r, 0)?,
                col_string(r, 1)?,
                col_string(r, 2)?,
                col_f64(r, 3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut txn_delta: Vec<(String, f64)> = Vec::new();
    for (account_id, t, payee, total) in totals {
        let Some(account_id) = account_id.filter(|a| !a.is_empty()) else {
            continue;
        };
        // `sum()` of a NOT NULL column is never null; JS would treat null as 0.
        let Some(delta) = balance_delta(&t, &payee, total.unwrap_or(0.0)) else {
            tracing::error!(
                "[balance] account {account_id}: {t} rows with payee \"{payee}\" have no balance direction and are excluded from the derived balance (transfer legs must be \"{TRANSFER_IN}\" or \"{TRANSFER_OUT}\")"
            );
            continue;
        };
        add_to(&mut txn_delta, &account_id, delta);
    }

    let mut stmt = conn.prepare(
        "select \"account_id\", \"currency\", sum(\"investments\".\"current_value\") from \"investments\" where \"investments\".\"asset_type\" not in (?) group by \"investments\".\"account_id\", \"investments\".\"currency\"",
    )?;
    let inv_totals = stmt
        .query_map([super::PHYSICAL_ASSET_TYPES[0]], |r| {
            Ok((col_str(r, 0)?, col_str(r, 1)?, col_f64(r, 2)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut inv_delta: Vec<(String, f64)> = Vec::new();
    for (account_id, currency, total) in inv_totals {
        let Some(account_id) = account_id.filter(|a| !a.is_empty()) else {
            continue;
        };
        let account_curr = account_currency
            .get(&account_id)
            .filter(|c| !c.is_empty())
            .cloned()
            .unwrap_or_else(|| "INR".into());
        let inv_curr = currency.unwrap_or_else(|| "INR".into());
        let total = total.unwrap_or(0.0);
        let mut value = total;
        if inv_curr != account_curr {
            let rate_from = rates.get(&inv_curr).copied().unwrap_or(1.0);
            let rate_to = rates.get(&account_curr).copied().unwrap_or(1.0);
            value = (total * rate_from) / rate_to;
        }
        add_to(&mut inv_delta, &account_id, value);
    }

    let mut balances = Vec::with_capacity(rows.len());
    for r in rows {
        let currency = r.currency.clone().unwrap_or_else(|| "INR".into());
        let start = if is_liability_type(&r.account_type) {
            -r.balance.unwrap_or(0.0).abs()
        } else {
            r.balance.unwrap_or(0.0)
        };
        let holdings_native = if bears_holdings(&r.account_type) {
            lookup(&inv_delta, &r.id).unwrap_or(0.0)
        } else {
            0.0
        };
        let native = start + lookup(&txn_delta, &r.id).unwrap_or(0.0) + holdings_native;
        let parts = AccountBalanceParts {
            native,
            base: to_inr(native, &currency, rates),
            holdings_native,
            holdings_base: to_inr(holdings_native, &currency, rates),
        };
        match balances
            .iter_mut()
            .find(|(k, _): &&mut (String, _)| *k == r.id)
        {
            Some((_, v)) => *v = parts,
            None => balances.push((r.id.clone(), parts)),
        }
    }
    Ok(AccountBalances(balances))
}

/// `listAccounts()`.
pub fn list_accounts(conn: &Connection) -> ApiResult<Vec<AccountResponse>> {
    let rates = get_latest_rates(conn)?;
    let mut stmt = conn.prepare(&format!(
        "select {ACCOUNT_COLS} from \"accounts\" order by \"accounts\".\"name\""
    ))?;
    let rows = stmt
        .query_map([], read_account)?
        .collect::<Result<Vec<_>, _>>()?;
    let balances = derive_account_balances(conn, &rows, &rates)?;
    Ok(rows
        .iter()
        .map(|r| {
            let live = balances.get(&r.id);
            AccountResponse {
                balance: live.map_or(0.0, |l| l.native),
                balance_inr: live.map_or(0.0, |l| l.base),
                ..to_account_response(r, &rates)
            }
        })
        .collect())
}

/// `CreateAccountSchema`'s output.
#[derive(Debug, Clone, Deserialize)]
pub struct CreateAccount {
    pub name: String,
    #[serde(rename = "type")]
    pub account_type: String,
    pub currency: String,
    pub institution: Option<String>,
    pub balance: f64,
    pub off_budget: bool,
}

/// `createAccount(data)`.
pub fn create_account(conn: &Connection, data: &CreateAccount) -> ApiResult<AccountResponse> {
    let rates = get_latest_rates(conn)?;
    let is_debt = is_liability_type(&data.account_type);
    let opening = if is_debt {
        -data.balance.abs()
    } else {
        data.balance
    };
    let seed = opening > 0.0 && !data.off_budget && !is_debt;

    let row = run_transaction(conn, |conn| {
        let now = now_iso();
        let created = conn.query_row(
            &format!(
                "insert into \"accounts\" ({ACCOUNT_COLS}) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning {ACCOUNT_COLS}"
            ),
            rusqlite::params![
                nanoid(),
                data.name,
                data.account_type,
                data.currency,
                if seed { 0.0 } else { opening },
                data.institution,
                1,
                i64::from(data.off_budget),
                now,
                now_iso(),
            ],
            read_account,
        )?;
        if seed {
            insert_transaction(
                conn,
                &NewTransaction {
                    account_id: created.id.clone(),
                    payee: STARTING_BALANCE_PAYEE.into(),
                    amount: opening,
                    txn_type: "income".into(),
                    date: Some(local_iso_date()),
                    income_category: Some("starting_balance".into()),
                    ..Default::default()
                },
            )?;
        }
        Ok::<_, ApiError>(created)
    })?;
    Ok(to_account_response(&row, &rates))
}

/// The columns `UpdateAccountSchema` can set, in drizzle's column order.
const UPDATABLE: [&str; 6] = [
    "name",
    "type",
    "currency",
    "institution",
    "is_active",
    "off_budget",
];

/// `updateAccount(id, data)`: metadata, then reconciliation to `balance`.
pub fn update_account(
    conn: &Connection,
    id: &str,
    data: &Map<String, Value>,
) -> ApiResult<AccountResponse> {
    let rates = get_latest_rates(conn)?;
    let requested = data.get("balance").and_then(Value::as_f64);

    let existing =
        find_account(conn, id)?.ok_or_else(|| ApiError::service(404, "Account not found"))?;

    let fields: Vec<(&str, &Value)> = UPDATABLE
        .iter()
        .filter_map(|k| data.get(*k).map(|v| (*k, v)))
        .collect();
    let mut row = existing;
    if !fields.is_empty() {
        let set: Vec<String> = fields
            .iter()
            .map(|(k, _)| format!("\"{k}\" = ?"))
            .chain(std::iter::once("\"updated_at\" = ?".to_string()))
            .collect();
        let mut values: Vec<SqlValue> = fields.iter().map(|(_, v)| sql_value(v)).collect();
        values.push(SqlValue::Text(now_iso()));
        values.push(SqlValue::Text(id.to_string()));
        let updated = conn
            .query_row(
                &format!(
                    "update \"accounts\" set {} where \"accounts\".\"id\" = ? returning {ACCOUNT_COLS}",
                    set.join(", ")
                ),
                params_from_iter(values),
                read_account,
            )
            .optional()?;
        row = updated.ok_or_else(|| ApiError::service(404, "Account not found"))?;
    }

    let currency = row.currency.clone().unwrap_or_else(|| "INR".into());
    let balances = get_account_balances(conn)?;
    let mut derived = round2(balances.get(id).map_or(0.0, |b| b.native));

    if let Some(req) = requested {
        let is_debt = is_liability_type(&row.account_type);
        let target = round2(if is_debt { -req.abs() } else { req });
        let diff = round2(target - derived);
        if diff.abs() >= 0.01 {
            let notes = format!(
                "Reconciled from {} to {}",
                js_to_fixed(derived, 2),
                js_to_fixed(target, 2)
            );
            run_transaction(conn, |conn| {
                insert_transaction(
                    conn,
                    &NewTransaction {
                        account_id: id.to_string(),
                        payee: BALANCE_ADJUSTMENT_PAYEE.into(),
                        amount: diff.abs(),
                        envelope_id: None,
                        txn_type: if diff > 0.0 { "income" } else { "expense" }.into(),
                        date: Some(local_iso_date()),
                        notes: Some(notes),
                        ..Default::default()
                    },
                )
            })?;
            derived = target;
        }
    }

    Ok(AccountResponse {
        balance: derived,
        balance_inr: to_inr(derived, &currency, &rates),
        ..to_account_response(&row, &rates)
    })
}

/// `deleteAccount(id)`.
pub fn delete_account(conn: &Connection, id: &str) -> ApiResult<()> {
    run_transaction(conn, |conn| {
        conn.execute(
            "delete from \"recurring_transactions\" where \"recurring_transactions\".\"account_id\" = ?",
            [id],
        )?;
        conn.execute(
            "delete from \"transactions\" where \"transactions\".\"account_id\" = ?",
            [id],
        )?;
        // `.returning()` only to count the deleted rows.
        let n = conn.execute(
            "delete from \"accounts\" where \"accounts\".\"id\" = ?",
            [id],
        )?;
        if n == 0 {
            return Err(ApiError::service(404, "Account not found"));
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::budget::test_support::{db, exec};

    fn account(conn: &Connection, id: &str, name: &str, t: &str, balance: f64) {
        conn.execute(
            "insert into accounts (id, name, type, currency, balance, is_active, off_budget) values (?, ?, ?, 'INR', ?, 1, 0)",
            rusqlite::params![id, name, t, balance],
        )
        .expect("account");
    }

    #[allow(clippy::type_complexity)]
    fn adjustments(
        conn: &Connection,
    ) -> Vec<(String, String, f64, Option<String>, Option<String>)> {
        let mut stmt = conn
            .prepare("select payee, type, amount, envelope_id, notes from transactions where payee = 'Balance Adjustment'")
            .expect("prepare");
        stmt.query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })
        .expect("query")
        .collect::<Result<Vec<_>, _>>()
        .expect("rows")
    }

    /// An account whose derived balance is 50 000 (all from transactions).
    fn reconcilable() -> Connection {
        let conn = db();
        account(&conn, "acc-1", "Old Name", "checking", 0.0);
        exec(
            &conn,
            "insert into transactions (id, account_id, payee, amount, type, date) values ('t1', 'acc-1', 'Starting Balance', 50000, 'income', '2026-05-01')",
        );
        conn
    }

    fn patch(v: serde_json::Value) -> Map<String, Value> {
        v.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn rename_with_unchanged_balance_writes_no_transaction() {
        let conn = reconcilable();
        let res = update_account(
            &conn,
            "acc-1",
            &patch(serde_json::json!({"name": "New Name", "balance": 50000})),
        )
        .expect("update");
        assert!(adjustments(&conn).is_empty());
        assert_eq!(res.balance, 50000.0);
        assert_eq!(res.name, "New Name");
        // The stored opening balance is never touched.
        let stored: f64 = conn
            .query_row("select balance from accounts where id = 'acc-1'", [], |r| {
                r.get(0)
            })
            .expect("balance");
        assert_eq!(stored, 0.0);
    }

    #[test]
    fn reconciling_upwards_posts_income() {
        let conn = reconcilable();
        let res = update_account(
            &conn,
            "acc-1",
            &patch(serde_json::json!({"balance": 60000})),
        )
        .expect("update");
        let adj = adjustments(&conn);
        assert_eq!(adj.len(), 1);
        assert_eq!(adj[0].1, "income");
        assert_eq!(adj[0].2, 10000.0);
        assert_eq!(adj[0].3, None);
        assert_eq!(
            adj[0].4.as_deref(),
            Some("Reconciled from 50000.00 to 60000.00")
        );
        assert_eq!(res.balance, 60000.0);
    }

    #[test]
    fn reconciling_downwards_posts_expense() {
        let conn = reconcilable();
        let res = update_account(
            &conn,
            "acc-1",
            &patch(serde_json::json!({"balance": 45000})),
        )
        .expect("update");
        let adj = adjustments(&conn);
        assert_eq!(adj.len(), 1);
        assert_eq!((adj[0].1.as_str(), adj[0].2), ("expense", 5000.0));
        assert_eq!(res.balance, 45000.0);
    }

    #[test]
    fn unknown_account_is_404() {
        let conn = db();
        let err = update_account(&conn, "nope", &patch(serde_json::json!({"name": "x"})))
            .expect_err("404");
        assert!(
            matches!(err, ApiError::Service { status: Some(404), ref message } if message == "Account not found")
        );
    }

    #[test]
    fn liabilities_are_normalised_negative() {
        let conn = db();
        account(&conn, "a1", "Card", "credit", 1000.0);
        account(&conn, "a2", "Mortgage", "loan", 2000.0);
        account(&conn, "a3", "Owed to a friend", "debt", 3000.0);
        account(&conn, "a4", "Zed Bank", "checking", 4000.0);
        let balances: Vec<f64> = list_accounts(&conn)
            .expect("list")
            .iter()
            .map(|a| a.balance)
            .collect();
        assert_eq!(balances, vec![-1000.0, -2000.0, -3000.0, 4000.0]);
    }

    #[test]
    fn create_seeds_a_starting_balance() {
        let conn = db();
        let data = CreateAccount {
            name: "Bank".into(),
            account_type: "checking".into(),
            currency: "INR".into(),
            institution: None,
            balance: 250.0,
            off_budget: false,
        };
        let res = create_account(&conn, &data).expect("create");
        assert_eq!(res.balance, 0.0);
        let listed = list_accounts(&conn).expect("list");
        assert_eq!(listed[0].balance, 250.0);
        let card = CreateAccount {
            account_type: "credit".into(),
            ..data
        };
        assert_eq!(create_account(&conn, &card).expect("card").balance, -250.0);
    }
}
