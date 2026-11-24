//! `dashboard.test.ts` ported as Rust tests. The Node file builds most
//! `NetWorthContext`s by hand (no mocks involved), so those cases do too; the
//! cases that rely on mocked services (`loadNetWorthContext`, the formula
//! invariant) run on a real in-memory database instead.
//!
//! Already ported elsewhere and not duplicated: the `computeInvestedAt`
//! policy cases ("values an unlinked policy at the premiums paid", "converts
//! an unlinked policy's premiums at its own currency") in `services/policy.rs`,
//! and the vehicle-valuation cases ("higher in the past", "flat with no rate")
//! in `services/investment/tests.rs`.

use super::*;
use serde_json::json;

const TODAY: &str = "2026-08-19";

fn conn() -> Connection {
    let c = Connection::open_in_memory().expect("open");
    crate::db::bootstrap::bootstrap_schema(&c).expect("bootstrap");
    c
}

/// `vi.setSystemTime(new Date("2026-08-19T09:00:00"))` (local time).
fn fake_now() -> f64 {
    utc_from_local(make_date(make_day(2026.0, 7.0, 19.0), 9.0 * 3_600_000.0))
}

fn rates() -> Rates {
    vec![("INR".into(), json!(1)), ("USD".into(), json!(80))]
}

fn ctx_of() -> NetWorthContext {
    NetWorthContext {
        since: "2000-01-01".into(),
        rates: rates(),
        ..Default::default()
    }
}

fn account(id: &str, account_type: &str, live_native: f64) -> NetWorthAccount {
    NetWorthAccount {
        id: id.into(),
        account_type: account_type.into(),
        currency: "INR".into(),
        off_budget: false,
        is_active: true,
        live_native,
        holdings_native: 0.0,
    }
}

fn holding(account_id: Option<&str>, purchase_date: &str, value: f64) -> NetWorthInvestment {
    NetWorthInvestment {
        account_id: account_id.map(String::from),
        purchase_date: purchase_date.into(),
        current_value_inr: value,
        ..Default::default()
    }
}

fn policy(account_id: Option<&str>) -> PolicyRow {
    PolicyRow {
        id: json!("pol-1"),
        name: json!("Endowment"),
        provider: json!("LIC"),
        policy_number: Value::Null,
        currency: json!("INR"),
        start_date: json!("2026-01-01"),
        premium_amount: json!(1000),
        premium_frequency: json!("monthly"),
        premium_term_years: json!(10),
        policy_term_years: json!(20),
        maturity_date: json!("2046-01-01"),
        sum_assured: json!(500000),
        maturity_value: json!(500000),
        surrender_value: Value::Null,
        notes: Value::Null,
        account_id: account_id.map_or(Value::Null, |a| json!(a)),
        created_at: json!(""),
        updated_at: json!(""),
    }
}

fn txn(date: &str, kind: &str, payee: &str, amount: f64) -> NetWorthTxn {
    NetWorthTxn {
        date: date.into(),
        kind: kind.into(),
        payee: payee.into(),
        amount,
    }
}

fn at(as_of: &str, ctx: &NetWorthContext) -> NetWorthSnapshot {
    compute_net_worth_at(as_of, ctx).expect("snapshot")
}

// ─── one formula for every consumer ──────────────────────────────────────────

fn shared_ctx() -> NetWorthContext {
    let mut sav = account("sav", "savings", 400000.0);
    sav.off_budget = true;
    let mut brk = account("brk", "investment", 250000.0);
    brk.off_budget = true;
    brk.holdings_native = 200000.0;
    NetWorthContext {
        accounts: vec![
            account("chk", "checking", 120000.0),
            sav,
            account("card", "credit", -35000.0),
            brk,
        ],
        investments: vec![holding(Some("brk"), "2024-06-01", 200000.0)],
        policies: vec![policy(None)],
        ..ctx_of()
    }
}

#[test]
fn current_net_worth_equals_the_last_point_of_the_history_series() {
    let shared = shared_ctx();
    let now = net_worth_from_context(&shared, fake_now()).expect("now");
    let history = net_worth_history_from_context(&shared, 6.0, fake_now()).expect("history");
    let last = history.last().expect("points");

    assert_eq!(history.len(), 6);
    assert_eq!(last.as_of, TODAY);
    assert_eq!(now.as_of, TODAY);
    assert_eq!(last.total_inr, now.total_inr);
    assert_eq!(last.cash_inr, now.breakdown.cash_inr);
    assert_eq!(last.debt_inr, now.breakdown.debt_inr);
    assert_eq!(
        last.investments_inr,
        now.breakdown.investments_inr + now.breakdown.policies_inr
    );
}

#[test]
fn keeps_the_breakdown_self_consistent_with_the_total() {
    let now = net_worth_from_context(&shared_ctx(), fake_now()).expect("now");
    let b = &now.breakdown;
    assert_eq!(b.cash_inr, 120000.0);
    assert_eq!(b.off_budget_cash_inr, 400000.0 + 50000.0);
    assert_eq!(b.holdings_inr, 200000.0);
    assert_eq!(b.investments_inr, b.holdings_inr + b.off_budget_cash_inr);
    assert_eq!(b.debt_inr, -35000.0);
    assert_eq!(
        now.total_inr,
        b.cash_inr + b.investments_inr + b.policies_inr + b.physical_assets_inr + b.debt_inr
    );
}

// ─── off-budget asset accounts ───────────────────────────────────────────────

#[test]
fn counts_an_off_budget_savings_account_identically_now_and_in_every_month() {
    let mut sav = account("sav", "savings", 100000.0);
    sav.off_budget = true;
    let ctx = NetWorthContext {
        accounts: vec![sav],
        ..ctx_of()
    };
    let now = net_worth_from_context(&ctx, fake_now()).expect("now");
    let history = net_worth_history_from_context(&ctx, 6.0, fake_now()).expect("history");

    assert_eq!(now.total_inr, 100000.0);
    assert_eq!(now.breakdown.cash_inr, 0.0);
    assert_eq!(now.breakdown.off_budget_cash_inr, 100000.0);
    for point in history {
        assert_eq!(point.total_inr, 100000.0);
        assert_eq!(point.investments_inr, 100000.0);
    }
}

// ─── physical assets ─────────────────────────────────────────────────────────

fn car() -> NetWorthInvestment {
    NetWorthInvestment {
        account_id: None,
        purchase_date: "2021-03-01".into(),
        asset_type: Some("vehicle".into()),
        current_value_inr: 18000.0,
        quoted_inr: Some(20000.0),
        quoted_at: Some("2025-08-19".into()),
        depreciation_rate: Some(10.0),
    }
}

#[test]
fn counts_a_vehicle_in_its_own_bucket_never_in_investments() {
    let ctx = NetWorthContext {
        investments: vec![car(), holding(None, "2020-01-01", 5000.0)],
        ..ctx_of()
    };
    let snap = at(TODAY, &ctx);
    // toBeCloseTo(18000, -1): |a - e| < 5
    assert!((snap.breakdown.physical_assets_inr - 18000.0).abs() < 5.0);
    assert_eq!(snap.breakdown.holdings_inr, 5000.0);
    assert_eq!(snap.breakdown.investments_inr, 5000.0);
    assert!((snap.total_inr - 23000.0).abs() < 5.0);
}

#[test]
fn does_not_count_a_vehicle_before_it_was_bought() {
    let ctx = NetWorthContext {
        investments: vec![car()],
        ..ctx_of()
    };
    assert_eq!(at("2020-12-31", &ctx).breakdown.physical_assets_inr, 0.0);
}

// ─── liabilities ─────────────────────────────────────────────────────────────

#[test]
fn reduces_net_worth_by_the_magnitude_owed_for_every_liability_type() {
    for t in ["credit", "loan", "debt"] {
        let ctx = NetWorthContext {
            accounts: vec![
                account("chk", "checking", 100000.0),
                account("owed", t, -25000.0),
            ],
            ..ctx_of()
        };
        let snap = at(TODAY, &ctx);
        assert_eq!(snap.breakdown.debt_inr, -25000.0);
        assert_eq!(snap.total_inr, 75000.0);
    }
}

// ─── linked holdings ─────────────────────────────────────────────────────────

#[test]
fn counts_a_linked_holding_once() {
    let mut brk = account("brk", "investment", 80000.0);
    brk.holdings_native = 30000.0;
    let ctx = NetWorthContext {
        accounts: vec![brk],
        investments: vec![holding(Some("brk"), "2020-01-01", 30000.0)],
        ..ctx_of()
    };
    let snap = at(TODAY, &ctx);
    assert_eq!(snap.breakdown.cash_inr, 50000.0);
    assert_eq!(snap.breakdown.holdings_inr, 30000.0);
    assert_eq!(snap.total_inr, 80000.0);
}

#[test]
fn does_not_credit_a_holding_before_it_was_bought() {
    let ctx = NetWorthContext {
        accounts: vec![account("chk", "checking", 10000.0)],
        investments: vec![holding(None, "2026-07-15", 40000.0)],
        ..ctx_of()
    };
    assert_eq!(at("2026-06-30", &ctx).total_inr, 10000.0);
    assert_eq!(at("2026-07-31", &ctx).total_inr, 50000.0);
}

// ─── overdrawn accounts ──────────────────────────────────────────────────────

#[test]
fn reports_a_negative_cash_sleeve_instead_of_flooring_it_at_zero() {
    let ctx = NetWorthContext {
        accounts: vec![account("chk", "checking", -5000.0)],
        ..ctx_of()
    };
    let snap = at(TODAY, &ctx);
    assert_eq!(snap.breakdown.cash_inr, -5000.0);
    assert_eq!(snap.total_inr, -5000.0);
}

// ─── as-of dates ─────────────────────────────────────────────────────────────

fn rollback_ctx(rows: Vec<NetWorthTxn>) -> NetWorthContext {
    NetWorthContext {
        since: "2026-01-01".into(),
        accounts: vec![account("chk", "checking", 60000.0)],
        txns_by_account: HashMap::from([("chk".to_string(), rows)]),
        ..ctx_of()
    }
}

#[test]
fn rolls_the_live_balance_back_over_later_transactions() {
    let ctx = rollback_ctx(vec![txn("2026-08-10", "income", "Salary", 10000.0)]);
    assert_eq!(at("2026-07-31", &ctx).total_inr, 50000.0);
    assert_eq!(at(TODAY, &ctx).total_inr, 60000.0);
}

#[test]
fn does_not_depend_on_the_order_transactions_arrive_in() {
    let rows = vec![
        txn("2026-08-10", "income", "Salary", 10000.0),
        txn("2026-06-01", "expense", "Rent", 5000.0),
        txn("2026-08-02", "transfer", "Transfer out", 2000.0),
    ];
    let mut asc = rows.clone();
    asc.sort_by(|a, b| a.date.cmp(&b.date));
    let mut desc = rows;
    desc.sort_by(|a, b| b.date.cmp(&a.date));
    let ascending = at("2026-07-31", &rollback_ctx(asc));
    let descending = at("2026-07-31", &rollback_ctx(desc));
    assert_eq!(ascending.total_inr, 52000.0);
    assert_eq!(descending.total_inr, ascending.total_inr);
}

#[test]
fn refuses_a_date_the_context_was_not_loaded_for() {
    let ctx = rollback_ctx(vec![txn("2026-08-10", "income", "Salary", 10000.0)]);
    let err = compute_net_worth_at("2025-12-31", &ctx).expect_err("must refuse");
    assert!(err.to_string().contains("cannot answer"), "{err}");
}

#[test]
fn clamps_the_current_month_to_today_so_future_dated_rows_land_in_neither_figure() {
    let ctx = NetWorthContext {
        accounts: vec![account("chk", "checking", 70000.0)],
        txns_by_account: HashMap::from([(
            "chk".to_string(),
            vec![txn("2026-08-31", "income", "Bonus", 20000.0)],
        )]),
        ..ctx_of()
    };
    let now = net_worth_from_context(&ctx, fake_now()).expect("now");
    let history = net_worth_history_from_context(&ctx, 3.0, fake_now()).expect("history");
    assert_eq!(now.total_inr, 50000.0);
    assert_eq!(history.last().map(|p| p.total_inr), Some(50000.0));
}

// ─── policies ────────────────────────────────────────────────────────────────

#[test]
fn values_a_linked_policy_from_its_account_and_never_also_as_cash() {
    let ctx = NetWorthContext {
        accounts: vec![
            account("chk", "checking", 10000.0),
            account("pol-acc", "savings", 45000.0),
        ],
        policies: vec![policy(Some("pol-acc"))],
        ..ctx_of()
    };
    let snap = at(TODAY, &ctx);
    assert_eq!(snap.breakdown.cash_inr, 10000.0);
    assert_eq!(snap.breakdown.policies_inr, 45000.0);
    assert_eq!(snap.total_inr, 55000.0);
}

#[test]
fn still_counts_a_policy_account_whose_policy_row_is_gone() {
    let ctx = NetWorthContext {
        accounts: vec![account("orphan", "policy", 7000.0)],
        ..ctx_of()
    };
    assert_eq!(at(TODAY, &ctx).breakdown.policies_inr, 7000.0);
}

#[test]
fn ignores_inactive_accounts() {
    let mut old = account("old", "checking", 999999.0);
    old.is_active = false;
    let ctx = NetWorthContext {
        accounts: vec![account("chk", "checking", 1000.0), old],
        ..ctx_of()
    };
    assert_eq!(at(TODAY, &ctx).total_inr, 1000.0);
}

// ─── loadNetWorthContext, on a real database ─────────────────────────────────

fn insert_account(c: &Connection, id: &str, t: &str, currency: &str, balance: f64, off: bool) {
    c.execute(
        "INSERT INTO accounts (id, name, type, currency, balance, is_active, off_budget) VALUES (?, ?, ?, ?, ?, 1, ?)",
        rusqlite::params![id, id, t, currency, balance, i64::from(off)],
    )
    .expect("account");
}

fn insert_txn(
    c: &Connection,
    id: &str,
    account: &str,
    t: &str,
    payee: &str,
    amount: f64,
    date: &str,
) {
    c.execute(
        "INSERT INTO transactions (id, account_id, payee, amount, type, date) VALUES (?, ?, ?, ?, ?, ?)",
        rusqlite::params![id, account, payee, amount, t, date],
    )
    .expect("txn");
}

fn insert_inr_base(c: &Connection) {
    c.execute(
        "INSERT OR REPLACE INTO app_settings (id, base_currency, updated_at) VALUES ('system', 'INR', '')",
        [],
    )
    .expect("settings");
    c.execute(
        "INSERT INTO exchange_rates (id, from_currency, rate_to_base, source, fetched_at) VALUES ('r', 'USD', 80, 'test', '2026-01-01')",
        [],
    )
    .expect("rate");
}

#[test]
fn takes_balances_from_get_account_balances() {
    let c = conn();
    insert_inr_base(&c);
    insert_account(&c, "chk", "checking", "INR", 0.0, false);
    // stored POSITIVE by a dialog that forgot to negate — still a liability
    insert_account(&c, "owed", "debt", "INR", 5000.0, false);
    insert_txn(
        &c,
        "t1",
        "chk",
        "income",
        "Starting Balance",
        50000.0,
        "2024-01-01",
    );
    // an orphan transfer leg: no direction, excluded from the balance
    insert_txn(&c, "t2", "chk", "transfer", "Moved", 999.0, "2024-01-02");
    c.execute(
        "INSERT INTO investments (id, name, asset_type, currency, purchase_value, purchase_date, current_value, account_id) VALUES ('i', 'Fund', 'mutual_fund', 'INR', 30000, '2024-01-01', 30000, 'chk')",
        [],
    )
    .expect("investment");

    let ctx = load_net_worth_context(&c, TODAY).expect("ctx");
    let snap = at(TODAY, &ctx);
    assert_eq!(snap.breakdown.cash_inr, 50000.0);
    assert_eq!(snap.breakdown.holdings_inr, 30000.0);
    assert_eq!(snap.breakdown.debt_inr, -5000.0);
    assert_eq!(snap.total_inr, 75000.0);
}

#[test]
fn net_worth_equals_the_last_history_point_on_a_real_database() {
    let c = conn();
    insert_inr_base(&c);
    insert_account(&c, "chk", "checking", "INR", 120000.0, false);
    insert_account(&c, "usd", "savings", "USD", 1000.0, true);
    insert_account(&c, "card", "credit", "INR", -35000.0, false);
    insert_txn(&c, "t1", "chk", "income", "Salary", 10000.0, "2000-01-01");
    insert_txn(&c, "t2", "chk", "expense", "Rent", 2500.0, "2099-01-01");
    let now = get_net_worth(&c).expect("now");
    let history = get_net_worth_history(&c, 6.0).expect("history");
    let last = history.last().expect("points");
    assert_eq!(last.total_inr, now.total_inr);
    assert_eq!(now.breakdown.cash_inr, 130000.0);
    assert_eq!(now.breakdown.off_budget_cash_inr, 80000.0);
    assert_eq!(now.total_inr, 130000.0 + 80000.0 - 35000.0);
}

#[test]
fn history_without_points_is_an_error_like_node() {
    let c = conn();
    assert!(get_net_worth_history(&c, f64::NAN).is_err());
    assert!(
        net_worth_history_from_context(&ctx_of(), f64::NAN, fake_now())
            .expect("with ctx")
            .is_empty()
    );
}

// ─── the rest of the service on a real database ──────────────────────────────

fn budget_db() -> Connection {
    let c = conn();
    insert_inr_base(&c);
    insert_account(&c, "chk", "checking", "INR", 0.0, false);
    insert_account(&c, "usd", "checking", "USD", 0.0, false);
    insert_account(&c, "off", "savings", "INR", 0.0, true);
    for (id, name, order) in [("g1", "Needs", 0), ("g2", "Savings", 1)] {
        c.execute(
            "INSERT INTO envelope_groups (id, name, sort_order) VALUES (?, ?, ?)",
            rusqlite::params![id, name, order],
        )
        .expect("group");
    }
    for (id, group, name, budgeted) in [("e1", "g1", "Food", 1000.0), ("e2", "g2", "Pot", 500.0)] {
        c.execute(
            "INSERT INTO envelopes (id, group_id, name, budgeted, budget_currency, month) VALUES (?, ?, ?, ?, 'INR', '2026-08')",
            rusqlite::params![id, group, name, budgeted],
        )
        .expect("envelope");
    }
    insert_txn(&c, "i1", "chk", "income", "Salary", 3000.0, "2026-08-01");
    insert_txn(&c, "i2", "usd", "income", "Salary", 10.0, "2026-08-02");
    insert_txn(&c, "i3", "chk", "income", "10", 5.0, "2026-08-03");
    insert_txn(
        &c,
        "i4",
        "chk",
        "income",
        "Starting Balance",
        99.0,
        "2026-08-01",
    );
    insert_txn(&c, "i5", "off", "income", "Interest", 7.0, "2026-08-01");
    c.execute_batch(
        "INSERT INTO transactions (id, account_id, envelope_id, payee, amount, type, date) VALUES
           ('x1', 'chk', 'e1', 'Shop', 400, 'expense', '2026-08-04'),
           ('x2', 'usd', 'e1', 'Shop', 2, 'expense', '2026-08-05'),
           ('x3', 'chk', 'e2', 'Saved', 300, 'expense', '2026-08-06'),
           ('x4', 'chk', 'e1', 'Transfer in', 50, 'transfer', '2026-08-07'),
           ('x5', 'chk', NULL, 'Loose', 70, 'expense', '2026-08-08');",
    )
    .expect("expenses");
    c
}

#[test]
fn cash_flow_groups_income_and_expenses_like_node() {
    let c = budget_db();
    let cf = get_cash_flow(&c, "2026-08").expect("cash flow");
    // Starting Balance and off-budget income are left out; USD converts at 80.
    assert_eq!(cf.total_income, 3000.0 + 800.0 + 5.0);
    let payees: Vec<&str> = cf.income_sources.iter().map(|s| s.payee.as_str()).collect();
    assert_eq!(payees, ["Salary", "10"]);
    assert_eq!(cf.income_sources[0].amount, 3800.0);
    // A transfer-in credit and an uncategorised expense are left out.
    assert_eq!(cf.total_expenses, 400.0 + 160.0 + 300.0);
    assert_eq!(cf.expense_groups[0].group_name, "Needs");
    assert_eq!(cf.expense_groups[0].total, 560.0);
    assert_eq!(cf.expense_groups[1].group_name, "Savings");
    assert_eq!(cf.savings, cf.total_income - cf.total_expenses);
}

#[test]
fn dashboard_excludes_the_savings_group_from_expenses() {
    let c = budget_db();
    let d = get_dashboard_at(&c, "2026-08", fake_now()).expect("dashboard");
    assert_eq!(d.monthly_income, 3805.0);
    assert_eq!(d.monthly_expenses, 560.0);
    assert_eq!(
        d.savings_rate,
        js_round(((3805.0 - 560.0) / 3805.0) * 1000.0) / 10.0
    );
    assert_eq!(d.budget.total_budgeted, 1500.0);
    assert_eq!(d.top_categories.len(), 1);
    assert_eq!(d.top_categories[0].name, "Needs");
    // Largest base-currency amounts first, transfers left out, at most 8.
    assert_eq!(d.recent_transactions.len(), 8);
    assert_eq!(d.recent_transactions[0].id, json!("i1"));
    assert_eq!(d.recent_transactions[1].amount_inr, 800.0);
}

#[test]
fn spending_trends_and_heatmap_walk_back_from_today() {
    let c = budget_db();
    let trends = get_spending_trends_at(&c, 2.0, fake_now()).expect("trends");
    let months: Vec<&str> = trends.iter().map(|t| t.month.as_str()).collect();
    assert_eq!(months, ["2026-07", "2026-08"]);
    assert_eq!(trends[1].income, 3805.0);
    assert_eq!(trends[1].expenses, 560.0);
    // Fractional months: i = 1.5, 0.5, and `new Date(y, 7 - i, 1)` truncates
    // 5.5 / 6.5 to June / July, so the current month is skipped.
    let frac = get_spending_trends_at(&c, 2.5, fake_now()).expect("trends");
    let months: Vec<&str> = frac.iter().map(|t| t.month.as_str()).collect();
    assert_eq!(months, ["2026-06", "2026-07"]);

    let heat = get_budget_heatmap_at(&c, 1.0, fake_now()).expect("heatmap");
    assert_eq!(heat.len(), 2);
    assert_eq!(heat[0].envelope_name, "Food");
    // (400 + 2 × 80 − the 50 transfer-in credit) / 1000.
    assert_eq!(heat[0].spend_pct, 51.0);
    assert_eq!(heat[1].spend_pct, 60.0);
}

#[test]
fn upcoming_premiums_fall_within_the_window_sorted_by_date() {
    let c = conn();
    c.execute_batch(
        "INSERT INTO policies (id, name, provider, currency, start_date, premium_amount, premium_frequency, premium_term_years, policy_term_years, maturity_date, sum_assured, maturity_value) VALUES
           ('p1', 'Monthly', 'A', 'INR', '2026-01-31', 100, 'monthly', 5, 10, '2036-01-31', 1, 1),
           ('p2', 'Annual', 'B', 'INR', '2020-09-01', 900, 'annual', 10, 20, '2040-09-01', 1, 1);",
    )
    .expect("policies");
    let due = get_upcoming_premiums_at(&c, 60.0, fake_now()).expect("premiums");
    let dates: Vec<&str> = due.iter().map(|d| d.due_date.as_str()).collect();
    assert_eq!(dates, ["2026-08-31", "2026-09-01", "2026-09-30"]);
    assert_eq!(due[1].policy_name, json!("Annual"));
}

#[test]
fn portfolio_breakdown_and_top_movers() {
    let c = conn();
    insert_inr_base(&c);
    insert_account(&c, "stash", "savings", "INR", 1000.0, true);
    c.execute_batch(
        "INSERT INTO investments (id, name, asset_type, currency, purchase_value, purchase_date, current_value) VALUES
           ('a', 'A', 'stock', 'INR', 1000, '2024-01-01', 1500),
           ('b', 'B', 'stock', 'INR', 1000, '2024-01-01', 500),
           ('c', 'C', 'etf', 'USD', 10, '2024-01-01', 20),
           ('v', 'Car', 'vehicle', 'INR', 9000, '2024-01-01', 8000);",
    )
    .expect("investments");
    let breakdown = get_portfolio_breakdown(&c).expect("breakdown");
    let types: Vec<&str> = breakdown.iter().map(|b| b.asset_type.as_str()).collect();
    assert_eq!(types, ["stock", "etf", "savings"]);
    assert_eq!(breakdown[0].value_inr, 2000.0);
    assert_eq!(breakdown[1].value_inr, 1600.0);
    assert_eq!(breakdown[0].percentage, 43.48);

    let movers = get_top_movers(&c, 30.0, 2.0).expect("movers");
    let ids: Vec<&str> = movers.iter().map(|m| m.investment.id.as_str()).collect();
    assert_eq!(ids, ["c", "a"]);
    assert!(get_top_movers(&c, 30.0, f64::NAN).expect("nan").is_empty());
    assert_eq!(get_top_movers(&c, 30.0, -1.0).expect("neg").len(), 2);
}

#[test]
fn slice_end_follows_array_slice() {
    assert_eq!(slice_end(5, 2.9), 2);
    assert_eq!(slice_end(5, -1.0), 4);
    assert_eq!(slice_end(5, -9.0), 0);
    assert_eq!(slice_end(5, f64::INFINITY), 5);
    assert_eq!(slice_end(5, f64::NAN), 0);
}
