//! Port of `apps/server/src/ai/context.builder.ts` (`buildSystemContext`).
//! Nothing in Node calls it (the chat fetches data through tools instead);
//! it is ported for completeness and checked against Node's output by
//! `tests/compat_ai.rs`.

use rusqlite::Connection;
use serde_json::Value;

use super::intl::{format_currency, to_fixed};
use super::js::{value_to_string, JsError};
use super::tools::{lookup_rate, RateLookup};
use crate::error::ApiResult;
use crate::json::{from_sql, to_number};
use crate::services::policy::dates::local_iso_today;
use crate::services::{budget, dashboard, exchange_rate, investment, life_insurance, policy};

fn label_asset_type(t: &str) -> String {
    match t {
        "mutual_fund" => "Mutual Fund",
        "stock" => "Stock",
        "etf" => "ETF",
        "fixed_deposit" => "Fixed Deposit",
        "bond" => "Bond",
        "real_estate" => "Real Estate",
        "cash" => "Cash",
        "structured" => "Structured Product",
        "other" => "Other",
        other => return other.to_string(),
    }
    .to_string()
}

fn label_account_type(t: &str) -> String {
    match t {
        "checking" => "Checking",
        "savings" => "Savings",
        "investment" => "Investment",
        "credit" => "Credit Card",
        "loan" => "Loan",
        "other" => "Other",
        other => return other.to_string(),
    }
    .to_string()
}

fn label_frequency(f: &str) -> &'static str {
    match f {
        "annual" => "annually",
        "quarterly" => "quarterly",
        _ => "monthly",
    }
}

/// This file's `CURRENCY_LOCALE[currency] ?? "en-US"` (it also maps TWD).
fn locale_for(currency: &str) -> &'static str {
    match currency {
        "INR" => "en-IN",
        "USD" => "en-US",
        "NTD" | "TWD" => "zh-TW",
        "GBP" => "en-GB",
        "EUR" => "en-IE",
        "SGD" => "en-SG",
        "JPY" => "ja-JP",
        _ => "en-US",
    }
}

fn fmt(n: f64, currency: &str) -> Result<String, JsError> {
    format_currency(n, locale_for(currency), currency)
}

/// `fromINR(inr, currency, rates)`.
fn from_inr(inr: f64, currency: &str, rates: &[(String, Value)]) -> f64 {
    if currency == "INR" {
        return inr;
    }
    match lookup_rate(rates, currency) {
        RateLookup::Own(v) if crate::json::truthy(Some(v)) => inr / to_number(v),
        RateLookup::Inherited => f64::NAN,
        _ => inr,
    }
}

/// `rates[c] ?? 1` as a number.
fn rate_or_one(rates: &[(String, Value)], c: &str) -> f64 {
    match lookup_rate(rates, c) {
        RateLookup::Own(v) if !v.is_null() => to_number(v),
        RateLookup::Inherited => f64::NAN,
        _ => 1.0,
    }
}

fn s(v: &Value) -> String {
    value_to_string(v)
}

/// The error a throwing formatter turns into (the builder has no catch).
fn js(e: JsError) -> crate::ApiError {
    crate::ApiError::internal(e.to_js_string())
}

/// `buildSystemContext(displayCurrency)`.
pub fn build_system_context(conn: &Connection, display_currency: &str) -> ApiResult<String> {
    let today = local_iso_today();
    let current_month: String = today.chars().take(7).collect();

    let net_worth = dashboard::get_net_worth(conn)?;
    let accounts = budget::list_accounts(conn)?;
    let envelopes = budget::list_envelopes(conn, &current_month)?;
    let investments =
        investment::list_investments(conn, &investment::InvestmentFilters::default())?;
    let policies = policy::list_policies(conn)?;
    let life = life_insurance::list_life_insurance(conn)?;
    let rates = exchange_rate::get_latest_rates(conn)?;

    let dc = display_currency;
    let fmt_display = |inr: f64| -> Result<String, JsError> {
        if dc == "INR" {
            return fmt(inr, "INR");
        }
        let converted = from_inr(inr, dc, &rates);
        Ok(format!("{} ({})", fmt(converted, dc)?, fmt(inr, "INR")?))
    };
    let fd = |inr: f64| fmt_display(inr).map_err(js);
    let f = |n: f64, c: &str| fmt(n, c).map_err(js);

    // Last 15 transactions
    let recent: Vec<(Value, Value, Value, Value, Value, Value)> = {
        let mut stmt = conn.prepare(
            "select \"date\", \"payee\", \"amount\", \"type\", \"notes\", \"account_id\" from \"transactions\" order by \"transactions\".\"date\" desc limit ?",
        )?;
        let rows = stmt
            .query_map([15], |r| {
                Ok((
                    from_sql(r.get_ref(0)?),
                    from_sql(r.get_ref(1)?),
                    from_sql(r.get_ref(2)?),
                    from_sql(r.get_ref(3)?),
                    from_sql(r.get_ref(4)?),
                    from_sql(r.get_ref(5)?),
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };

    let mut lines: Vec<String> = vec![
        format!("=== YOUR FINANCIAL SNAPSHOT — {today} ==="),
        format!(
            "CURRENCY: All amounts below are in {dc}{}. Do not convert or restate amounts in any other currency unless asked.",
            if dc != "INR" {
                format!(". INR equivalents are shown in parentheses for reference only — always respond in {dc}")
            } else {
                String::new()
            }
        ),
        String::new(),
        "## Net Worth".into(),
        format!("Total net worth: {}", fd(net_worth.total_inr)?),
        format!("  - Cash & Accounts: {}", fd(net_worth.breakdown.cash_inr)?),
        format!("  - Investments: {}", fd(net_worth.breakdown.investments_inr)?),
        format!("  - Insurance Policies: {}", fd(net_worth.breakdown.policies_inr)?),
        format!(
            "  - Physical Assets (vehicles, depreciated): {}",
            fd(net_worth.breakdown.physical_assets_inr)?
        ),
        format!("  - Debt: {}", fd(net_worth.breakdown.debt_inr)?),
        String::new(),
        "## Exchange Rates (to INR)".into(),
        rates
            .iter()
            .map(|(k, v)| format!("  1 {k} = ₹{}", s(v)))
            .collect::<Vec<_>>()
            .join("\n"),
        String::new(),
        "## Bank & Savings Accounts".into(),
    ];

    if accounts.is_empty() {
        lines.push("  No accounts added.".into());
    }
    for a in &accounts {
        let native = format!(
            "{}{}",
            f(a.balance, &a.currency)?,
            if a.currency != "INR" {
                format!(" ({})", f(a.balance_inr, "INR")?)
            } else {
                String::new()
            }
        );
        let display = if dc != "INR" && dc != a.currency {
            format!(" = {}", f(from_inr(a.balance_inr, dc, &rates), dc)?)
        } else {
            String::new()
        };
        lines.push(format!(
            "  {} — {}, {}\n    Balance: {native}{display}{}",
            a.name,
            label_account_type(&a.account_type),
            a.currency,
            if a.is_active { "" } else { " [Inactive]" }
        ));
    }

    lines.push(String::new());
    lines.push(format!("## Budget for {current_month}"));
    if envelopes.is_empty() {
        lines.push("  No envelopes set up.".into());
    } else {
        let tb = envelopes.iter().fold(0.0, |acc, e| acc + e.budgeted_inr);
        let ts = envelopes.iter().fold(0.0, |acc, e| acc + e.spent);
        let ta = envelopes.iter().fold(0.0, |acc, e| acc + e.available);
        lines.push(format!(
            "  >>> TOTALS: budgeted={}, spent={}, remaining={} <<<",
            fd(tb)?,
            fd(ts)?,
            fd(ta)?
        ));
        for e in &envelopes {
            let group = if e.group_name.is_empty() {
                String::new()
            } else {
                format!(" ({})", e.group_name)
            };
            lines.push(format!(
                "  {}{group}: budgeted {}, spent {}, available {}",
                e.name,
                fd(e.budgeted_inr)?,
                fd(e.spent)?,
                fd(e.available)?
            ));
        }
    }

    lines.push(String::new());
    lines.push("## Investments".into());
    if investments.is_empty() {
        lines.push("  No investments tracked.".into());
    }
    for i in &investments {
        let rate = if i.currency == "INR" {
            1.0
        } else {
            rate_or_one(&rates, &i.currency)
        };
        let purchase_display = fd(i.purchase_value * rate)?;
        let current_display = fd(i.current_value_inr)?;
        let gain_display = fd(i.gain_loss_inr)?;
        let non_inr = i.currency != "INR";
        lines.push(format!(
            "  {} — {}, held in {}\n    Invested: {}{}\n    Current value: {}{}\n    Gain/Loss: {gain_display} ({}%)",
            i.name,
            label_asset_type(&i.asset_type),
            i.currency,
            f(i.purchase_value, &i.currency)?,
            if non_inr { format!(" ({purchase_display})") } else { String::new() },
            f(i.current_value, &i.currency)?,
            if non_inr { format!(" ({current_display})") } else { String::new() },
            to_fixed(i.gain_loss_pct, 1)
        ));
    }

    lines.push(String::new());
    lines.push("## Insurance & Savings Policies".into());
    if policies.is_empty() {
        lines.push("  No policies tracked.".into());
    }
    for p in &policies {
        let maturity = if p.maturity_value.is_null() {
            0.0
        } else {
            to_number(&p.maturity_value)
        };
        lines.push(format!(
            "  {} by {}\n    Premium: {} paid {}\n    Sum Assured: {} | Maturity Value: {} on {}",
            s(&p.name),
            s(&p.provider),
            fd(to_number(&p.premium_amount))?,
            label_frequency(&s(&p.premium_frequency)),
            fd(to_number(&p.sum_assured))?,
            fd(maturity)?,
            s(&p.maturity_date)
        ));
    }

    lines.push(String::new());
    lines.push(
        "## Life Insurance (protection cover — NOT an asset, excluded from net worth)".into(),
    );
    if life.is_empty() {
        lines.push("  No life insurance tracked.".into());
    }
    for l in &life {
        let currency = s(&l.currency);
        let premium = if l.premium_amount.is_null() {
            "not recorded".to_string()
        } else {
            let freq = if l.premium_frequency.is_null() {
                "annual".to_string()
            } else {
                s(&l.premium_frequency)
            };
            format!(
                "{} {}",
                f(to_number(&l.premium_amount), &currency)?,
                label_frequency(&freq)
            )
        };
        let days = to_number(&l.days_to_renewal);
        let renewal = if days < 0.0 {
            format!(
                "{} days overdue",
                crate::services::policy::dates::js_number_to_string(days.abs())
            )
        } else {
            format!(
                "in {} days",
                crate::services::policy::dates::js_number_to_string(days)
            )
        };
        lines.push(format!(
            "  {} by {} — covers {}\n    Cover: {}{}\n    Renews: {} ({renewal}) | Premium: {premium}",
            s(&l.name),
            s(&l.provider),
            s(&l.insured_person),
            f(to_number(&l.coverage_amount), &currency)?,
            if currency != "INR" {
                format!(" ({})", fd(to_number(&l.coverage_amount_inr))?)
            } else {
                String::new()
            },
            s(&l.renewal_date)
        ));
    }

    lines.push(String::new());
    lines.push("## Recent Transactions (last 15)".into());
    if recent.is_empty() {
        lines.push("  No transactions yet.".into());
    }
    for (date, payee, amount, kind, notes, account_id) in &recent {
        let acc = accounts
            .iter()
            .find(|a| Value::String(a.id.clone()) == *account_id);
        let txn_currency = acc.map(|a| a.currency.as_str()).unwrap_or("INR");
        let abs = to_number(amount).abs();
        let native = f(abs, txn_currency)?;
        let display = if dc != txn_currency {
            let r = if txn_currency == "INR" {
                1.0
            } else {
                rate_or_one(&rates, txn_currency)
            };
            format!(" ({})", fd(abs * r)?)
        } else {
            String::new()
        };
        let name = acc
            .map(|a| format!("{} ({})", a.name, a.currency))
            .unwrap_or_else(|| "Unknown".into());
        let notes = if crate::json::truthy(Some(notes)) {
            format!(" — {}", s(notes))
        } else {
            String::new()
        };
        lines.push(format!(
            "  {} | {} | {name} | {} | {native}{display}{notes}",
            s(date),
            s(kind),
            s(payee)
        ));
    }

    lines.push(String::new());
    lines.push("=== END OF SNAPSHOT ===".into());
    Ok(lines.join("\n"))
}
