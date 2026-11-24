//! Port of `apps/server/src/services/policy.service.ts`.
//! Owner: Wave 1 (policies).
//!
//! Column values are kept as the JSON values better-sqlite3 would hand to
//! `JSON.stringify` ([`from_sql`]) wherever Node passes them through, and are
//! coerced with JS `Number()` semantics ([`to_number`]) wherever Node does
//! arithmetic on them, so odd stored values render the same.

pub mod dates;
pub(crate) mod schemas;

use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, Connection, OptionalExtension, Row};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::error::{ApiError, ApiResult};
use crate::ids::nanoid;
use crate::js::now_iso;
use crate::json::{from_sql, number, to_number, truthy};
use crate::services::exchange_rate::{get_base_currency, get_latest_rates};

use dates::{
    add_months_iso, day_of_month, days_between_iso, js_number_to_string, js_slice, js_str_cmp,
    local_full_year, local_iso_date, local_iso_today, now_ms, parse_date, set_full_year_local,
    time_clip,
};

/// `TRANSFER_IN` / `TRANSFER_OUT` from `@openfinance/shared/constants`.
const TRANSFER_IN: &str = "Transfer in";
const TRANSFER_OUT: &str = "Transfer out";

/// Latest rates as `getLatestRates()` returns them (JS object, insertion order).
pub type Rates = Vec<(String, Value)>;

// ─── Rows ─────────────────────────────────────────────────────────────────────

const POLICY_COLS: &str = "id, name, provider, policy_number, currency, start_date, \
    premium_amount, premium_frequency, premium_term_years, policy_term_years, maturity_date, \
    sum_assured, maturity_value, surrender_value, notes, account_id, created_at, updated_at";

/// A `policies` row as drizzle returns it (`typeof policies.$inferSelect`).
#[derive(Debug, Clone, PartialEq)]
pub struct PolicyRow {
    pub id: Value,
    pub name: Value,
    pub provider: Value,
    pub policy_number: Value,
    pub currency: Value,
    pub start_date: Value,
    pub premium_amount: Value,
    pub premium_frequency: Value,
    pub premium_term_years: Value,
    pub policy_term_years: Value,
    pub maturity_date: Value,
    pub sum_assured: Value,
    pub maturity_value: Value,
    pub surrender_value: Value,
    pub notes: Value,
    pub account_id: Value,
    pub created_at: Value,
    pub updated_at: Value,
}

impl PolicyRow {
    fn from_row(r: &Row<'_>) -> rusqlite::Result<Self> {
        let v = |i: usize| -> rusqlite::Result<Value> { Ok(from_sql(r.get_ref(i)?)) };
        Ok(Self {
            id: v(0)?,
            name: v(1)?,
            provider: v(2)?,
            policy_number: v(3)?,
            currency: v(4)?,
            start_date: v(5)?,
            premium_amount: v(6)?,
            premium_frequency: v(7)?,
            premium_term_years: v(8)?,
            policy_term_years: v(9)?,
            maturity_date: v(10)?,
            sum_assured: v(11)?,
            maturity_value: v(12)?,
            surrender_value: v(13)?,
            notes: v(14)?,
            account_id: v(15)?,
            created_at: v(16)?,
            updated_at: v(17)?,
        })
    }

    /// `policy.start_date.slice(0, 10)` needs a string; anything else throws a
    /// TypeError in Node (a 500).
    fn start_date_str(&self) -> ApiResult<&str> {
        self.start_date.as_str().ok_or_else(|| {
            ApiError::internal("TypeError: policy.start_date.slice is not a function")
        })
    }

    /// `premiumDueDates(policy)` for this row.
    pub fn premium_due_dates(&self) -> ApiResult<Vec<String>> {
        Ok(premium_due_dates(
            self.start_date_str()?,
            self.premium_frequency.as_str().unwrap_or(""),
            to_number(&self.premium_term_years),
        ))
    }
}

/// `db.select().from(policies)` — no ORDER BY (the dashboard and the timeline use this).
pub fn select_policies(conn: &Connection) -> ApiResult<Vec<PolicyRow>> {
    let mut stmt = conn.prepare(&format!("SELECT {POLICY_COLS} FROM policies"))?;
    let rows = stmt
        .query_map([], PolicyRow::from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn select_policy(conn: &Connection, id: &str) -> ApiResult<Option<PolicyRow>> {
    Ok(conn
        .query_row(
            &format!("SELECT {POLICY_COLS} FROM policies WHERE id = ?"),
            [id],
            PolicyRow::from_row,
        )
        .optional()?)
}

const PAYOUT_COLS: &str = "id, policy_id, payout_date, amount, label, is_received";

#[derive(Debug, Clone, PartialEq)]
struct PayoutRow {
    id: Value,
    policy_id: Value,
    payout_date: Value,
    amount: Value,
    label: Value,
    is_received: Value,
}

impl PayoutRow {
    fn from_row(r: &Row<'_>) -> rusqlite::Result<Self> {
        let v = |i: usize| -> rusqlite::Result<Value> { Ok(from_sql(r.get_ref(i)?)) };
        Ok(Self {
            id: v(0)?,
            policy_id: v(1)?,
            payout_date: v(2)?,
            amount: v(3)?,
            label: v(4)?,
            is_received: v(5)?,
        })
    }
}

// ─── Responses ────────────────────────────────────────────────────────────────

/// `PayoutResponse`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PayoutResponse {
    pub id: Value,
    pub policy_id: Value,
    pub payout_date: Value,
    pub amount: Value,
    pub label: Value,
    pub is_received: bool,
}

/// `PolicyResponse`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PolicyResponse {
    pub id: Value,
    pub name: Value,
    pub provider: Value,
    pub policy_number: Value,
    pub start_date: Value,
    pub currency: Value,
    pub premium_amount: Value,
    pub premium_amount_inr: Value,
    pub premium_frequency: Value,
    pub premium_term_years: Value,
    pub policy_term_years: Value,
    pub maturity_date: Value,
    pub sum_assured: Value,
    pub sum_assured_inr: Value,
    pub maturity_value: Value,
    pub maturity_value_inr: Value,
    pub surrender_value: Value,
    pub surrender_value_inr: Value,
    pub total_invested: Value,
    pub total_invested_inr: Value,
    pub notes: Value,
    pub account_id: Value,
    pub payouts: Vec<PayoutResponse>,
    pub created_at: Value,
    pub updated_at: Value,
}

/// `TimelineEvent`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TimelineEvent {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub date: Value,
    pub policy_id: Value,
    pub policy_name: Value,
    pub amount: Value,
    pub label: Value,
}

/// `PolicyAlert`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PolicyAlert {
    pub policy_id: Value,
    pub policy_name: Value,
    pub next_premium_date: String,
    pub premium_amount: Value,
    pub days_until_due: Value,
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// `toPayoutResponse(row)`; `is_received` is drizzle's `Number(v) === 1`.
fn to_payout_response(row: PayoutRow) -> PayoutResponse {
    let is_received = !row.is_received.is_null() && to_number(&row.is_received) == 1.0;
    PayoutResponse {
        id: row.id,
        policy_id: row.policy_id,
        payout_date: row.payout_date,
        amount: row.amount,
        label: row.label,
        is_received,
    }
}

/// Properties every plain JS object inherits from `Object.prototype`.
const OBJECT_PROTO_KEYS: &[&str] = &[
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

/// `String(v)` used as a property key.
pub(crate) fn js_property_key(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => js_number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Array(_) | Value::Object(_) => "[object Object]".into(),
    }
}

/// `rates[currency] ?? 1.0` as a number (inherited object members multiply to NaN).
pub(crate) fn rate_for(currency: &Value, rates: &Rates) -> f64 {
    let key = js_property_key(currency);
    match rates.iter().find(|(k, _)| *k == key) {
        Some((_, v)) if !v.is_null() => to_number(v),
        Some(_) => 1.0,
        None if OBJECT_PROTO_KEYS.contains(&key.as_str()) => f64::NAN,
        None => 1.0,
    }
}

/// `toInr(amount, currency, rates)`: `amount * (rates[currency] ?? 1.0)`.
pub(crate) fn to_inr(amount: f64, currency: &Value, rates: &Rates) -> f64 {
    amount * rate_for(currency, rates)
}

/// `row.currency ?? "INR"`.
pub(crate) fn currency_or_inr(currency: &Value) -> Value {
    if currency.is_null() {
        Value::String("INR".into())
    } else {
        currency.clone()
    }
}

/// `v ?? fallback`.
pub(crate) fn or_value(v: &Value, fallback: Value) -> Value {
    if v.is_null() {
        fallback
    } else {
        v.clone()
    }
}

/// How better-sqlite3 binds a JS value drizzle passes through unchanged
/// (numbers always as doubles, booleans as drizzle's boolean-mode 1/0).
pub(crate) fn bind(v: &Value) -> SqlValue {
    match v {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(i64::from(*b)),
        Value::Number(n) => n.as_f64().map_or(SqlValue::Null, SqlValue::Real),
        Value::String(s) => SqlValue::Text(s.clone()),
        Value::Array(_) | Value::Object(_) => SqlValue::Text(v.to_string()),
    }
}

/// An f64 bound by better-sqlite3 (NaN is stored as NULL by SQLite itself).
fn bind_f64(f: f64) -> SqlValue {
    SqlValue::Real(f)
}

/// Months between premiums for a policy's frequency.
fn premium_step_months(freq: &str) -> f64 {
    match freq {
        "monthly" => 1.0,
        "quarterly" => 3.0,
        _ => 12.0,
    }
}

/// `premiumDueDates(policy)`: every premium due date over the premium term,
/// as calendar dates, `k × step` months from the start (clamped to month end).
pub fn premium_due_dates(
    start_date: &str,
    premium_frequency: &str,
    premium_term_years: f64,
) -> Vec<String> {
    let start = js_slice(start_date, 0, 10);
    let end_of_term = add_months_iso(&start, 12.0 * premium_term_years, None);
    let step = premium_step_months(premium_frequency);
    let anchor = day_of_month(&start);
    let mut dates = Vec::new();
    for k in 0..12 * 200 {
        let due = add_months_iso(&start, f64::from(k) * step, anchor);
        if js_str_cmp(&due, &end_of_term).is_ge() {
            break;
        }
        dates.push(due);
    }
    dates
}

/// The `asOf` argument of `computeInvestedAt`: a `Date` (time value) or a string.
#[derive(Debug, Clone, Copy)]
pub enum AsOf<'a> {
    /// A JS `Date`, as milliseconds since the epoch (NaN for an invalid date).
    Date(f64),
    /// A date string; only its first 10 characters are used.
    Iso(&'a str),
}

/// `computeInvestedAt(policy, asOf)`: premiums paid by `asOf`, in the policy's currency.
pub fn compute_invested_at(policy: &PolicyRow, as_of: AsOf<'_>) -> ApiResult<f64> {
    let cutoff = match as_of {
        AsOf::Iso(s) => js_slice(s, 0, 10),
        AsOf::Date(t) => local_iso_date(t),
    };
    let paid = policy
        .premium_due_dates()?
        .iter()
        .filter(|d| js_str_cmp(d, &cutoff).is_le())
        .count();
    Ok(paid as f64 * to_number(&policy.premium_amount))
}

fn compute_total_invested(policy: &PolicyRow) -> ApiResult<f64> {
    compute_invested_at(policy, AsOf::Date(now_ms()))
}

/// `balanceDelta({ type, payee, amount })`.
fn balance_delta(kind: &Value, payee: &Value, amount: &Value) -> Option<f64> {
    match kind.as_str() {
        Some("income") => Some(to_number(amount)),
        Some("expense") => Some(-to_number(amount)),
        Some("transfer") => match payee.as_str() {
            Some(TRANSFER_IN) => Some(to_number(amount)),
            Some(TRANSFER_OUT) => Some(-to_number(amount)),
            _ => None,
        },
        _ => None,
    }
}

/// `getAccountLiveBalance(db, accountId)`: `(account.balance ?? 0) + delta`
/// (string concatenation when the stored balance is text, as in JS).
fn get_account_live_balance(conn: &Connection, account_id: &Value) -> ApiResult<Value> {
    let account_id = bind(account_id);
    let balance: Option<Value> = conn
        .query_row(
            "SELECT id, name, type, currency, balance, institution, is_active, off_budget, \
             created_at, updated_at FROM accounts WHERE id = ? LIMIT 1",
            [&account_id],
            |r| Ok(from_sql(r.get_ref(4)?)),
        )
        .optional()?;
    let Some(balance) = balance else {
        return Ok(number(0.0));
    };

    let mut stmt = conn.prepare(
        "SELECT type, payee, sum(amount) FROM transactions WHERE account_id = ? \
         GROUP BY type, payee",
    )?;
    let totals = stmt
        .query_map([&account_id], |r| {
            Ok((
                from_sql(r.get_ref(0)?),
                from_sql(r.get_ref(1)?),
                from_sql(r.get_ref(2)?),
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut delta = 0.0;
    for (kind, payee, total) in totals {
        match balance_delta(&kind, &payee, &total) {
            Some(signed) => delta += signed,
            None => {
                let account = match &account_id {
                    SqlValue::Text(s) => s.clone(),
                    other => format!("{other:?}"),
                };
                tracing::error!(
                    "[policy] account {account}: {} rows with payee \"{}\" have no balance \
                     direction and are excluded from the invested total (transfer legs must be \
                     \"{TRANSFER_IN}\" or \"{TRANSFER_OUT}\")",
                    js_property_key(&kind),
                    js_property_key(&payee),
                );
            }
        }
    }

    Ok(match balance {
        Value::Null => number(0.0 + delta),
        Value::String(s) => Value::String(format!("{s}{}", js_number_to_string(delta))),
        other => number(to_number(&other) + delta),
    })
}

fn select_payouts(conn: &Connection, policy_id: &Value) -> ApiResult<Vec<PayoutResponse>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {PAYOUT_COLS} FROM policy_payouts WHERE policy_id = ? ORDER BY payout_date"
    ))?;
    let rows = stmt
        .query_map([bind(policy_id)], PayoutRow::from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows.into_iter().map(to_payout_response).collect())
}

/// `toPolicyResponse(row, rates)`.
fn to_policy_response(
    conn: &Connection,
    row: PolicyRow,
    rates: &Rates,
) -> ApiResult<PolicyResponse> {
    let payouts = select_payouts(conn, &row.id)?;

    let currency = currency_or_inr(&row.currency);
    let premium_inr = to_inr(to_number(&row.premium_amount), &currency, rates);
    let sum_assured_inr = to_inr(to_number(&row.sum_assured), &currency, rates);
    let maturity_value_inr = to_inr(to_number(&row.maturity_value), &currency, rates);
    let surrender_value_inr = if row.surrender_value.is_null() {
        Value::Null
    } else {
        number(to_inr(to_number(&row.surrender_value), &currency, rates))
    };
    let mut total_invested = number(compute_total_invested(&row)?);
    if truthy(Some(&row.account_id)) {
        total_invested = get_account_live_balance(conn, &row.account_id)?;
    }
    let total_invested_inr = to_inr(to_number(&total_invested), &currency, rates);

    Ok(PolicyResponse {
        id: row.id,
        name: row.name,
        provider: row.provider,
        policy_number: row.policy_number,
        start_date: row.start_date,
        currency,
        premium_amount: row.premium_amount,
        premium_amount_inr: number(premium_inr),
        premium_frequency: row.premium_frequency,
        premium_term_years: row.premium_term_years,
        policy_term_years: row.policy_term_years,
        maturity_date: row.maturity_date,
        sum_assured: row.sum_assured,
        sum_assured_inr: number(sum_assured_inr),
        maturity_value: row.maturity_value,
        maturity_value_inr: number(maturity_value_inr),
        surrender_value: row.surrender_value,
        surrender_value_inr,
        total_invested,
        total_invested_inr: number(total_invested_inr),
        notes: row.notes,
        account_id: row.account_id,
        payouts,
        created_at: or_value(&row.created_at, Value::String(String::new())),
        updated_at: or_value(&row.updated_at, Value::String(String::new())),
    })
}

/// `getNextPremiumDate(policy)`: next premium due strictly after today (local).
fn get_next_premium_date(policy: &PolicyRow) -> ApiResult<Option<String>> {
    let today = local_iso_today();
    Ok(policy
        .premium_due_dates()?
        .into_iter()
        .find(|d| js_str_cmp(d, &today).is_gt()))
}

fn not_found() -> ApiError {
    ApiError::service(404, "Policy not found")
}

fn payout_not_found() -> ApiError {
    ApiError::service(404, "Payout not found")
}

// ─── Service methods ──────────────────────────────────────────────────────────

/// `listPolicies()`.
pub fn list_policies(conn: &Connection) -> ApiResult<Vec<PolicyResponse>> {
    let mut stmt = conn.prepare(&format!("SELECT {POLICY_COLS} FROM policies ORDER BY name"))?;
    let rows = stmt
        .query_map([], PolicyRow::from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    let rates = get_latest_rates(conn)?;
    rows.into_iter()
        .map(|r| to_policy_response(conn, r, &rates))
        .collect()
}

/// `createPolicy(data)`: also creates the companion `policy` account.
/// `data` is the parsed `CreatePolicySchema` output.
pub fn create_policy(conn: &Connection, data: &Map<String, Value>) -> ApiResult<PolicyResponse> {
    let base_currency = get_base_currency(conn)?;
    let currency = data
        .get("currency")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(Value::String(base_currency));
    let account_id = nanoid();
    let null = Value::Null;
    conn.execute(
        "INSERT INTO accounts (id, name, type, currency, balance, institution, is_active, \
         off_budget, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params_from_iter([
            SqlValue::Text(account_id.clone()),
            bind(data.get("name").unwrap_or(&null)),
            SqlValue::Text("policy".into()),
            bind(&currency),
            bind_f64(0.0),
            bind(data.get("provider").unwrap_or(&null)),
            SqlValue::Integer(1),
            SqlValue::Integer(1),
            SqlValue::Text(now_iso()),
            SqlValue::Text(now_iso()),
        ]),
    )?;

    let mut cols: Vec<String> = vec!["id".into()];
    let mut vals: Vec<SqlValue> = vec![SqlValue::Text(nanoid())];
    for (k, v) in data {
        if k != "account_id" {
            cols.push(k.clone());
            vals.push(bind(v));
        }
    }
    cols.extend([
        "account_id".into(),
        "created_at".into(),
        "updated_at".into(),
    ]);
    vals.extend([
        SqlValue::Text(account_id),
        SqlValue::Text(now_iso()),
        SqlValue::Text(now_iso()),
    ]);
    let placeholders = vec!["?"; cols.len()].join(", ");
    let row = conn.query_row(
        &format!(
            "INSERT INTO policies ({}) VALUES ({placeholders}) RETURNING {POLICY_COLS}",
            cols.join(", ")
        ),
        params_from_iter(vals),
        PolicyRow::from_row,
    )?;

    let rates = get_latest_rates(conn)?;
    to_policy_response(conn, row, &rates)
}

/// `updatePolicy(id, data)`: also syncs the companion account's name,
/// institution, currency and balance (the scheduled premiums paid to date).
pub fn update_policy(
    conn: &Connection,
    id: &str,
    data: &Map<String, Value>,
) -> ApiResult<PolicyResponse> {
    let mut sets: Vec<String> = Vec::new();
    let mut vals: Vec<SqlValue> = Vec::new();
    for (k, v) in data {
        sets.push(format!("{k} = ?"));
        vals.push(bind(v));
    }
    sets.push("updated_at = ?".into());
    vals.push(SqlValue::Text(now_iso()));
    vals.push(SqlValue::Text(id.to_string()));
    let row = conn
        .query_row(
            &format!(
                "UPDATE policies SET {} WHERE id = ? RETURNING {POLICY_COLS}",
                sets.join(", ")
            ),
            params_from_iter(vals),
            PolicyRow::from_row,
        )
        .optional()?
        .ok_or_else(not_found)?;

    if truthy(Some(&row.account_id)) {
        let actual_invested = compute_total_invested(&row)?;
        conn.execute(
            "UPDATE accounts SET name = ?, currency = ?, balance = ?, institution = ?, \
             updated_at = ? WHERE id = ?",
            params_from_iter([
                bind(&row.name),
                bind(&row.currency),
                bind_f64(actual_invested),
                bind(&row.provider),
                SqlValue::Text(now_iso()),
                bind(&row.account_id),
            ]),
        )?;
    }

    let rates = get_latest_rates(conn)?;
    to_policy_response(conn, row, &rates)
}

/// The parameters better-sqlite3 binds for one argument drizzle passes
/// through unchanged: a scalar is one parameter and an array is spread into
/// its elements; booleans, objects and nested arrays throw.
fn spread_params(v: &Value) -> ApiResult<Vec<SqlValue>> {
    let cannot_bind = || {
        ApiError::internal(
            "TypeError: SQLite3 can only bind numbers, strings, bigints, buffers, and null",
        )
    };
    match v {
        Value::String(_) | Value::Number(_) | Value::Null => Ok(vec![bind(v)]),
        Value::Array(items) => items
            .iter()
            .map(|i| match i {
                Value::String(_) | Value::Number(_) | Value::Null => Ok(bind(i)),
                _ => Err(cannot_bind()),
            })
            .collect(),
        _ => Err(cannot_bind()),
    }
}

/// `String(value)` for a JSON value (`Array.prototype.toString` joins with ",").
fn js_to_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Array(items) => items
            .iter()
            .map(|i| match i {
                Value::Null => String::new(),
                other => js_to_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
        other => js_property_key(other),
    }
}

/// `opts.end_date.slice(0, 10)` coerced to the string `due > …` compares with.
fn end_date_bound(v: Option<&Value>) -> ApiResult<String> {
    match v {
        Some(Value::String(s)) => Ok(js_slice(s, 0, 10)),
        Some(Value::Array(items)) => Ok(js_to_string(&Value::Array(
            items.iter().take(10).cloned().collect(),
        ))),
        _ => Err(ApiError::internal(
            "TypeError: opts.end_date.slice is not a function",
        )),
    }
}

/// `generatePayouts(policyId, opts)`. `opts` is the raw request body (the
/// route only checks that the five fields are truthy).
pub fn generate_payouts(conn: &Connection, policy_id: &str, opts: &Value) -> ApiResult<usize> {
    if select_policy(conn, policy_id)?.is_none() {
        return Err(not_found());
    }
    let get = |k: &str| opts.as_object().and_then(|o| o.get(k));

    let months_step = premium_step_months(get("frequency").and_then(Value::as_str).unwrap_or(""));
    let start_date = match get("start_date") {
        Some(Value::String(s)) => s.clone(),
        _ => {
            return Err(ApiError::internal(
                "TypeError: iso.slice(...).split is not a function",
            ))
        }
    };
    let anchor = day_of_month(&start_date);
    let mut dates: Vec<String> = Vec::new();
    for k in 0..12 * 200 {
        let due = add_months_iso(&start_date, f64::from(k) * months_step, anchor);
        let end = end_date_bound(get("end_date"))?;
        if js_str_cmp(&due, &end).is_gt() {
            break;
        }
        dates.push(due);
    }

    if dates.is_empty() {
        return Ok(0);
    }

    let null = Value::Null;
    // amount and label are spread like better-sqlite3 does; the statement
    // fails unless together they still make up exactly two parameters.
    let mut middle = spread_params(get("amount").unwrap_or(&null))?;
    middle.extend(spread_params(get("label").unwrap_or(&null))?);
    if middle.len() != 2 {
        return Err(ApiError::internal(if middle.len() > 2 {
            "RangeError: Too many parameter values were provided"
        } else {
            "RangeError: Too few parameter values were provided"
        }));
    }
    let rows = vec!["(?, ?, ?, ?, ?, ?)"; dates.len()].join(", ");
    let mut vals: Vec<SqlValue> = Vec::with_capacity(dates.len() * 6);
    for d in &dates {
        vals.extend([
            SqlValue::Text(nanoid()),
            SqlValue::Text(policy_id.to_string()),
            SqlValue::Text(d.clone()),
        ]);
        vals.extend(middle.iter().cloned());
        vals.push(SqlValue::Integer(0));
    }
    conn.execute(
        &format!(
            "INSERT INTO policy_payouts (id, policy_id, payout_date, amount, label, is_received) \
             VALUES {rows}"
        ),
        params_from_iter(vals),
    )?;
    Ok(dates.len())
}

/// `deletePolicy(id)`: payouts, the policy, then its companion account.
pub fn delete_policy(conn: &Connection, id: &str) -> ApiResult<()> {
    let policy = conn
        .query_row(
            &format!("SELECT {POLICY_COLS} FROM policies WHERE id = ? LIMIT 1"),
            [id],
            PolicyRow::from_row,
        )
        .optional()?;

    conn.execute("DELETE FROM policy_payouts WHERE policy_id = ?", [id])?;
    let deleted: Option<Value> = conn
        .query_row(
            &format!("DELETE FROM policies WHERE id = ? RETURNING {POLICY_COLS}"),
            [id],
            |r| Ok(from_sql(r.get_ref(0)?)),
        )
        .optional()?;
    if deleted.is_none() {
        return Err(not_found());
    }

    if let Some(policy) = policy.filter(|p| truthy(Some(&p.account_id))) {
        conn.execute(
            "DELETE FROM accounts WHERE id = ?",
            [bind(&policy.account_id)],
        )?;
    }
    Ok(())
}

/// `getPayouts(policyId)`.
pub fn get_payouts(conn: &Connection, policy_id: &str) -> ApiResult<Vec<PayoutResponse>> {
    select_payouts(conn, &Value::String(policy_id.to_string()))
}

/// `addPayout(policyId, data)`; `data` is the parsed `CreatePayoutSchema` output.
pub fn add_payout(
    conn: &Connection,
    policy_id: &str,
    data: &Map<String, Value>,
) -> ApiResult<PayoutResponse> {
    let mut cols: Vec<String> = vec!["id".into()];
    let mut vals: Vec<SqlValue> = vec![SqlValue::Text(nanoid())];
    for (k, v) in data {
        if k != "policy_id" {
            cols.push(k.clone());
            vals.push(bind(v));
        }
    }
    cols.push("policy_id".into());
    vals.push(SqlValue::Text(policy_id.to_string()));
    let placeholders = vec!["?"; cols.len()].join(", ");
    let row = conn.query_row(
        &format!(
            "INSERT INTO policy_payouts ({}) VALUES ({placeholders}) RETURNING {PAYOUT_COLS}",
            cols.join(", ")
        ),
        params_from_iter(vals),
        PayoutRow::from_row,
    )?;
    Ok(to_payout_response(row))
}

/// `markPayoutReceived(policyId, payoutId)`. The update runs before the
/// policy check, so a mismatched policy id still marks the payout (QUIRKS.md).
pub fn mark_payout_received(
    conn: &Connection,
    policy_id: &str,
    payout_id: &str,
) -> ApiResult<PayoutResponse> {
    let row = conn
        .query_row(
            &format!(
                "UPDATE policy_payouts SET is_received = ? WHERE id = ? RETURNING {PAYOUT_COLS}"
            ),
            params_from_iter([SqlValue::Integer(1), SqlValue::Text(payout_id.to_string())]),
            PayoutRow::from_row,
        )
        .optional()?;
    match row {
        Some(row) if row.policy_id.as_str() == Some(policy_id) => Ok(to_payout_response(row)),
        _ => Err(payout_not_found()),
    }
}

/// `updatePayout(policyId, payoutId, data)`; `data` is the parsed
/// `UpdatePayoutSchema` output. An empty update throws drizzle's
/// "No values to set" (a 500), like Node.
pub fn update_payout(
    conn: &Connection,
    policy_id: &str,
    payout_id: &str,
    data: &Map<String, Value>,
) -> ApiResult<PayoutResponse> {
    if data.is_empty() {
        return Err(ApiError::plain("No values to set"));
    }
    let mut sets: Vec<String> = Vec::new();
    let mut vals: Vec<SqlValue> = Vec::new();
    for (k, v) in data {
        sets.push(format!("{k} = ?"));
        vals.push(bind(v));
    }
    vals.push(SqlValue::Text(payout_id.to_string()));
    let row = conn
        .query_row(
            &format!(
                "UPDATE policy_payouts SET {} WHERE id = ? RETURNING {PAYOUT_COLS}",
                sets.join(", ")
            ),
            params_from_iter(vals),
            PayoutRow::from_row,
        )
        .optional()?;
    match row {
        Some(row) if row.policy_id.as_str() == Some(policy_id) => Ok(to_payout_response(row)),
        _ => Err(payout_not_found()),
    }
}

/// `new Date(value)` for a column value.
fn js_new_date(v: &Value) -> f64 {
    match v {
        Value::String(s) => parse_date(s),
        Value::Number(n) => time_clip(n.as_f64().unwrap_or(f64::NAN)),
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        _ => f64::NAN,
    }
}

/// `a.date.localeCompare(b.date)` for the calendar-date strings the timeline
/// holds (digits and `-`, where ICU's root collation agrees with code-unit order).
fn locale_compare(a: &Value, b: &Value) -> std::cmp::Ordering {
    js_str_cmp(&js_property_key(a), &js_property_key(b))
}

/// `getTimeline(years)`: maturities, the next premium and payouts up to
/// `years` from now, sorted by date.
pub fn get_timeline(conn: &Connection, years: f64) -> ApiResult<Vec<TimelineEvent>> {
    let all_policies = select_policies(conn)?;
    let mut stmt = conn.prepare(&format!("SELECT {PAYOUT_COLS} FROM policy_payouts"))?;
    let all_payouts = stmt
        .query_map([], PayoutRow::from_row)?
        .collect::<Result<Vec<_>, _>>()?;

    let now = now_ms();
    let cutoff = set_full_year_local(now, local_full_year(now) + years);
    let cutoff_iso = local_iso_date(cutoff);
    let mut events: Vec<TimelineEvent> = Vec::new();

    for p in &all_policies {
        let maturity = js_new_date(&p.maturity_date);
        if maturity <= cutoff {
            events.push(TimelineEvent {
                kind: "maturity",
                date: p.maturity_date.clone(),
                policy_id: p.id.clone(),
                policy_name: p.name.clone(),
                amount: p.maturity_value.clone(),
                label: Value::String("Policy Maturity".into()),
            });
        }

        if let Some(next) = get_next_premium_date(p)? {
            if js_str_cmp(&next, &cutoff_iso).is_le() {
                events.push(TimelineEvent {
                    kind: "premium_due",
                    date: Value::String(next),
                    policy_id: p.id.clone(),
                    policy_name: p.name.clone(),
                    amount: p.premium_amount.clone(),
                    label: Value::String(format!(
                        "{} premium",
                        js_property_key(&p.premium_frequency)
                    )),
                });
            }
        }
    }

    for po in all_payouts {
        let payout_date = js_new_date(&po.payout_date);
        if payout_date <= cutoff {
            let policy_name = all_policies
                .iter()
                .find(|p| p.id == po.policy_id)
                .map(|p| or_value(&p.name, Value::String(String::new())))
                .unwrap_or(Value::String(String::new()));
            events.push(TimelineEvent {
                kind: "payout",
                date: po.payout_date,
                policy_id: po.policy_id,
                policy_name,
                amount: po.amount,
                label: po.label,
            });
        }
    }

    events.sort_by(|a, b| locale_compare(&a.date, &b.date));
    Ok(events)
}

/// `getUpcomingAlerts(days)`: policies whose next premium is due within `days`.
pub fn get_upcoming_alerts(conn: &Connection, days: f64) -> ApiResult<Vec<PolicyAlert>> {
    let all_policies = select_policies(conn)?;
    let today = now_ms();
    let mut alerts: Vec<(f64, PolicyAlert)> = Vec::new();

    for p in all_policies {
        let Some(next) = get_next_premium_date(&p)? else {
            continue;
        };
        let days_until = days_between_iso(&local_iso_date(today), &next);
        if days_until <= days {
            alerts.push((
                days_until,
                PolicyAlert {
                    policy_id: p.id,
                    policy_name: p.name,
                    next_premium_date: next,
                    premium_amount: p.premium_amount,
                    days_until_due: number(days_until),
                },
            ));
        }
    }

    alerts.sort_by(|a, b| {
        (a.0 - b.0)
            .partial_cmp(&0.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(alerts.into_iter().map(|(_, a)| a).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().expect("open");
        crate::db::bootstrap::bootstrap_schema(&c).expect("bootstrap");
        c
    }

    fn policy(over: Value) -> PolicyRow {
        // dashboard.test.ts `policy({})`
        let mut base = json!({
            "id": "pol-1", "name": "Endowment", "provider": "LIC", "policy_number": null,
            "currency": "INR", "start_date": "2026-01-01", "premium_amount": 1000,
            "premium_frequency": "monthly", "premium_term_years": 10, "policy_term_years": 20,
            "maturity_date": "2046-01-01", "sum_assured": 500000, "maturity_value": 500000,
            "surrender_value": null, "notes": null, "account_id": null,
            "created_at": "", "updated_at": ""
        });
        if let (Some(b), Some(o)) = (base.as_object_mut(), over.as_object()) {
            for (k, v) in o {
                b.insert(k.clone(), v.clone());
            }
        }
        let g = |k: &str| base.get(k).cloned().unwrap_or(Value::Null);
        PolicyRow {
            id: g("id"),
            name: g("name"),
            provider: g("provider"),
            policy_number: g("policy_number"),
            currency: g("currency"),
            start_date: g("start_date"),
            premium_amount: g("premium_amount"),
            premium_frequency: g("premium_frequency"),
            premium_term_years: g("premium_term_years"),
            policy_term_years: g("policy_term_years"),
            maturity_date: g("maturity_date"),
            sum_assured: g("sum_assured"),
            maturity_value: g("maturity_value"),
            surrender_value: g("surrender_value"),
            notes: g("notes"),
            account_id: g("account_id"),
            created_at: g("created_at"),
            updated_at: g("updated_at"),
        }
    }

    // dates.test.ts: "policy premium schedule"
    #[test]
    fn premium_schedule_lists_each_premium_once_on_its_day() {
        let dates = premium_due_dates("2026-01-31", "monthly", 1.0);
        assert_eq!(dates.len(), 12);
        assert_eq!(&dates[..3], ["2026-01-31", "2026-02-28", "2026-03-31"]);
        assert_eq!(dates[11], "2026-12-31");
    }

    #[test]
    fn premium_schedule_frequencies_and_odd_input() {
        assert_eq!(
            premium_due_dates("2026-11-30", "quarterly", 1.0),
            ["2026-11-30", "2027-02-28", "2027-05-30", "2027-08-30"]
        );
        // Unknown frequencies step annually.
        assert_eq!(
            premium_due_dates("2024-02-29", "weekly", 3.0),
            ["2024-02-29", "2025-02-28", "2026-02-28"]
        );
        // The time part of a stored datetime is ignored.
        assert_eq!(
            premium_due_dates("2026-01-15T10:00:00Z", "annual", 2.0),
            ["2026-01-15", "2027-01-15"]
        );
        // "NaN-NaN-NaN" >= "NaN-NaN-NaN" ends the loop at once.
        assert!(premium_due_dates("garbage", "monthly", 1.0).is_empty());
        assert!(premium_due_dates("2026-01-01", "monthly", 0.0).is_empty());
        assert_eq!(
            premium_due_dates("2026-01-01", "monthly", 1000.0).len(),
            2400
        );
    }

    // dashboard.test.ts: "values an unlinked policy at the premiums paid by that date"
    #[test]
    fn invested_at_counts_premiums_paid_by_the_date() {
        let p = policy(json!({}));
        assert_eq!(
            compute_invested_at(&p, AsOf::Iso("2026-03-31")).ok(),
            Some(3000.0)
        );
        assert_eq!(
            compute_invested_at(&p, AsOf::Iso("2026-06-30")).ok(),
            Some(6000.0)
        );
        assert_ne!(
            compute_invested_at(&p, AsOf::Iso("2026-03-31")).ok(),
            Some(1000.0 * 12.0 * 10.0)
        );
        // Strings are cut to the date; Dates use the local calendar day.
        assert_eq!(
            compute_invested_at(&p, AsOf::Iso("2026-03-31T23:59:59Z")).ok(),
            Some(3000.0)
        );
        let local_noon = dates::utc_from_local(dates::make_date(
            dates::make_day(2026.0, 2.0, 31.0),
            12.0 * 3_600_000.0,
        ));
        assert_eq!(
            compute_invested_at(&p, AsOf::Date(local_noon)).ok(),
            Some(3000.0)
        );
        assert_eq!(
            compute_invested_at(&p, AsOf::Iso("2025-12-31")).ok(),
            Some(0.0)
        );
    }

    // dashboard.test.ts: "converts an unlinked policy's premiums at its own currency"
    #[test]
    fn invested_converts_at_the_policy_currency() {
        let p = policy(json!({ "currency": "USD" }));
        let rates: Rates = vec![("INR".into(), json!(1.0)), ("USD".into(), json!(80))];
        let invested = compute_invested_at(&p, AsOf::Iso("2026-03-31")).unwrap_or(f64::NAN);
        assert_eq!(
            to_inr(invested, &currency_or_inr(&p.currency), &rates),
            3000.0 * 80.0
        );
        assert!(to_inr(1.0, &json!("constructor"), &rates).is_nan());
        assert_eq!(to_inr(2.0, &json!("XYZ"), &rates), 2.0);
    }

    #[test]
    fn create_update_delete_roundtrip() {
        let c = conn();
        let data = schemas::parse(
            schemas::CREATE_POLICY,
            Some(&json!({
                "name": "Plan", "provider": "LIC", "start_date": "2020-01-15",
                "premium_amount": 100, "premium_frequency": "annual",
                "premium_term_years": 5, "policy_term_years": 10,
                "maturity_date": "2030-01-15", "sum_assured": 1000, "maturity_value": 2000,
                "account_id": "ignored"
            })),
        )
        .expect("valid");
        let created = create_policy(&c, &data).expect("create");
        assert_eq!(created.currency, json!("INR"));
        assert_eq!(created.total_invested, json!(0.0));
        let acc = created.account_id.as_str().unwrap_or_default().to_string();
        assert_ne!(acc, "ignored");
        let id = created.id.as_str().unwrap_or_default().to_string();

        let upd = schemas::parse(schemas::UPDATE_POLICY, Some(&json!({ "name": "Renamed" })))
            .expect("valid");
        let updated = update_policy(&c, &id, &upd).expect("update");
        assert_eq!(updated.name, json!("Renamed"));
        // 2020..2024 premiums are all in the past: the account holds 5 × 100.
        assert_eq!(updated.total_invested, json!(500.0));
        let name: String = c
            .query_row("SELECT name FROM accounts WHERE id = ?", [&acc], |r| {
                r.get(0)
            })
            .expect("account");
        assert_eq!(name, "Renamed");

        assert!(matches!(
            update_policy(&c, "missing", &upd),
            Err(ApiError::Service {
                status: Some(404),
                ..
            })
        ));
        delete_policy(&c, &id).expect("delete");
        let left: i64 = c
            .query_row("SELECT count(*) FROM accounts WHERE id = ?", [&acc], |r| {
                r.get(0)
            })
            .expect("count");
        assert_eq!(left, 0);
        assert!(delete_policy(&c, &id).is_err());
    }

    #[test]
    fn payouts_generate_and_mark() {
        let c = conn();
        c.execute(
            "INSERT INTO policies (id, name, provider, start_date, premium_amount, \
             premium_frequency, premium_term_years, policy_term_years, maturity_date, \
             sum_assured, maturity_value) VALUES ('p1', 'P', 'X', '2026-01-31', 10, 'monthly', \
             1, 1, '2027-01-31', 1, 1)",
            [],
        )
        .expect("insert");
        let body = json!({
            "start_date": "2026-01-31", "end_date": "2026-05-31", "amount": 5,
            "frequency": "monthly", "label": "Bonus"
        });
        assert_eq!(generate_payouts(&c, "p1", &body).ok(), Some(5));
        let payouts = get_payouts(&c, "p1").expect("payouts");
        let dates: Vec<&str> = payouts
            .iter()
            .filter_map(|p| p.payout_date.as_str())
            .collect();
        assert_eq!(
            dates,
            [
                "2026-01-31",
                "2026-02-28",
                "2026-03-31",
                "2026-04-30",
                "2026-05-31"
            ]
        );
        let pid = payouts[0].id.as_str().unwrap_or_default().to_string();
        // Wrong policy: 404, but the payout is marked anyway (QUIRKS.md).
        assert!(mark_payout_received(&c, "other", &pid).is_err());
        let again = get_payouts(&c, "p1").expect("payouts");
        assert!(again[0].is_received);
        assert!(update_payout(&c, "p1", &pid, &Map::new()).is_err());
        assert!(generate_payouts(&c, "nope", &body).is_err());
        let bad = json!({
            "start_date": "2026-01-31", "end_date": "2026-05-31", "amount": true,
            "frequency": "monthly", "label": "Bonus"
        });
        assert!(matches!(
            generate_payouts(&c, "p1", &bad),
            Err(ApiError::Internal(_))
        ));
    }
}
