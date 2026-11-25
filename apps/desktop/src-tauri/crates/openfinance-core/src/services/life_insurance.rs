//! Port of `apps/server/src/services/life-insurance.service.ts`.
//! Owner: Wave 1 (policies).

use std::collections::HashMap;
use std::path::Path;

use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, Connection, OptionalExtension, Row};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::error::{ApiError, ApiResult};
use crate::ids::nanoid;
use crate::js::now_iso;
use crate::json::{from_sql, number, to_number, truthy};
use crate::services::document;
use crate::services::exchange_rate::get_latest_rates;
use crate::services::policy::dates::{js_round, now_ms, parse_date, MS_PER_DAY};
use crate::services::policy::{bind, currency_or_inr, js_property_key, or_value, to_inr, Rates};

const COLS: &str = "id, name, insured_person, provider, policy_number, currency, \
    coverage_amount, renewal_date, premium_amount, premium_frequency, created_at, updated_at";

/// A `life_insurance` row as drizzle returns it.
#[derive(Debug, Clone, PartialEq)]
struct LifeInsuranceRow {
    id: Value,
    name: Value,
    insured_person: Value,
    provider: Value,
    policy_number: Value,
    currency: Value,
    coverage_amount: Value,
    renewal_date: Value,
    premium_amount: Value,
    premium_frequency: Value,
    created_at: Value,
    updated_at: Value,
}

impl LifeInsuranceRow {
    fn from_row(r: &Row<'_>) -> rusqlite::Result<Self> {
        let v = |i: usize| -> rusqlite::Result<Value> { Ok(from_sql(r.get_ref(i)?)) };
        Ok(Self {
            id: v(0)?,
            name: v(1)?,
            insured_person: v(2)?,
            provider: v(3)?,
            policy_number: v(4)?,
            currency: v(5)?,
            coverage_amount: v(6)?,
            renewal_date: v(7)?,
            premium_amount: v(8)?,
            premium_frequency: v(9)?,
            created_at: v(10)?,
            updated_at: v(11)?,
        })
    }
}

/// `LifeInsuranceResponse`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LifeInsuranceResponse {
    pub id: Value,
    pub name: Value,
    pub insured_person: Value,
    pub provider: Value,
    pub policy_number: Value,
    pub currency: Value,
    pub coverage_amount: Value,
    pub coverage_amount_inr: Value,
    pub renewal_date: Value,
    pub days_to_renewal: Value,
    pub premium_amount: Value,
    pub premium_amount_inr: Value,
    pub premium_frequency: Value,
    pub annual_premium_inr: Value,
    pub document_count: Value,
    pub created_at: Value,
    pub updated_at: Value,
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// `daysUntil(date)`: whole days from today (UTC calendar day) to `date`,
/// read as `${date}T00:00:00Z`; 0 when that does not parse.
fn days_until(date: &Value) -> f64 {
    let target = parse_date(&format!("{}T00:00:00Z", js_property_key(date)));
    if target.is_nan() {
        return 0.0;
    }
    let today = (now_ms() / MS_PER_DAY).floor() * MS_PER_DAY;
    js_round((target - today) / 86_400_000.0)
}

/// `PAYMENTS_PER_YEAR[freq] ?? null` (an inherited object member is a
/// function, which multiplies to NaN).
fn payments_per_year(freq: &Value) -> Option<f64> {
    match js_property_key(freq).as_str() {
        "monthly" => Some(12.0),
        "quarterly" => Some(4.0),
        "annual" => Some(1.0),
        "constructor"
        | "__defineGetter__"
        | "__defineSetter__"
        | "hasOwnProperty"
        | "__lookupGetter__"
        | "__lookupSetter__"
        | "isPrototypeOf"
        | "propertyIsEnumerable"
        | "toString"
        | "valueOf"
        | "__proto__"
        | "toLocaleString" => Some(f64::NAN),
        _ => None,
    }
}

fn to_response(row: LifeInsuranceRow, rates: &Rates, document_count: f64) -> LifeInsuranceResponse {
    let currency = currency_or_inr(&row.currency);
    let premium_inr = if row.premium_amount.is_null() {
        None
    } else {
        Some(to_inr(to_number(&row.premium_amount), &currency, rates))
    };
    let per_year = if truthy(Some(&row.premium_frequency)) {
        payments_per_year(&row.premium_frequency)
    } else {
        None
    };
    let annual = match (premium_inr, per_year) {
        (Some(p), Some(n)) => number(p * n),
        _ => Value::Null,
    };

    LifeInsuranceResponse {
        id: row.id,
        name: row.name,
        insured_person: row.insured_person,
        provider: row.provider,
        policy_number: row.policy_number,
        coverage_amount_inr: number(to_inr(to_number(&row.coverage_amount), &currency, rates)),
        currency,
        coverage_amount: row.coverage_amount,
        days_to_renewal: number(days_until(&row.renewal_date)),
        renewal_date: row.renewal_date,
        premium_amount: row.premium_amount,
        premium_amount_inr: premium_inr.map_or(Value::Null, number),
        premium_frequency: row.premium_frequency,
        annual_premium_inr: annual,
        document_count: number(document_count),
        created_at: or_value(&row.created_at, Value::String(String::new())),
        updated_at: or_value(&row.updated_at, Value::String(String::new())),
    }
}

/// `documentCounts()`: document counts keyed by `life_insurance_id`.
fn document_counts(conn: &Connection) -> ApiResult<HashMap<String, f64>> {
    let mut stmt = conn.prepare(
        "SELECT life_insurance_id, count(*) FROM investment_documents \
         GROUP BY life_insurance_id",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok((from_sql(r.get_ref(0)?), from_sql(r.get_ref(1)?)))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut counts = HashMap::new();
    for (id, count) in rows {
        if truthy(Some(&id)) {
            counts.insert(js_property_key(&id), to_number(&count));
        }
    }
    Ok(counts)
}

fn count_for(counts: &HashMap<String, f64>, id: &Value) -> f64 {
    counts.get(&js_property_key(id)).copied().unwrap_or(0.0)
}

fn not_found() -> ApiError {
    ApiError::service(404, "Life insurance policy not found")
}

fn select_one(conn: &Connection, id: &str) -> ApiResult<Option<LifeInsuranceRow>> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLS} FROM life_insurance WHERE id = ? LIMIT 1"),
            [id],
            LifeInsuranceRow::from_row,
        )
        .optional()?)
}

// ─── Service methods ──────────────────────────────────────────────────────────

/// `listLifeInsurance()`, ordered by renewal date.
pub fn list_life_insurance(conn: &Connection) -> ApiResult<Vec<LifeInsuranceResponse>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM life_insurance ORDER BY renewal_date"
    ))?;
    let rows = stmt
        .query_map([], LifeInsuranceRow::from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    let rates = get_latest_rates(conn)?;
    let counts = document_counts(conn)?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let count = count_for(&counts, &r.id);
            to_response(r, &rates, count)
        })
        .collect())
}

/// `getLifeInsurance(id)`.
pub fn get_life_insurance(conn: &Connection, id: &str) -> ApiResult<LifeInsuranceResponse> {
    let row = select_one(conn, id)?.ok_or_else(not_found)?;
    let rates = get_latest_rates(conn)?;
    let counts = document_counts(conn)?;
    let count = count_for(&counts, &row.id);
    Ok(to_response(row, &rates, count))
}

/// `createLifeInsurance(data)`; `data` is the parsed `CreateLifeInsuranceSchema` output.
pub fn create_life_insurance(
    conn: &Connection,
    data: &Map<String, Value>,
) -> ApiResult<LifeInsuranceResponse> {
    let null = Value::Null;
    let get = |k: &str| bind(data.get(k).unwrap_or(&null));
    let row = conn.query_row(
        &format!(
            "INSERT INTO life_insurance (id, name, insured_person, provider, policy_number, \
             currency, coverage_amount, renewal_date, premium_amount, premium_frequency, \
             created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING {COLS}"
        ),
        params_from_iter([
            SqlValue::Text(nanoid()),
            get("name"),
            get("insured_person"),
            get("provider"),
            get("policy_number"),
            get("currency"),
            get("coverage_amount"),
            get("renewal_date"),
            get("premium_amount"),
            get("premium_frequency"),
            SqlValue::Text(now_iso()),
            SqlValue::Text(now_iso()),
        ]),
        LifeInsuranceRow::from_row,
    )?;
    let rates = get_latest_rates(conn)?;
    Ok(to_response(row, &rates, 0.0))
}

/// `updateLifeInsurance(id, data)`; `data` is the parsed `UpdateLifeInsuranceSchema` output.
pub fn update_life_insurance(
    conn: &Connection,
    id: &str,
    data: &Map<String, Value>,
) -> ApiResult<LifeInsuranceResponse> {
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
                "UPDATE life_insurance SET {} WHERE id = ? RETURNING {COLS}",
                sets.join(", ")
            ),
            params_from_iter(vals),
            LifeInsuranceRow::from_row,
        )
        .optional()?
        .ok_or_else(not_found)?;
    let rates = get_latest_rates(conn)?;
    let counts = document_counts(conn)?;
    let count = count_for(&counts, &row.id);
    Ok(to_response(row, &rates, count))
}

/// `deleteLifeInsurance(id)`: removes attached documents (rows and files)
/// first, then the policy. `uploads_dir` is `UPLOADS_DIR`
/// (`<data dir>/uploads/documents`).
pub fn delete_life_insurance(conn: &Connection, uploads_dir: &Path, id: &str) -> ApiResult<()> {
    if select_one(conn, id)?.is_none() {
        return Err(not_found());
    }
    let mut stmt =
        conn.prepare("SELECT id FROM investment_documents WHERE life_insurance_id = ?")?;
    let docs = stmt
        .query_map([id], |r| Ok(from_sql(r.get_ref(0)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    for doc in &docs {
        // `deleteDocument(doc.id)`: `id` is `TEXT PRIMARY KEY NOT NULL`, so
        // the value is always a string.
        document::delete_document(conn, uploads_dir, &js_property_key(doc))?;
    }
    conn.execute("DELETE FROM life_insurance WHERE id = ?", [id])?;
    Ok(())
}

/// `getRenewalAlerts(days)`: policies renewing within `days` (or overdue), soonest first.
pub fn get_renewal_alerts(conn: &Connection, days: f64) -> ApiResult<Vec<LifeInsuranceResponse>> {
    let mut all: Vec<(f64, LifeInsuranceResponse)> = list_life_insurance(conn)?
        .into_iter()
        .map(|p| (to_number(&p.days_to_renewal), p))
        .filter(|(d, _)| *d <= days)
        .collect();
    all.sort_by(|a, b| {
        (a.0 - b.0)
            .partial_cmp(&0.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(all.into_iter().map(|(_, p)| p).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::policy::schemas;
    use serde_json::json;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().expect("open");
        crate::db::bootstrap::bootstrap_schema(&c).expect("bootstrap");
        c
    }

    #[test]
    fn days_until_reads_utc_calendar_days() {
        assert_eq!(days_until(&json!("not a date")), 0.0);
        assert_eq!(days_until(&json!("2026-1-5")), 0.0);
        let today = (now_ms() / MS_PER_DAY).floor() * MS_PER_DAY;
        let iso = chrono::DateTime::from_timestamp_millis(today as i64 + 3 * 86_400_000)
            .map(|d| d.format("%Y-%m-%d").to_string())
            .unwrap_or_default();
        assert_eq!(days_until(&json!(iso)), 3.0);
    }

    #[test]
    fn crud_and_alerts() {
        let c = conn();
        let data = schemas::parse(
            schemas::CREATE_LIFE_INSURANCE,
            Some(&json!({
                "name": "Term", "insured_person": "Me", "provider": "LIC",
                "coverage_amount": 1000, "renewal_date": "2000-01-01",
                "premium_amount": 10, "premium_frequency": "quarterly"
            })),
        )
        .expect("valid");
        let created = create_life_insurance(&c, &data).expect("create");
        assert_eq!(created.currency, json!("INR"));
        assert_eq!(created.annual_premium_inr, json!(40.0));
        assert_eq!(created.document_count, json!(0.0));
        let id = created.id.as_str().unwrap_or_default().to_string();

        let alerts = get_renewal_alerts(&c, 60.0).expect("alerts");
        assert_eq!(alerts.len(), 1);
        assert!(get_renewal_alerts(&c, -1e9).expect("alerts").is_empty());

        let upd = schemas::parse(
            schemas::UPDATE_LIFE_INSURANCE,
            Some(&json!({ "premium_frequency": null })),
        )
        .expect("valid");
        let updated = update_life_insurance(&c, &id, &upd).expect("update");
        assert_eq!(updated.premium_frequency, Value::Null);
        assert_eq!(updated.annual_premium_inr, Value::Null);
        assert_eq!(updated.premium_amount_inr, json!(10.0));

        let dir = tempfile::tempdir().expect("tmp");
        std::fs::write(dir.path().join("doc.pdf"), b"x").expect("write");
        c.execute(
            "INSERT INTO investment_documents (id, name, file_name, file_size, mime_type, \
             life_insurance_id) VALUES ('d1', 'Doc', 'doc.pdf', 1, 'application/pdf', ?)",
            [&id],
        )
        .expect("doc");
        assert_eq!(
            get_life_insurance(&c, &id).expect("get").document_count,
            json!(1.0)
        );
        delete_life_insurance(&c, dir.path(), &id).expect("delete");
        assert!(!dir.path().join("doc.pdf").exists());
        assert!(get_life_insurance(&c, &id).is_err());
        assert!(delete_life_insurance(&c, dir.path(), &id).is_err());
    }
}
