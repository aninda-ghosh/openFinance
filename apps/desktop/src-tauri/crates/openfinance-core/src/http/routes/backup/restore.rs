//! The data half of `POST /api/backup/import`: the "JSON Backup Migration
//! Pipeline" over `body.data` and the wipe-and-restore transaction, with the
//! JavaScript semantics Node applies along the way:
//!
//! - property access and truthiness on whatever JSON the backup holds, and
//!   the `TypeError`s Node throws for the wrong shapes (all → 500);
//! - drizzle's insert building (`db/schema.ts` column order and defaults,
//!   boolean columns mapped to 1/0) in chunks of 1000 rows;
//! - better-sqlite3's parameter binding: numbers bind as doubles, strings as
//!   text, booleans throw, arrays spread into several parameters and a plain
//!   object is a (here empty) named-parameter set — after which the total
//!   must equal the number of placeholders.

use rusqlite::types::Value as Sql;
use rusqlite::Connection;
use serde_json::{Map, Value};

use super::jsdate;
use super::jsjson::number_to_string;
use super::tables::{self, Default, Table};
use crate::ids::nanoid;
use crate::js::now_iso;
use crate::json::{string_to_number, truthy};

/// A thrown JS error: the import answers `500 {"error":"Import failed"}`.
#[derive(Debug)]
pub struct Thrown(pub String);

impl From<rusqlite::Error> for Thrown {
    fn from(e: rusqlite::Error) -> Self {
        Thrown(e.to_string())
    }
}

fn type_error(msg: &str) -> Thrown {
    Thrown(format!("TypeError: {msg}"))
}

/// A row value: JSON from the backup, or a double the pipeline computed
/// (which may be NaN or ±Infinity, unlike a JSON number).
#[derive(Debug, Clone)]
pub enum Cell {
    Json(Value),
    Float(f64),
}

/// A pipeline-created account (its balance may be a non-JSON double).
#[derive(Debug, Clone)]
struct NewAccount {
    fields: Vec<(&'static str, Cell)>,
}

impl NewAccount {
    fn id(&self) -> Option<&Value> {
        self.fields.iter().find_map(|(k, v)| match (k, v) {
            (&"id", Cell::Json(v)) => Some(v),
            _ => None,
        })
    }
}

/// One element of the accounts array during the pipeline.
#[derive(Debug, Clone)]
enum Account {
    Backup(Value),
    New(NewAccount),
}

impl Account {
    /// `acc.id`, `None` for `undefined`.
    fn id(&self) -> Option<&Value> {
        match self {
            Account::Backup(v) => v.as_object().and_then(|o| o.get("id")),
            Account::New(n) => n.id(),
        }
    }
}

/// `a === b` for JSON values: objects and arrays are distinct references.
fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        _ => false,
    }
}

/// `String(v)` (`undefined` → "undefined").
fn js_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|e| match e {
                Value::Null => String::new(),
                other => js_string(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// `Number(v)` (`undefined` → NaN).
fn js_number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => string_to_number(s),
        Some(other @ Value::Array(_)) => string_to_number(&js_string(Some(other))),
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// `n + v` for a number `n` (string concatenation for strings and objects).
fn js_add(n: f64, v: Option<&Value>) -> f64 {
    match v {
        Some(Value::String(_)) | Some(Value::Array(_)) | Some(Value::Object(_)) => {
            string_to_number(&format!("{}{}", number_to_string(n), js_string(v)))
        }
        other => n + js_number(other),
    }
}

/// `new Date(v).getTime()`.
fn js_new_date(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::String(s)) => jsdate::parse(s),
        Some(Value::Array(_)) | Some(Value::Object(_)) => jsdate::parse(&js_string(v)),
        other => jsdate::time_clip(js_number(other)),
    }
}

/// `obj.key` on an element that must not be null (TypeError on null).
fn prop<'a>(v: &'a Value, key: &str) -> Result<Option<&'a Value>, Thrown> {
    match v {
        Value::Null => Err(type_error(&format!(
            "Cannot read properties of null (reading '{key}')"
        ))),
        Value::Object(o) => Ok(o.get(key)),
        // Primitives and arrays have no such own property.
        _ => Ok(None),
    }
}

/// The policy's premiums paid so far (`calculatedInvested`).
fn calculated_invested(pol: &Map<String, Value>) -> f64 {
    let start = js_new_date(pol.get("start_date"));
    let today = jsdate::now();
    let end = jsdate::set_full_year(
        start,
        js_add(jsdate::get_full_year(start), pol.get("premium_term_years")),
    );
    let months = match pol.get("premium_frequency").and_then(Value::as_str) {
        Some("monthly") => 1.0,
        Some("quarterly") => 3.0,
        _ => 12.0,
    };
    let mut count = 0.0;
    let mut cursor = start;
    while cursor <= today && cursor < end {
        count += 1.0;
        cursor = jsdate::set_month(cursor, jsdate::get_month(cursor) + months);
    }
    js_number(pol.get("premium_amount")) * count
}

/// The import data after the migration pipeline, ready to insert.
#[derive(Debug)]
pub struct Prepared {
    data: Map<String, Value>,
    accounts: Vec<Account>,
}

/// `if (!d.key) d.key = []`.
fn default_empty(d: &mut Map<String, Value>, key: &str) {
    if !truthy(d.get(key)) {
        d.insert(key.to_string(), Value::Array(Vec::new()));
    }
}

/// Runs the pipeline on `body.data` (already known to be truthy).
pub fn prepare(data: Value) -> Result<Prepared, Thrown> {
    let mut d = match data {
        Value::Object(o) => o,
        // An array takes the new properties like an object; it has none of
        // the table keys itself.
        Value::Array(_) => Map::new(),
        _ => return Err(type_error("Cannot create property 'accounts' on primitive")),
    };
    for key in [
        "accounts",
        "investment_documents",
        "investments",
        "policies",
        "life_insurance",
    ] {
        default_empty(&mut d, key);
    }
    if !truthy(d.get("exchange_rates")) {
        d.insert("exchange_rates".into(), Value::Array(Vec::new()));
    } else {
        let Some(Value::Array(rates)) = d.remove("exchange_rates") else {
            return Err(type_error("d.exchange_rates.filter is not a function"));
        };
        let mut kept = Vec::with_capacity(rates.len());
        for r in rates {
            let rate = prop(&r, "rate_to_base")?;
            let keep = matches!(rate, Some(v) if !v.is_null()) && !js_number(rate).is_nan();
            if keep {
                kept.push(r);
            }
        }
        d.insert("exchange_rates".into(), Value::Array(kept));
    }

    // Brokerage Portfolio (INR) -> Brokerage Portfolio
    let Some(Value::Array(raw_accounts)) = d.remove("accounts") else {
        return Err(type_error("d.accounts is not iterable"));
    };
    let mut accounts = Vec::with_capacity(raw_accounts.len());
    for mut acc in raw_accounts {
        let name = prop(&acc, "name")?.cloned();
        if truthy(name.as_ref()) {
            match name {
                Some(Value::String(s)) => {
                    if s.starts_with("Brokerage Portfolio") {
                        if let Value::Object(o) = &mut acc {
                            o.insert("name".into(), Value::String("Brokerage Portfolio".into()));
                        }
                    }
                }
                _ => return Err(type_error("acc.name.startsWith is not a function")),
            }
        }
        accounts.push(Account::Backup(acc));
    }

    // 1. Parent brokerage accounts for orphaned investments.
    let Some(Value::Array(mut investments)) = d.remove("investments") else {
        return Err(type_error("d.investments.filter is not a function"));
    };
    for inv in investments.iter_mut() {
        if truthy(prop(inv, "account_id")?) {
            continue;
        }
        let Value::Object(o) = inv else {
            return Err(type_error(
                "Cannot create property 'account_id' on primitive",
            ));
        };
        let currency = match o.get("currency") {
            None | Some(Value::Null) => Value::String("INR".into()),
            Some(v) => v.clone(),
        };
        let Value::String(cur) = &currency else {
            return Err(type_error("currency.toLowerCase is not a function"));
        };
        let dummy = Value::String(format!("brokerage-{}-imported", cur.to_lowercase()));
        if !accounts.iter().any(|a| strict_eq(a.id(), Some(&dummy))) {
            let now = now_iso();
            accounts.push(Account::New(NewAccount {
                fields: vec![
                    ("id", Cell::Json(dummy.clone())),
                    ("name", Cell::Json("Brokerage Portfolio".into())),
                    ("type", Cell::Json("investment".into())),
                    ("currency", Cell::Json(currency.clone())),
                    ("balance", Cell::Float(0.0)),
                    ("institution", Cell::Json("Imported Portfolio".into())),
                    ("is_active", Cell::Json(Value::Bool(true))),
                    ("off_budget", Cell::Json(Value::Bool(true))),
                    ("created_at", Cell::Json(Value::String(now.clone()))),
                    ("updated_at", Cell::Json(Value::String(now_iso()))),
                ],
            }));
        }
        o.insert("account_id".into(), dummy);
    }
    d.insert("investments".into(), Value::Array(investments));

    // 2. A first-class account for every policy.
    let mut policies = match d.remove("policies") {
        Some(Value::Array(p)) => p,
        _ => return Err(type_error("d.policies is not iterable")),
    };
    for pol in policies.iter_mut() {
        let Value::Object(o) = pol else {
            return Err(match pol {
                Value::Null => type_error("Cannot read properties of null (reading 'account_id')"),
                _ => type_error("Cannot create property 'account_id' on primitive"),
            });
        };
        if !truthy(o.get("account_id")) {
            let suffix = if truthy(o.get("id")) {
                js_string(o.get("id"))
            } else {
                nanoid()
            };
            o.insert(
                "account_id".into(),
                Value::String(format!("policy-acc-{suffix}")),
            );
        }
        let account_id = o.get("account_id").cloned();
        if !accounts
            .iter()
            .any(|a| strict_eq(a.id(), account_id.as_ref()))
        {
            let invested = calculated_invested(o);
            let currency = match o.get("currency") {
                None | Some(Value::Null) => Value::String("INR".into()),
                Some(v) => v.clone(),
            };
            let stamp = |k: &str| match o.get(k) {
                v @ Some(_) if truthy(v) => v.cloned().unwrap_or(Value::Null),
                _ => Value::String(now_iso()),
            };
            let mut fields = vec![("id", Cell::Json(account_id.clone().unwrap_or(Value::Null)))];
            if let Some(name) = o.get("name") {
                fields.push(("name", Cell::Json(name.clone())));
            }
            fields.push(("type", Cell::Json("policy".into())));
            fields.push(("currency", Cell::Json(currency)));
            fields.push(("balance", Cell::Float(invested)));
            if let Some(provider) = o.get("provider") {
                fields.push(("institution", Cell::Json(provider.clone())));
            }
            fields.push(("is_active", Cell::Json(Value::Bool(true))));
            fields.push(("off_budget", Cell::Json(Value::Bool(true))));
            fields.push(("created_at", Cell::Json(stamp("created_at"))));
            fields.push(("updated_at", Cell::Json(stamp("updated_at"))));
            accounts.push(Account::New(NewAccount { fields }));
        }
    }
    d.insert("policies".into(), Value::Array(policies));
    Ok(Prepared { data: d, accounts })
}

/// One bound parameter or SQL literal in the VALUES list.
enum Slot {
    Literal,
    Params(Vec<Sql>),
}

/// `new Param(value, column)` → `mapToDriverValue` → better-sqlite3's binder.
/// Returns the parameters this value contributes, or the error it throws.
fn bind_cell(cell: &Cell, boolean: bool, named_seen: &mut bool) -> Result<Vec<Sql>, Thrown> {
    let v = match cell {
        Cell::Float(f) => return Ok(vec![Sql::Real(*f)]),
        Cell::Json(v) => v,
    };
    if v.is_null() {
        return Ok(vec![Sql::Null]);
    }
    if boolean {
        let one = if truthy(Some(v)) { 1.0 } else { 0.0 };
        return Ok(vec![Sql::Real(one)]);
    }
    let scalar = |v: &Value| -> Result<Sql, Thrown> {
        match v {
            Value::Null => Ok(Sql::Null),
            Value::Number(n) => Ok(Sql::Real(n.as_f64().unwrap_or(f64::NAN))),
            Value::String(s) => Ok(Sql::Text(s.clone())),
            _ => Err(type_error(
                "SQLite3 can only bind numbers, strings, bigints, buffers, and null",
            )),
        }
    };
    match v {
        Value::Array(items) => items.iter().map(scalar).collect(),
        Value::Object(_) => {
            if *named_seen {
                return Err(type_error(
                    "You cannot specify named parameters in two different objects",
                ));
            }
            *named_seen = true;
            Ok(Vec::new())
        }
        other => Ok(vec![scalar(other)?]),
    }
}

fn default_slot(default: Default) -> Slot {
    match default {
        Default::Null => Slot::Literal,
        Default::Nanoid => Slot::Params(vec![Sql::Text(nanoid())]),
        Default::Now => Slot::Params(vec![Sql::Text(now_iso())]),
        Default::Text(s) => Slot::Params(vec![Sql::Text(s.to_string())]),
        Default::Number(n) => Slot::Params(vec![Sql::Real(n)]),
        Default::Bool(b) => Slot::Params(vec![Sql::Real(if b { 1.0 } else { 0.0 })]),
    }
}

/// `tx.insert(table).values(chunk)` for rows given as (key, value) lookups.
fn insert_chunk(
    conn: &Connection,
    table: &Table,
    rows: &[Vec<(String, Cell)>],
) -> Result<(), Thrown> {
    let cols = table
        .columns
        .iter()
        .map(|c| format!("\"{}\"", c.name))
        .collect::<Vec<_>>()
        .join(", ");
    let mut tuples = Vec::with_capacity(rows.len());
    let mut params: Vec<Sql> = Vec::new();
    let mut placeholders = 0usize;
    let mut named_seen = false;
    for row in rows {
        let mut parts = Vec::with_capacity(table.columns.len());
        for col in table.columns {
            let present = row
                .iter()
                .rev()
                .find(|(k, _)| k == col.name)
                .map(|(_, v)| v);
            let slot = match present {
                Some(cell) => Slot::Params(bind_cell(cell, col.boolean, &mut named_seen)?),
                None => default_slot(col.default),
            };
            match slot {
                Slot::Literal => parts.push("null"),
                Slot::Params(p) => {
                    parts.push("?");
                    placeholders += 1;
                    params.extend(p);
                }
            }
        }
        tuples.push(format!("({})", parts.join(", ")));
    }
    if params.len() < placeholders {
        return Err(Thrown(
            "RangeError: Too few parameter values were provided".into(),
        ));
    }
    if params.len() > placeholders {
        return Err(Thrown(
            "RangeError: Too many parameter values were provided".into(),
        ));
    }
    let sql = format!(
        "insert into \"{}\" ({cols}) values {}",
        table.name,
        tuples.join(", ")
    );
    conn.execute(&sql, rusqlite::params_from_iter(params))?;
    Ok(())
}

fn row_of_value(v: &Value) -> Result<Vec<(String, Cell)>, Thrown> {
    match v {
        Value::Object(o) => Ok(o
            .iter()
            .map(|(k, v)| (k.clone(), Cell::Json(v.clone())))
            .collect()),
        Value::Null => Err(type_error("Cannot convert undefined or null to object")),
        // A primitive or array has no column keys: an all-default row, which
        // violates the table's NOT NULL columns.
        _ => Ok(Vec::new()),
    }
}

/// `if (d.key?.length) await batchInsert(table, d.key)`.
fn insert_table(conn: &Connection, table: &Table, value: Option<&Value>) -> Result<(), Thrown> {
    let items = match value {
        Some(Value::Array(a)) if !a.is_empty() => a,
        Some(Value::String(s)) if !s.is_empty() => {
            return Err(type_error("NOT NULL constraint failed (string rows)"));
        }
        Some(Value::Object(o)) if truthy(o.get("length")) => {
            return Err(type_error("items.slice is not a function"));
        }
        _ => return Ok(()),
    };
    for chunk in items.chunks(1000) {
        let rows = chunk
            .iter()
            .map(row_of_value)
            .collect::<Result<Vec<_>, _>>()?;
        insert_chunk(conn, table, &rows)?;
    }
    Ok(())
}

/// The wipe-and-restore transaction body (the caller opens the transaction).
pub fn restore(conn: &Connection, prepared: &Prepared) -> Result<(), Thrown> {
    super::super::reset::wipe_all(conn)?;
    for table in tables::INSERT_ORDER {
        if table.name == "accounts" {
            let rows: Vec<Vec<(String, Cell)>> = prepared
                .accounts
                .iter()
                .map(|a| match a {
                    Account::Backup(v) => row_of_value(v),
                    Account::New(n) => Ok(n
                        .fields
                        .iter()
                        .map(|(k, v)| ((*k).to_string(), v.clone()))
                        .collect()),
                })
                .collect::<Result<_, _>>()?;
            for chunk in rows.chunks(1000) {
                insert_chunk(conn, &table, chunk)?;
            }
            continue;
        }
        insert_table(conn, &table, prepared.data.get(table.name))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().expect("open");
        c.execute_batch("PRAGMA foreign_keys = ON").expect("fk");
        crate::db::bootstrap::bootstrap_schema(&c).expect("bootstrap");
        c
    }

    #[test]
    fn js_conversions() {
        assert_eq!(js_string(Some(&json!([1, null, "a", [2, 3]]))), "1,,a,2,3");
        assert_eq!(js_string(Some(&json!(1.0))), "1");
        assert!(js_number(Some(&json!([true]))).is_nan());
        assert_eq!(js_number(Some(&json!(["5"]))), 5.0);
        assert_eq!(js_add(2020.0, Some(&json!("10"))), 202010.0);
        assert_eq!(js_add(2020.0, Some(&json!(10))), 2030.0);
        assert_eq!(js_add(2020.0, Some(&json!(null))), 2020.0);
        assert!(js_add(2020.0, None).is_nan());
        assert_eq!(js_new_date(Some(&json!(null))), 0.0);
        assert_eq!(js_new_date(Some(&json!(true))), 1.0);
    }

    #[test]
    fn pipeline_and_restore() {
        let c = conn();
        let data = json!({
            "accounts": [{"id": "a1", "name": "Brokerage Portfolio (INR)", "type": "investment"}],
            "investments": [
                {"id": "i1", "name": "X", "asset_type": "stock", "purchase_value": 1, "purchase_date": "2020-01-01", "current_value": 2, "currency": "USD"},
                {"id": "i2", "name": "Y", "asset_type": "stock", "purchase_value": 1, "purchase_date": "2020-01-01", "current_value": 2, "account_id": "a1"}
            ],
            "policies": [{"id": "p1", "name": "P", "provider": "Prov", "start_date": "2020-01-15",
                "premium_amount": 100, "premium_frequency": "annual", "premium_term_years": 2,
                "policy_term_years": 10, "maturity_date": "2030-01-15", "sum_assured": 1, "maturity_value": 1}],
            "exchange_rates": [{"from_currency": "USD", "rate_to_base": "1.5"}, {"from_currency": "X", "rate_to_base": "abc"}, 5],
            "envelope_groups": {"not": "an array"}
        });
        let prepared = prepare(data).expect("prepare");
        db_run(&c, &prepared);
        let names: Vec<(String, String, Option<f64>, i64)> = c
            .prepare("select id, name, balance, off_budget from accounts order by id")
            .expect("prep")
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .expect("q")
            .map(|r| r.expect("row"))
            .collect();
        assert_eq!(
            names[0],
            ("a1".into(), "Brokerage Portfolio".into(), Some(0.0), 0)
        );
        assert_eq!(
            names[1],
            (
                "brokerage-usd-imported".into(),
                "Brokerage Portfolio".into(),
                Some(0.0),
                1
            )
        );
        assert_eq!(
            names[2],
            ("policy-acc-p1".into(), "P".into(), Some(200.0), 1)
        );
        let rates: i64 = c
            .query_row("select count(*) from exchange_rates", [], |r| r.get(0))
            .expect("rates");
        assert_eq!(rates, 1);
    }

    fn db_run(c: &Connection, p: &Prepared) {
        crate::db::run_transaction::<_, Thrown, _>(c, |c| restore(c, p)).expect("restore");
    }

    #[test]
    fn binding_rules() {
        let c = conn();
        // A one-element array binds as its element; a boolean throws.
        let ok = prepare(json!({"envelope_groups": [{"id": ["g1"], "name": "G"}]})).expect("prep");
        db_run(&c, &ok);
        let id: String = c
            .query_row("select id from envelope_groups", [], |r| r.get(0))
            .expect("id");
        assert_eq!(id, "g1");
        let bad = prepare(json!({"envelope_groups": [{"id": "g2", "name": true}]})).expect("prep");
        assert!(crate::db::run_transaction::<_, Thrown, _>(&c, |c| restore(c, &bad)).is_err());
        let shifted = prepare(json!({"envelope_groups": [{"id": [], "name": "G"}]})).expect("prep");
        assert!(crate::db::run_transaction::<_, Thrown, _>(&c, |c| restore(c, &shifted)).is_err());
        // The failed restores rolled back: the first import is intact.
        let n: i64 = c
            .query_row("select count(*) from envelope_groups", [], |r| r.get(0))
            .expect("n");
        assert_eq!(n, 1);
        // A number in a text column is stored as SQLite renders the double.
        let num = prepare(json!({"envelope_groups": [{"id": "g3", "name": 5}]})).expect("prep");
        db_run(&c, &num);
        let name: String = c
            .query_row("select name from envelope_groups", [], |r| r.get(0))
            .expect("name");
        assert_eq!(name, "5.0");
    }

    #[test]
    fn shape_errors() {
        assert!(prepare(json!("x")).is_err());
        assert!(prepare(json!({"investments": {"a": 1}})).is_err());
        assert!(prepare(json!({"accounts": [null]})).is_err());
        assert!(prepare(json!({"accounts": [{"name": 5}]})).is_err());
        assert!(prepare(json!({"exchange_rates": [null]})).is_err());
        assert!(prepare(json!({"policies": [1]})).is_err());
        assert!(prepare(json!({"investments": [{"currency": 5}]})).is_err());
        assert!(prepare(json!([1, 2])).is_ok());
    }
}
