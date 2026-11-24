//! Port of `apps/server/src/services/investment.service.ts`, plus
//! `depreciatedValue` (`packages/shared/src/utils/depreciation.ts`) and
//! `isPhysicalAsset` (`packages/shared/src/constants`).
//! Owner: Wave 2 (investments).
//!
//! Every function takes `&Connection` (the price lookup Node makes in
//! `refreshPrice` never leaves the machine; see `services/price.rs`).
//! Pub API for the dashboard and AI waves: [`list_investments`],
//! [`get_investment_by_id`], [`get_portfolio_summary`], [`value_on_date`],
//! [`depreciated_value`], [`is_physical_asset`] and [`InvestmentResponse`].
//!
//! Numbers are read the way better-sqlite3 hands them over (INTEGER/REAL as
//! numbers, a numeric-looking TEXT through `Number()`); text columns as text.
//! Non-numeric text stored in a REAL column (possible only through a crafted
//! backup) is not reproduced: Node would concatenate strings there.

pub mod jssort;

use std::collections::HashMap;

use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, Connection, Row};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::error::{ApiError, ApiResult};
use crate::ids::nanoid;
use crate::js::now_iso;
use crate::services::budget::{self, col_f64, col_str, col_string, PHYSICAL_ASSET_TYPES};
use crate::services::exchange_rate;
use crate::services::policy::dates::{js_min, js_round, js_slice, local_iso_today, parse_date};
use crate::services::policy::{self, Rates};
use crate::services::price;

// ─── Shared helpers (`@openfinance/shared`) ─────────────────────────────────

/// `isPhysicalAsset(assetType)`.
pub fn is_physical_asset(asset_type: &str) -> bool {
    PHYSICAL_ASSET_TYPES.contains(&asset_type)
}

/// `365.25 * 24 * 60 * 60 * 1000`.
const MS_PER_YEAR: f64 = 365.25 * 24.0 * 60.0 * 60.0 * 1000.0;

/// `yearsBetween(from, to)`: whole-day-precision years between two dates.
fn years_between(from: &str, to: &str) -> f64 {
    let a = parse_date(&format!("{}T00:00:00Z", js_slice(from, 0, 10)));
    let b = parse_date(&format!("{}T00:00:00Z", js_slice(to, 0, 10)));
    if a.is_nan() || b.is_nan() {
        return 0.0;
    }
    (b - a) / MS_PER_YEAR
}

/// `depreciatedValue(quote, ratePct, quotedAt, asOf)`:
/// `quote × (1 − rate/100) ^ years`, rounded to cents; flat without a
/// positive rate or a quote date.
pub fn depreciated_value(
    quote: f64,
    rate_pct: Option<f64>,
    quoted_at: Option<&str>,
    as_of: &str,
) -> f64 {
    let Some(rate_pct) = rate_pct.filter(|r| *r != 0.0 && !r.is_nan()) else {
        return quote;
    };
    let Some(quoted_at) = quoted_at.filter(|q| !q.is_empty()) else {
        return quote;
    };
    if rate_pct <= 0.0 {
        return quote;
    }
    let rate = js_min(rate_pct, 100.0) / 100.0;
    if rate >= 1.0 {
        return 0.0;
    }
    let value = quote * (1.0 - rate).powf(years_between(quoted_at, as_of));
    js_round(value * 100.0) / 100.0
}

// ─── Rows ────────────────────────────────────────────────────────────────────

/// A row of `investments` as drizzle returns it.
#[derive(Debug, Clone, PartialEq)]
pub struct InvestmentRow {
    pub id: String,
    pub name: String,
    pub asset_type: String,
    pub currency: Option<String>,
    pub purchase_value: f64,
    pub units: Option<f64>,
    pub purchase_date: String,
    pub current_value: f64,
    pub current_value_source: Option<String>,
    pub current_value_at: Option<String>,
    pub notes: Option<String>,
    pub account_id: Option<String>,
    pub maturity_date: Option<String>,
    pub depreciation_rate: Option<f64>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

/// The `investments` columns in schema order, as drizzle selects them.
const INVESTMENT_COLS: &str = "\"id\", \"name\", \"asset_type\", \"currency\", \"purchase_value\", \"units\", \"purchase_date\", \"current_value\", \"current_value_source\", \"current_value_at\", \"notes\", \"account_id\", \"maturity_date\", \"depreciation_rate\", \"created_at\", \"updated_at\"";

fn read_investment(r: &Row) -> rusqlite::Result<InvestmentRow> {
    Ok(InvestmentRow {
        id: col_string(r, 0)?,
        name: col_string(r, 1)?,
        asset_type: col_string(r, 2)?,
        currency: col_str(r, 3)?,
        purchase_value: col_f64(r, 4)?.unwrap_or(f64::NAN),
        units: col_f64(r, 5)?,
        purchase_date: col_string(r, 6)?,
        current_value: col_f64(r, 7)?.unwrap_or(f64::NAN),
        current_value_source: col_str(r, 8)?,
        current_value_at: col_str(r, 9)?,
        notes: col_str(r, 10)?,
        account_id: col_str(r, 11)?,
        maturity_date: col_str(r, 12)?,
        depreciation_rate: col_f64(r, 13)?,
        created_at: col_str(r, 14)?,
        updated_at: col_str(r, 15)?,
    })
}

fn find_investment(conn: &Connection, id: &str, limit: bool) -> ApiResult<Option<InvestmentRow>> {
    let sql = format!(
        "select {INVESTMENT_COLS} from \"investments\" where \"investments\".\"id\" = ?{}",
        if limit { " limit ?" } else { "" }
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = if limit {
        stmt.query(rusqlite::params![id, 1])?
    } else {
        stmt.query([id])?
    };
    Ok(match rows.next()? {
        Some(r) => Some(read_investment(r)?),
        None => None,
    })
}

fn not_found() -> ApiError {
    ApiError::service(404, "Investment not found")
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// What a row is worth on `as_of` (`valueOnDate`). Only physical assets
/// depreciate, from `current_value_at` (else `updated_at`'s date).
pub fn value_on_date(row: &InvestmentRow, as_of: &str) -> f64 {
    if !is_physical_asset(&row.asset_type) {
        return row.current_value;
    }
    let quoted_at = match &row.current_value_at {
        Some(at) => Some(at.clone()),
        None => row.updated_at.as_deref().map(|u| js_slice(u, 0, 10)),
    };
    depreciated_value(
        row.current_value,
        row.depreciation_rate,
        quoted_at.as_deref(),
        as_of,
    )
}

/// `toInr(amount, currency, rates)` with exchange-rate.service's rates.
fn to_inr(amount: f64, currency: &str, rates: &Rates) -> f64 {
    policy::to_inr(amount, &Value::String(currency.to_string()), rates)
}

/// `contributionTotals(investmentId?)`: Σ contribution per investment.
fn contribution_totals(
    conn: &Connection,
    investment_id: Option<&str>,
) -> ApiResult<HashMap<String, f64>> {
    let select = "select \"investment_id\", sum(coalesce(\"investment_value_history\".\"contribution\", 0)) from \"investment_value_history\"";
    let group = "group by \"investment_value_history\".\"investment_id\"";
    let (sql, params): (String, Vec<SqlValue>) = match investment_id {
        Some(id) => (
            format!("{select} where \"investment_value_history\".\"investment_id\" = ? {group}"),
            vec![SqlValue::Text(id.to_string())],
        ),
        None => (format!("{select} {group}"), Vec::new()),
    };
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params_from_iter(params), |r| {
            Ok((col_str(r, 0)?, crate::json::from_sql(r.get_ref(1)?)))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut totals = HashMap::new();
    for (id, total) in rows {
        if let Some(id) = id.filter(|i| !i.is_empty()) {
            // `Number(r.total) || 0`
            let n = crate::json::to_number(&total);
            totals.insert(id, if n.is_nan() { 0.0 } else { n });
        }
    }
    Ok(totals)
}

/// `InvestmentResponse` (`packages/shared/src/api-contracts`).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct InvestmentResponse {
    pub id: String,
    pub name: String,
    pub asset_type: String,
    pub currency: String,
    pub purchase_value: f64,
    pub purchase_value_inr: f64,
    pub total_contributions: f64,
    pub total_contributions_inr: f64,
    pub cost_basis: f64,
    pub cost_basis_inr: f64,
    pub units: Option<f64>,
    pub purchase_date: String,
    pub current_value: f64,
    pub current_value_inr: f64,
    pub quoted_value: f64,
    pub depreciation_rate: Option<f64>,
    pub gain_loss_inr: f64,
    pub gain_loss_pct: f64,
    pub current_value_source: Option<String>,
    pub current_value_at: Option<String>,
    pub notes: Option<String>,
    pub account_id: Option<String>,
    pub maturity_date: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// `toInvestmentResponse(row, rates, contributions)`.
fn to_investment_response(
    row: &InvestmentRow,
    rates: &Rates,
    contributions: f64,
    today: &str,
) -> InvestmentResponse {
    let currency = row.currency.clone().unwrap_or_else(|| "INR".into());
    let purchase_inr = to_inr(row.purchase_value, &currency, rates);
    let cost_basis = row.purchase_value + contributions;
    let cost_basis_inr = to_inr(cost_basis, &currency, rates);
    let current_value = value_on_date(row, today);
    let current_inr = to_inr(current_value, &currency, rates);
    let gain_loss_inr = current_inr - cost_basis_inr;
    let gain_loss_pct = if cost_basis_inr > 0.0 {
        (gain_loss_inr / cost_basis_inr) * 100.0
    } else {
        0.0
    };
    InvestmentResponse {
        id: row.id.clone(),
        name: row.name.clone(),
        asset_type: row.asset_type.clone(),
        purchase_value: row.purchase_value,
        purchase_value_inr: purchase_inr,
        total_contributions: contributions,
        total_contributions_inr: to_inr(contributions, &currency, rates),
        cost_basis,
        cost_basis_inr,
        units: row.units,
        purchase_date: row.purchase_date.clone(),
        current_value,
        current_value_inr: current_inr,
        quoted_value: row.current_value,
        depreciation_rate: row.depreciation_rate,
        gain_loss_inr,
        gain_loss_pct: js_round(gain_loss_pct * 100.0) / 100.0,
        current_value_source: row.current_value_source.clone(),
        current_value_at: row.current_value_at.clone(),
        notes: row.notes.clone(),
        account_id: row.account_id.clone(),
        maturity_date: row.maturity_date.clone(),
        created_at: row.created_at.clone().unwrap_or_default(),
        updated_at: row.updated_at.clone().unwrap_or_default(),
        currency,
    }
}

/// How better-sqlite3 binds a JSON value drizzle passes through.
fn bind(v: &Value) -> SqlValue {
    policy::bind(v)
}

// ─── Service methods ─────────────────────────────────────────────────────────

/// `listInvestments(filters)` options.
#[derive(Debug, Clone, Default)]
pub struct InvestmentFilters {
    pub asset_type: Option<String>,
    pub sort: Option<String>,
}

/// `listInvestments(filters?)`: every holding by name, optionally filtered
/// by asset type and sorted by gain (`sort: "gain_desc"`).
pub fn list_investments(
    conn: &Connection,
    filters: &InvestmentFilters,
) -> ApiResult<Vec<InvestmentResponse>> {
    let rates = exchange_rate::get_latest_rates(conn)?;
    let mut stmt = conn.prepare(&format!(
        "select {INVESTMENT_COLS} from \"investments\" order by \"investments\".\"name\""
    ))?;
    let rows = stmt
        .query_map([], read_investment)?
        .collect::<Result<Vec<_>, _>>()?;
    let contributions = contribution_totals(conn, None)?;
    let today = local_iso_today();

    let mut result: Vec<InvestmentResponse> = rows
        .iter()
        .map(|r| {
            let c = contributions.get(&r.id).copied().unwrap_or(0.0);
            to_investment_response(r, &rates, c, &today)
        })
        .collect();

    if let Some(asset_type) = filters.asset_type.as_deref().filter(|a| !a.is_empty()) {
        result.retain(|r| r.asset_type == asset_type);
    }
    if filters.sort.as_deref() == Some("gain_desc") {
        jssort::js_sort_by(&mut result, |a, b| b.gain_loss_inr - a.gain_loss_inr);
    }
    Ok(result)
}

/// `CreateInvestmentSchema`'s output (`data`): zod-parsed JSON object.
pub fn create_investment(
    conn: &Connection,
    data: &Map<String, Value>,
) -> ApiResult<InvestmentResponse> {
    let rates = exchange_rate::get_latest_rates(conn)?;
    let asset_type = data.get("asset_type").and_then(Value::as_str).unwrap_or("");
    let physical = is_physical_asset(asset_type);
    let today = local_iso_today();
    let get = |k: &str| data.get(k).cloned().unwrap_or(Value::Null);

    let account_id = if physical {
        Value::Null
    } else {
        get("account_id")
    };
    let current_value_at = match data.get("current_value_at") {
        Some(v) if !v.is_null() => v.clone(),
        _ if physical => Value::String(today.clone()),
        _ => Value::Null,
    };
    let depreciation_rate = if physical {
        get("depreciation_rate")
    } else {
        Value::Null
    };
    // An absent `currency` would take the column default; zod always fills it.
    let currency = data
        .get("currency")
        .cloned()
        .unwrap_or_else(|| Value::String("INR".into()));

    let values = [
        Value::String(nanoid()),
        get("name"),
        get("asset_type"),
        currency,
        get("purchase_value"),
        get("units"),
        get("purchase_date"),
        get("current_value"),
        get("current_value_source"),
        current_value_at,
        get("notes"),
        account_id,
        get("maturity_date"),
        depreciation_rate,
        Value::String(now_iso()),
        Value::String(now_iso()),
    ];
    let sql = format!(
        "insert into \"investments\" ({INVESTMENT_COLS}) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning {INVESTMENT_COLS}"
    );
    let row = conn.query_row(
        &sql,
        params_from_iter(values.iter().map(bind)),
        read_investment,
    )?;
    Ok(to_investment_response(&row, &rates, 0.0, &today))
}

fn as_opt_f64(v: Option<&Value>) -> Option<Option<f64>> {
    v.map(|v| v.as_f64())
}

/// `updateInvestment(id, data)`; `data` is `UpdateInvestmentSchema`'s output.
pub fn update_investment(
    conn: &Connection,
    id: &str,
    data: &Map<String, Value>,
) -> ApiResult<InvestmentResponse> {
    let rates = exchange_rate::get_latest_rates(conn)?;
    let existing = find_investment(conn, id, false)?.ok_or_else(not_found)?;
    let today = local_iso_today();

    let contribution = data.get("contribution").and_then(Value::as_f64);
    let mut columns: Map<String, Value> = data
        .iter()
        .filter(|(k, _)| k.as_str() != "contribution")
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();

    let previous_value = value_on_date(&existing, &today);
    let asset_type = data
        .get("asset_type")
        .and_then(Value::as_str)
        .unwrap_or(&existing.asset_type);
    let physical = is_physical_asset(asset_type);

    if physical {
        columns.insert("account_id".into(), Value::Null);
        // `data.depreciation_rate !== undefined && (data.rate ?? null) !== (existing.rate ?? null)`
        let rate_changed = match as_opt_f64(data.get("depreciation_rate")) {
            None => false,
            Some(new_rate) => new_rate != existing.depreciation_rate,
        };
        if let Some(cv) = columns.get("current_value").and_then(Value::as_f64) {
            if (cv - previous_value).abs() < 0.005 {
                columns.remove("current_value");
            }
        }
        if columns.contains_key("current_value") {
            let at = match data.get("current_value_at") {
                Some(v) if !v.is_null() => v.clone(),
                _ => Value::String(today.clone()),
            };
            columns.insert("current_value_at".into(), at);
        } else if rate_changed {
            columns.insert("current_value".into(), crate::json::number(previous_value));
            columns.insert("current_value_at".into(), Value::String(today.clone()));
        }
    } else {
        columns.insert("depreciation_rate".into(), Value::Null);
    }

    columns.insert("updated_at".into(), Value::String(now_iso()));
    let set: Vec<String> = columns.keys().map(|k| format!("\"{k}\" = ?")).collect();
    let mut params: Vec<SqlValue> = columns.values().map(bind).collect();
    params.push(SqlValue::Text(id.to_string()));
    let sql = format!(
        "update \"investments\" set {} where \"investments\".\"id\" = ? returning {INVESTMENT_COLS}",
        set.join(", ")
    );
    let row = conn
        .query_row(&sql, params_from_iter(params), read_investment)
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => not_found(),
            other => other.into(),
        })?;

    let new_value = columns.get("current_value").and_then(Value::as_f64);
    let value_changed = new_value.is_some()
        && data.contains_key("current_value")
        && new_value != Some(previous_value);
    let notes = data.get("notes").cloned().unwrap_or(Value::Null);

    if value_changed {
        insert_value_history(
            conn,
            id,
            Some(previous_value),
            new_value.unwrap_or(f64::NAN),
            "manual",
            &notes,
            Some(contribution.unwrap_or(0.0)),
        )?;
    } else if let Some(c) = contribution.filter(|c| *c != 0.0 && !c.is_nan()) {
        insert_value_history(
            conn,
            id,
            Some(previous_value),
            previous_value,
            "manual",
            &notes,
            Some(c),
        )?;
    }

    let totals = contribution_totals(conn, Some(id))?;
    let c = totals.get(id).copied().unwrap_or(0.0);
    Ok(to_investment_response(&row, &rates, c, &today))
}

/// Inserts an `investment_value_history` row; `contribution: None` leaves
/// the column to its SQL default (0), as drizzle does for an absent value.
fn insert_value_history(
    conn: &Connection,
    investment_id: &str,
    previous_value: Option<f64>,
    new_value: f64,
    source: &str,
    notes: &Value,
    contribution: Option<f64>,
) -> ApiResult<()> {
    let mut cols = vec![
        "\"id\"",
        "\"investment_id\"",
        "\"previous_value\"",
        "\"new_value\"",
    ];
    let mut params = vec![
        SqlValue::Text(nanoid()),
        SqlValue::Text(investment_id.to_string()),
        previous_value.map_or(SqlValue::Null, SqlValue::Real),
        SqlValue::Real(new_value),
    ];
    if let Some(c) = contribution {
        cols.push("\"contribution\"");
        params.push(SqlValue::Real(c));
    }
    cols.extend(["\"source\"", "\"notes\"", "\"changed_at\""]);
    params.extend([
        SqlValue::Text(source.to_string()),
        bind(notes),
        SqlValue::Text(now_iso()),
    ]);
    let sql = format!(
        "insert into \"investment_value_history\" ({}) values ({})",
        cols.join(", "),
        budget::placeholders(cols.len())
    );
    conn.execute(&sql, params_from_iter(params))?;
    Ok(())
}

/// `deleteInvestment(id)`: price and value history first, then the row
/// (its documents cascade). Not transactional, like Node.
pub fn delete_investment(conn: &Connection, id: &str) -> ApiResult<()> {
    conn.execute(
        "delete from \"price_history\" where \"price_history\".\"investment_id\" = ?",
        [id],
    )?;
    conn.execute(
        "delete from \"investment_value_history\" where \"investment_value_history\".\"investment_id\" = ?",
        [id],
    )?;
    let mut stmt = conn
        .prepare("delete from \"investments\" where \"investments\".\"id\" = ? returning \"id\"")?;
    let deleted = stmt
        .query_map([id], |r| col_str(r, 0))?
        .collect::<Result<Vec<_>, _>>()?;
    if deleted.is_empty() {
        return Err(not_found());
    }
    Ok(())
}

/// `refreshPrice(id)`'s response.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RefreshPriceResult {
    pub source_url: String,
    pub price: f64,
    pub price_inr: f64,
    pub currency: String,
    pub fetched_at: String,
}

/// `refreshPrice(id)`. Node's `fetchCurrentPrice` returns the stored value
/// (no request leaves the machine), so this runs on the connection alone.
pub fn refresh_price(conn: &Connection, id: &str) -> ApiResult<RefreshPriceResult> {
    let rates = exchange_rate::get_latest_rates(conn)?;
    let inv = find_investment(conn, id, false)?.ok_or_else(not_found)?;
    if is_physical_asset(&inv.asset_type) {
        return Err(ApiError::service(
            400,
            "Physical assets have no market price to refresh.",
        ));
    }
    let contributions = contribution_totals(conn, Some(id))?
        .get(id)
        .copied()
        .unwrap_or(0.0);
    let inv_response = to_investment_response(&inv, &rates, contributions, &local_iso_today());

    let result = price::fetch_current_price(conn, &inv_response)?;

    // `!result.price || result.price <= 0`
    if result.price == 0.0 || result.price.is_nan() || result.price <= 0.0 {
        return Err(ApiError::service(
            422,
            format!(
                "Could not find a valid market price for \"{}\" — try updating the value manually",
                inv.name
            ),
        ));
    }

    conn.execute(
        "insert into \"price_history\" (\"id\", \"investment_id\", \"price\", \"source_url\", \"fetched_at\") values (?, ?, ?, ?, ?)",
        rusqlite::params![nanoid(), id, result.price, result.source_url, now_iso()],
    )?;
    insert_value_history(
        conn,
        id,
        Some(inv.current_value),
        result.price,
        "price_refresh",
        &Value::String(result.source_url.clone()),
        None,
    )?;
    conn.execute(
        "update \"investments\" set \"current_value\" = ?, \"current_value_source\" = ?, \"current_value_at\" = ?, \"updated_at\" = ? where \"investments\".\"id\" = ?",
        rusqlite::params![
            result.price,
            result.source_url,
            result.fetched_at,
            result.fetched_at,
            id
        ],
    )?;

    Ok(RefreshPriceResult {
        source_url: result.source_url,
        price: result.price,
        price_inr: result.price_inr,
        currency: result.currency,
        fetched_at: result.fetched_at,
    })
}

/// `PriceHistoryEntry`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PriceHistoryEntry {
    pub id: String,
    pub price: f64,
    pub source_url: Option<String>,
    pub fetched_at: String,
}

/// `getPriceHistory(id, from?, to?)`: newest first, filtered by string
/// comparison of `fetched_at` against non-empty bounds.
pub fn get_price_history(
    conn: &Connection,
    id: &str,
    from: Option<&str>,
    to: Option<&str>,
) -> ApiResult<Vec<PriceHistoryEntry>> {
    let mut stmt = conn.prepare(
        "select \"id\", \"investment_id\", \"price\", \"source_url\", \"fetched_at\" from \"price_history\" where \"price_history\".\"investment_id\" = ? order by \"price_history\".\"fetched_at\" desc",
    )?;
    let rows = stmt
        .query_map([id], |r| {
            Ok(PriceHistoryEntry {
                id: col_string(r, 0)?,
                price: col_f64(r, 2)?.unwrap_or(f64::NAN),
                source_url: col_str(r, 3)?,
                fetched_at: col_str(r, 4)?.unwrap_or_default(),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let lt = |a: &str, b: &str| policy::dates::js_str_cmp(a, b).is_lt();
    let from = from.filter(|f| !f.is_empty());
    let to = to.filter(|t| !t.is_empty());
    Ok(rows
        .into_iter()
        .filter(|r| {
            let at = r.fetched_at.as_str();
            if at.is_empty() {
                return true;
            }
            if from.is_some_and(|f| lt(at, f)) {
                return false;
            }
            if to.is_some_and(|t| lt(t, at)) {
                return false;
            }
            true
        })
        .collect())
}

/// One `getValueHistory` entry.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ValueHistoryEntry {
    pub id: String,
    pub previous_value: Option<f64>,
    pub new_value: f64,
    pub source: String,
    pub notes: Option<String>,
    pub contribution: f64,
    pub changed_at: String,
}

/// `getValueHistory(id)`: newest first.
pub fn get_value_history(conn: &Connection, id: &str) -> ApiResult<Vec<ValueHistoryEntry>> {
    let mut stmt = conn.prepare(
        "select \"id\", \"investment_id\", \"previous_value\", \"new_value\", \"contribution\", \"source\", \"notes\", \"changed_at\" from \"investment_value_history\" where \"investment_value_history\".\"investment_id\" = ? order by \"investment_value_history\".\"changed_at\" desc",
    )?;
    let rows = stmt
        .query_map([id], |r| {
            Ok(ValueHistoryEntry {
                id: col_string(r, 0)?,
                previous_value: col_f64(r, 2)?,
                new_value: col_f64(r, 3)?.unwrap_or(f64::NAN),
                contribution: col_f64(r, 4)?.unwrap_or(0.0),
                source: col_string(r, 5)?,
                notes: col_str(r, 6)?,
                changed_at: col_str(r, 7)?.unwrap_or_default(),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// `setEntryContribution(investmentId, entryId, contribution)`.
pub fn set_entry_contribution(
    conn: &Connection,
    investment_id: &str,
    entry_id: &str,
    contribution: f64,
) -> ApiResult<InvestmentResponse> {
    let entry: Option<Option<String>> = {
        let mut stmt = conn.prepare(
            "select \"id\", \"investment_id\", \"previous_value\", \"new_value\", \"contribution\", \"source\", \"notes\", \"changed_at\" from \"investment_value_history\" where \"investment_value_history\".\"id\" = ? limit ?",
        )?;
        let mut rows = stmt.query(rusqlite::params![entry_id, 1])?;
        match rows.next()? {
            Some(r) => Some(col_str(r, 1)?),
            None => None,
        }
    };
    match entry {
        Some(Some(owner)) if owner == investment_id => {}
        _ => return Err(ApiError::service(404, "History entry not found")),
    }
    conn.execute(
        "update \"investment_value_history\" set \"contribution\" = ? where \"investment_value_history\".\"id\" = ?",
        rusqlite::params![contribution, entry_id],
    )?;
    get_investment_by_id(conn, investment_id)
}

/// `bulkSetContributions(investmentId, mode)`: `match_delta` sets each
/// row's contribution to its own change, `clear` to 0.
pub fn bulk_set_contributions(
    conn: &Connection,
    investment_id: &str,
    mode: &str,
) -> ApiResult<InvestmentResponse> {
    let rows = {
        let mut stmt = conn.prepare(
            "select \"id\", \"investment_id\", \"previous_value\", \"new_value\", \"contribution\", \"source\", \"notes\", \"changed_at\" from \"investment_value_history\" where \"investment_value_history\".\"investment_id\" = ?",
        )?;
        let rows = stmt
            .query_map([investment_id], |r| {
                Ok((
                    col_string(r, 0)?,
                    col_f64(r, 2)?,
                    col_f64(r, 3)?.unwrap_or(f64::NAN),
                    col_f64(r, 4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    for (id, previous, new_value, contribution) in rows {
        let delta = match previous {
            Some(p) if mode != "clear" => new_value - p,
            _ => 0.0,
        };
        if contribution.unwrap_or(0.0) == delta {
            continue;
        }
        conn.execute(
            "update \"investment_value_history\" set \"contribution\" = ? where \"investment_value_history\".\"id\" = ?",
            rusqlite::params![delta, id],
        )?;
    }
    get_investment_by_id(conn, investment_id)
}

/// `getInvestmentById(id)`.
pub fn get_investment_by_id(conn: &Connection, id: &str) -> ApiResult<InvestmentResponse> {
    let row = find_investment(conn, id, true)?.ok_or_else(not_found)?;
    let rates = exchange_rate::get_latest_rates(conn)?;
    let totals = contribution_totals(conn, Some(id))?;
    let c = totals.get(id).copied().unwrap_or(0.0);
    Ok(to_investment_response(&row, &rates, c, &local_iso_today()))
}

/// `getPortfolioSummary()`'s response.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PortfolioSummary {
    pub total_inr: f64,
    /// `{ [assetType]: valueInr }` in JS insertion order.
    pub by_asset_type: Map<String, Value>,
}

/// `getPortfolioSummary()`: holdings by asset type (physical assets
/// excluded) plus the uninvested cash of off-budget linked accounts.
pub fn get_portfolio_summary(conn: &Connection) -> ApiResult<PortfolioSummary> {
    let inv_list = list_investments(conn, &InvestmentFilters::default())?;
    let all_accounts = budget::list_accounts(conn)?;

    let mut by_asset_type: Vec<(String, f64)> = Vec::new();
    let mut add = |key: &str, v: f64| match by_asset_type.iter_mut().find(|(k, _)| k == key) {
        Some((_, total)) => *total += v,
        None => by_asset_type.push((key.to_string(), 0.0 + v)),
    };

    for inv in &inv_list {
        if is_physical_asset(&inv.asset_type) {
            continue;
        }
        add(&inv.asset_type, inv.current_value_inr);
    }

    let linked = all_accounts.iter().filter(|a| {
        a.off_budget
            && ["investment", "savings", "checking", "cash"].contains(&a.account_type.as_str())
    });
    for acc in linked {
        let holdings_val_inr = inv_list
            .iter()
            .filter(|i| i.account_id.as_deref() == Some(acc.id.as_str()))
            .fold(0.0, |sum, i| sum + i.current_value_inr);
        let diff = acc.balance_inr - holdings_val_inr;
        // `Math.max(0, diff)`: NaN stays NaN (and is not > 0).
        let cash_val_inr = if diff.is_nan() {
            f64::NAN
        } else {
            diff.max(0.0)
        };
        if cash_val_inr > 0.0 {
            add(&acc.account_type, cash_val_inr);
        }
    }

    let total_inr = by_asset_type.iter().fold(0.0, |s, (_, v)| s + v);
    Ok(PortfolioSummary {
        total_inr,
        by_asset_type: by_asset_type
            .into_iter()
            .map(|(k, v)| (k, crate::json::number(v)))
            .collect(),
    })
}

#[cfg(test)]
mod tests;
