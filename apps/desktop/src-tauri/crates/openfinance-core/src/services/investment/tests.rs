//! `depreciation.test.ts`, the physical-asset cases of `dashboard.test.ts`
//! that exercise `depreciatedValue` / `valueOnDate`, and service tests on an
//! in-memory database.

use super::*;
use serde_json::json;

fn conn() -> Connection {
    let c = Connection::open_in_memory().expect("open");
    crate::db::bootstrap::bootstrap_schema(&c).expect("bootstrap");
    c
}

fn obj(v: Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}

fn close_to(actual: f64, expected: f64, digits: i32) -> bool {
    // vitest `toBeCloseTo(expected, digits)`: |a - e| < 10^-digits / 2
    (actual - expected).abs() < 10f64.powi(-digits) / 2.0
}

// ─── depreciation.test.ts ────────────────────────────────────────────────────

#[test]
fn returns_the_quote_unchanged_on_the_quote_date() {
    assert_eq!(
        depreciated_value(20000.0, Some(15.0), Some("2026-01-01"), "2026-01-01"),
        20000.0
    );
}

#[test]
fn compounds_the_yearly_rate() {
    // Two years at 15%: 20000 × 0.85² = 14450 (±leap-day rounding).
    let v = depreciated_value(20000.0, Some(15.0), Some("2024-01-01"), "2026-01-01");
    assert!(close_to(v, 14450.0, -1), "{v}");
}

#[test]
fn drifts_continuously_within_a_year() {
    let half = depreciated_value(20000.0, Some(15.0), Some("2026-01-01"), "2026-07-02");
    assert!(half < 20000.0);
    assert!(half > 17000.0);
}

#[test]
fn is_flat_without_a_rate_or_a_quote_date() {
    assert_eq!(
        depreciated_value(20000.0, None, Some("2020-01-01"), "2026-01-01"),
        20000.0
    );
    assert_eq!(
        depreciated_value(20000.0, Some(0.0), Some("2020-01-01"), "2026-01-01"),
        20000.0
    );
    assert_eq!(
        depreciated_value(20000.0, Some(15.0), None, "2026-01-01"),
        20000.0
    );
}

#[test]
fn estimates_a_higher_value_before_the_quote_date() {
    assert!(depreciated_value(20000.0, Some(15.0), Some("2026-01-01"), "2025-01-01") > 20000.0);
}

/// Outputs of the real `depreciatedValue` under V8 (fixed edge cases plus
/// 400 random inputs), generated with tsx from packages/shared.
#[test]
fn matches_v8_bit_for_bit() {
    let lines = include_str!("depreciation_v8.jsonl");
    let mut n = 0;
    for line in lines.lines().filter(|l| !l.trim().is_empty()) {
        let v: Value = serde_json::from_str(line).expect("fixture line");
        let a = v.as_array().expect("array");
        let quote = a[0].as_f64().expect("quote");
        let rate = a[1].as_f64();
        let at = a[2].as_str();
        let as_of = a[3].as_str().expect("asOf");
        let expected = a[4].as_f64().expect("expected");
        let got = depreciated_value(quote, rate, at, as_of);
        assert_eq!(got.to_bits(), expected.to_bits(), "{line}: got {got}");
        n += 1;
    }
    assert_eq!(n, 415);
}

// ─── dashboard.test.ts "physical assets" (the valuation part) ───────────────

fn car() -> InvestmentRow {
    InvestmentRow {
        id: "car".into(),
        name: "Car".into(),
        asset_type: "vehicle".into(),
        currency: Some("INR".into()),
        purchase_value: 25000.0,
        units: None,
        purchase_date: "2021-03-01".into(),
        current_value: 20000.0,
        current_value_source: None,
        current_value_at: Some("2025-08-19".into()),
        notes: None,
        account_id: None,
        maturity_date: None,
        depreciation_rate: Some(10.0),
        created_at: None,
        updated_at: Some("2025-01-01T00:00:00.000Z".into()),
    }
}

#[test]
fn values_a_depreciating_vehicle_as_of_each_date() {
    let c = car();
    assert_eq!(value_on_date(&c, "2025-08-19"), 20000.0);
    // One year after a 20,000 quote at 10%/yr.
    let later = value_on_date(&c, "2026-08-19");
    assert!(close_to(later, 18000.0, -1), "{later}");
    assert!(later < 20000.0);
    // History is higher in the past.
    assert!(value_on_date(&c, "2024-08-19") > 20000.0);
}

#[test]
fn keeps_a_vehicle_with_no_rate_at_its_flat_value() {
    let c = InvestmentRow {
        depreciation_rate: None,
        current_value: 15000.0,
        ..car()
    };
    assert_eq!(value_on_date(&c, "2026-11-24"), 15000.0);
}

#[test]
fn non_physical_assets_never_depreciate() {
    let c = InvestmentRow {
        asset_type: "stock".into(),
        ..car()
    };
    assert_eq!(value_on_date(&c, "2030-01-01"), 20000.0);
}

#[test]
fn falls_back_to_the_update_date_without_a_quote_date() {
    let c = InvestmentRow {
        current_value_at: None,
        updated_at: Some("2025-08-19T23:59:59.000Z".into()),
        ..car()
    };
    assert_eq!(value_on_date(&c, "2025-08-19"), 20000.0);
    assert!(value_on_date(&c, "2026-08-19") < 20000.0);
}

// ─── Service tests ───────────────────────────────────────────────────────────

fn create(c: &Connection, v: Value) -> InvestmentResponse {
    create_investment(c, &obj(v)).expect("create")
}

fn stock(c: &Connection) -> InvestmentResponse {
    create(
        c,
        json!({"name":"Fund","asset_type":"mutual_fund","currency":"INR",
               "purchase_value":1000,"purchase_date":"2025-01-01","current_value":1200}),
    )
}

#[test]
fn create_and_list() {
    let c = conn();
    let inv = stock(&c);
    assert_eq!(inv.cost_basis, 1000.0);
    assert_eq!(inv.gain_loss_inr, 200.0);
    assert_eq!(inv.gain_loss_pct, 20.0);
    assert_eq!(inv.current_value_at, None);
    assert_eq!(inv.depreciation_rate, None);
    let b = create(
        &c,
        json!({"name":"Apple","asset_type":"stock","currency":"INR",
               "purchase_value":100,"purchase_date":"2025-01-01","current_value":50}),
    );
    let all = list_investments(&c, &InvestmentFilters::default()).expect("list");
    assert_eq!(
        all.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(),
        ["Apple", "Fund"]
    );
    let sorted = list_investments(
        &c,
        &InvestmentFilters {
            sort: Some("gain_desc".into()),
            ..Default::default()
        },
    )
    .expect("list");
    assert_eq!(sorted[0].id, inv.id);
    let stocks = list_investments(
        &c,
        &InvestmentFilters {
            asset_type: Some("stock".into()),
            ..Default::default()
        },
    )
    .expect("list");
    assert_eq!(stocks.len(), 1);
    assert_eq!(stocks[0].id, b.id);
}

#[test]
fn physical_assets_are_unlinked_and_anchored_today() {
    let c = conn();
    c.execute(
        "insert into accounts (id, name, type) values ('acc', 'Broker', 'investment')",
        [],
    )
    .expect("account");
    let car = create(
        &c,
        json!({"name":"Car","asset_type":"vehicle","purchase_value":30000,
               "purchase_date":"2022-01-01","current_value":20000,
               "account_id":"acc","depreciation_rate":15}),
    );
    assert_eq!(car.account_id, None);
    assert_eq!(car.current_value_at, Some(local_iso_today()));
    assert_eq!(car.depreciation_rate, Some(15.0));
    assert_eq!(car.current_value, 20000.0);

    // Non-physical: the rate is dropped and the link kept.
    let s = create(
        &c,
        json!({"name":"S","asset_type":"stock","purchase_value":1,
               "purchase_date":"2022-01-01","current_value":1,
               "account_id":"acc","depreciation_rate":15}),
    );
    assert_eq!(s.account_id.as_deref(), Some("acc"));
    assert_eq!(s.depreciation_rate, None);
}

#[test]
fn vehicle_updates_reanchor_without_logging_echoes() {
    let c = conn();
    let car = create(
        &c,
        json!({"name":"Car","asset_type":"vehicle","purchase_value":30000,
               "purchase_date":"2022-01-01","current_value":20000,
               "current_value_at":"2025-01-01","depreciation_rate":10}),
    );
    let shown = car.current_value;
    assert!(shown < 20000.0);

    // Echoing the displayed value is not a new quote.
    let same =
        update_investment(&c, &car.id, &obj(json!({"current_value": shown}))).expect("update");
    assert_eq!(same.quoted_value, 20000.0);
    assert!(get_value_history(&c, &car.id).expect("history").is_empty());

    // A new rate re-anchors at today's value so the figure does not jump.
    let rerated =
        update_investment(&c, &car.id, &obj(json!({"depreciation_rate": 20}))).expect("update");
    assert_eq!(rerated.quoted_value, shown);
    assert_eq!(rerated.current_value, shown);
    assert_eq!(rerated.current_value_at, Some(local_iso_today()));
    assert!(get_value_history(&c, &car.id).expect("history").is_empty());

    // A real quote is logged with the derived previous value.
    let quoted = update_investment(
        &c,
        &car.id,
        &obj(json!({"current_value": 15000, "current_value_at": "2026-01-01"})),
    )
    .expect("update");
    assert_eq!(quoted.quoted_value, 15000.0);
    assert_eq!(quoted.current_value_at.as_deref(), Some("2026-01-01"));
    let h = get_value_history(&c, &car.id).expect("history");
    assert_eq!(h.len(), 1);
    assert_eq!(h[0].previous_value, Some(shown));
    assert_eq!(h[0].new_value, 15000.0);
    assert_eq!(h[0].source, "manual");
}

#[test]
fn contributions_raise_the_basis() {
    let c = conn();
    let inv = stock(&c);
    // Value change with a contribution: one row, basis rises with it.
    let up = update_investment(
        &c,
        &inv.id,
        &obj(json!({"current_value": 1700, "contribution": 500, "notes": "payroll"})),
    )
    .expect("update");
    assert_eq!(up.total_contributions, 500.0);
    assert_eq!(up.cost_basis, 1500.0);
    assert_eq!(up.gain_loss_inr, 200.0);
    // A contribution without a value change is still recorded.
    let more = update_investment(&c, &inv.id, &obj(json!({"contribution": 100}))).expect("update");
    assert_eq!(more.total_contributions, 600.0);
    let h = get_value_history(&c, &inv.id).expect("history");
    assert_eq!(h.len(), 2);
    let zero_move = h.iter().find(|e| e.contribution == 100.0).expect("row");
    assert_eq!(zero_move.previous_value, Some(1700.0));
    assert_eq!(zero_move.new_value, 1700.0);
    assert_eq!(zero_move.notes, None);

    // Reclassify one entry, then everything.
    let first = h.iter().find(|e| e.contribution == 500.0).expect("row");
    let set = set_entry_contribution(&c, &inv.id, &first.id, 0.0).expect("set");
    assert_eq!(set.total_contributions, 100.0);
    let matched = bulk_set_contributions(&c, &inv.id, "match_delta").expect("bulk");
    assert_eq!(matched.total_contributions, 500.0);
    let cleared = bulk_set_contributions(&c, &inv.id, "clear").expect("bulk");
    assert_eq!(cleared.total_contributions, 0.0);

    // Entry ownership is checked.
    let other = stock(&c);
    let err = set_entry_contribution(&c, &other.id, &first.id, 1.0).expect_err("404");
    assert_eq!(err.status_code().as_u16(), 404);
    let err = bulk_set_contributions(&c, "nope", "clear").expect_err("404");
    assert_eq!(err.status_code().as_u16(), 404);
}

#[test]
fn refresh_uses_the_stored_value() {
    let c = conn();
    let inv = stock(&c);
    let r = refresh_price(&c, &inv.id).expect("refresh");
    assert_eq!(r.price, 1200.0);
    assert_eq!(r.price_inr, 1200.0);
    assert_eq!(r.source_url, "manual://stored-value");
    let after = get_investment_by_id(&c, &inv.id).expect("get");
    assert_eq!(
        after.current_value_at.as_deref(),
        Some(r.fetched_at.as_str())
    );
    assert_eq!(
        after.current_value_source.as_deref(),
        Some("manual://stored-value")
    );
    let h = get_value_history(&c, &inv.id).expect("history");
    assert_eq!(h[0].source, "price_refresh");
    assert_eq!(h[0].contribution, 0.0);
    let ph = get_price_history(&c, &inv.id, None, None).expect("prices");
    assert_eq!(ph.len(), 1);
    assert!(get_price_history(&c, &inv.id, Some("9999"), None)
        .expect("prices")
        .is_empty());
    assert_eq!(
        get_price_history(&c, &inv.id, Some(""), Some("9999"))
            .expect("prices")
            .len(),
        1
    );

    let car = create(
        &c,
        json!({"name":"Car","asset_type":"vehicle","purchase_value":1,
               "purchase_date":"2022-01-01","current_value":1}),
    );
    let err = refresh_price(&c, &car.id).expect_err("400");
    assert_eq!(err.status_code().as_u16(), 400);
    let zero = create(
        &c,
        json!({"name":"Zero","asset_type":"cash","purchase_value":1,
               "purchase_date":"2022-01-01","current_value":0}),
    );
    let err = refresh_price(&c, &zero.id).expect_err("422");
    assert_eq!(err.status_code().as_u16(), 422);
    let err = refresh_price(&c, "nope").expect_err("404");
    assert_eq!(err.status_code().as_u16(), 404);
}

#[test]
fn delete_removes_history() {
    let c = conn();
    let inv = stock(&c);
    refresh_price(&c, &inv.id).expect("refresh");
    delete_investment(&c, &inv.id).expect("delete");
    assert!(get_value_history(&c, &inv.id).expect("history").is_empty());
    assert!(get_price_history(&c, &inv.id, None, None)
        .expect("prices")
        .is_empty());
    let err = delete_investment(&c, &inv.id).expect_err("404");
    assert_eq!(err.status_code().as_u16(), 404);
}

#[test]
fn portfolio_summary_counts_holdings_and_linked_cash() {
    let c = conn();
    c.execute(
        "insert into accounts (id, name, type, currency, balance, off_budget) values ('brk', 'Broker', 'investment', 'INR', 5000, 1)",
        [],
    )
    .expect("account");
    create(
        &c,
        json!({"name":"Linked","asset_type":"stock","purchase_value":1000,
               "purchase_date":"2022-01-01","current_value":3000,"account_id":"brk"}),
    );
    stock(&c);
    create(
        &c,
        json!({"name":"Car","asset_type":"vehicle","purchase_value":1,
               "purchase_date":"2022-01-01","current_value":9999}),
    );
    let s = get_portfolio_summary(&c).expect("summary");
    assert_eq!(s.by_asset_type.get("stock"), Some(&json!(3000.0)));
    assert_eq!(s.by_asset_type.get("mutual_fund"), Some(&json!(1200.0)));
    // listAccounts already folds linked holdings into the balance (5000 + 3000).
    assert_eq!(s.by_asset_type.get("investment"), Some(&json!(5000.0)));
    assert_eq!(s.by_asset_type.get("vehicle"), None);
    assert_eq!(s.total_inr, 9200.0);
}

#[test]
fn converts_with_the_stored_rate() {
    let c = conn();
    c.execute(
        "insert into exchange_rates (id, from_currency, rate_to_base, source, fetched_at) values ('r', 'EUR', 80, 'x', '2026-01-01')",
        [],
    )
    .expect("rate");
    let inv = create(
        &c,
        json!({"name":"US","asset_type":"etf","currency":"EUR","purchase_value":10,
               "purchase_date":"2022-01-01","current_value":15}),
    );
    assert_eq!(inv.purchase_value_inr, 800.0);
    assert_eq!(inv.current_value_inr, 1200.0);
    assert_eq!(inv.gain_loss_pct, 50.0);
    let r = refresh_price(&c, &inv.id).expect("refresh");
    assert_eq!(r.price_inr, 1200.0);
    assert_eq!(r.currency, "EUR");
}
