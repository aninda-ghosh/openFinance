//! Port of `apps/server/src/services/exchange-rate.service.ts` (Wave 0).
//!
//! Rates are kept as JSON values where Node passes the raw column value
//! through (`row.rate_to_base ?? 1.0`), so odd stored values render the same.

use std::time::Duration;

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;

use crate::error::{ApiError, ApiResult};
use crate::ids::nanoid;
use crate::js::now_iso;
use crate::json::{from_sql, number, to_number, truthy};
use crate::state::AppState;

/// Supported currencies, also the display order (`CURRENCY_ORDER`).
pub const SUPPORTED: [&str; 7] = ["INR", "USD", "SGD", "GBP", "EUR", "JPY", "NTD"];

/// `ExchangeRateResponse` from `@openfinance/shared/api-contracts`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ExchangeRateResponse {
    pub from_currency: Value,
    pub rate_to_base: Value,
    pub source: Value,
    pub fetched_at: Value,
}

fn order_index(currency: &Value) -> i64 {
    currency
        .as_str()
        .and_then(|c| SUPPORTED.iter().position(|s| *s == c))
        .map_or(-1, |i| i as i64)
}

/// `getBaseCurrency()`: the `app_settings` row's value, or "USD".
pub fn get_base_currency(conn: &Connection) -> ApiResult<String> {
    let row: Option<Value> = conn
        .query_row(
            "SELECT base_currency FROM app_settings WHERE id = 'system' LIMIT 1",
            [],
            |r| Ok(from_sql(r.get_ref(0)?)),
        )
        .optional()?;
    Ok(match row {
        Some(Value::String(s)) => s,
        Some(Value::Null) | None => "USD".to_string(),
        // NOT NULL TEXT column; a non-text value would be stringified by JS
        // wherever it is used.
        Some(other) => other.to_string(),
    })
}

/// `updateBaseCurrency(base)`.
pub fn update_base_currency(conn: &Connection, base: &str) -> ApiResult<()> {
    let now = now_iso();
    conn.execute(
        "INSERT INTO app_settings (id, base_currency, updated_at) VALUES ('system', ?1, ?2) \
         ON CONFLICT (id) DO UPDATE SET base_currency = ?1, updated_at = ?3",
        rusqlite::params![base, now, now_iso()],
    )?;
    Ok(())
}

/// `getLatestRates()`: `{ [currency]: rate }` in JS insertion order (base first).
pub fn get_latest_rates(conn: &Connection) -> ApiResult<Vec<(String, Value)>> {
    let base = get_base_currency(conn)?;
    let mut stmt = conn.prepare(
        "SELECT id, from_currency, rate_to_base, source, fetched_at FROM exchange_rates ORDER BY fetched_at DESC",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok((from_sql(r.get_ref(1)?), from_sql(r.get_ref(2)?)))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut latest: Vec<(String, Value)> = vec![(base, number(1.0))];
    for (from, rate) in rows {
        let Some(cur) = from.as_str().filter(|c| SUPPORTED.contains(c)) else {
            continue;
        };
        // `!latest[cur]`: absent *or falsy* (0, "") entries are overwritten.
        match latest.iter_mut().find(|(k, _)| k == cur) {
            Some((_, existing)) if truthy(Some(existing)) => {}
            Some((_, existing)) => *existing = rate_or_one(rate),
            None => latest.push((cur.to_string(), rate_or_one(rate))),
        }
    }
    Ok(latest)
}

/// `row.rate_to_base ?? 1.0`.
fn rate_or_one(v: Value) -> Value {
    if v.is_null() {
        number(1.0)
    } else {
        v
    }
}

/// `getRate(fromCurrency)`: the latest stored rate, 1.0 for the base currency
/// or when none is stored. Returned as a JS number (`Number(value)`).
pub fn get_rate(conn: &Connection, from_currency: &str) -> ApiResult<f64> {
    let base = get_base_currency(conn)?;
    if from_currency == base {
        return Ok(1.0);
    }
    let row: Option<Value> = conn
        .query_row(
            "SELECT rate_to_base FROM exchange_rates WHERE from_currency = ? ORDER BY fetched_at DESC LIMIT 1",
            [from_currency],
            |r| Ok(from_sql(r.get_ref(0)?)),
        )
        .optional()?;
    Ok(match row {
        None | Some(Value::Null) => 1.0,
        Some(v) => to_number(&v),
    })
}

/// `saveRate(from, rate, source)`: inserts a row and echoes it.
pub fn save_rate(
    conn: &Connection,
    from_currency: &str,
    rate_to_base: f64,
    source: &str,
) -> ApiResult<ExchangeRateResponse> {
    let row = conn.query_row(
        "INSERT INTO exchange_rates (id, from_currency, rate_to_base, source, fetched_at) \
         VALUES (?, ?, ?, ?, ?) RETURNING from_currency, rate_to_base, source, fetched_at",
        rusqlite::params![nanoid(), from_currency, rate_to_base, source, now_iso()],
        |r| {
            Ok((
                from_sql(r.get_ref(0)?),
                from_sql(r.get_ref(1)?),
                from_sql(r.get_ref(2)?),
                from_sql(r.get_ref(3)?),
            ))
        },
    )?;
    let or = |v: Value, fallback: Value| if v.is_null() { fallback } else { v };
    Ok(ExchangeRateResponse {
        from_currency: row.0,
        rate_to_base: or(row.1, number(rate_to_base)),
        source: or(row.2, Value::String(source.to_string())),
        fetched_at: or(row.3, Value::String(now_iso())),
    })
}

/// `listRates()`: latest rates, `source: "stored"`, sorted by `CURRENCY_ORDER`.
pub fn list_rates(conn: &Connection) -> ApiResult<Vec<ExchangeRateResponse>> {
    let mut out: Vec<ExchangeRateResponse> = get_latest_rates(conn)?
        .into_iter()
        .map(|(currency, rate)| ExchangeRateResponse {
            from_currency: Value::String(currency),
            rate_to_base: rate,
            source: Value::String("stored".into()),
            fetched_at: Value::String(now_iso()),
        })
        .collect();
    out.sort_by_key(|r| order_index(&r.from_currency));
    Ok(out)
}

fn api_code(currency: &str) -> &str {
    if currency == "NTD" {
        "TWD"
    } else {
        currency
    }
}

fn fetch_failed() -> ApiError {
    ApiError::service(503, "Failed to fetch exchange rates from API")
}

/// Fetches `url` and returns `data.rates` when `data.result === "success"`.
async fn fetch_rates(state: &AppState, url: &str) -> Result<Value, String> {
    if state.config().no_network {
        // Test-only (parity harness): behave as if the network were down.
        return Err("TypeError: fetch failed".into());
    }
    let res = state
        .http()
        .get(url)
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("Error: HTTP {}", res.status().as_u16()));
    }
    let data: Value = res.json().await.map_err(|e| e.to_string())?;
    let rates = data.get("rates");
    if data.get("result").and_then(Value::as_str) == Some("success") && truthy(rates) {
        Ok(rates.cloned().unwrap_or(Value::Null))
    } else {
        Err("Error: Exchange rates response result was not success".into())
    }
}

/// `refreshFromWeb(currency?)`. `currency` is the raw `body?.currency` value
/// (`None` when absent): falsy refreshes all; a string filters by its
/// upper-cased value; any other truthy value throws in Node (`toUpperCase is
/// not a function`), which becomes a 500 after a successful fetch.
pub async fn refresh_from_web(
    state: &AppState,
    currency: Option<Value>,
) -> ApiResult<Vec<ExchangeRateResponse>> {
    let base = state.db(get_base_currency).await?;
    let url = format!("https://open.er-api.com/v6/latest/{}", api_code(&base));

    let rates = match fetch_rates(state, &url).await {
        Ok(rates) => rates,
        Err(err) => {
            tracing::error!("[exchange-rate] Failed to fetch live rates from {url}: {err}");
            return Err(fetch_failed());
        }
    };

    let targets: Vec<&'static str> = if truthy(currency.as_ref()) {
        match currency.as_ref().and_then(Value::as_str) {
            Some(c) => {
                let upper = c.to_uppercase();
                SUPPORTED.iter().copied().filter(|s| *s == upper).collect()
            }
            None => {
                return Err(ApiError::internal(
                    "TypeError: currency.toUpperCase is not a function",
                ))
            }
        }
    } else {
        SUPPORTED.to_vec()
    };

    let mut results = state
        .db(move |conn| {
            let mut results = Vec::new();
            for cur in targets {
                if cur == base {
                    results.push(save_rate(conn, cur, 1.0, "system_base")?);
                    continue;
                }
                let code = api_code(cur);
                let rate_in_base = rates.as_object().and_then(|o| o.get(code));
                let Some(rate_in_base) = rate_in_base.and_then(Value::as_f64) else {
                    tracing::warn!(
                        "[exchange-rate] Rate for {cur} (API code: {code}) not found in API response."
                    );
                    continue;
                };
                // 1 unit of cur = (1 / rateInBase) unit of base currency
                let conversion_rate = 1.0 / rate_in_base;
                results.push(save_rate(conn, cur, conversion_rate, "web_search")?);
            }
            Ok(results)
        })
        .await?;

    if results.is_empty() {
        return Err(ApiError::service(
            503,
            "All exchange rate refreshes failed — check network",
        ));
    }
    results.sort_by_key(|r| order_index(&r.from_currency));
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().expect("open");
        crate::db::bootstrap::bootstrap_schema(&c).expect("bootstrap");
        c
    }

    fn insert(c: &Connection, cur: &str, rate: &str, at: &str) {
        c.execute(
            &format!("INSERT INTO exchange_rates (id, from_currency, rate_to_base, fetched_at) VALUES (?, ?, {rate}, ?)"),
            rusqlite::params![nanoid(), cur, at],
        )
        .expect("insert");
    }

    #[test]
    fn latest_rates_follow_js_semantics() {
        let c = conn();
        insert(&c, "INR", "0.012", "2026-01-01T00:00:00.000Z");
        insert(&c, "INR", "0.011", "2026-02-01T00:00:00.000Z");
        // A falsy newer rate falls through to the next row, like `!latest[cur]`.
        insert(&c, "SGD", "0.7", "2026-01-01T00:00:00.000Z");
        insert(&c, "SGD", "0", "2026-03-01T00:00:00.000Z");
        insert(&c, "XYZ", "5", "2026-03-01T00:00:00.000Z");
        let latest = get_latest_rates(&c).expect("latest");
        let keys: Vec<&str> = latest.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, ["USD", "SGD", "INR"]);
        assert_eq!(latest[1].1, number(0.7));
        assert_eq!(latest[2].1, number(0.011));
        let listed = list_rates(&c).expect("list");
        let order: Vec<&str> = listed
            .iter()
            .filter_map(|r| r.from_currency.as_str())
            .collect();
        assert_eq!(order, ["INR", "USD", "SGD"]);
        assert_eq!(get_rate(&c, "INR").expect("rate"), 0.011);
        assert_eq!(get_rate(&c, "USD").expect("rate"), 1.0);
        assert_eq!(get_rate(&c, "GBP").expect("rate"), 1.0);
    }

    #[test]
    fn base_currency_roundtrip() {
        let c = conn();
        assert_eq!(get_base_currency(&c).expect("base"), "USD");
        update_base_currency(&c, "INR").expect("update");
        assert_eq!(get_base_currency(&c).expect("base"), "INR");
    }
}
