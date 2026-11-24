//! Port of `apps/server/src/services/dashboard.service.ts`.
//! Owner: Wave 2 (dashboard).
//!
//! Every function takes `&Connection`. Functions that read the clock have an
//! `*_at(…, now)` variant taking the JS time value (`Date.now()`) so tests can
//! pin "today"; the plain variant uses the real clock, like Node.
//!
//! Pub API for the AI wave (`ai/context.builder.ts`, `ai/tools/index.ts`
//! import `getNetWorth`): [`get_net_worth`] → [`NetWorthSnapshot`]; also
//! [`load_net_worth_context`], [`compute_net_worth_at`],
//! [`get_net_worth_history`] and the rest of the service.
//!
//! Rates are exchange-rate.service's `getLatestRates()` (base currency
//! included), as `dashboard.service.ts` imports them, and are passed on to
//! budget.service's `computeCarryoverForMonth` / `computeFromSavings` exactly
//! like Node does. JS objects used as records keep JS property order
//! ([`jsobj::JsRecord`]); sorts use V8's algorithm
//! ([`crate::services::investment::jssort::js_sort_by`]).

mod jsobj;
#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};

use rusqlite::{params_from_iter, Connection};
use serde::Serialize;
use serde_json::Value;

use crate::error::{ApiError, ApiResult};
use crate::json::{from_sql, to_number, truthy};
use crate::services::budget::compat::{add_days_iso, js_make_date, month_end};
use crate::services::budget::{
    self, balance_delta, bears_holdings, col_bool, col_f64, col_str, col_string, is_liability_type,
    is_transfer_in, SavingsRange, STARTING_BALANCE_PAYEE,
};
use crate::services::exchange_rate::get_latest_rates;
use crate::services::investment::jssort::js_sort_by;
use crate::services::investment::{
    depreciated_value, is_physical_asset, list_investments, InvestmentFilters, InvestmentResponse,
};
use crate::services::policy::dates::{
    js_round, js_slice, js_str_cmp, local_fields, local_iso_date, local_time, make_date, make_day,
    now_ms, parse_date, time_clip, utc_from_local,
};
use crate::services::policy::{
    compute_invested_at, currency_or_inr, js_property_key, rate_for, select_policies, AsOf,
    PolicyRow, Rates,
};

use jsobj::JsRecord;

const MS_PER_DAY: f64 = 86_400_000.0;

// ─── JS helpers ───────────────────────────────────────────────────────────────

/// `Math.max(a, b)`: NaN wins; `+0` beats `-0`.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b || (a == b && b.is_sign_negative()) {
        a
    } else {
        b
    }
}

/// The `end` argument of `Array.prototype.slice(0, end)` resolved against `len`.
fn slice_end(len: usize, end: f64) -> usize {
    let e = if end.is_nan() { 0.0 } else { end.trunc() };
    let len_f = len as f64;
    let resolved = if e < 0.0 {
        (len_f + e).max(0.0)
    } else {
        e.min(len_f)
    };
    resolved as usize
}

/// `rates[currency] ?? 1.0`.
fn rate_of(currency: &str, rates: &Rates) -> f64 {
    rate_for(&Value::String(currency.to_string()), rates)
}

/// exchange-rate.service's rates as the `Record<string, number>` budget.service
/// functions receive (`amount * (rates[cur] ?? 1.0)` coerces with `Number()`).
fn budget_rates(rates: &Rates) -> budget::Rates {
    rates
        .iter()
        .map(|(k, v)| (k.clone(), to_number(v)))
        .collect()
}

/// `new Date(y, m - i, 1)` as `"YYYY-MM"` (`getFullYear()` / `getMonth() + 1`),
/// and the date itself for further arithmetic.
fn month_start(year: f64, month0: f64, i: f64) -> Option<(i64, i64)> {
    js_make_date(year, month0 - i, 1.0).map(|(y, m, _)| (y, m))
}

fn month_label(d: Option<(i64, i64)>) -> String {
    match d {
        Some((y, m)) => format!("{y}-{m:02}"),
        None => "NaN-NaN".to_string(),
    }
}

/// `localeCompare` with Node's default (ICU root, tertiary) collation.
fn collator() -> ApiResult<icu_collator::CollatorBorrowed<'static>> {
    icu_collator::Collator::try_new(
        Default::default(),
        icu_collator::options::CollatorOptions::default(),
    )
    .map_err(ApiError::internal)
}

fn ordering_to_f64(o: std::cmp::Ordering) -> f64 {
    match o {
        std::cmp::Ordering::Less => -1.0,
        std::cmp::Ordering::Equal => 0.0,
        std::cmp::Ordering::Greater => 1.0,
    }
}

/// `lower.toLowerCase() === "savings"`.
fn is_savings(group_name: &str) -> bool {
    group_name.to_lowercase() == "savings"
}

// ─── Net Worth ────────────────────────────────────────────────────────────────

/// One account as `computeNetWorthAt` sees it (`NetWorthAccount`).
#[derive(Debug, Clone, PartialEq)]
pub struct NetWorthAccount {
    pub id: String,
    pub account_type: String,
    pub currency: String,
    pub off_budget: bool,
    pub is_active: bool,
    /// Live derived balance, native currency, holdings included.
    pub live_native: f64,
    /// The linked-holdings term of `live_native`, native currency.
    pub holdings_native: f64,
}

/// A transaction dated after `since` (`NetWorthTxn`).
#[derive(Debug, Clone, PartialEq)]
pub struct NetWorthTxn {
    pub date: String,
    pub kind: String,
    pub payee: String,
    pub amount: f64,
}

/// One holding as `computeNetWorthAt` sees it.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct NetWorthInvestment {
    pub account_id: Option<String>,
    pub purchase_date: String,
    pub current_value_inr: f64,
    /// `None` = a regular holding (the optional field in Node's type).
    pub asset_type: Option<String>,
    pub quoted_inr: Option<f64>,
    pub quoted_at: Option<String>,
    pub depreciation_rate: Option<f64>,
}

/// `NetWorthContext`: everything `computeNetWorthAt` reads, loaded once.
#[derive(Debug, Clone, Default)]
pub struct NetWorthContext {
    /// Earliest date this context can answer for.
    pub since: String,
    pub accounts: Vec<NetWorthAccount>,
    /// Only transactions dated AFTER `since`.
    pub txns_by_account: HashMap<String, Vec<NetWorthTxn>>,
    pub investments: Vec<NetWorthInvestment>,
    pub policies: Vec<PolicyRow>,
    pub rates: Rates,
}

const ACCOUNT_SELECT: &str = "select \"id\", \"name\", \"type\", \"currency\", \"balance\", \"institution\", \"is_active\", \"off_budget\", \"created_at\", \"updated_at\" from \"accounts\"";

/// `loadNetWorthContext(since)`.
pub fn load_net_worth_context(conn: &Connection, since: &str) -> ApiResult<NetWorthContext> {
    let rates = get_latest_rates(conn)?;
    let balances = budget::get_account_balances(conn)?;
    let inv_list = list_investments(conn, &InvestmentFilters::default())?;

    let mut stmt = conn.prepare(ACCOUNT_SELECT)?;
    let account_rows = stmt
        .query_map([], |r| {
            Ok((
                col_string(r, 0)?,
                col_string(r, 2)?,
                col_str(r, 3)?,
                col_bool(r, 6)?,
                col_bool(r, 7)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let policies = select_policies(conn)?;

    let mut stmt = conn.prepare(
        "select \"account_id\", \"amount\", \"type\", \"payee\", \"date\" from \"transactions\" where \"transactions\".\"date\" > ?",
    )?;
    let txn_rows = stmt
        .query_map([since], |r| {
            Ok((
                col_str(r, 0)?,
                col_f64(r, 1)?.unwrap_or(0.0),
                col_string(r, 2)?,
                col_string(r, 3)?,
                col_string(r, 4)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut txns_by_account: HashMap<String, Vec<NetWorthTxn>> = HashMap::new();
    let mut orphan_legs = 0usize;
    for (account_id, amount, kind, payee, date) in txn_rows {
        let Some(account_id) = account_id.filter(|a| !a.is_empty()) else {
            continue;
        };
        if balance_delta(&kind, &payee, amount).is_none() {
            orphan_legs += 1;
            continue;
        }
        txns_by_account
            .entry(account_id)
            .or_default()
            .push(NetWorthTxn {
                date,
                kind,
                payee,
                amount,
            });
    }
    if orphan_legs > 0 {
        tracing::error!(
            "[net-worth] {orphan_legs} transfer row(s) have no direction and are excluded from historical rollback (same as the live balance)"
        );
    }

    Ok(NetWorthContext {
        since: since.to_string(),
        accounts: account_rows
            .into_iter()
            .map(|(id, account_type, currency, is_active, off_budget)| {
                let parts = balances.get(&id);
                NetWorthAccount {
                    live_native: parts.map_or(0.0, |p| p.native),
                    holdings_native: parts.map_or(0.0, |p| p.holdings_native),
                    id,
                    account_type,
                    currency: currency.unwrap_or_else(|| "INR".into()),
                    off_budget: off_budget.unwrap_or(false),
                    is_active: is_active.unwrap_or(true),
                }
            })
            .collect(),
        txns_by_account,
        investments: inv_list.iter().map(to_net_worth_investment).collect(),
        policies,
        rates,
    })
}

fn to_net_worth_investment(i: &InvestmentResponse) -> NetWorthInvestment {
    NetWorthInvestment {
        account_id: i.account_id.clone(),
        purchase_date: i.purchase_date.clone(),
        current_value_inr: i.current_value_inr,
        asset_type: Some(i.asset_type.clone()),
        // Rate conversion is linear, so converting the quote once and running
        // the curve in base currency equals converting each derived value.
        quoted_inr: Some(if i.current_value > 0.0 {
            (i.current_value_inr / i.current_value) * i.quoted_value
        } else {
            0.0
        }),
        // `current_value_at ?? updated_at?.slice(0, 10) ?? null`
        quoted_at: Some(match &i.current_value_at {
            Some(at) => at.clone(),
            None => js_slice(&i.updated_at, 0, 10),
        }),
        depreciation_rate: i.depreciation_rate,
    }
}

/// `NetWorthSnapshot.breakdown`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct NetWorthBreakdown {
    /// On-budget asset accounts, holdings excluded.
    pub cash_inr: f64,
    /// Investment holdings + the cash sleeve of off-budget asset accounts.
    pub investments_inr: f64,
    pub policies_inr: f64,
    /// Negative: liabilities reduce net worth.
    pub debt_inr: f64,
    /// Holdings alone. Included in `investments_inr`.
    pub holdings_inr: f64,
    /// Off-budget asset cash alone. Included in `investments_inr`.
    pub off_budget_cash_inr: f64,
    /// Physical assets valued on the date (not part of `investments_inr`).
    pub physical_assets_inr: f64,
}

/// `NetWorthSnapshot`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct NetWorthSnapshot {
    pub as_of: String,
    pub total_inr: f64,
    pub breakdown: NetWorthBreakdown,
}

/// `computeNetWorthAt(asOf, ctx)`: the one net-worth formula.
pub fn compute_net_worth_at(as_of: &str, ctx: &NetWorthContext) -> ApiResult<NetWorthSnapshot> {
    if js_str_cmp(as_of, &ctx.since).is_lt() {
        return Err(ApiError::plain(format!(
            "net-worth context was loaded for dates >= {}, cannot answer {as_of}",
            ctx.since
        )));
    }

    let to_inr = |amount: f64, currency: &str| amount * rate_of(currency, &ctx.rates);

    let native_at = |acc: &NetWorthAccount| {
        let mut after = 0.0;
        if let Some(txns) = ctx.txns_by_account.get(&acc.id) {
            for t in txns {
                if js_str_cmp(&t.date, as_of).is_le() {
                    continue;
                }
                after += balance_delta(&t.kind, &t.payee, t.amount).unwrap_or(0.0);
            }
        }
        acc.live_native - after
    };

    // An account a policy points at is valued as a policy, never as cash.
    let policy_account_ids: HashSet<&str> = ctx
        .policies
        .iter()
        .filter_map(|p| p.account_id.as_str().filter(|s| !s.is_empty()))
        .collect();

    let mut cash_inr = 0.0;
    let mut off_budget_cash_inr = 0.0;
    let mut debt_inr = 0.0;
    // A JS `Map`: insertion order, `set` on an existing key keeps its place.
    let mut policy_account_inr: Vec<(String, f64)> = Vec::new();

    for acc in &ctx.accounts {
        if !acc.is_active {
            continue;
        }
        let balance_inr = to_inr(native_at(acc), &acc.currency);

        if is_liability_type(&acc.account_type) {
            debt_inr += balance_inr;
            continue;
        }
        if acc.account_type == "policy" || policy_account_ids.contains(acc.id.as_str()) {
            match policy_account_inr.iter_mut().find(|(k, _)| *k == acc.id) {
                Some((_, v)) => *v = balance_inr,
                None => policy_account_inr.push((acc.id.clone(), balance_inr)),
            }
            continue;
        }

        let sleeve_inr = balance_inr - to_inr(acc.holdings_native, &acc.currency);
        if acc.off_budget {
            off_budget_cash_inr += sleeve_inr;
        } else {
            cash_inr += sleeve_inr;
        }
    }

    let mut holdings_inr = 0.0;
    let mut physical_inr = 0.0;
    for i in &ctx.investments {
        if js_str_cmp(&i.purchase_date, as_of).is_gt() {
            continue;
        }
        let physical = i
            .asset_type
            .as_deref()
            .is_some_and(|t| !t.is_empty() && is_physical_asset(t));
        if physical {
            let rate = i.depreciation_rate.filter(|r| *r != 0.0 && !r.is_nan());
            let quoted_at = i.quoted_at.as_deref().filter(|q| !q.is_empty());
            physical_inr += match (rate, quoted_at) {
                (Some(rate), Some(at)) => depreciated_value(
                    i.quoted_inr.unwrap_or(i.current_value_inr),
                    Some(rate),
                    Some(at),
                    as_of,
                ),
                _ => i.current_value_inr,
            };
            continue;
        }
        holdings_inr += i.current_value_inr;
    }

    let mut policies_inr = 0.0;
    let mut valued_policy_accounts: HashSet<String> = HashSet::new();
    for p in &ctx.policies {
        let linked = p
            .account_id
            .as_str()
            .filter(|s| !s.is_empty())
            .and_then(|id| policy_account_inr.iter().find(|(k, _)| k == id));
        if let Some((id, value)) = linked {
            policies_inr += *value;
            valued_policy_accounts.insert(id.clone());
            continue;
        }
        // No linked account: value the premiums actually paid by `asOf`.
        let paid = compute_invested_at(p, AsOf::Iso(as_of))?;
        policies_inr += paid * rate_for(&currency_or_inr(&p.currency), &ctx.rates);
    }
    // A `policy` account with no policy row left pointing at it still counts.
    for (id, value) in &policy_account_inr {
        if !valued_policy_accounts.contains(id) {
            policies_inr += *value;
        }
    }

    let investments_inr = holdings_inr + off_budget_cash_inr;

    Ok(NetWorthSnapshot {
        as_of: as_of.to_string(),
        total_inr: cash_inr + investments_inr + policies_inr + physical_inr + debt_inr,
        breakdown: NetWorthBreakdown {
            cash_inr,
            investments_inr,
            policies_inr,
            debt_inr,
            holdings_inr,
            off_budget_cash_inr,
            physical_assets_inr: physical_inr,
        },
    })
}

/// `getNetWorth()`: net worth right now.
pub fn get_net_worth(conn: &Connection) -> ApiResult<NetWorthSnapshot> {
    get_net_worth_at(conn, now_ms())
}

/// `getNetWorth()` with the clock at `now`.
pub fn get_net_worth_at(conn: &Connection, now: f64) -> ApiResult<NetWorthSnapshot> {
    let today = local_iso_date(now);
    let ctx = load_net_worth_context(conn, &today)?;
    compute_net_worth_at(&today, &ctx)
}

/// `getNetWorth(ctx)` with the clock at `now`.
pub fn net_worth_from_context(ctx: &NetWorthContext, now: f64) -> ApiResult<NetWorthSnapshot> {
    compute_net_worth_at(&local_iso_date(now), ctx)
}

// ─── Portfolio Breakdown ───────────────────────────────────────────────────────

/// One `getPortfolioBreakdown()` slice.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BreakdownEntry {
    pub asset_type: String,
    pub value_inr: f64,
    pub percentage: f64,
}

/// `getPortfolioBreakdown()`.
pub fn get_portfolio_breakdown(conn: &Connection) -> ApiResult<Vec<BreakdownEntry>> {
    let inv_list = list_investments(conn, &InvestmentFilters::default())?;
    let all_accounts = budget::list_accounts(conn)?;
    let balances = budget::get_account_balances(conn)?;

    let mut by_type: JsRecord<f64> = JsRecord::new();
    for inv in &inv_list {
        if is_physical_asset(&inv.asset_type) {
            continue;
        }
        let prev = by_type.get(&inv.asset_type).copied().unwrap_or(0.0);
        by_type.set(&inv.asset_type, prev + inv.current_value_inr);
    }

    for acc in &all_accounts {
        if !acc.is_active || !acc.off_budget || !bears_holdings(&acc.account_type) {
            continue;
        }
        let parts = balances.get(&acc.id);
        let cash_val_inr = parts.map_or(0.0, |p| p.base) - parts.map_or(0.0, |p| p.holdings_base);
        if cash_val_inr > 0.0 {
            let prev = by_type.get(&acc.account_type).copied().unwrap_or(0.0);
            by_type.set(&acc.account_type, prev + cash_val_inr);
        }
    }

    let total = by_type.values().into_iter().fold(0.0, |s, v| s + *v);

    Ok(by_type
        .into_entries()
        .into_iter()
        .map(|(asset_type, value_inr)| BreakdownEntry {
            percentage: if total > 0.0 {
                js_round((value_inr / total) * 10000.0) / 100.0
            } else {
                0.0
            },
            asset_type,
            value_inr,
        })
        .collect())
}

// ─── Budget Heatmap ───────────────────────────────────────────────────────────

/// One `getBudgetHeatmap()` cell.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct HeatmapCell {
    pub month: String,
    pub envelope_name: String,
    pub spend_pct: f64,
}

/// `getBudgetHeatmap(months)`.
pub fn get_budget_heatmap(conn: &Connection, months: f64) -> ApiResult<Vec<HeatmapCell>> {
    get_budget_heatmap_at(conn, months, now_ms())
}

/// `getBudgetHeatmap(months)` with the clock at `now`.
pub fn get_budget_heatmap_at(
    conn: &Connection,
    months: f64,
    now: f64,
) -> ApiResult<Vec<HeatmapCell>> {
    let mut rows = Vec::new();
    let (year, month0, _) = local_fields(now);
    let mut i = 0.0;
    while i < months {
        let month = month_label(month_start(year, month0, i));
        for env in budget::list_envelopes(conn, &month)? {
            let spend_pct = if env.budgeted > 0.0 {
                (env.spent / env.budgeted) * 100.0
            } else {
                0.0
            };
            rows.push(HeatmapCell {
                month: month.clone(),
                envelope_name: env.name,
                spend_pct: js_round(spend_pct * 10.0) / 10.0,
            });
        }
        i += 1.0;
    }
    Ok(rows)
}

// ─── Top Movers ───────────────────────────────────────────────────────────────

/// One `getTopMovers()` entry.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TopMover {
    pub investment: InvestmentResponse,
    pub gain_loss_inr: f64,
    pub gain_loss_pct: f64,
}

/// `getTopMovers(_days, limit)`: `days` is unused, as in Node.
pub fn get_top_movers(conn: &Connection, _days: f64, limit: f64) -> ApiResult<Vec<TopMover>> {
    let mut inv_list = list_investments(
        conn,
        &InvestmentFilters {
            asset_type: None,
            sort: Some("gain_desc".into()),
        },
    )?;
    inv_list.retain(|inv| !is_physical_asset(&inv.asset_type));
    let end = slice_end(inv_list.len(), limit);
    inv_list.truncate(end);
    Ok(inv_list
        .into_iter()
        .map(|inv| TopMover {
            gain_loss_inr: inv.gain_loss_inr,
            gain_loss_pct: inv.gain_loss_pct,
            investment: inv,
        })
        .collect())
}

// ─── Spending Trends ──────────────────────────────────────────────────────────

/// One `getSpendingTrends()` month.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SpendingTrend {
    pub month: String,
    pub income: f64,
    pub expenses: f64,
}

/// `getSpendingTrends(months)`.
pub fn get_spending_trends(conn: &Connection, months: f64) -> ApiResult<Vec<SpendingTrend>> {
    get_spending_trends_at(conn, months, now_ms())
}

/// `getSpendingTrends(months)` with the clock at `now`.
pub fn get_spending_trends_at(
    conn: &Connection,
    months: f64,
    now: f64,
) -> ApiResult<Vec<SpendingTrend>> {
    let (year, month0, _) = local_fields(now);
    let mut out = Vec::new();
    let mut i = months - 1.0;
    while i >= 0.0 {
        let month = month_label(month_start(year, month0, i));
        let cf = get_cash_flow(conn, &month)?;
        let savings_group_total = cf
            .expense_groups
            .iter()
            .find(|g| is_savings(&g.group_name))
            .map_or(0.0, |g| g.total);
        let living_expenses = cf.total_expenses - savings_group_total;
        out.push(SpendingTrend {
            month,
            income: js_round(cf.total_income),
            expenses: js_round(living_expenses),
        });
        i -= 1.0;
    }
    Ok(out)
}

// ─── Upcoming Premium Payments ────────────────────────────────────────────────

/// One `getUpcomingPremiums()` entry.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct UpcomingPremium {
    pub policy_name: Value,
    pub provider: Value,
    pub due_date: String,
    pub amount: Value,
    pub frequency: Value,
}

/// `getUpcomingPremiums(daysAhead)`.
pub fn get_upcoming_premiums(
    conn: &Connection,
    days_ahead: f64,
) -> ApiResult<Vec<UpcomingPremium>> {
    get_upcoming_premiums_at(conn, days_ahead, now_ms())
}

/// `getUpcomingPremiums(daysAhead)` with the clock at `now`.
pub fn get_upcoming_premiums_at(
    conn: &Connection,
    days_ahead: f64,
    now: f64,
) -> ApiResult<Vec<UpcomingPremium>> {
    let all_policies = select_policies(conn)?;
    // `today.setHours(0,0,0,0)` keeps the local calendar day; `cutoff` is that
    // day + daysAhead (`setDate`), so both are calendar arithmetic.
    let today_iso = local_iso_date(now);
    let cutoff_iso = add_days_iso(&today_iso, days_ahead);

    let mut upcoming = Vec::new();
    for p in &all_policies {
        for due in p.premium_due_dates()? {
            if js_str_cmp(&due, &cutoff_iso).is_gt() {
                break;
            }
            if js_str_cmp(&due, &today_iso).is_lt() {
                continue;
            }
            upcoming.push(UpcomingPremium {
                policy_name: p.name.clone(),
                provider: p.provider.clone(),
                due_date: due,
                amount: p.premium_amount.clone(),
                frequency: p.premium_frequency.clone(),
            });
        }
    }

    if upcoming.len() > 1 {
        let coll = collator()?;
        js_sort_by(&mut upcoming, |a, b| {
            ordering_to_f64(coll.compare(&a.due_date, &b.due_date))
        });
    }
    upcoming.truncate(10);
    Ok(upcoming)
}

// ─── Cash Flow ────────────────────────────────────────────────────────────────

/// `{ payee, amount }`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct IncomeSource {
    pub payee: String,
    pub amount: f64,
}

/// `{ name, amount }`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct NamedAmount {
    pub name: String,
    pub amount: f64,
}

/// One `expense_groups` entry.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ExpenseGroup {
    pub group_name: String,
    pub total: f64,
    pub envelopes: Vec<NamedAmount>,
}

/// `getCashFlow(month)`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CashFlow {
    pub month: String,
    pub carryover: f64,
    pub total_income: f64,
    pub total_expenses: f64,
    pub savings: f64,
    pub income_sources: Vec<IncomeSource>,
    pub expense_groups: Vec<ExpenseGroup>,
}

/// `toInrLocal(amount, currency)`: unconverted when the currency is falsy.
fn to_inr_local(amount: f64, currency: Option<&str>, rates: &Rates) -> f64 {
    match currency.filter(|c| !c.is_empty()) {
        Some(c) => amount * rate_of(c, rates),
        None => amount,
    }
}

/// `String(v)` as an object key for a nullable text column.
fn key_of(v: Option<String>) -> String {
    v.unwrap_or_else(|| "null".into())
}

/// `getCashFlow(month)`.
pub fn get_cash_flow(conn: &Connection, month: &str) -> ApiResult<CashFlow> {
    let rates = get_latest_rates(conn)?;

    let date_from = format!("{month}-01");
    let date_to = month_end(month);

    let mut stmt = conn.prepare(
        "select \"transactions\".\"payee\", \"transactions\".\"amount\", \"accounts\".\"currency\" from \"transactions\" left join \"accounts\" on \"transactions\".\"account_id\" = \"accounts\".\"id\" where (\"transactions\".\"type\" = ? and \"accounts\".\"off_budget\" = ? and \"transactions\".\"date\" >= ? and \"transactions\".\"date\" <= ?)",
    )?;
    let income_txns = stmt
        .query_map(rusqlite::params!["income", 0, date_from, date_to], |r| {
            Ok((
                col_str(r, 0)?,
                col_f64(r, 1)?.unwrap_or(0.0),
                col_str(r, 2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut income_by_payee: JsRecord<f64> = JsRecord::new();
    for (payee, amount, currency) in income_txns {
        if payee.as_deref() == Some(STARTING_BALANCE_PAYEE) {
            continue;
        }
        let key = key_of(payee);
        let prev = income_by_payee.get(&key).copied().unwrap_or(0.0);
        income_by_payee.set(
            &key,
            prev + to_inr_local(amount, currency.as_deref(), &rates),
        );
    }
    let total_income = income_by_payee
        .values()
        .into_iter()
        .fold(0.0, |s, v| s + *v);

    let mut stmt = conn.prepare(
        "select \"transactions\".\"envelope_id\", \"envelopes\".\"name\", \"envelope_groups\".\"name\", \"transactions\".\"amount\", \"accounts\".\"currency\", \"transactions\".\"type\", \"transactions\".\"payee\" from \"transactions\" left join \"accounts\" on \"transactions\".\"account_id\" = \"accounts\".\"id\" left join \"envelopes\" on \"transactions\".\"envelope_id\" = \"envelopes\".\"id\" left join \"envelope_groups\" on \"envelopes\".\"group_id\" = \"envelope_groups\".\"id\" where ((\"transactions\".\"type\" = ? or \"transactions\".\"type\" = ?) and \"accounts\".\"off_budget\" = ? and \"transactions\".\"date\" >= ? and \"transactions\".\"date\" <= ?)",
    )?;
    let expense_txns = stmt
        .query_map(
            rusqlite::params!["expense", "transfer", 0, date_from, date_to],
            |r| {
                Ok((
                    col_str(r, 0)?,
                    col_str(r, 1)?,
                    col_str(r, 2)?,
                    col_f64(r, 3)?.unwrap_or(0.0),
                    col_str(r, 4)?,
                    col_string(r, 5)?,
                    col_string(r, 6)?,
                ))
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;

    let mut group_map: JsRecord<(f64, JsRecord<f64>)> = JsRecord::new();
    let mut total_expenses = 0.0;
    for (envelope_id, envelope_name, group_name, amount, currency, kind, payee) in expense_txns {
        if envelope_id.as_deref().is_none_or(str::is_empty) {
            continue;
        }
        let is_credit = is_transfer_in(&kind, &payee);
        let inr = to_inr_local(amount, currency.as_deref(), &rates);
        let net = if is_credit { -inr } else { inr };
        if net <= 0.0 {
            continue;
        }

        let group_name = group_name.unwrap_or_else(|| "Uncategorised".into());
        let env_name = envelope_name.unwrap_or_else(|| "Unknown".into());

        if group_map.get(&group_name).is_none() {
            group_map.set(&group_name, (0.0, JsRecord::new()));
        }
        if let Some((total, envs)) = group_map.get_mut(&group_name) {
            *total += net;
            let prev = envs.get(&env_name).copied().unwrap_or(0.0);
            envs.set(&env_name, prev + net);
        }
        total_expenses += net;
    }

    let mut group_entries = group_map.into_entries();
    js_sort_by(&mut group_entries, |a, b| b.1 .0 - a.1 .0);
    let expense_groups = group_entries
        .into_iter()
        .map(|(group_name, (total, envs))| {
            let mut envs = envs.into_entries();
            js_sort_by(&mut envs, |a, b| b.1 - a.1);
            ExpenseGroup {
                group_name,
                total,
                envelopes: envs
                    .into_iter()
                    .map(|(name, amount)| NamedAmount { name, amount })
                    .collect(),
            }
        })
        .collect();

    let carryover = budget::compute_carryover_for_month(conn, month, &budget_rates(&rates))?;

    let mut income_sources = income_by_payee.into_entries();
    js_sort_by(&mut income_sources, |a, b| b.1 - a.1);

    Ok(CashFlow {
        month: month.to_string(),
        carryover,
        total_income,
        total_expenses,
        savings: js_max(0.0, total_income - total_expenses),
        income_sources: income_sources
            .into_iter()
            .map(|(payee, amount)| IncomeSource { payee, amount })
            .collect(),
        expense_groups,
    })
}

// ─── Net Worth History ─────────────────────────────────────────────────────────

/// One `getNetWorthHistory()` point.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct NetWorthHistoryPoint {
    pub month: String,
    pub as_of: String,
    pub total_inr: f64,
    pub cash_inr: f64,
    /// Investments + policies, bundled for the chart.
    pub investments_inr: f64,
    pub physical_assets_inr: f64,
    pub debt_inr: f64,
}

/// The `(month, asOf)` points of `getNetWorthHistory(months)`.
fn history_points(months: f64, now: f64) -> Vec<(String, String)> {
    let today_iso = local_iso_date(now);
    let (year, month0, _) = local_fields(now);
    let mut points = Vec::new();
    let mut i = months - 1.0;
    while i >= 0.0 {
        let d = month_start(year, month0, i);
        let month = month_label(d);
        let month_end = match d.and_then(|(y, m)| js_make_date(y as f64, m as f64, 0.0)) {
            Some((y, m, day)) => format!("{y}-{m:02}-{day:02}"),
            None => "NaN-NaN-NaN".to_string(),
        };
        let as_of = if js_str_cmp(&month_end, &today_iso).is_gt() {
            today_iso.clone()
        } else {
            month_end
        };
        points.push((month, as_of));
        i -= 1.0;
    }
    points
}

/// `getNetWorthHistory(months)`.
pub fn get_net_worth_history(
    conn: &Connection,
    months: f64,
) -> ApiResult<Vec<NetWorthHistoryPoint>> {
    get_net_worth_history_at(conn, months, now_ms())
}

/// `getNetWorthHistory(months)` with the clock at `now`.
pub fn get_net_worth_history_at(
    conn: &Connection,
    months: f64,
    now: f64,
) -> ApiResult<Vec<NetWorthHistoryPoint>> {
    let points = history_points(months, now);
    let Some((_, first)) = points.first() else {
        // `points[0].asOf` on an empty list.
        return Err(ApiError::plain(
            "Cannot read properties of undefined (reading 'asOf')",
        ));
    };
    let ctx = load_net_worth_context(conn, first)?;
    history_from_points(points, &ctx)
}

/// `getNetWorthHistory(months, ctx)` with the clock at `now`.
pub fn net_worth_history_from_context(
    ctx: &NetWorthContext,
    months: f64,
    now: f64,
) -> ApiResult<Vec<NetWorthHistoryPoint>> {
    history_from_points(history_points(months, now), ctx)
}

fn history_from_points(
    points: Vec<(String, String)>,
    ctx: &NetWorthContext,
) -> ApiResult<Vec<NetWorthHistoryPoint>> {
    points
        .into_iter()
        .map(|(month, as_of)| {
            let snap = compute_net_worth_at(&as_of, ctx)?;
            Ok(NetWorthHistoryPoint {
                month,
                as_of,
                total_inr: snap.total_inr,
                cash_inr: snap.breakdown.cash_inr,
                investments_inr: snap.breakdown.investments_inr + snap.breakdown.policies_inr,
                physical_assets_inr: snap.breakdown.physical_assets_inr,
                debt_inr: snap.breakdown.debt_inr,
            })
        })
        .collect()
}

// ─── Full Dashboard ───────────────────────────────────────────────────────────

/// `DashboardResponse.budget`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DashboardBudget {
    pub total_budgeted: f64,
    pub total_spent: f64,
    pub total_available: f64,
    pub total_income: f64,
    pub to_assign: f64,
}

/// One `recent_transactions` entry.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RecentTransaction {
    pub id: Value,
    pub payee: Value,
    pub amount: Value,
    pub amount_inr: f64,
    pub currency: Value,
    #[serde(rename = "type")]
    pub kind: Value,
    pub date: Value,
    pub account_name: Value,
}

/// One `upcoming_policy_payouts` entry.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct UpcomingPayout {
    pub policy_name: Value,
    pub payout_date: Value,
    pub amount: Value,
    pub label: Value,
}

/// `DashboardResponse`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DashboardResponse {
    pub net_worth_inr: f64,
    pub month: String,
    pub budget: DashboardBudget,
    pub cash_total_inr: f64,
    pub investments_total_inr: f64,
    pub policies_total_inr: f64,
    pub debt_total_inr: f64,
    pub monthly_income: f64,
    pub monthly_expenses: f64,
    pub savings_rate: f64,
    pub recent_transactions: Vec<RecentTransaction>,
    pub upcoming_policy_payouts: Vec<UpcomingPayout>,
    pub upcoming_premium_payments: Vec<UpcomingPremium>,
    pub top_categories: Vec<NamedAmount>,
}

/// `getDashboard(month)`.
pub fn get_dashboard(conn: &Connection, month: &str) -> ApiResult<DashboardResponse> {
    get_dashboard_at(conn, month, now_ms())
}

/// `toInrAmt(amount, currency)`: unconverted when the currency is falsy.
fn to_inr_amt(amount: &Value, currency: &Value, rates: &Rates) -> f64 {
    let amount = to_number(amount);
    if truthy(Some(currency)) {
        amount * rate_for(currency, rates)
    } else {
        amount
    }
}

/// `new Date(value)` for a stored column value.
fn js_date_of(v: &Value) -> f64 {
    match v {
        Value::String(s) => parse_date(s),
        other => time_clip(to_number(other)),
    }
}

/// `d.setDate(d.getDate() + days)` in local time on time value `t`.
fn add_local_days(t: f64, days: f64) -> f64 {
    if t.is_nan() {
        return t;
    }
    let lt = local_time(t);
    let day = (lt / MS_PER_DAY).floor();
    let within = lt - day * MS_PER_DAY;
    let (y, m, d) = local_fields(t);
    time_clip(utc_from_local(make_date(make_day(y, m, d + days), within)))
}

/// `getDashboard(month)` with the clock at `now`.
pub fn get_dashboard_at(conn: &Connection, month: &str, now: f64) -> ApiResult<DashboardResponse> {
    let rates = get_latest_rates(conn)?;
    let b_rates = budget_rates(&rates);

    let net_worth = get_net_worth_at(conn, now)?;
    let envelopes = budget::list_envelopes(conn, month)?;
    let mut stmt = conn.prepare(ACCOUNT_SELECT)?;
    let all_accounts = stmt
        .query_map([], |r| {
            Ok((
                from_sql(r.get_ref(0)?),
                from_sql(r.get_ref(1)?),
                from_sql(r.get_ref(3)?),
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut stmt = conn.prepare(
        "select \"id\", \"policy_id\", \"payout_date\", \"amount\", \"label\", \"is_received\" from \"policy_payouts\"",
    )?;
    let all_payouts = stmt
        .query_map([], |r| {
            Ok((
                from_sql(r.get_ref(1)?),
                from_sql(r.get_ref(2)?),
                from_sql(r.get_ref(3)?),
                from_sql(r.get_ref(4)?),
                from_sql(r.get_ref(5)?),
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let all_policies = select_policies(conn)?;
    let upcoming_premiums = get_upcoming_premiums_at(conn, 60.0, now)?;
    let carryover = budget::compute_carryover_for_month(conn, month, &b_rates)?;
    let cash_flow = get_cash_flow(conn, month)?;

    let total_budgeted = envelopes.iter().fold(0.0, |s, e| s + e.budgeted_inr);
    let total_spent = envelopes.iter().fold(0.0, |s, e| s + e.spent);

    let date_from = format!("{month}-01");
    let date_to = month_end(month);
    // Savings brought back into the budget this month — funds to_assign.
    let from_savings = budget::compute_from_savings(
        conn,
        &b_rates,
        &SavingsRange {
            before: None,
            from: Some(date_from.clone()),
            to: Some(date_to.clone()),
        },
    )?;
    let mut stmt = conn.prepare(
        "select \"transactions\".\"amount\", \"transactions\".\"type\", \"accounts\".\"currency\", \"transactions\".\"account_id\", \"transactions\".\"id\", \"transactions\".\"payee\", \"transactions\".\"date\" from \"transactions\" left join \"accounts\" on \"transactions\".\"account_id\" = \"accounts\".\"id\" where (\"transactions\".\"date\" >= ? and \"transactions\".\"date\" <= ?)",
    )?;
    let month_txns = stmt
        .query_map(params_from_iter([&date_from, &date_to]), |r| {
            Ok(MonthTxn {
                amount: from_sql(r.get_ref(0)?),
                kind: from_sql(r.get_ref(1)?),
                account_id: from_sql(r.get_ref(3)?),
                id: from_sql(r.get_ref(4)?),
                payee: from_sql(r.get_ref(5)?),
                date: from_sql(r.get_ref(6)?),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let monthly_income = cash_flow.total_income;
    let savings_group_total = cash_flow
        .expense_groups
        .iter()
        .find(|g| is_savings(&g.group_name))
        .map_or(0.0, |g| g.total);
    let monthly_expenses = cash_flow.total_expenses - savings_group_total;

    let savings_rate = if monthly_income > 0.0 {
        js_round(((monthly_income - monthly_expenses) / monthly_income) * 1000.0) / 10.0
    } else {
        0.0
    };

    // `Object.fromEntries(accounts.map(a => [a.id, { name, currency }]))`.
    let mut account_map: HashMap<String, (Value, Value)> = HashMap::new();
    for (id, name, currency) in all_accounts {
        account_map.insert(js_property_key(&id), (name, currency));
    }
    let account_of = |t: &MonthTxn| account_map.get(&js_property_key(&t.account_id));
    let currency_or = |t: &MonthTxn, fallback: Value| match account_of(t) {
        Some((_, c)) if !c.is_null() => c.clone(),
        _ => fallback,
    };

    let mut recent: Vec<&MonthTxn> = month_txns
        .iter()
        .filter(|t| t.kind.as_str() != Some("transfer"))
        .collect();
    js_sort_by(&mut recent, |a, b| {
        to_inr_amt(&b.amount, &currency_or(b, Value::Null), &rates)
            - to_inr_amt(&a.amount, &currency_or(a, Value::Null), &rates)
    });
    recent.truncate(8);

    let in90 = add_local_days(now, 90.0);
    let mut policy_map: HashMap<String, Value> = HashMap::new();
    for p in &all_policies {
        policy_map.insert(js_property_key(&p.id), p.name.clone());
    }

    let mut upcoming: Vec<&(Value, Value, Value, Value, Value)> = all_payouts
        .iter()
        .filter(|(_, payout_date, _, _, is_received)| {
            let received = !is_received.is_null() && to_number(is_received) == 1.0;
            let d = js_date_of(payout_date);
            !received && d >= now && d <= in90
        })
        .collect();
    if upcoming.len() > 1 {
        // `payout_date` is a NOT NULL TEXT column, so always a string.
        let coll = collator()?;
        js_sort_by(&mut upcoming, |a, b| {
            ordering_to_f64(coll.compare(
                a.1.as_str().unwrap_or_default(),
                b.1.as_str().unwrap_or_default(),
            ))
        });
    }
    upcoming.truncate(5);
    let upcoming_policy_payouts = upcoming
        .into_iter()
        .map(
            |(policy_id, payout_date, amount, label, _)| UpcomingPayout {
                policy_name: match policy_map.get(&js_property_key(policy_id)) {
                    Some(name) if !name.is_null() => name.clone(),
                    _ => Value::String(String::new()),
                },
                payout_date: payout_date.clone(),
                amount: amount.clone(),
                label: label.clone(),
            },
        )
        .collect();

    let recent_transactions = recent
        .into_iter()
        .map(|t| {
            let currency = currency_or(t, Value::String("INR".into()));
            RecentTransaction {
                id: t.id.clone(),
                payee: t.payee.clone(),
                amount: t.amount.clone(),
                amount_inr: to_inr_amt(&t.amount, &currency, &rates),
                currency,
                kind: t.kind.clone(),
                date: t.date.clone(),
                account_name: match account_of(t) {
                    Some((name, _)) if !name.is_null() => name.clone(),
                    _ => Value::String(String::new()),
                },
            }
        })
        .collect();

    let top_categories = cash_flow
        .expense_groups
        .iter()
        .filter(|g| !is_savings(&g.group_name))
        .map(|g| NamedAmount {
            name: g.group_name.clone(),
            amount: g.total,
        })
        .collect();

    Ok(DashboardResponse {
        net_worth_inr: net_worth.total_inr,
        month: month.to_string(),
        budget: DashboardBudget {
            total_budgeted,
            total_spent,
            total_available: total_budgeted - total_spent,
            total_income: monthly_income,
            to_assign: monthly_income + from_savings + carryover - total_budgeted,
        },
        cash_total_inr: net_worth.breakdown.cash_inr,
        investments_total_inr: net_worth.breakdown.investments_inr,
        policies_total_inr: net_worth.breakdown.policies_inr,
        debt_total_inr: net_worth.breakdown.debt_inr,
        monthly_income,
        monthly_expenses,
        savings_rate,
        recent_transactions,
        upcoming_policy_payouts,
        upcoming_premium_payments: upcoming_premiums,
        top_categories,
    })
}

/// A `monthTxns` row (raw column values).
struct MonthTxn {
    amount: Value,
    kind: Value,
    account_id: Value,
    id: Value,
    payee: Value,
    date: Value,
}

/// `localYearMonth()`: the local calendar month as `YYYY-MM`.
pub fn local_year_month() -> String {
    js_slice(&local_iso_date(now_ms()), 0, 7)
}
