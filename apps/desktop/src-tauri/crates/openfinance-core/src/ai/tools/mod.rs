//! Port of `apps/server/src/ai/tools/index.ts`: the Ollama tool definitions
//! (`AI_TOOLS`) and `executeTool`, which formats the user's data as text.

pub mod calculator;
mod filters;

use std::sync::LazyLock;

use serde_json::Value;

use super::intl::{format_currency, to_fixed};
use super::js::{
    get_prop, js_number, js_string, nullish, stringify, truthy, value_to_string, JsError,
    OBJECT_PROTO_KEYS,
};
use crate::services::policy::dates::js_number_to_string;
use crate::services::{budget, dashboard, exchange_rate, investment, policy};
use crate::state::AppState;

/// `AI_TOOLS`, extracted verbatim from the TS array literal (key order kept).
static AI_TOOLS: LazyLock<Value> =
    LazyLock::new(|| serde_json::from_str(include_str!("definitions.json")).unwrap_or(Value::Null));

/// `AI_TOOLS` as sent in `tools`.
pub fn ai_tools() -> &'static Value {
    &AI_TOOLS
}

/// The tools file's `CURRENCY_LOCALE[currency] ?? "en-US"`.
fn locale_for(currency: &str) -> &'static str {
    match currency {
        "INR" => "en-IN",
        "USD" => "en-US",
        "SGD" => "en-SG",
        "GBP" => "en-GB",
        "EUR" => "en-IE",
        "JPY" => "ja-JP",
        "NTD" => "zh-TW",
        _ => "en-US",
    }
}

/// `fmt(n, currency)`.
fn fmt(n: f64, currency: &str) -> Result<String, JsError> {
    format_currency(n, locale_for(currency), currency)
}

/// `rates[key]` on the object `getLatestRates()` returns: an own entry, or
/// an inherited `Object.prototype` member (truthy, NaN in arithmetic).
pub(crate) enum RateLookup<'a> {
    Own(&'a Value),
    Inherited,
    Missing,
}

pub(crate) fn lookup_rate<'a>(rates: &'a [(String, Value)], key: &str) -> RateLookup<'a> {
    match rates.iter().find(|(k, _)| k == key) {
        Some((_, v)) => RateLookup::Own(v),
        None if OBJECT_PROTO_KEYS.contains(&key) => RateLookup::Inherited,
        None => RateLookup::Missing,
    }
}

/// `fmtDisplay(inrAmount, displayCurrency, rates)`.
fn fmt_display(inr: f64, display: &str, rates: &[(String, Value)]) -> Result<String, JsError> {
    if display == "INR" {
        return fmt(inr, "INR");
    }
    let rate = match lookup_rate(rates, display) {
        RateLookup::Own(v) if truthy(Some(v)) => crate::json::to_number(v),
        RateLookup::Inherited => f64::NAN,
        _ => return fmt(inr, "INR"),
    };
    fmt(inr / rate, display)
}

fn s(v: &Value) -> String {
    value_to_string(v)
}

/// `executeTool(name, params, displayCurrency)`: the tool's text, or the
/// error it throws.
pub async fn execute_tool(
    state: &AppState,
    name: Option<&Value>,
    params: Option<&Value>,
    display_currency: &str,
) -> Result<String, JsError> {
    let rates = state.db(exchange_rate::get_latest_rates).await?;
    let d = |inr: f64| fmt_display(inr, display_currency, &rates);
    let name_str = match name {
        Some(Value::String(n)) => n.as_str(),
        _ => "",
    };

    match name_str {
        "get_net_worth" => {
            let nw = state.db(dashboard::get_net_worth).await?;
            let b = &nw.breakdown;
            Ok([
                format!("Net Worth: {}", d(nw.total_inr)?),
                format!("  Cash & Accounts: {}", d(b.cash_inr)?),
                format!("  Investments:      {}", d(b.investments_inr)?),
                format!("  Policies:         {}", d(b.policies_inr)?),
                format!("  Physical assets:  {}", d(b.physical_assets_inr)?),
                format!("  Debt:             {}", d(b.debt_inr)?),
            ]
            .join("\n"))
        }

        "get_envelope_summary" => {
            let month = month_param(params)?;
            let m = month.clone();
            let envelopes = state
                .db(move |conn| budget::list_envelopes(conn, &m))
                .await?;
            if envelopes.is_empty() {
                return Ok(format!("No budget envelopes for {month}."));
            }
            let total_budgeted = envelopes.iter().fold(0.0, |s, e| s + e.budgeted_inr);
            let total_spent = envelopes.iter().fold(0.0, |s, e| s + e.spent);
            let total_available = envelopes.iter().fold(0.0, |s, e| s + e.available);
            let mut lines = vec![
                format!("Budget for {month}:"),
                format!("  Total budgeted: {}", d(total_budgeted)?),
                format!("  Total spent:    {}", d(total_spent)?),
                format!("  Total remaining:{}", d(total_available)?),
                String::new(),
                "Per category:".to_string(),
            ];
            for e in &envelopes {
                let group = if e.group_name.is_empty() {
                    String::new()
                } else {
                    format!(" ({})", e.group_name)
                };
                lines.push(format!(
                    "  {}{group}: budgeted {}, spent {}, remaining {}",
                    e.name,
                    d(e.budgeted_inr)?,
                    d(e.spent)?,
                    d(e.available)?
                ));
            }
            Ok(lines.join("\n"))
        }

        "get_monthly_summary" => {
            let month = month_param(params)?;
            let m = month.clone();
            let sm = state
                .db(move |conn| budget::get_monthly_summary(conn, &m))
                .await?;
            Ok([
                format!("Monthly summary for {month}:"),
                format!("  Income:   {}", d(sm.total_income)?),
                format!("  Expenses: {}", d(sm.total_expenses)?),
                format!("  Net:      {}", d(sm.net)?),
            ]
            .join("\n"))
        }

        "get_accounts" => {
            let accs = state.db(budget::list_accounts).await?;
            if accs.is_empty() {
                return Ok("No accounts found.".into());
            }
            let mut out = Vec::with_capacity(accs.len());
            for a in &accs {
                let native = fmt(a.balance, &a.currency)?;
                let display = if display_currency != a.currency {
                    format!(" ({})", d(a.balance_inr)?)
                } else {
                    String::new()
                };
                let inactive = if a.is_active { "" } else { " — Inactive" };
                out.push(format!(
                    "{} [{}, {}]: {native}{display}{inactive}",
                    a.name, a.account_type, a.currency
                ));
            }
            Ok(out.join("\n"))
        }

        "get_transactions" => {
            let p = |k: &str| get_prop(params, k);
            let input = filters::Input {
                account_id: p("account_id")?.cloned(),
                envelope_id: p("envelope_id")?.cloned(),
                date_from: p("date_from")?.cloned(),
                date_to: p("date_to")?.cloned(),
                limit: nullish(p("limit")?).cloned(),
            };
            let filters = filters::parse(&input).map_err(|msg| JsError::new("", msg))?;
            let response = state
                .db(move |conn| budget::list_transactions(conn, &filters))
                .await?;
            let txns = &response.transactions;
            if txns.is_empty() {
                return Ok("No transactions found.".into());
            }
            let mut out = Vec::with_capacity(txns.len());
            for t in txns {
                let t = &t.base;
                let notes = match t.notes.as_deref() {
                    Some(n) if !n.is_empty() => format!(" — {n}"),
                    _ => String::new(),
                };
                out.push(format!(
                    "{} | {} | {} | {}{notes}",
                    t.date,
                    t.txn_type,
                    t.payee,
                    fmt(t.amount.abs(), &t.currency)?
                ));
            }
            Ok(out.join("\n"))
        }

        "get_investment_summary" => {
            let investments = state
                .db(|conn| {
                    investment::list_investments(conn, &investment::InvestmentFilters::default())
                })
                .await?;
            if investments.is_empty() {
                return Ok("No investments tracked.".into());
            }
            let mut out = Vec::with_capacity(investments.len());
            for i in &investments {
                out.push(format!(
                    "{} ({}): invested {}, current {}, gain/loss {} ({}%)",
                    i.name,
                    i.asset_type,
                    fmt(i.purchase_value, &i.currency)?,
                    fmt(i.current_value, &i.currency)?,
                    d(i.gain_loss_inr)?,
                    to_fixed(i.gain_loss_pct, 1)
                ));
            }
            Ok(out.join("\n"))
        }

        "get_policy_timeline" => {
            let years_v = nullish(get_prop(params, "years")?).cloned();
            let years = match years_v {
                Some(v) => js_number(Some(&v)),
                None => 5.0,
            };
            let events = state
                .db(move |conn| policy::get_timeline(conn, years))
                .await?;
            if events.is_empty() {
                return Ok(format!(
                    "No policy events in the next {} years.",
                    js_number_to_string(years)
                ));
            }
            let mut out = Vec::with_capacity(events.len());
            for e in &events {
                let amount = match nullish(Some(&e.amount)) {
                    Some(v) => crate::json::to_number(v),
                    None => 0.0,
                };
                out.push(format!(
                    "{} | {} | {} | {}",
                    s(&e.date),
                    s(&e.label),
                    s(&e.policy_name),
                    d(amount)?
                ));
            }
            Ok(out.join("\n"))
        }

        "get_exchange_rates" => {
            let r = state.db(exchange_rate::get_latest_rates).await?;
            Ok(r.iter()
                .map(|(k, v)| format!("1 {k} = ₹{}", s(v)))
                .collect::<Vec<_>>()
                .join("\n"))
        }

        "refresh_investment_price" => {
            // String(params.investment_id ?? "")
            let id = match nullish(get_prop(params, "investment_id")?) {
                Some(v) => value_to_string(v),
                None => String::new(),
            };
            if id.is_empty() {
                return Err(JsError::error("investment_id is required"));
            }
            let result = state
                .db(move |conn| investment::refresh_price(conn, &id))
                .await?;
            let json = serde_json::to_value(&result).map_err(crate::ApiError::from)?;
            Ok(format!("Updated: {}", stringify(&json)))
        }

        "refresh_exchange_rates" => {
            let c = get_prop(params, "currency")?;
            let currency = if truthy(c) {
                Some(Value::String(js_string(c)))
            } else {
                None
            };
            let result = exchange_rate::refresh_from_web(state, currency).await?;
            let json = serde_json::to_value(&result).map_err(crate::ApiError::from)?;
            Ok(format!("Updated rates: {}", stringify(&json)))
        }

        "calculate" => {
            let expr = match nullish(get_prop(params, "expression")?) {
                Some(v) => value_to_string(v),
                None => String::new(),
            };
            if expr.is_empty() {
                return Err(JsError::error("expression is required for calculation"));
            }
            Ok(match calculator::safe_evaluate(&expr) {
                Ok(v) => format!("Calculation Result: {}", js_number_to_string(v)),
                Err(msg) => format!("Error in calculation: {msg}"),
            })
        }

        _ => Err(JsError::error(format!("Unknown tool: {}", js_string(name)))),
    }
}

/// `String(params.month ?? localYearMonth())`.
fn month_param(params: Option<&Value>) -> Result<String, JsError> {
    Ok(match nullish(get_prop(params, "month")?) {
        Some(v) => value_to_string(v),
        None => dashboard::local_year_month(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn definitions_parse() {
        let tools = ai_tools().as_array().expect("array");
        assert_eq!(tools.len(), 11);
        assert_eq!(tools[0]["function"]["name"], "get_net_worth");
        assert_eq!(
            tools[10]["function"]["parameters"]["required"],
            json!(["expression"])
        );
    }

    #[test]
    fn display_formatting() {
        let rates = vec![
            ("USD".to_string(), json!(1)),
            ("INR".to_string(), json!(0.012)),
            ("SGD".to_string(), json!(0)),
        ];
        assert_eq!(fmt_display(1234.5, "INR", &rates).expect("inr"), "₹1,235");
        assert_eq!(fmt_display(1234.5, "USD", &rates).expect("usd"), "$1,235");
        // A falsy or missing rate falls back to INR.
        assert_eq!(fmt_display(10.0, "SGD", &rates).expect("sgd"), "₹10");
        assert_eq!(fmt_display(10.0, "EUR", &rates).expect("eur"), "₹10");
        let e = fmt_display(10.0, "toString", &rates).expect_err("proto");
        assert_eq!(
            e.to_js_string(),
            "RangeError: Invalid currency code : toString"
        );
    }
}
