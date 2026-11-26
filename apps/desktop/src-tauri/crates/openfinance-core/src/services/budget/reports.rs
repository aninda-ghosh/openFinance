//! Reports: Ready-to-assign carryover, From Savings, the monthly summary and
//! envelope trends (budget.service.ts "Reports").

use std::collections::HashMap;

use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, Connection, OptionalExtension};
use serde::Serialize;

use super::compat::month_end;
use super::envelopes::{compute_spent_by_envelope, list_envelopes};
use super::{
    col_f64, col_str, col_string, get_latest_rates, is_transfer_in, to_inr, Rates, FROM_SAVINGS,
    TRANSFER_IN,
};
use crate::error::{ApiError, ApiResult};

const ON_BUDGET: &str = "(\"accounts\".\"off_budget\" = ? or \"accounts\".\"off_budget\" is null)";

/// The `range` argument of `computeFromSavings`.
#[derive(Debug, Clone, Default)]
pub struct SavingsRange {
    pub before: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
}

fn amounts_with_currency(
    conn: &Connection,
    sql: &str,
    params: Vec<SqlValue>,
) -> ApiResult<Vec<(f64, Option<String>)>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt
        .query_map(params_from_iter(params), |r| {
            Ok((col_f64(r, 0)?.unwrap_or(0.0), col_str(r, 1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn sum_base(rows: &[(f64, Option<String>)], rates: &Rates) -> f64 {
    rows.iter().fold(0.0, |s, (amount, currency)| {
        s + to_inr(*amount, currency.as_deref().unwrap_or("INR"), rates)
    })
}

/// `computeFromSavings(rates, range)`: base-currency sum of Transfer-in legs
/// tagged FROM_SAVINGS on on-budget accounts.
pub fn compute_from_savings(
    conn: &Connection,
    rates: &Rates,
    range: &SavingsRange,
) -> ApiResult<f64> {
    let mut conds = vec![
        "\"transactions\".\"type\" = ?".to_string(),
        "\"transactions\".\"payee\" = ?".to_string(),
        "\"transactions\".\"income_category\" = ?".to_string(),
        ON_BUDGET.to_string(),
    ];
    let mut params = vec![
        SqlValue::Text("transfer".into()),
        SqlValue::Text(TRANSFER_IN.into()),
        SqlValue::Text(FROM_SAVINGS.into()),
        SqlValue::Integer(0),
    ];
    let truthy = |s: &Option<String>| s.clone().filter(|s| !s.is_empty());
    if let Some(b) = truthy(&range.before) {
        conds.push("\"transactions\".\"date\" < ?".into());
        params.push(SqlValue::Text(b));
    }
    if let Some(f) = truthy(&range.from) {
        conds.push("\"transactions\".\"date\" >= ?".into());
        params.push(SqlValue::Text(f));
    }
    if let Some(t) = truthy(&range.to) {
        conds.push("\"transactions\".\"date\" <= ?".into());
        params.push(SqlValue::Text(t));
    }
    let rows = amounts_with_currency(
        conn,
        &format!(
            "select \"transactions\".\"amount\", \"accounts\".\"currency\" from \"transactions\" left join \"accounts\" on \"transactions\".\"account_id\" = \"accounts\".\"id\" where ({})",
            conds.join(" and ")
        ),
        params,
    )?;
    Ok(sum_base(&rows, rates))
}

/// `computeCarryoverForMonth(month, rates)`: Σ(prior income + From Savings)
/// − Σ(prior budgeted) − Σ(prior overspending).
pub fn compute_carryover_for_month(
    conn: &Connection,
    month: &str,
    rates: &Rates,
) -> ApiResult<f64> {
    let first = format!("{month}-01");
    let income = amounts_with_currency(
        conn,
        &format!(
            "select \"transactions\".\"amount\", \"accounts\".\"currency\" from \"transactions\" left join \"accounts\" on \"transactions\".\"account_id\" = \"accounts\".\"id\" where (\"transactions\".\"type\" = ? and {ON_BUDGET} and \"transactions\".\"date\" < ?)"
        ),
        vec![
            SqlValue::Text("income".into()),
            SqlValue::Integer(0),
            SqlValue::Text(first.clone()),
        ],
    )?;
    let total_prior_income = sum_base(&income, rates)
        + compute_from_savings(
            conn,
            rates,
            &SavingsRange {
                before: Some(first),
                ..Default::default()
            },
        )?;

    let mut stmt = conn.prepare(
        "select \"id\", \"month\", \"budgeted\", \"budget_currency\" from \"envelopes\" where \"envelopes\".\"month\" < ?",
    )?;
    let prior = stmt
        .query_map([month], |r| {
            Ok((
                col_string(r, 0)?,
                col_string(r, 1)?,
                col_f64(r, 2)?,
                col_str(r, 3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut months: Vec<&str> = Vec::new();
    for (_, m, _, _) in &prior {
        if !months.contains(&m.as_str()) {
            months.push(m);
        }
    }
    let mut spent_by_month: HashMap<&str, HashMap<String, f64>> = HashMap::new();
    for m in months {
        let ids: Vec<String> = prior
            .iter()
            .filter(|(_, pm, _, _)| pm == m)
            .map(|(id, _, _, _)| id.clone())
            .collect();
        spent_by_month.insert(m, compute_spent_by_envelope(conn, m, rates, Some(&ids))?);
    }

    let mut total_budgeted = 0.0;
    let mut total_overspent = 0.0;
    for (id, m, budgeted, currency) in &prior {
        let budgeted_inr = to_inr(
            budgeted.unwrap_or(0.0),
            currency.as_deref().unwrap_or("INR"),
            rates,
        );
        let spent_inr = spent_by_month
            .get(m.as_str())
            .and_then(|s| s.get(id))
            .copied()
            .unwrap_or(0.0);
        total_budgeted += budgeted_inr;
        if spent_inr > budgeted_inr {
            total_overspent += spent_inr - budgeted_inr;
        }
    }
    Ok(total_prior_income - total_budgeted - total_overspent)
}

/// One `envelope_summaries` entry.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct EnvelopeSummary {
    pub envelope_id: String,
    pub envelope_name: String,
    pub budgeted: f64,
    pub spent: f64,
    pub available: f64,
}

/// `MonthlySummaryResponse`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MonthlySummaryResponse {
    pub month: String,
    pub total_income: f64,
    pub total_expenses: f64,
    pub net: f64,
    pub total_from_savings: f64,
    pub carryover_from_previous: f64,
    pub envelope_summaries: Vec<EnvelopeSummary>,
}

/// `getMonthlySummary(month)`.
pub fn get_monthly_summary(conn: &Connection, month: &str) -> ApiResult<MonthlySummaryResponse> {
    let date_from = format!("{month}-01");
    let date_to = month_end(month);
    let rates = get_latest_rates(conn)?;
    let carryover = compute_carryover_for_month(conn, month, &rates)?;

    let mut stmt = conn.prepare(&format!(
        "select \"transactions\".\"id\", \"transactions\".\"account_id\", \"transactions\".\"envelope_id\", \"transactions\".\"amount\", \"transactions\".\"type\", \"transactions\".\"payee\", \"transactions\".\"income_category\", \"accounts\".\"currency\" from \"transactions\" left join \"accounts\" on \"transactions\".\"account_id\" = \"accounts\".\"id\" where (\"transactions\".\"date\" >= ? and \"transactions\".\"date\" <= ? and {ON_BUDGET})"
    ))?;
    struct Txn {
        envelope_id: Option<String>,
        amount: f64,
        t: String,
        payee: String,
        income_category: Option<String>,
        currency: Option<String>,
    }
    let txns = stmt
        .query_map(rusqlite::params![date_from, date_to, 0], |r| {
            Ok(Txn {
                envelope_id: col_str(r, 2)?,
                amount: col_f64(r, 3)?.unwrap_or(0.0),
                t: col_string(r, 4)?,
                payee: col_string(r, 5)?,
                income_category: col_str(r, 6)?,
                currency: col_str(r, 7)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let inr = |t: &Txn| to_inr(t.amount, t.currency.as_deref().unwrap_or("INR"), &rates);
    let has_env = |t: &Txn| t.envelope_id.as_deref().is_some_and(|e| !e.is_empty());

    let total_income = txns
        .iter()
        .filter(|t| t.t == "income")
        .fold(0.0, |s, t| s + inr(t));
    let total_expenses = txns
        .iter()
        .filter(|t| t.t == "expense" || (has_env(t) && t.t == "transfer"))
        .fold(0.0, |s, t| {
            let v = inr(t);
            s + if is_transfer_in(&t.t, &t.payee) {
                -v
            } else {
                v
            }
        });
    let total_from_savings = txns
        .iter()
        .filter(|t| {
            is_transfer_in(&t.t, &t.payee)
                && t.income_category.as_deref() == Some(FROM_SAVINGS)
                && !has_env(t)
        })
        .fold(0.0, |s, t| s + inr(t));

    let envelopes = list_envelopes(conn, month)?;
    Ok(MonthlySummaryResponse {
        month: month.to_string(),
        total_income,
        total_expenses,
        net: total_income - total_expenses,
        total_from_savings,
        carryover_from_previous: carryover,
        envelope_summaries: envelopes
            .into_iter()
            .map(|e| EnvelopeSummary {
                envelope_id: e.id,
                envelope_name: e.name,
                budgeted: e.budgeted_inr,
                spent: e.spent,
                available: e.available,
            })
            .collect(),
    })
}

/// `TrendResponse`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TrendResponse {
    pub month: String,
    pub budgeted: f64,
    pub spent: f64,
}

/// `getEnvelopeTrends(envelopeId, months)`: budgeted vs spent for the last
/// `months` months of the envelope's `group_id|name`. `months` is the raw JS
/// number (`Number(query ?? 6)`); NaN or negative means no limit.
pub fn get_envelope_trends(
    conn: &Connection,
    envelope_id: &str,
    months: f64,
) -> ApiResult<Vec<TrendResponse>> {
    let rates = get_latest_rates(conn)?;
    let anchor = conn
        .query_row(
            "select \"group_id\", \"name\" from \"envelopes\" where \"envelopes\".\"id\" = ? limit ?",
            rusqlite::params![envelope_id, 1],
            |r| Ok((col_string(r, 0)?, col_string(r, 1)?)),
        )
        .optional()?
        .ok_or_else(|| ApiError::service(404, "Envelope not found"))?;

    let mut sql = "select \"id\", \"month\", \"budgeted\", \"budget_currency\" from \"envelopes\" where (\"envelopes\".\"group_id\" = ? and \"envelopes\".\"name\" = ?) order by \"envelopes\".\"month\" desc".to_string();
    let mut params = vec![SqlValue::Text(anchor.0), SqlValue::Text(anchor.1)];
    // drizzle only emits `limit ?` for a number >= 0.
    if months >= 0.0 {
        sql.push_str(" limit ?");
        params.push(SqlValue::Real(months));
    }
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params_from_iter(params), |r| {
            Ok((
                col_string(r, 0)?,
                col_string(r, 1)?,
                col_f64(r, 2)?,
                col_str(r, 3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut trends = Vec::with_capacity(rows.len());
    for (id, month, budgeted, currency) in rows {
        let spent =
            compute_spent_by_envelope(conn, &month, &rates, Some(std::slice::from_ref(&id)))?;
        trends.push(TrendResponse {
            budgeted: to_inr(
                budgeted.unwrap_or(0.0),
                currency.as_deref().unwrap_or("INR"),
                &rates,
            ),
            month,
            spent: spent.get(&id).copied().unwrap_or(0.0),
        });
    }
    Ok(trends)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::budget::test_support::{db, exec};

    #[test]
    fn carryover_and_summary() {
        let conn = db();
        exec(
            &conn,
            "insert into accounts (id, name, type, currency, off_budget) values
               ('chk', 'Checking', 'checking', 'INR', 0), ('hysa', 'HYSA', 'savings', 'INR', 1);
             insert into envelope_groups (id, name, sort_order) values ('g', 'G', 0);
             insert into envelopes (id, group_id, name, month, budgeted) values
               ('a4', 'g', 'Food', '2026-04', 100), ('a5', 'g', 'Food', '2026-05', 100);
             insert into transactions (id, account_id, envelope_id, payee, amount, type, date, income_category) values
               ('i1', 'chk', null, 'Pay', 1000, 'income', '2026-04-01', 'income'),
               ('x1', 'chk', 'a4', 'Shop', 150, 'expense', '2026-04-10', null),
               ('s1', 'chk', null, 'Transfer in', 40, 'transfer', '2026-04-11', 'from_savings'),
               ('s2', 'hysa', null, 'Transfer out', 40, 'transfer', '2026-04-11', null),
               ('h1', 'hysa', null, 'Interest', 5, 'income', '2026-04-12', 'income'),
               ('i2', 'chk', null, 'Pay', 500, 'income', '2026-05-01', 'income'),
               ('x2', 'chk', 'a5', 'Shop', 30, 'expense', '2026-05-02', null),
               ('s3', 'chk', null, 'Transfer in', 7, 'transfer', '2026-05-03', 'from_savings');",
        );
        let rates = Rates::new();
        // 1000 income + 40 from savings − 100 budgeted − 50 overspent
        assert_eq!(
            compute_carryover_for_month(&conn, "2026-05", &rates).expect("c"),
            890.0
        );
        let s = get_monthly_summary(&conn, "2026-05").expect("summary");
        assert_eq!(s.total_income, 500.0);
        assert_eq!(s.total_expenses, 30.0);
        assert_eq!(s.net, 470.0);
        assert_eq!(s.total_from_savings, 7.0);
        assert_eq!(s.carryover_from_previous, 890.0);
        assert_eq!(s.envelope_summaries.len(), 1);
        assert_eq!(s.envelope_summaries[0].available, 70.0);

        let trends = get_envelope_trends(&conn, "a5", 6.0).expect("trends");
        assert_eq!(
            trends.iter().map(|t| t.month.as_str()).collect::<Vec<_>>(),
            ["2026-05", "2026-04"]
        );
        assert_eq!(trends[1].spent, 150.0);
        assert_eq!(get_envelope_trends(&conn, "a5", 1.0).expect("one").len(), 1);
        assert_eq!(
            get_envelope_trends(&conn, "a5", f64::NAN)
                .expect("all")
                .len(),
            2
        );
    }
}
