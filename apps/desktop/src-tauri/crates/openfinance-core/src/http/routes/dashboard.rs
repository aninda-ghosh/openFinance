//! Port of `apps/server/src/routes/dashboard.ts`, mounted at `/api/dashboard`.
//! Owner: Wave 2 (dashboard).
//!
//! Query parameters are read like `c.req.query(name)` (Hono decoding, first
//! occurrence) and converted with JS `Number()`; nothing is validated, as in Node.

use axum::extract::{OriginalUri, State};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};

use super::policies::hono;
use crate::error::ApiResult;
use crate::json::string_to_number;
use crate::services::dashboard as service;
use crate::services::exchange_rate;
use crate::services::policy::dates::js_min;
use crate::state::AppState;

/// `handleError` in dashboard.ts: only 404 passes through.
const PASSTHROUGH: &[u16] = &[404];
/// `/cash-flow` and `/net-worth-history` answer every error with a 500.
const NONE: &[u16] = &[];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(dashboard))
        .route("/net-worth", get(net_worth))
        .route("/portfolio-breakdown", get(portfolio_breakdown))
        .route("/budget-heatmap", get(budget_heatmap))
        .route("/top-movers", get(top_movers))
        .route("/spending-trends", get(spending_trends))
        .route("/cash-flow", get(cash_flow))
        .route("/net-worth-history", get(net_worth_history))
        .route("/exchange-rates", get(exchange_rates))
}

/// `Number(c.req.query(key) ?? fallback)`.
fn number_query(uri: &axum::http::Uri, key: &str, fallback: f64) -> f64 {
    hono::query(uri.query(), key).map_or(fallback, |s| string_to_number(&s))
}

/// `c.req.query("month") ?? localYearMonth()`.
fn month_query(uri: &axum::http::Uri) -> String {
    hono::query(uri.query(), "month").unwrap_or_else(service::local_year_month)
}

/// `Math.max(a, b)` (NaN wins).
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b || (a == b && b.is_sign_negative()) {
        a
    } else {
        b
    }
}

/// GET /api/dashboard?month=YYYY-MM
async fn dashboard(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
) -> ApiResult<Json<Value>> {
    let month = month_query(&uri);
    let dashboard = state
        .db(move |conn| service::get_dashboard(conn, &month))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(serde_json::to_value(dashboard)?))
}

/// GET /api/dashboard/net-worth
async fn net_worth(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let net_worth = state
        .db(service::get_net_worth)
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(serde_json::to_value(net_worth)?))
}

/// GET /api/dashboard/portfolio-breakdown
async fn portfolio_breakdown(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let breakdown = state
        .db(service::get_portfolio_breakdown)
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(json!({ "breakdown": breakdown })))
}

/// GET /api/dashboard/budget-heatmap?months=6
async fn budget_heatmap(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
) -> ApiResult<Json<Value>> {
    let months = number_query(&uri, "months", 6.0);
    let heatmap = state
        .db(move |conn| service::get_budget_heatmap(conn, months))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(json!({ "heatmap": heatmap })))
}

/// GET /api/dashboard/top-movers?days=30&limit=5
async fn top_movers(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
) -> ApiResult<Json<Value>> {
    let days = number_query(&uri, "days", 30.0);
    let limit = number_query(&uri, "limit", 5.0);
    let movers = state
        .db(move |conn| service::get_top_movers(conn, days, limit))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(json!({ "movers": movers })))
}

/// GET /api/dashboard/spending-trends?months=6
async fn spending_trends(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
) -> ApiResult<Json<Value>> {
    let months = number_query(&uri, "months", 6.0);
    let trends = state
        .db(move |conn| service::get_spending_trends(conn, months))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(json!({ "trends": trends })))
}

/// GET /api/dashboard/cash-flow?month=YYYY-MM
async fn cash_flow(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
) -> ApiResult<Json<Value>> {
    let month = month_query(&uri);
    let data = state
        .db(move |conn| service::get_cash_flow(conn, &month))
        .await
        .map_err(|e| e.handled(NONE))?;
    Ok(Json(serde_json::to_value(data)?))
}

/// GET /api/dashboard/net-worth-history?months=6 (clamped to 1..=24)
async fn net_worth_history(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
) -> ApiResult<Json<Value>> {
    let months = js_min(24.0, js_max(1.0, number_query(&uri, "months", 6.0)));
    let history = state
        .db(move |conn| service::get_net_worth_history(conn, months))
        .await
        .map_err(|e| e.handled(NONE))?;
    Ok(Json(json!({ "history": history })))
}

/// GET /api/dashboard/exchange-rates
async fn exchange_rates(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let rates = state
        .db(exchange_rate::list_rates)
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(json!({ "rates": rates })))
}
