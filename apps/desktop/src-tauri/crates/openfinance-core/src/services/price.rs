//! Port of `apps/server/src/services/price.service.ts`.
//! Owner: Wave 2 (investments).
//!
//! `fetchCurrentPrice` is the only function Node calls, and it makes **no**
//! request: every investment "refreshes" to its stored value
//! (`source_url: "manual://stored-value"`). It therefore runs on the
//! connection like any other service function.
//!
//! The web lookups below it (`_fetchMutualFundNAV`, `_fetchYahooFinancePrice`
//! → Stooq, `fetchWithTimeout`) are dead code in Node (QUIRKS.md, Wave 2
//! investments). They are ported anyway, so re-enabling them later is a
//! one-line change: same URLs, no extra headers (Node passes `{}`), an
//! 8-second abort that covers the request until its headers arrive, every
//! failure swallowed to `None`, and `config().no_network` failing like
//! Node's `OPENFINANCE_NO_NETWORK` guard (`TypeError: fetch failed`, before
//! any I/O). Network work takes `&AppState` and never holds the connection.
//! The response parsing is split into pure functions with unit tests on
//! recorded-shape payloads.

use std::time::Duration;

use rusqlite::Connection;
use serde_json::Value;

use crate::error::ApiResult;
use crate::js::{js_trim, now_iso};
use crate::services::budget::compat::js_parse_float;
use crate::services::exchange_rate;
use crate::services::investment::InvestmentResponse;
use crate::services::policy::{self, dates::js_number_to_string};
use crate::state::AppState;

/// `PriceResult`.
#[derive(Debug, Clone, PartialEq)]
pub struct PriceResult {
    /// In the investment's native currency.
    pub price: f64,
    /// Converted with the latest stored rate.
    pub price_inr: f64,
    pub currency: String,
    pub source_url: String,
    pub fetched_at: String,
}

/// `Omit<PriceResult, "price_inr" | "fetched_at">`: what a web lookup finds.
#[derive(Debug, Clone, PartialEq)]
pub struct PriceQuote {
    pub price: f64,
    pub currency: String,
    pub source_url: String,
}

// ─── Public helpers ──────────────────────────────────────────────────────────

/// `fetchCurrentPrice(investment)`: the stored value, converted with the
/// latest rate (`rates[currency] ?? 1.0`).
pub fn fetch_current_price(
    conn: &Connection,
    investment: &InvestmentResponse,
) -> ApiResult<PriceResult> {
    let fetched_at = now_iso();
    let rates = exchange_rate::get_latest_rates(conn)?;
    let currency = Value::String(investment.currency.clone());
    let rate = policy::rate_for(&currency, &rates);
    Ok(PriceResult {
        price: investment.current_value,
        price_inr: investment.current_value * rate,
        currency: investment.currency.clone(),
        source_url: "manual://stored-value".into(),
        fetched_at,
    })
}

// ─── Mutual fund NAV via mfapi.in (AMFI India) ──────────────────────────────

/// `_fetchMutualFundNAV(name)` (unused in Node).
pub async fn fetch_mutual_fund_nav(state: &AppState, name: &str) -> Option<PriceQuote> {
    let search_url = format!(
        "https://api.mfapi.in/mf/search?q={}",
        crate::http::routes::documents::hono::encode_uri_component(name)
    );
    let funds = fetch_json(state, &search_url).await?;
    let scheme_code = best_scheme_code(&funds)?;
    let nav_url = format!("https://api.mfapi.in/mf/{scheme_code}");
    let data = fetch_json(state, &nav_url).await?;
    parse_mf_nav(&data, &scheme_code)
}

/// The search step: `funds[0].schemeCode` as it would be interpolated into
/// a URL, or `None` where Node returns null (no results) or throws.
pub fn best_scheme_code(funds: &Value) -> Option<String> {
    // `if (!funds.length) return null;` (`.length` on null throws → null).
    let best = match funds {
        Value::Null => return None,
        Value::Array(a) => a.first(),
        Value::String(s) => {
            if s.is_empty() {
                return None;
            }
            // `funds[0]` is a one-character string; `.schemeCode` is undefined.
            return Some("undefined".into());
        }
        Value::Object(o) => {
            if !crate::json::truthy(o.get("length")) {
                return None;
            }
            o.get("0")
        }
        Value::Bool(_) | Value::Number(_) => return None,
    };
    let best = best?;
    if best.is_null() {
        return None; // `null.schemeCode` throws
    }
    let code = best.as_object().and_then(|o| o.get("schemeCode"));
    Some(js_template(code))
}

/// The NAV step: `parseFloat(data.data[0].nav)` when positive.
pub fn parse_mf_nav(data: &Value, scheme_code: &str) -> Option<PriceQuote> {
    // `data.data?.[0]` (`null.data` throws → null)
    if data.is_null() {
        return None;
    }
    let latest = index(data.as_object()?.get("data")?, 0)?;
    if !crate::json::truthy(Some(&latest)) {
        return None;
    }
    let nav = latest.as_object().and_then(|o| o.get("nav"));
    let price = js_parse_float(&js_template(nav));
    if price.is_nan() || price <= 0.0 {
        return None;
    }
    Some(PriceQuote {
        price,
        currency: "INR".into(),
        source_url: format!("https://www.amfiindia.com/nav-history-download (code: {scheme_code})"),
    })
}

/// `v?.[i]` for a JSON value (strings index to one-character strings).
fn index(v: &Value, i: usize) -> Option<Value> {
    match v {
        Value::Array(a) => a.get(i).cloned(),
        Value::Object(o) => o.get(&i.to_string()).cloned(),
        Value::String(s) => {
            let units: Vec<u16> = s.encode_utf16().collect();
            units
                .get(i)
                .map(|u| Value::String(String::from_utf16_lossy(&[*u])))
        }
        _ => None,
    }
}

/// `${v}` / `String(v)` for a JSON value (`None` is `undefined`).
fn js_template(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => js_number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|i| match i {
                Value::Null => String::new(),
                other => js_template(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

// ─── Stocks, ETFs, crypto via Stooq ─────────────────────────────────────────

/// `CURRENCY_TO_STOOQ_SUFFIX[currency] ?? [".US"]`.
pub fn stooq_suffixes(currency: &str) -> &'static [&'static str] {
    match currency {
        "USD" => &[".US"],
        "SGD" => &[".SG", ".US"],
        "NTD" => &[".TW", ".US"],
        "INR" => &[".NS", ".BO", ".US"],
        _ => &[".US"],
    }
}

/// `name.match(/\b([A-Z]{1,6})\b/g) ?? []`: whole ASCII words of one to six
/// capital letters.
pub fn ticker_candidates(name: &str) -> Vec<String> {
    let is_word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let mut out = Vec::new();
    let mut word = String::new();
    for c in name.chars().chain(std::iter::once(' ')) {
        if is_word(c) {
            word.push(c);
            continue;
        }
        if (1..=6).contains(&word.len()) && word.chars().all(|c| c.is_ascii_uppercase()) {
            out.push(word.clone());
        }
        word.clear();
    }
    out
}

/// `_fetchYahooFinancePrice(name, preferredCurrency)` (unused in Node): the
/// first four ticker candidates × the currency's Stooq suffixes, in order.
pub async fn fetch_yahoo_finance_price(
    state: &AppState,
    name: &str,
    preferred_currency: &str,
) -> Option<PriceQuote> {
    for ticker in ticker_candidates(name).iter().take(4) {
        for suffix in stooq_suffixes(preferred_currency) {
            if let Some(q) = fetch_stooq_quote(state, &format!("{ticker}{suffix}")).await {
                return Some(q);
            }
        }
    }
    None
}

/// `fetchStooqQuote(stooqSymbol)`.
pub async fn fetch_stooq_quote(state: &AppState, stooq_symbol: &str) -> Option<PriceQuote> {
    let url = format!(
        "https://stooq.com/q/l/?s={}&f=sd2t2ohlcvn&h&e=csv",
        crate::http::routes::documents::hono::encode_uri_component(&stooq_symbol.to_lowercase())
    );
    let res = fetch_with_timeout(state, &url, 8000).await.ok()?;
    if !res.status().is_success() {
        return None;
    }
    let text = body_text(res).await?;
    parse_stooq_csv(&text, stooq_symbol)
}

/// Parses Stooq's CSV (`Symbol,Date,Time,Open,High,Low,Close,Volume,Name`).
pub fn parse_stooq_csv(text: &str, stooq_symbol: &str) -> Option<PriceQuote> {
    let lines: Vec<&str> = js_trim(text).split('\n').collect();
    if lines.len() < 2 {
        return None;
    }
    let cols: Vec<&str> = lines[1].split(',').collect();
    let close_col = cols.get(6).copied().unwrap_or("");
    if close_col.is_empty() || cols.get(2) == Some(&"N/D") {
        return None;
    }
    let close = js_parse_float(close_col);
    if close.is_nan() || close <= 0.0 {
        return None;
    }
    let upper = stooq_symbol.to_uppercase();
    let suffix = upper.rsplit('.').next().unwrap_or("");
    let currency = match suffix {
        "US" => "USD",
        "SG" => "SGD",
        "TW" => "TWD",
        "NS" | "BO" => "INR",
        _ => "USD",
    };
    Some(PriceQuote {
        price: close,
        currency: currency.into(),
        source_url: format!("https://stooq.com/q/?s={}", stooq_symbol.to_lowercase()),
    })
}

// ─── Utilities ───────────────────────────────────────────────────────────────

/// `fetchWithTimeout(url, ms)`: fails like `TypeError: fetch failed` when the
/// network is disabled; the abort timer covers the request until the
/// response headers arrive (Node clears it once `fetch` resolves).
pub async fn fetch_with_timeout(
    state: &AppState,
    url: &str,
    ms: u64,
) -> Result<reqwest::Response, String> {
    if state.config().no_network {
        // Test-only (OPENFINANCE_NO_NETWORK): behave as if the network were down.
        return Err("TypeError: fetch failed".into());
    }
    let send = state.http().get(url).send();
    match tokio::time::timeout(Duration::from_millis(ms), send).await {
        Ok(Ok(res)) => Ok(res),
        Ok(Err(e)) => Err(format!("TypeError: fetch failed ({e})")),
        Err(_) => Err("AbortError: This operation was aborted".into()),
    }
}

/// `await (await fetchWithTimeout(url, 8000)).json()` when `res.ok`.
async fn fetch_json(state: &AppState, url: &str) -> Option<Value> {
    let res = fetch_with_timeout(state, url, 8000).await.ok()?;
    if !res.status().is_success() {
        return None;
    }
    let bytes = res.bytes().await.ok()?;
    crate::json::parse_body(&bytes)
}

/// `await res.text()`: UTF-8 with replacement, a leading BOM dropped.
async fn body_text(res: reqwest::Response) -> Option<String> {
    let bytes = res.bytes().await.ok()?;
    let text = String::from_utf8_lossy(&bytes);
    Some(text.strip_prefix('\u{feff}').unwrap_or(&text).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mfapi_search_payloads() {
        // https://api.mfapi.in/mf/search?q=... returns an array of schemes.
        let found = json!([
            {"schemeCode": 120503, "schemeName": "Axis ELSS Tax Saver Fund - Direct Plan - Growth"},
            {"schemeCode": 112323, "schemeName": "Axis ELSS Tax Saver Fund - Regular Plan - Growth"}
        ]);
        assert_eq!(best_scheme_code(&found).as_deref(), Some("120503"));
        assert_eq!(best_scheme_code(&json!([])), None);
        assert_eq!(best_scheme_code(&Value::Null), None);
        assert_eq!(best_scheme_code(&json!({"status": "FAIL"})), None);
        assert_eq!(best_scheme_code(&json!([null])), None);
        assert_eq!(best_scheme_code(&json!([{}])).as_deref(), Some("undefined"));
        assert_eq!(
            best_scheme_code(&json!([{"schemeCode": "100033"}])).as_deref(),
            Some("100033")
        );
    }

    #[test]
    fn mfapi_nav_payloads() {
        // https://api.mfapi.in/mf/120503: meta + newest-first NAV list.
        let data = json!({
            "meta": {"fund_house": "Axis Mutual Fund", "scheme_code": 120503},
            "data": [
                {"date": "22-11-2026", "nav": "98.76540"},
                {"date": "21-11-2026", "nav": "98.12000"}
            ],
            "status": "SUCCESS"
        });
        assert_eq!(
            parse_mf_nav(&data, "120503"),
            Some(PriceQuote {
                price: 98.7654,
                currency: "INR".into(),
                source_url: "https://www.amfiindia.com/nav-history-download (code: 120503)".into(),
            })
        );
        assert_eq!(parse_mf_nav(&json!({"data": []}), "1"), None);
        assert_eq!(parse_mf_nav(&json!({}), "1"), None);
        assert_eq!(parse_mf_nav(&Value::Null, "1"), None);
        assert_eq!(
            parse_mf_nav(&json!({"data": [{"nav": "0.0000"}]}), "1"),
            None
        );
        assert_eq!(parse_mf_nav(&json!({"data": [{"nav": "N.A."}]}), "1"), None);
        assert_eq!(parse_mf_nav(&json!({"data": [{"date": "x"}]}), "1"), None);
        // parseFloat takes the numeric prefix, and String(number) for numbers.
        assert_eq!(
            parse_mf_nav(&json!({"data": [{"nav": " 12.5abc"}]}), "7").map(|q| q.price),
            Some(12.5)
        );
        assert_eq!(
            parse_mf_nav(&json!({"data": [{"nav": 15}]}), "7").map(|q| q.price),
            Some(15.0)
        );
    }

    #[test]
    fn stooq_csv_payloads() {
        let ok = "Symbol,Date,Time,Open,High,Low,Close,Volume,Name\r\nAAPL.US,2026-11-21,22:00:09,228.1,230.2,227.5,229.87,41234567,APPLE\r\n";
        assert_eq!(
            parse_stooq_csv(ok, "AAPL.US"),
            Some(PriceQuote {
                price: 229.87,
                currency: "USD".into(),
                source_url: "https://stooq.com/q/?s=aapl.us".into(),
            })
        );
        let nd = "Symbol,Date,Time,Open,High,Low,Close,Volume,Name\nXXXX.US,N/D,N/D,N/D,N/D,N/D,N/D,N/D,XXXX.US\n";
        assert_eq!(parse_stooq_csv(nd, "XXXX.US"), None);
        assert_eq!(parse_stooq_csv("Symbol,Date\n", "A.US"), None);
        assert_eq!(
            parse_stooq_csv("h\nD05.SG,2026-11-21,08:00:00,1,2,3,0,1,DBS", "D05.SG"),
            None
        );
        let sg = "h\nD05.SG,2026-11-21,08:00:00,1,2,3,38.5,1,DBS";
        assert_eq!(
            parse_stooq_csv(sg, "D05.SG").map(|q| q.currency),
            Some("SGD".into())
        );
        let tw = "h\n2330.TW,2026-11-21,08:00:00,1,2,3,1000,1,TSMC";
        assert_eq!(
            parse_stooq_csv(tw, "2330.TW").map(|q| q.currency),
            Some("TWD".into())
        );
        let ns = "h\nINFY.NS,2026-11-21,08:00:00,1,2,3,1800.5,1,INFOSYS";
        assert_eq!(
            parse_stooq_csv(ns, "INFY.NS").map(|q| q.currency),
            Some("INR".into())
        );
        let short = "h\nA.US,2026-11-21,08:00:00,1,2";
        assert_eq!(parse_stooq_csv(short, "A.US"), None);
    }

    #[test]
    fn tickers_and_suffixes() {
        assert_eq!(
            ticker_candidates("Apple Inc. (AAPL) / VOO, ABCDEFG, A1, X_Y, Ünicode QQQ"),
            vec!["AAPL", "VOO", "QQQ"]
        );
        assert_eq!(
            ticker_candidates("Vanguard S&P 500 ETF"),
            vec!["S", "P", "ETF"]
        );
        assert_eq!(stooq_suffixes("INR"), &[".NS", ".BO", ".US"]);
        assert_eq!(stooq_suffixes("EUR"), &[".US"]);
    }

    #[test]
    fn js_matches_regex_semantics() {
        // Non-ASCII letters are not \w, so they end a word.
        assert_eq!(ticker_candidates("éABC"), vec!["ABC"]);
        assert_eq!(ticker_candidates("ABCDEF"), vec!["ABCDEF"]);
    }
}
